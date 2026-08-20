import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/admin.quotations";
import { requireSessionUser } from "../lib/auth.server";
import { nextDocumentNumber } from "../lib/documents.server";
import { canTransition } from "../lib/workflow";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { recordWorkflowEvent } from "../lib/business-workflow.server";
import { Modal } from "../components/Modal";

type Quote = { id: string; quote_number: string; customer_id:string; customer_name: string; salesperson_user_id:string|null; salesperson_name:string|null; inquiry_number:string|null; version_number:number; origin_country: string; origin_city: string; destination_country: string; destination_city: string; transport_mode: string; road_load_type:"ftl"|"ltl"; service_level: string | null; cargo_description: string; pieces: number; gross_weight_kg: number; volume_cbm: number; currency: string; subtotal:number; tax_amount:number; total_amount: number; valid_until: string | null; status: string; notes:string|null; created_at: string; charges: string | null; charge_name:string|null;charge_quantity:number|null;charge_unit_price:number|null;charge_exchange_rate:number|null;surcharge:number|null };
type Inquiry={id:string;inquiry_number:string;customer_name:string;product_name:string|null;origin_country:string;origin_city:string|null;destination_country:string;destination_city:string|null;cargo_description:string;pieces:number;gross_weight_kg:number;volume_cbm:number;estimated_currency:string;estimated_total:number;status:string;customer_notes:string|null;created_at:string};
type GeoReference={code:string;name:string;parent_code:string|null};
type SalespersonOption={id:string;display_name:string;email:string};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "quote.view");
  const [quotes,inquiries, customers, opportunities, modes, services, currencies, countries,provinces,cities,users,quoteSalespeople] = await Promise.all([
    env.DB.prepare(`SELECT q.id,q.quote_number,q.customer_id,c.name AS customer_name,fi.inquiry_number,q.version_number,q.origin_country,q.origin_city,q.destination_country,q.destination_city,q.transport_mode,q.road_load_type,q.service_level,q.cargo_description,q.pieces,q.gross_weight_kg,q.volume_cbm,q.currency,q.subtotal,q.tax_amount,q.total_amount,q.valid_until,q.status,q.notes,q.created_at,GROUP_CONCAT(qc.description || ' ' || qc.quantity || ' × ' || qc.unit_price || '，汇率 ' || qc.exchange_rate || '，金额 ' || qc.amount, '；') AS charges,MAX(CASE WHEN qc.charge_code='FREIGHT' THEN qc.description END) charge_name,MAX(CASE WHEN qc.charge_code='FREIGHT' THEN qc.quantity END) charge_quantity,MAX(CASE WHEN qc.charge_code='FREIGHT' THEN qc.unit_price END) charge_unit_price,MAX(CASE WHEN qc.charge_code='FREIGHT' THEN qc.exchange_rate END) charge_exchange_rate,MAX(CASE WHEN qc.charge_code='SURCHARGE' THEN qc.amount END) surcharge FROM quotations q JOIN customers c ON c.id=q.customer_id LEFT JOIN freight_inquiries fi ON fi.id=q.inquiry_id LEFT JOIN quotation_charges qc ON qc.quotation_id=q.id WHERE q.organization_id=? GROUP BY q.id ORDER BY q.created_at DESC LIMIT 200`).bind(current.organizationId).all<Quote>(),
    env.DB.prepare(`SELECT fi.id,fi.inquiry_number,c.name AS customer_name,p.product_name,fi.origin_country,fi.origin_city,fi.destination_country,fi.destination_city,fi.cargo_description,fi.pieces,fi.gross_weight_kg,fi.volume_cbm,fi.estimated_currency,fi.estimated_total,fi.status,fi.customer_notes,fi.created_at FROM freight_inquiries fi JOIN customers c ON c.id=fi.customer_id LEFT JOIN logistics_products p ON p.id=fi.logistics_product_id WHERE fi.organization_id=? ORDER BY CASE fi.status WHEN 'submitted' THEN 0 WHEN 'quoting' THEN 1 ELSE 2 END,fi.created_at DESC LIMIT 200`).bind(current.organizationId).all<Inquiry>(),
    env.DB.prepare("SELECT id, code, name FROM customers WHERE organization_id = ? AND status = 'active' ORDER BY name").bind(current.organizationId).all<{ id: string; code: string; name: string }>(),
    env.DB.prepare("SELECT id, name FROM sales_opportunities WHERE organization_id = ? AND stage NOT IN ('won','lost') ORDER BY updated_at DESC").bind(current.organizationId).all<{ id: string; name: string }>(),
    reference(current.organizationId, "transport_mode"), reference(current.organizationId, "service_level"), reference(current.organizationId, "currency"), reference(current.organizationId, "country"),
    geoReference(current.organizationId,"province"),geoReference(current.organizationId,"city"),
    env.DB.prepare("SELECT u.id,u.display_name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.status='active' AND u.status='active' ORDER BY u.display_name,u.email").bind(current.organizationId).all<SalespersonOption>(),
    env.DB.prepare("SELECT q.id quote_id,q.salesperson_user_id,u.display_name salesperson_name FROM quotations q LEFT JOIN users u ON u.id=q.salesperson_user_id WHERE q.organization_id=?").bind(current.organizationId).all<{quote_id:string;salesperson_user_id:string|null;salesperson_name:string|null}>(),
  ]);
  const salespersonByQuote=new Map(quoteSalespeople.results.map(row=>[row.quote_id,row]));
  const quoteRows=quotes.results.map(quote=>({...quote,salesperson_user_id:salespersonByQuote.get(quote.id)?.salesperson_user_id??null,salesperson_name:salespersonByQuote.get(quote.id)?.salesperson_name??null}));
  return { current, quotes: quoteRows,inquiries:inquiries.results, customers: customers.results, opportunities: opportunities.results, modes: modes.results, services: services.results, currencies: currencies.results, countries: countries.results,provinces:provinces.results,cities:cities.results,users:users.results };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "quote.manage");
  const form = await request.formData(), intent = valueOf(form, "intent"), now = new Date().toISOString();
  if(intent==="quoteInquiry"){
    const inquiryId=valueOf(form,"inquiryId"),salespersonUserId=valueOf(form,"salespersonUserId"),roadLoadType=valueOf(form,"roadLoadType"),originCity=valueOf(form,"originCity"),destinationCity=valueOf(form,"destinationCity"),validUntil=valueOf(form,"validUntil"),notes=valueOf(form,"notes"),chargeName=valueOf(form,"chargeName")||"汽运运费",quantity=Number(valueOf(form,"quantity")||1),unitPrice=Number(valueOf(form,"unitPrice")||0),exchangeRate=1,surcharge=Number(valueOf(form,"surcharge")||0);
    const inquiry=await env.DB.prepare(`SELECT fi.*,p.transport_mode,p.product_name FROM freight_inquiries fi LEFT JOIN logistics_products p ON p.id=fi.logistics_product_id WHERE fi.id=? AND fi.organization_id=? AND fi.status IN ('submitted','quoting','quoted')`).bind(inquiryId,current.organizationId).first<Record<string,string|number|null>>();
    const salesperson=await findActiveSalesperson(current.organizationId,salespersonUserId);
    const currency=String(inquiry?.estimated_currency||"CNY"),freight=quantity*unitPrice;
    if(!inquiry||!salesperson||!['ftl','ltl'].includes(roadLoadType)||!originCity||!destinationCity||!chargeName||!Number.isFinite(quantity)||quantity<=0||[unitPrice,surcharge].some(v=>!Number.isFinite(v)||v<0))return{formError:"请选择有效业务员，并填写完整的正式报价资料"};
    const versionRow=await env.DB.prepare("SELECT COALESCE(MAX(version_number),0)+1 AS version FROM quotations WHERE inquiry_id=?").bind(inquiryId).first<{version:number}>(),version=Number(versionRow?.version??1),subtotal=freight+surcharge,tax=0,total=subtotal,id=crypto.randomUUID(),number=await nextDocumentNumber(current.organizationId,"quote");
    await env.DB.batch([
      env.DB.prepare("UPDATE quotations SET status='cancelled',updated_at=? WHERE inquiry_id=? AND road_load_type=? AND status='sent'").bind(now,inquiryId,roadLoadType),
      env.DB.prepare(`INSERT INTO quotations(id,organization_id,quote_number,customer_id,inquiry_id,logistics_product_id,version_number,origin_country,origin_city,destination_country,destination_city,transport_mode,road_load_type,cargo_description,pieces,gross_weight_kg,volume_cbm,currency,subtotal,tax_amount,total_amount,valid_until,status,notes,salesperson_user_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'sent',?,?,?,?,?)`).bind(id,current.organizationId,number,String(inquiry.customer_id),inquiryId,inquiry.logistics_product_id,version,String(inquiry.origin_country),originCity,String(inquiry.destination_country),destinationCity,String(inquiry.transport_mode??"ROAD"),roadLoadType,String(inquiry.cargo_description),Number(inquiry.pieces),Number(inquiry.gross_weight_kg),Number(inquiry.volume_cbm),currency,subtotal,tax,total,validUntil||null,notes||null,salesperson.id,current.userId,now,now),
      env.DB.prepare("INSERT INTO quotation_charges(id,quotation_id,charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order,created_at) VALUES(?,?,'FREIGHT',?,?,?,?,?,10,?)").bind(crypto.randomUUID(),id,chargeName,quantity,unitPrice,freight,exchangeRate,now),
      env.DB.prepare("UPDATE freight_inquiries SET status='quoted',updated_at=? WHERE id=? AND organization_id=?").bind(now,inquiryId,current.organizationId),
      env.DB.prepare("INSERT INTO portal_notifications(id,organization_id,customer_id,user_id,type,title,message,link,is_read,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)").bind(crypto.randomUUID(),current.organizationId,String(inquiry.customer_id),null,"quote","新报价待确认",`报价 ${number} 已发布，请确认接受或拒绝。`,"/portal/orders",now),
    ]);
    if(surcharge>0)await env.DB.prepare("INSERT INTO quotation_charges(id,quotation_id,charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order,created_at) VALUES(?,?,'SURCHARGE','附加费',1,?,?,?,20,?)").bind(crypto.randomUUID(),id,surcharge,surcharge,exchangeRate,now).run();
    await recordWorkflowEvent({organizationId:current.organizationId,event:"quote.created",customerId:String(inquiry.customer_id),quotationId:id,actorUserId:current.userId,source:"admin",metadata:{number,total,inquiryId,version}});
    await writeAudit({request,action:"inquiry.quote.create",resourceType:"quotation",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{number,inquiryId,version,total,salespersonUserId:salesperson.id}});
    return{success:`正式报价 ${number}（V${version}）已发布到客户门户，等待客户确认`};
  }
  if(intent==="edit"){
    const id=valueOf(form,"id"),customerId=valueOf(form,"customerId"),salespersonUserId=valueOf(form,"salespersonUserId"),roadLoadType=valueOf(form,"roadLoadType"),originCountry=valueOf(form,"originCountry"),originCity=valueOf(form,"originCity"),destinationCountry=valueOf(form,"destinationCountry"),destinationCity=valueOf(form,"destinationCity"),mode=valueOf(form,"mode"),cargo=valueOf(form,"cargo"),validUntil=valueOf(form,"validUntil"),notes=valueOf(form,"notes"),chargeName=valueOf(form,"chargeName"),pieces=Number(valueOf(form,"pieces")),weight=Number(valueOf(form,"weight")),volume=Number(valueOf(form,"volume")),quantity=Number(valueOf(form,"quantity")),unitPrice=Number(valueOf(form,"unitPrice")),exchangeRate=1,surcharge=Number(valueOf(form,"surcharge")||0);
    const existing=await env.DB.prepare("SELECT status,currency FROM quotations WHERE id=? AND organization_id=?").bind(id,current.organizationId).first<{status:string;currency:string}>();
    const salesperson=await findActiveSalesperson(current.organizationId,salespersonUserId);
    if(!existing)return{formError:"报价不存在"};
    if(existing.status==="cancelled")return{formError:"已作废报价只能查看，不能编辑"};
    if(!salesperson||!customerId||!['ftl','ltl'].includes(roadLoadType)||!originCountry||!originCity||!destinationCountry||!destinationCity||!mode||!cargo||!chargeName||!Number.isInteger(pieces)||pieces<1||!Number.isFinite(quantity)||quantity<=0||[weight,volume,unitPrice,surcharge].some(value=>!Number.isFinite(value)||value<0))return{formError:"请选择有效业务员，并填写完整报价资料"};
    const currency=existing.currency||"CNY",freight=quantity*unitPrice,subtotal=freight+surcharge,tax=0,total=subtotal,newStatus="draft";
    const statements=[
      env.DB.prepare("UPDATE quotations SET customer_id=?,salesperson_user_id=?,origin_country=?,origin_city=?,destination_country=?,destination_city=?,transport_mode=?,road_load_type=?,cargo_description=?,pieces=?,gross_weight_kg=?,volume_cbm=?,currency=?,subtotal=?,tax_amount=?,total_amount=?,valid_until=?,notes=?,status=?,accepted_at=NULL,updated_at=? WHERE id=? AND organization_id=?").bind(customerId,salesperson.id,originCountry,originCity,destinationCountry,destinationCity,mode,roadLoadType,cargo,pieces,weight,volume,currency,subtotal,tax,total,validUntil||null,notes||null,newStatus,now,id,current.organizationId),
      env.DB.prepare("UPDATE quotation_charges SET description=?,quantity=?,unit_price=?,amount=?,exchange_rate=? WHERE id=(SELECT id FROM quotation_charges WHERE quotation_id=? AND charge_code='FREIGHT' ORDER BY sort_order LIMIT 1)").bind(chargeName,quantity,unitPrice,freight,exchangeRate,id),
      env.DB.prepare("DELETE FROM quotation_charges WHERE quotation_id=? AND charge_code='SURCHARGE'").bind(id),
    ];
    if(surcharge>0)statements.push(env.DB.prepare("INSERT INTO quotation_charges(id,quotation_id,charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order,created_at) VALUES(?,?,'SURCHARGE','附加费',1,?,?,?,20,?)").bind(crypto.randomUUID(),id,surcharge,surcharge,exchangeRate,now));
    await env.DB.batch(statements);
    await writeAudit({request,action:"quote.edit",resourceType:"quotation",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{previousStatus:existing.status,newStatus,total,salespersonUserId:salesperson.id}});
    return{success:existing.status==="draft"?"报价信息已更新":"报价信息已更新；因内容发生变化，状态已恢复为报价草稿"};
  }
  if (intent === "status") {
    const id = valueOf(form, "id"), status = valueOf(form, "status");
    const quote = await env.DB.prepare("SELECT status,customer_id,quote_number FROM quotations WHERE id = ? AND organization_id = ?").bind(id, current.organizationId).first<{ status: string; customer_id:string; quote_number:string }>();
    const isOfflineAcceptance=status==="accepted"&&["draft","sent"].includes(quote?.status||"");
    if (!quote || !["sent","accepted","cancelled"].includes(status) || (!isOfflineAcceptance&&!canTransition("quote", quote.status, status))) return { formError: "报价状态流转无效" };
    const statements=[env.DB.prepare("UPDATE quotations SET status = ?, accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END, updated_at = ? WHERE id = ? AND organization_id = ?").bind(status,status,now,now,id,current.organizationId)];
    if(status==="sent")statements.push(env.DB.prepare("INSERT INTO portal_notifications(id,organization_id,customer_id,user_id,type,title,message,link,is_read,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)").bind(crypto.randomUUID(),current.organizationId,quote.customer_id,null,"quote","新报价待确认",`报价 ${quote.quote_number} 已发布，请确认接受或拒绝。`,"/portal/orders",now));
    await env.DB.batch(statements);
    if(status==="accepted")await recordWorkflowEvent({organizationId:current.organizationId,event:"quote.accepted",customerId:quote.customer_id,quotationId:id,actorUserId:current.userId,source:"admin",metadata:{confirmationMethod:"offline"}});
    await writeAudit({ request, action: "quote.status", resourceType: "quotation", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { from: quote.status, to: status } });
    return { success: status==="sent"?"报价已发布到客户门户，等待客户确认":status==="accepted"?"价格已确认，可在新增订单中选择该报价":"报价已作废" };
  }
  const customerId = valueOf(form, "customerId"), opportunityId = valueOf(form, "opportunityId"), salespersonUserId=valueOf(form,"salespersonUserId"), roadLoadType=valueOf(form,"roadLoadType"), originCountry = valueOf(form, "originCountry"), originCity = valueOf(form, "originCity"), destinationCountry = valueOf(form, "destinationCountry"), destinationCity = valueOf(form, "destinationCity"), mode = valueOf(form, "mode"), service = valueOf(form, "service"), cargo = valueOf(form, "cargo"), currency = "CNY", validUntil = valueOf(form, "validUntil"), notes = valueOf(form, "notes"), chargeName = valueOf(form, "chargeName") || "汽运运费";
  const pieces = Number(valueOf(form, "pieces") || 1), weight = Number(valueOf(form, "weight") || 0), volume = Number(valueOf(form, "volume") || 0), quantity = Number(valueOf(form, "quantity") || 1), unitPrice = Number(valueOf(form, "unitPrice") || 0), exchangeRate = 1, freight = quantity * unitPrice, surcharge = Number(valueOf(form, "surcharge") || 0);
  if (!(await env.DB.prepare("SELECT 1 FROM customers WHERE id = ? AND organization_id = ? AND status = 'active'").bind(customerId, current.organizationId).first())) return { formError: "请选择有效客户" };
  const salesperson=await findActiveSalesperson(current.organizationId,salespersonUserId);
  if(!salesperson)return{formError:"业务员为必填项，请从启用用户中选择"};
  if (opportunityId && !(await env.DB.prepare("SELECT 1 FROM sales_opportunities WHERE id = ? AND organization_id = ?").bind(opportunityId, current.organizationId).first())) return { formError: "关联商机无效" };
  if (!['ftl','ltl'].includes(roadLoadType) || !originCity || !destinationCity || !cargo || !mode || !chargeName || !Number.isInteger(pieces) || pieces < 1 || !Number.isFinite(quantity) || quantity <= 0 || [weight, volume, unitPrice, surcharge].some(value => !Number.isFinite(value) || value < 0)) return { formError: "请填写完整路线、货物和有效费用" };
  const subtotal = freight + surcharge, tax = 0, total = subtotal, id = crypto.randomUUID(), number = await nextDocumentNumber(current.organizationId, "quote");
  const statements = [
    env.DB.prepare(`INSERT INTO quotations (id, organization_id, quote_number, customer_id, opportunity_id, salesperson_user_id, origin_country, origin_city, destination_country, destination_city, transport_mode, road_load_type, service_level, cargo_description, pieces, gross_weight_kg, volume_cbm, currency, subtotal, tax_amount, total_amount, valid_until, notes, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, current.organizationId, number, customerId, opportunityId || null, salesperson.id, originCountry, originCity, destinationCountry, destinationCity, mode, roadLoadType, service || null, cargo, pieces, weight, volume, currency, subtotal, tax, total, validUntil || null, notes || null, current.userId, now, now),
    env.DB.prepare("INSERT INTO quotation_charges (id, quotation_id, charge_code, description, quantity, unit_price, amount, exchange_rate, sort_order, created_at) VALUES (?, ?, 'FREIGHT', ?, ?, ?, ?, ?, 10, ?)").bind(crypto.randomUUID(), id, chargeName, quantity, unitPrice, freight, exchangeRate, now),
  ];
  if (surcharge > 0) statements.push(env.DB.prepare("INSERT INTO quotation_charges (id, quotation_id, charge_code, description, quantity, unit_price, amount, exchange_rate, sort_order, created_at) VALUES (?, ?, 'SURCHARGE', '附加费', 1, ?, ?, ?, 20, ?)").bind(crypto.randomUUID(), id, surcharge, surcharge, exchangeRate, now));
  await env.DB.batch(statements);
  await recordWorkflowEvent({ organizationId: current.organizationId, event: "customer.ready", customerId, quotationId: id, actorUserId: current.userId, source: "admin" });
  await recordWorkflowEvent({ organizationId: current.organizationId, event: "quote.created", customerId, quotationId: id, actorUserId: current.userId, source: "admin", metadata: { number, total } });
  await writeAudit({ request, action: "quote.create", resourceType: "quotation", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { number, total, salespersonUserId:salesperson.id } });
  return { success: `报价 ${number} 已创建` };
}

function reference(organizationId: string, category: string) { return env.DB.prepare("SELECT code, name FROM reference_data WHERE organization_id = ? AND category = ? AND status = 'active' ORDER BY sort_order, code").bind(organizationId, category).all<{ code: string; name: string }>(); }
function geoReference(organizationId:string,category:"province"|"city"){return env.DB.prepare("SELECT code,name,parent_code FROM reference_data WHERE organization_id=? AND category=? AND status='active' ORDER BY sort_order,code").bind(organizationId,category).all<GeoReference>();}
function findActiveSalesperson(organizationId:string,userId:string){return env.DB.prepare("SELECT u.id,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND u.status='active'").bind(organizationId,userId).first<{id:string;display_name:string}>();}
export function meta() { return [{ title: "询价报价 | International TMS" }]; }
const statusLabels: Record<string, string> = { draft: "报价草稿", sent: "待客户确认", accepted: "客户已接受", rejected: "客户已拒绝", expired: "已过期", cancelled: "已作废" };
const quotationTransportModes: [string,string][] = [
  ["ROAD","汽运"],
  ["RAIL","铁运"],
  ["AIR","空运"],
];
const receivableChargeNames: [string,string][] = [
  ["陆运费","陆运费"],
  ["国内汽运费","国内汽运费"],
  ["国外段汽运费","国外段汽运费"],
  ["铁路运费","铁路运费"],
  ["内贸海运费","内贸海运费"],
  ["内贸铁路运费","内贸铁路运费"],
  ["汽运运费","汽运运费"],
  ["押运费","押运费"],
];

export default function Quotations({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle", manage = loaderData.current.permissions.includes("quote.manage");
  return <>
    <header className="page-header"><div><p className="eyebrow">QUOTATION</p><h1>询价与报价</h1><p>按客户、路线、货量和服务生成标准运输报价。</p></div><span className="status-pill">{loaderData.quotes.length} 份报价</span></header>
    {(actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`}>{actionData.formError ?? actionData.success}</div>}
    {loaderData.inquiries.length>0&&<section className="panel"><div className="panel-header"><div><h2>客户询价</h2><p>门户试算后提交的正式询价。</p></div><span className="status-pill">{loaderData.inquiries.filter(i=>i.status==="submitted").length} 待处理</span></div><div className="table-wrap"><table><thead><tr><th>询价号/客户</th><th>产品与线路</th><th>货物</th><th>试算价格</th><th>状态</th><th>操作</th></tr></thead><tbody>{loaderData.inquiries.map(i=><tr key={i.id}><td><strong>{i.inquiry_number}</strong><small>{i.customer_name}</small></td><td><strong>{i.product_name||"产品已下架"}</strong><small>{i.origin_country} {i.origin_city||""} → {i.destination_country} {i.destination_city||""}</small></td><td><strong>{i.cargo_description}</strong><small>{i.pieces} 件 · {i.gross_weight_kg} KG · {i.volume_cbm} CBM</small></td><td><strong>{i.estimated_currency} {i.estimated_total.toLocaleString()}</strong><small>{i.customer_notes||"无备注"}</small></td><td><span className={`status-pill ${i.status==="cancelled"?"off":""}`}>{i.status==="submitted"?"待报价":i.status==="quoted"?"已报价":i.status==="quoting"?"处理中":"已取消"}</span></td><td>{manage&&i.status!=="cancelled"&&<Modal title={`为 ${i.inquiry_number} 生成正式报价`} triggerLabel={i.status==="quoted"?"新版本":"生成报价"} triggerClassName="text-button" closeSignal={actionData?.success} size="wide"><InquiryQuoteForm inquiry={i} loaderData={loaderData} busy={busy}/></Modal>}</td></tr>)}</tbody></table></div></section>}
    {manage&&<details className="panel expandable quotation-create-panel" open={loaderData.quotes.length===0}><summary>创建报价</summary><QuotationCreateForm loaderData={loaderData} busy={busy}/></details>}
    <section className="panel"><div className="table-wrap"><table><thead><tr><th>报价号/客户</th><th>业务员</th><th>路线</th><th>货物</th><th>费用</th><th>有效期</th><th>状态</th><th>操作</th></tr></thead><tbody>{loaderData.quotes.map(q=><tr key={q.id}><td><strong>{q.quote_number}{q.inquiry_number?` · V${q.version_number}`:""}</strong><small>{q.customer_name}{q.inquiry_number?` · ${q.inquiry_number}`:""}</small></td><td><strong>{q.salesperson_name||"未指定"}</strong></td><td><strong>{q.origin_country} {q.origin_city} → {q.destination_country} {q.destination_city}</strong><small>{q.transport_mode} · {q.service_level||"标准"}</small></td><td><strong>{q.cargo_description}</strong><small>{q.pieces} 件 · {q.gross_weight_kg} KG · {q.volume_cbm} CBM</small></td><td><strong>{q.currency} {q.total_amount.toLocaleString()}</strong><small>{q.charges||"—"}</small></td><td>{q.valid_until||"—"}</td><td><span className={`status-pill ${q.status==="cancelled"?"off":""}`}>{statusLabels[q.status]||q.status}</span></td><td><QuoteActions quote={q} manage={manage} busy={busy} loaderData={loaderData} closeSignal={actionData?.success}/></td></tr>)}</tbody></table></div></section>
  </>;
}

