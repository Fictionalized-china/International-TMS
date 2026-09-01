import { env } from "cloudflare:workers";
import { useNavigation } from "react-router";
import type { Route } from "./+types/portal.calculator";
import { PortalForm as Form } from "../components/PortalNavigation";
import { requirePortalCustomer } from "../lib/portal.server";
import { calculatePrice, type ChargeWeightMode, type PriceTier, type PricingMode, type PricingProduct } from "../lib/pricing";
import { valueOf } from "../lib/validation";
import { nextDocumentNumber } from "../lib/documents.server";
import { writeAudit } from "../lib/audit.server";
import { recordWorkflowEvent } from "../lib/business-workflow.server";

type ProductRow = { id:string; product_code:string; product_name:string; origin_country_code:string; origin_city:string|null; destination_country_code:string; destination_city:string|null; transport_mode:string; estimated_days:string|null; currency:string; charge_weight_mode:ChargeWeightMode; pricing_mode:PricingMode; min_weight:number; max_weight:number|null; volume_divisor:number; rounding_unit:number; density_threshold:number; density_low_mode:"actual"|"volume"; density_high_mode:"actual"|"volume"; first_weight:number; first_price:number; additional_weight:number; additional_price:number; minimum_charge:number; handling_fee:number; fuel_surcharge_rate:number; cargo_surcharge_rate:number; remarks:string|null };
type TierRow = { product_id:string; from_value:number; to_value:number|null; billing_unit:"KG"|"CBM"; unit_size:number|null; unit_price:number|null; first_weight:number|null; first_price:number|null; additional_weight:number|null; additional_price:number|null };

const publicProductSql = `FROM logistics_products WHERE organization_id=? AND status='active' AND public_visible=1 AND (effective_from IS NULL OR date(effective_from)<=date('now')) AND (effective_to IS NULL OR date(effective_to)>=date('now'))`;
const chargeLabels:Record<ChargeWeightMode,string> = { max_actual_volume:"实重/体积重取大", actual:"实重计费", volume:"体积重计费", density:"密度计费" };
const priceLabels:Record<PricingMode,string> = { first_additional:"首重续重", tier_unit:"阶梯价格", multi_additional:"多级续重", tier_first_additional:"阶梯首重续重", density_tier:"密度阶梯" };

export async function loader({ request }:Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const products = await env.DB.prepare(`SELECT * ${publicProductSql} ORDER BY origin_country_code,destination_country_code,product_name`).bind(user.organizationId).all<ProductRow>();
  return { customer, products:products.results };
}