function QuotationCreateForm({loaderData,busy}:{loaderData:Route.ComponentProps["loaderData"];busy:boolean}){
  return <Form method="post" className="quotation-entry-form">
    <input type="hidden" name="intent" value="create"/>
    <Select label="客户" name="customerId" items={loaderData.customers.map(item=>[item.id,`${item.code} · ${item.name}`])}/>
    <Select label="业务员（销售员）" name="salespersonUserId" items={salespersonItems(loaderData.users)}/>
    <Select label="关联商机" name="opportunityId" optional items={loaderData.opportunities.map(item=>[item.id,item.name])}/>
    <Select label="运输方式" name="mode" items={quotationTransportModes}/>
    <Select label="汽运方案" name="roadLoadType" defaultValue="ltl" items={[["ltl","拼车"],["ftl","整车"]]}/>
    <Select label="服务等级" name="service" optional items={loaderData.services.map(item=>[item.code,item.name])}/>
    <RouteLocationFields countries={loaderData.countries} provinces={loaderData.provinces} cities={loaderData.cities}/>
    <label className="field quotation-cargo"><span>货物描述</span><textarea name="cargo" rows={2} required/></label>
    <Num label="件数" name="pieces" value="1"/>
    <Num label="毛重（KG）" name="weight"/>
    <Num label="体积（CBM）" name="volume" step="0.001"/>
    <Select label="应收费用名称" name="chargeName" defaultValue="汽运运费" items={receivableChargeNames}/>
    <Num label="数量" name="quantity" value="1" step="0.0001"/>
    <Num label="单价" name="unitPrice" step="0.01"/>
    <Num label="应收附加费" name="surcharge" step="0.01"/>
    <label className="field"><span>有效期至</span><input name="validUntil" type="date"/></label>
    <label className="field quotation-notes"><span>备注</span><input name="notes"/></label>
    <button className="primary quotation-submit" disabled={busy}>生成报价</button>
  </Form>;
}