export async function action({ request }:Route.ActionArgs) {
  const { user,customer } = await requirePortalCustomer(request);
  const form = await request.formData();
  const intent=valueOf(form,"intent")||"calculate";
  const origin = valueOf(form,"origin").toUpperCase(), destination = valueOf(form,"destination").toUpperCase();
  const actualWeight = Number(valueOf(form,"actualWeight")), volumeCbm = Number(valueOf(form,"volumeCbm"));
  const pieces=Number(valueOf(form,"pieces")||1),cargo=valueOf(form,"cargo"),notes=valueOf(form,"notes");
  const values = { origin, destination, actualWeight:valueOf(form,"actualWeight"), volumeCbm:valueOf(form,"volumeCbm"),pieces:valueOf(form,"pieces")||"1",cargo,notes };
  if (!origin || !destination || origin===destination || !Number.isFinite(actualWeight) || actualWeight<=0 || !Number.isFinite(volumeCbm) || volumeCbm<=0) return { formError:"请选择有效线路，并填写大于 0 的实际重量和总体积。", values };
  if(intent==="inquiry"){
    const productId=valueOf(form,"productId");
    if(!cargo||!Number.isInteger(pieces)||pieces<1)return{formError:"提交询价前请填写货物描述和有效件数。",values};
    const product=await env.DB.prepare(`SELECT * ${publicProductSql} AND id=? AND origin_country_code=? AND destination_country_code=?`).bind(user.organizationId,productId,origin,destination).first<ProductRow>();
    if(!product)return{formError:"物流产品已下架或线路无效，请重新试算。",values};
    const tiers=await env.DB.prepare("SELECT * FROM logistics_product_price_tiers WHERE product_id=? ORDER BY sort_order,from_value").bind(product.id).all<TierRow>();
    const calculation=calculatePrice(mapProduct(product),tiers.results.map(mapTier),actualWeight,volumeCbm);
    if(!calculation)return{formError:"当前货量没有可用价格，请联系客户经理。",values};
    const id=crypto.randomUUID(),number=await nextDocumentNumber(user.organizationId,"inquiry"),now=new Date().toISOString();
    await env.DB.prepare(`INSERT INTO freight_inquiries(id,organization_id,inquiry_number,customer_id,logistics_product_id,origin_country,origin_city,destination_country,destination_city,cargo_description,pieces,gross_weight_kg,volume_cbm,estimated_currency,estimated_base_freight,estimated_total,status,customer_notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,user.organizationId,number,customer.id,product.id,origin,product.origin_city,destination,product.destination_city,cargo,pieces,actualWeight,volumeCbm,product.currency,calculation.baseFreight,calculation.total,"submitted",notes||null,user.userId,now,now).run();
    await recordWorkflowEvent({organizationId:user.organizationId,event:"customer.ready",customerId:customer.id,actorUserId:user.userId,source:"portal",metadata:{inquiryId:id,number}});
    await writeAudit({request,action:"portal.inquiry.submit",resourceType:"freight_inquiry",resourceId:id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{number,productId,total:calculation.total}});
    return{success:`询价 ${number} 已提交，客户经理将生成正式报价。`,values};
  }
  const products = await env.DB.prepare(`SELECT * ${publicProductSql} AND origin_country_code=? AND destination_country_code=? ORDER BY currency,product_name`).bind(user.organizationId,origin,destination).all<ProductRow>();
  if (!products.results.length) return { formError:"该线路暂时没有可试算的物流产品，请联系客户经理。", values };
  const placeholders = products.results.map(()=>"?").join(",");
  const tiers = await env.DB.prepare(`SELECT * FROM logistics_product_price_tiers WHERE product_id IN (${placeholders}) ORDER BY product_id,sort_order,from_value`).bind(...products.results.map(product=>product.id)).all<TierRow>();
  const results = products.results.flatMap(product => {
    const calculation = calculatePrice(mapProduct(product),tiers.results.filter(tier=>tier.product_id===product.id).map(mapTier),actualWeight,volumeCbm);
    return calculation ? [{ id:product.id, code:product.product_code, name:product.product_name, origin:product.origin_country_code, originCity:product.origin_city, destination:product.destination_country_code, destinationCity:product.destination_city, transportMode:product.transport_mode, estimatedDays:product.estimated_days, currency:product.currency, remarks:product.remarks, chargeLabel:chargeLabels[product.charge_weight_mode], priceLabel:priceLabels[product.pricing_mode], ...calculation }] : [];
  }).sort((a,b)=>a.currency.localeCompare(b.currency)||a.total-b.total);
  if (!results.length) return { formError:"现有产品没有匹配该重量或密度的价格阶梯，请联系客户经理。", values };
  return { results, values, unavailableCount:products.results.length-results.length };
}

export default function PortalCalculator({ loaderData, actionData }:Route.ComponentProps) {
  const busy = useNavigation().state!=="idle";
  const origins = unique(loaderData.products.map(product=>product.origin_country_code));
  const destinations = unique(loaderData.products.map(product=>product.destination_country_code));
  const values = actionData?.values;
  const results = actionData && "results" in actionData ? actionData.results??[] : [];
  return <><header className="page-header"><div><p className="eyebrow">FREIGHT CALCULATOR</p><h1>运费试算</h1><p>输入货物总重量与总体积，实时比较当前可用物流产品。</p></div><span className="status-pill">{loaderData.products.length} 个可用产品</span></header>
    <section className="panel calculator-panel"><div className="calculator-note"><strong>参考价格</strong><span>试算结果不构成正式报价，最终费用以订单报价及实际复核数据为准。</span></div>
      <Form method="post" className="form-grid calculator-form">
        <input type="hidden" name="intent" value="calculate"/>
        <label className="field calculator-route-field"><span>起运国家/地区</span><select name="origin" defaultValue={values?.origin||""} required><option value="">请选择</option>{origins.map(code=><option key={code}>{code}</option>)}</select></label>
        <label className="field calculator-route-field"><span>目的国家/地区</span><select name="destination" defaultValue={values?.destination||""} required><option value="">请选择</option>{destinations.map(code=><option key={code}>{code}</option>)}</select></label>
        <label className="field calculator-number-field"><span>货物实际总重量 KG</span><input name="actualWeight" type="number" min="0.001" step="0.001" defaultValue={values?.actualWeight||""} placeholder="例如 1200" required/></label>
        <label className="field calculator-number-field"><span>货物总体积 CBM</span><input name="volumeCbm" type="number" min="0.001" step="0.001" defaultValue={values?.volumeCbm||""} placeholder="例如 10" required/></label>
        <label className="field calculator-pieces-field"><span>件数</span><input name="pieces" type="number" min="1" step="1" defaultValue={values?.pieces||"1"}/></label>
        <label className="field calculator-cargo-field"><span>货物描述</span><input name="cargo" defaultValue={values?.cargo||""} placeholder="例如：服装、普货"/></label>
        <label className="field calculator-notes-field"><span>询价备注</span><textarea name="notes" rows={2} defaultValue={values?.notes||""} placeholder="包装、报关或时效要求"/></label>
        <button className="primary portal-primary" disabled={busy||!loaderData.products.length}>{busy?"正在计算…":"立即试算"}</button>
      </Form>
      {!loaderData.products.length&&<p className="empty-state">暂无对客户开放的物流产品，请联系客户经理或等待产品上架。</p>}
      {actionData&&"formError" in actionData&&<div className="alert error">{actionData.formError}</div>}
      {actionData&&"success" in actionData&&<div className="alert success">{actionData.success}</div>}
    </section>
    {results.length>0&&<section className="rate-results"><div className="panel-header"><div><h2>可选运输方案</h2><p>共找到 {results.length} 个可报价产品，已按币种和总价排列。</p></div></div>{results.map(result=><article className="rate-card" key={result.id}><header><div><span className="rate-code">{result.code}</span><h2>{result.name}</h2><p>{routeName(result.origin,result.originCity)} → {routeName(result.destination,result.destinationCity)} · {result.transportMode}</p></div><div className="rate-total"><span>预估总价</span><strong>{money(result.total,result.currency)}</strong><small>{result.estimatedDays||"时效待确认"}</small></div></header><div className="rate-metrics"><div><span>实重</span><strong>{number(result.weight.actualWeight)} KG</strong></div><div><span>体积重</span><strong>{number(result.weight.volumeWeight)} KG</strong></div><div><span>密度</span><strong>{result.weight.density===null?"—":`${number(result.weight.density)} KG/CBM`}</strong></div><div><span>计费重</span><strong>{number(result.weight.chargeableWeight)} KG</strong></div></div><div className="rate-breakdown"><span>计费方式 <strong>{result.chargeLabel} · {result.priceLabel}</strong></span><span>基础运费 <strong>{money(result.baseFreight,result.currency)}</strong></span><span>燃油附加 <strong>{money(result.fuelSurcharge,result.currency)}</strong></span><span>货物附加 <strong>{money(result.cargoSurcharge,result.currency)}</strong></span><span>操作费 <strong>{money(result.handlingFee,result.currency)}</strong></span></div>{result.remarks&&<div className="rate-remarks"><strong>另计费用与注意事项</strong><p>{result.remarks}</p></div>}<Form method="post" className="rate-inquiry-action"><input type="hidden" name="intent" value="inquiry"/><input type="hidden" name="productId" value={result.id}/><input type="hidden" name="origin" value={values?.origin}/><input type="hidden" name="destination" value={values?.destination}/><input type="hidden" name="actualWeight" value={values?.actualWeight}/><input type="hidden" name="volumeCbm" value={values?.volumeCbm}/><input type="hidden" name="pieces" value={values?.pieces}/><input type="hidden" name="cargo" value={values?.cargo}/><input type="hidden" name="notes" value={values?.notes}/><span>需要正式价格和业务确认？</span><button className="primary portal-primary" disabled={busy}>提交正式询价</button></Form></article>)}{actionData&&"unavailableCount" in actionData&&Number(actionData.unavailableCount)>0&&<p className="calculator-footnote">另有 {actionData.unavailableCount} 个产品因重量限制或价格阶梯不匹配未展示。</p>}</section>}
  </>;
}

function mapProduct(p:ProductRow):PricingProduct { return { chargeWeightMode:p.charge_weight_mode,pricingMode:p.pricing_mode,minWeight:p.min_weight,maxWeight:p.max_weight,volumeDivisor:p.volume_divisor,roundingUnit:p.rounding_unit,densityThreshold:p.density_threshold,densityLowMode:p.density_low_mode,densityHighMode:p.density_high_mode,firstWeight:p.first_weight,firstPrice:p.first_price,additionalWeight:p.additional_weight,additionalPrice:p.additional_price,minimumCharge:p.minimum_charge,handlingFee:p.handling_fee,fuelSurchargeRate:p.fuel_surcharge_rate,cargoSurchargeRate:p.cargo_surcharge_rate }; }
function mapTier(t:TierRow):PriceTier { return { from:t.from_value,to:t.to_value,billingUnit:t.billing_unit,unitSize:t.unit_size,unitPrice:t.unit_price,firstWeight:t.first_weight,firstPrice:t.first_price,additionalWeight:t.additional_weight,additionalPrice:t.additional_price }; }
function unique(values:string[]) { return [...new Set(values)].sort(); }
function number(value:number) { return value.toLocaleString("zh-CN",{ maximumFractionDigits:3 }); }
function money(value:number,currency:string) { return `${currency} ${value.toLocaleString("zh-CN",{ minimumFractionDigits:2,maximumFractionDigits:2 })}`; }
function routeName(country:string,city:string|null) { return city?`${country} ${city}`:country; }
export function meta() { return [{ title:"运费试算 | International TMS" }]; }