function InquiryQuoteForm({inquiry,loaderData,busy}:{inquiry:Inquiry;loaderData:Route.ComponentProps["loaderData"];busy:boolean}){
  return <Form method="post" className="quotation-dialog-form">
    <input type="hidden" name="intent" value="quoteInquiry"/><input type="hidden" name="inquiryId" value={inquiry.id}/>
    <Select label="业务员（销售员）" name="salespersonUserId" items={salespersonItems(loaderData.users)}/>
    <Select label="汽运方案" name="roadLoadType" defaultValue="ltl" items={[["ltl","拼车"],["ftl","整车"]]}/>
    <CitySelect label="起运城市" name="originCity" country={inquiry.origin_country} defaultValue={inquiry.origin_city||""} provinces={loaderData.provinces} cities={loaderData.cities}/>
    <CitySelect label="目的城市" name="destinationCity" country={inquiry.destination_country} defaultValue={inquiry.destination_city||""} provinces={loaderData.provinces} cities={loaderData.cities}/>
    <Select label="应收费用名称" name="chargeName" defaultValue="汽运运费" items={receivableChargeNames}/>
    <Num label="数量" name="quantity" value="1" step="0.0001"/>
    <Num label="单价" name="unitPrice" value={String(inquiry.estimated_total)} step="0.01"/><Num label="应收附加费" name="surcharge" step="0.01"/>
    <label className="field"><span>有效期至</span><input name="validUntil" type="date" required/></label>
    <label className="field quotation-dialog-notes"><span>报价条款</span><input name="notes" defaultValue={inquiry.customer_notes||""}/></label>
    <button className="primary" disabled={busy}>发布到客户门户</button>
  </Form>;
}

function QuoteActions({quote,manage,busy,loaderData,closeSignal}:{quote:Quote;manage:boolean;busy:boolean;loaderData:Route.ComponentProps["loaderData"];closeSignal?:unknown}){
  const canPublish=manage&&quote.status==="draft";
  const canAccept=manage&&(quote.status==="draft"||quote.status==="sent");
  const canCancel=manage&&(quote.status==="draft"||quote.status==="sent");
  return <div className="quote-status-actions">
    <Modal title={`查看报价 · ${quote.quote_number}`} triggerLabel="查看" triggerClassName="text-button" size="wide"><QuoteView quote={quote}/></Modal>
    {manage&&<Modal title={`编辑报价 · ${quote.quote_number}`} triggerLabel="编辑" triggerClassName="text-button" closeSignal={closeSignal} size="wide">{quote.status==="cancelled"?<div className="alert error">已作废报价只能查看，不能编辑。</div>:<QuoteEditForm quote={quote} loaderData={loaderData} busy={busy}/>}</Modal>}
    {canPublish&&<Form method="post"><input type="hidden" name="intent" value="status"/><input type="hidden" name="id" value={quote.id}/><input type="hidden" name="status" value="sent"/><button className="text-button" disabled={busy}>发布到客户门户</button></Form>}
    {canAccept&&<Form method="post" onSubmit={event=>{if(!window.confirm("确认客户已经接受该报价和价格吗？"))event.preventDefault();}}><input type="hidden" name="intent" value="status"/><input type="hidden" name="id" value={quote.id}/><input type="hidden" name="status" value="accepted"/><button className="text-button" disabled={busy}>确认价格</button></Form>}
    {canCancel&&<Form method="post" onSubmit={event=>{if(!window.confirm("确认作废这份报价吗？作废后不能继续流转。"))event.preventDefault();}}><input type="hidden" name="intent" value="status"/><input type="hidden" name="id" value={quote.id}/><input type="hidden" name="status" value="cancelled"/><button className="text-button danger" disabled={busy}>作废</button></Form>}
    {!canPublish&&!canAccept&&!canCancel&&<span>—</span>}
  </div>;
}

function QuoteView({quote}:{quote:Quote}){
  const rows=[["客户",quote.customer_name],["业务员（销售员）",quote.salesperson_name||"未指定"],["路线",`${quote.origin_country} ${quote.origin_city} → ${quote.destination_country} ${quote.destination_city}`],["运输方式",quotationTransportModes.find(item=>item[0]===quote.transport_mode)?.[1]||quote.transport_mode],["汽运方案",quote.road_load_type==="ftl"?"整车":"拼车"],["货物",quote.cargo_description],["数量",`${quote.pieces} 件 · ${quote.gross_weight_kg} KG · ${quote.volume_cbm} CBM`],["应收费用",quote.charges||"—"],["报价总额",`${quote.currency} ${quote.total_amount.toLocaleString()}`],["有效期",quote.valid_until||"未指定"],["状态",statusLabels[quote.status]||quote.status],["备注",quote.notes||"—"]];
  return <dl className="quote-detail-grid">{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function QuoteEditForm({quote,loaderData,busy}:{quote:Quote;loaderData:Route.ComponentProps["loaderData"];busy:boolean}){
  return <Form method="post" className="quotation-dialog-form">
    <input type="hidden" name="intent" value="edit"/><input type="hidden" name="id" value={quote.id}/>
    <Select label="客户" name="customerId" defaultValue={quote.customer_id} items={loaderData.customers.map(item=>[item.id,`${item.code} · ${item.name}`])}/>
    <Select label="业务员（销售员）" name="salespersonUserId" defaultValue={quote.salesperson_user_id||""} items={salespersonItems(loaderData.users,quote)}/>
    <Select label="运输方式" name="mode" defaultValue={quote.transport_mode} items={quotationTransportModes}/>
    <Select label="汽运方案" name="roadLoadType" defaultValue={quote.road_load_type} items={[["ltl","拼车"],["ftl","整车"]]}/>
    <RouteLocationFields countries={loaderData.countries} provinces={loaderData.provinces} cities={loaderData.cities} initialOriginCountry={quote.origin_country} initialOriginCity={quote.origin_city} initialDestinationCountry={quote.destination_country} initialDestinationCity={quote.destination_city}/>
    <label className="field quotation-dialog-notes"><span>货物描述</span><textarea name="cargo" rows={2} defaultValue={quote.cargo_description} required/></label>
    <Num label="件数" name="pieces" value={String(quote.pieces)}/><Num label="毛重（KG）" name="weight" value={String(quote.gross_weight_kg)} step="0.001"/><Num label="体积（CBM）" name="volume" value={String(quote.volume_cbm)} step="0.001"/>
    <Select label="应收费用名称" name="chargeName" defaultValue={quote.charge_name||"汽运运费"} items={receivableChargeNames}/>
    <Num label="数量" name="quantity" value={String(quote.charge_quantity||1)} step="0.0001"/><Num label="单价" name="unitPrice" value={String(quote.charge_unit_price||0)} step="0.01"/><Num label="应收附加费" name="surcharge" value={String(quote.surcharge||0)} step="0.01"/>
    <label className="field"><span>有效期至</span><input name="validUntil" type="date" defaultValue={quote.valid_until||""}/></label><label className="field quotation-dialog-notes"><span>备注</span><input name="notes" defaultValue={quote.notes||""}/></label>
    {quote.status!=="draft"&&<div className="alert span-2">修改已确认或已发布报价后，报价会恢复为草稿，需要重新确认。</div>}
    <button className="primary" disabled={busy}>保存修改</button>
  </Form>;
}

function RouteLocationFields({countries,provinces,cities,initialOriginCountry="",initialOriginCity="",initialDestinationCountry="",initialDestinationCity=""}:{countries:{code:string;name:string}[];provinces:GeoReference[];cities:GeoReference[];initialOriginCountry?:string;initialOriginCity?:string;initialDestinationCountry?:string;initialDestinationCity?:string}){
  const [originCountry,setOriginCountry]=useState(initialOriginCountry);
  const [destinationCountry,setDestinationCountry]=useState(initialDestinationCountry);
  return <>
    <label className="field"><span>起运国家</span><select name="originCountry" value={originCountry} onChange={event=>setOriginCountry(event.target.value)} required><option value="">请选择国家/地区</option>{countries.map(item=><option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label>
    <CitySelect label="起运城市" name="originCity" country={originCountry} defaultValue={initialOriginCity} provinces={provinces} cities={cities}/>
    <label className="field"><span>目的国家</span><select name="destinationCountry" value={destinationCountry} onChange={event=>setDestinationCountry(event.target.value)} required><option value="">请选择国家/地区</option>{countries.map(item=><option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label>
    <CitySelect label="目的城市" name="destinationCity" country={destinationCountry} defaultValue={initialDestinationCity} provinces={provinces} cities={cities}/>
  </>;
}

function CitySelect({label,name,country,defaultValue="",provinces,cities}:{label:string;name:string;country:string;defaultValue?:string;provinces:GeoReference[];cities:GeoReference[]}){
  const provinceNames=new Map(provinces.map(item=>[item.code,item.name]));
  const provinceCodes=new Set(provinces.filter(item=>item.parent_code===country).map(item=>item.code));
  const options=cities.filter(item=>item.parent_code&&provinceCodes.has(item.parent_code));
  const hasDefault=options.some(item=>item.name===defaultValue);
  return <label className="field"><span>{label}</span><select name={name} defaultValue={defaultValue} disabled={!country} required><option value="">{country?"请选择城市":"请先选择国家"}</option>{defaultValue&&!hasDefault&&<option value={defaultValue}>{defaultValue} · 历史值</option>}{options.map(item=><option key={item.code} value={item.name}>{provinceNames.get(item.parent_code||"")||""} · {item.name}</option>)}</select></label>;
}

function salespersonItems(users:SalespersonOption[],quote?:Quote):[string,string][]{const items:[string,string][]=users.map(user=>[user.id,`${user.display_name} · ${user.email}`]);if(quote?.salesperson_user_id&&!items.some(([id])=>id===quote.salesperson_user_id))items.push([quote.salesperson_user_id,`${quote.salesperson_name||"原业务员"} · 已停用`]);return items;}
function Select({ label, name, items, optional,defaultValue }: { label: string; name: string; items: [string, string][]; optional?: boolean;defaultValue?:string }) { return <label className="field"><span>{label}{!optional&&<b className="required-mark">*</b>}</span><select name={name} required={!optional} defaultValue={defaultValue||""}><option value="">{optional ? "未指定" : "请选择"}</option>{items.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>; }
function Num({ label, name, value = "0", step = "1" }: { label: string; name: string; value?: string; step?: string }) { return <label className="field"><span>{label}</span><input name={name} type="number" min="0" step={step} defaultValue={value} required/></label>; }
