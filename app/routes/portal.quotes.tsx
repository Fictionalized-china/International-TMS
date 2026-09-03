import { env } from "cloudflare:workers";
import { useNavigation } from "react-router";
import type { Route } from "./+types/portal.quotes";
import { PortalForm as Form, PortalLink as Link } from "../components/PortalNavigation";
import { Modal } from "../components/Modal";
import { acceptQuotation, withdrawQuotationAcceptance } from "../lib/quotation-lifecycle.server";
import { requirePortalCustomer } from "../lib/portal.server";
import { valueOf } from "../lib/validation";
import { ConfirmAction } from "../components/ConfirmAction";
import {
  listQuotationWorkflowFields,
  listQuotationWorkflowFieldValues,
  listQuotationWorkflowInstanceFields,
} from "../lib/quotation-workflow-fields.server";
import {
  activeQuotationCustomWorkflowFields,
  quotationWorkflowFieldPolicy,
  quotationWorkflowDisplayValue,
} from "../lib/quotation-workflow-fields";
import type { QuotationNativeFieldKey } from "../lib/quotation-native-field-catalog";

type Quote = {
  id: string;
  quote_number: string;
  customer_name: string;
  customer_contact_name: string | null;
  customer_contact_phone: string | null;
  salesperson_name: string | null;
  workflow_definition_id: string | null;
  workflow_name: string | null;
  workflow_version_number: number | null;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  pickup_address: string | null;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  destination_warehouse_name: string | null;
  destination_warehouse_note: string | null;
  customs_clearance_mode: "company" | "customer";
  road_load_type: "ftl" | "ltl";
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  estimated_length_cm: number;
  estimated_width_cm: number;
  estimated_height_cm: number;
  total_amount: number;
  valid_until: string | null;
  notes: string | null;
  lifecycle_status: "pending" | "accepted" | "withdrawn" | "void";
  order_id: string | null;
  order_number: string | null;
  order_status: string | null;
  current_step_code: string | null;
  created_at: string;
};

type Charge = {
  quotation_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  sort_order: number;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const url = new URL(request.url);
  const requestedLifecycle = url.searchParams.get("status");
  const lifecycle = requestedLifecycle === null ? "pending" : requestedLifecycle;
  const quotationId = url.searchParams.get("quote")?.trim() || "";
  const params: unknown[] = [user.organizationId, customer.id];
  let where = "q.organization_id=? AND q.customer_id=?";
  if (["pending", "accepted", "withdrawn", "void"].includes(lifecycle)) {
    where += " AND q.lifecycle_status=?";
    params.push(lifecycle);
  }
  const orderParams: unknown[] = [];
  const orderBy = quotationId
    ? "CASE WHEN q.id=? THEN 0 ELSE 1 END,q.created_at DESC"
    : "q.created_at DESC";
  if (quotationId) orderParams.push(quotationId);
  const [quoteRows, chargeRows] = await Promise.all([
    env.DB.prepare(
      `SELECT q.id,q.quote_number,c.name customer_name,q.customer_contact_name,q.customer_contact_phone,
        u.display_name salesperson_name,q.workflow_definition_id,wd.name workflow_name,wd.version_number workflow_version_number,
        q.origin_country,q.origin_state,q.origin_city,q.pickup_address,
        q.destination_country,q.destination_state,q.destination_city,w.name destination_warehouse_name,
        q.destination_warehouse_note,q.customs_clearance_mode,q.road_load_type,q.cargo_description,
        q.pieces,q.gross_weight_kg,q.volume_cbm,q.estimated_length_cm,q.estimated_width_cm,
        q.estimated_height_cm,q.total_amount,q.valid_until,q.notes,q.lifecycle_status,
        o.id order_id,o.order_number,o.status order_status,o.current_step_code,q.created_at
       FROM quotations q
       JOIN customers c ON c.id=q.customer_id AND c.organization_id=q.organization_id
       LEFT JOIN users u ON u.id=q.salesperson_user_id
       LEFT JOIN workflow_definitions wd ON wd.id=q.workflow_definition_id AND wd.organization_id=q.organization_id
       LEFT JOIN warehouses w ON w.id=q.destination_warehouse_id AND w.organization_id=q.organization_id
       LEFT JOIN transport_orders o ON o.organization_id=q.organization_id AND o.quotation_id=q.id
       WHERE ${where}
       ORDER BY ${orderBy}`,
    ).bind(...params, ...orderParams).all<Quote>(),
    env.DB.prepare(
      `SELECT qc.quotation_id,qc.description,qc.quantity,qc.unit_price,qc.amount,qc.sort_order
       FROM quotation_charges qc
       JOIN quotations q ON q.id=qc.quotation_id
       WHERE q.organization_id=? AND q.customer_id=?
       ORDER BY qc.quotation_id,qc.sort_order,qc.id`,
    ).bind(user.organizationId, customer.id).all<Charge>(),
  ]);
  const charges = new Map<string, Charge[]>();
  for (const charge of chargeRows.results) {
    charges.set(charge.quotation_id, [...(charges.get(charge.quotation_id) || []), charge]);
  }
  const [workflowFields,quotationWorkflowFields,workflowValues] = await Promise.all([
    listQuotationWorkflowFields(user.organizationId),
    listQuotationWorkflowInstanceFields(
      user.organizationId,
      quoteRows.results.map((quote) => quote.id),
    ),
    listQuotationWorkflowFieldValues(
      user.organizationId,
      quoteRows.results.map((quote) => quote.id),
    ),
  ]);
  return {
    quotes: quoteRows.results,
    charges: Object.fromEntries(charges),
    lifecycle,
    quotationId,
    workflowFields,
    quotationWorkflowFields,
    workflowValues,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const quotationId = valueOf(form, "id");
  if (!quotationId) return { formError: "缺少报价编号" };
  const owned = await env.DB.prepare(
    "SELECT id FROM quotations WHERE id=? AND organization_id=? AND customer_id=? LIMIT 1",
  ).bind(quotationId, user.organizationId, customer.id).first<{ id: string }>();
  if (!owned) return { formError: "报价不存在或不属于当前客户" };
  try {
    if (intent === "accept") {
      const result = await acceptQuotation({
        organizationId: user.organizationId,
        quotationId,
        actorUserId: user.userId,
        source: "portal",
        request,
      });
      return { success: `报价已接受，系统已${result.created ? "自动创建" : "恢复"}订单 ${result.orderNumber}，入仓唛头已生成` };
    }
    if (intent === "withdraw") {
      const result = await withdrawQuotationAcceptance({
        organizationId: user.organizationId,
        quotationId,
        actorUserId: user.userId,
        source: "portal",
      });
      return { success: `报价接受已撤回，订单 ${result.orderNumber || ""} 已保留` };
    }
    return { formError: "不支持的报价操作" };
  } catch (error) {
    return { formError: error instanceof Error ? error.message : String(error) };
  }
}

export default function PortalQuotes({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <div className="page prototype-page">
      <div className="breadcrumb">客户门户 / 报价确认</div>
      <header className="page-head">
        <div><h1>报价确认</h1><p>查看完整运输条件与费用，接受后系统自动生成唯一订单。</p></div>
      </header>
      {(actionData?.success || actionData?.formError) && (
        <div className={`alert ${actionData.formError ? "error" : "success"}`} role="alert">{actionData.formError || actionData.success}</div>
      )}
      {loaderData.quotationId && !actionData?.success && (
        <div className="alert portal-quote-focus-notice" role="status">
          <span>已定位从首页选择的报价；本页同时显示当前客户的全部待确认报价。</span>
          <Link className="btn small" to="/portal/quotes?status=pending">取消定位</Link>
        </div>
      )}
      <Form method="get" action="." className="filters quotation-filters">
        <label className="field"><span>报价状态</span><select className="control filled" name="status" defaultValue={loaderData.lifecycle}><option value="">全部</option><option value="pending">待确认</option><option value="accepted">已接受</option><option value="withdrawn">接受已撤回</option><option value="void">已作废</option></select></label>
        <button className="btn primary">筛选</button>
      </Form>
      <section className="table-panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>报价</th><th>运输方案</th><th>线路与目的仓</th><th>货物</th><th>费用</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {loaderData.quotes.map((quote) => {
                const snapshotFields=loaderData.quotationWorkflowFields.filter(field=>field.quotation_id===quote.id);
                const fields=snapshotFields.length?snapshotFields:loaderData.workflowFields.filter(field=>field.workflow_id===quote.workflow_definition_id);
                const visible=(key:QuotationNativeFieldKey,fallback:"required"|"optional")=>quotationWorkflowFieldPolicy(fields,key,fallback).isActive;
                const measures=[
                  visible("quotation_pieces","required")?`${quote.pieces} 件`:null,
                  visible("quotation_gross_weight_kg","required")?`${quote.gross_weight_kg} KG`:null,
                  visible("quotation_volume_cbm","required")?`${quote.volume_cbm} CBM`:null,
                ].filter(Boolean).join(" · ");
                const dimensions=[
                  visible("quotation_length_cm","required")?quote.estimated_length_cm:null,
                  visible("quotation_width_cm","required")?quote.estimated_width_cm:null,
                  visible("quotation_height_cm","required")?quote.estimated_height_cm:null,
                ];
                return <tr key={quote.id} id={`quote-${quote.id}`} className={loaderData.quotationId === quote.id ? "portal-quote-focus-row" : undefined}>
                  <td><b className="order-id">{quote.quote_number}</b><small className="subline">{new Date(quote.created_at).toLocaleString("zh-CN")}</small></td>
                  <td><span className={`pill ${quote.road_load_type === "ltl" ? "ltl" : ""}`}>{quote.road_load_type === "ltl" ? "拼车" : "整车"}</span>{visible("quotation_customs_clearance_mode","required")&&<small className="subline">汽运 · {quote.customs_clearance_mode === "company" ? "公司代办清关" : "客户自理清关"}</small>}</td>
                  <td>{(visible("quotation_origin_region","required")||visible("quotation_destination_region","required"))&&<b>{quote.origin_state || ""}{quote.origin_city} → {quote.destination_state || ""}{quote.destination_city}</b>}{visible("quotation_pickup_address","required")&&<small className="subline">提货：{quote.pickup_address || "未填写"}</small>}{visible("quotation_destination_warehouse_id","required")&&<small className="subline">目的仓：{quote.destination_warehouse_name || "未填写"}</small>}{visible("quotation_destination_warehouse_note","optional")&&quote.destination_warehouse_note&&<small className="subline">目的备注：{quote.destination_warehouse_note}</small>}</td>
                  <td>{visible("quotation_cargo_description","required")&&<b>{quote.cargo_description}</b>}{measures&&<small className="subline">{measures}</small>}{dimensions.some(value=>value!==null)&&<small className="subline">预计 {dimensions.map(value=>value??"—").join(" × ")} CM</small>}</td>
                  <td>{visible("quotation_charge_items","required")?<><b>CNY {quote.total_amount.toLocaleString()}</b><QuoteChargeSummary charges={loaderData.charges[quote.id] || []} /></>:<span className="subline">当前工作流不展示费用</span>}</td>
                  <td><span className={`status ${statusTone(quote.lifecycle_status)}`}>{statusLabel(quote.lifecycle_status)}</span>{visible("quotation_valid_until","optional")&&quote.valid_until && <small className="subline">有效期至 {quote.valid_until}</small>}{quote.order_id && <Link className="subline order-id" to="/portal/orders">订单 {quote.order_number}</Link>}</td>
                  <td><QuoteActions quote={quote} charges={loaderData.charges[quote.id] || []} fields={fields} values={loaderData.workflowValues.filter((value) => value.quotation_id === quote.id)} busy={busy} closeSignal={actionData?.success} /></td>
                </tr>;
              })}
              {!loaderData.quotes.length && <tr><td className="empty" colSpan={7}>{loaderData.quotationId ? "未找到该报价，报价可能已被删除或不属于当前客户。" : "暂无报价"}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function QuoteChargeSummary({ charges }: { charges: Charge[] }) {
  if (!charges.length) return <small className="subline">暂无费用明细</small>;
  return <details><summary>查看 {charges.length} 项费用</summary>{charges.map((charge) => <small className="subline" key={`${charge.sort_order}-${charge.description}`}>{charge.description}：{charge.quantity} × {charge.unit_price} = {charge.amount}</small>)}</details>;
}

function QuoteActions({ quote, charges, fields, values, busy, closeSignal }: {
  quote: Quote;
  charges: Charge[];
  fields: Awaited<ReturnType<typeof listQuotationWorkflowFields>>;
  values: Awaited<ReturnType<typeof listQuotationWorkflowFieldValues>>;
  busy: boolean;
  closeSignal?: unknown;
}) {
  const canAccept = quote.lifecycle_status === "pending" || quote.lifecycle_status === "withdrawn";
  const visible = (key: QuotationNativeFieldKey, fallback: "required" | "optional") =>
    quotationWorkflowFieldPolicy(fields, key, fallback).isActive;
  const route = [quote.origin_country, quote.origin_state, quote.origin_city].filter(Boolean).join(" ") +
    " → " + [quote.destination_country, quote.destination_state, quote.destination_city].filter(Boolean).join(" ");
  const dimensions = [quote.estimated_length_cm, quote.estimated_width_cm, quote.estimated_height_cm].join(" × ");
  const customFacts = activeQuotationCustomWorkflowFields(fields).map((field) => ({
    id: field.id,
    label: field.label,
    value: quotationWorkflowDisplayValue(
      field,
      values.find((value) => value.field_id === field.id || value.field_key === field.field_key) || null,
    ),
  }));
  return <Modal
    title={`报价详情 · ${quote.quote_number}`}
    triggerLabel={canAccept ? "查看并确认" : "查看详情"}
    triggerClassName={canAccept ? "btn primary" : "btn"}
    size="wide"
    dialogClassName="quote-review-modal"
    closeSignal={closeSignal}
  >
    <div className="quote-review-sheet">
      <header className="quote-review-hero">
        <div><span>{quote.road_load_type === "ltl" ? "拼车运输报价" : "整车运输报价"}</span><strong>{route}</strong><small>{quote.workflow_name ? `${quote.workflow_name} · v${quote.workflow_version_number}` : "历史报价"}</small></div>
        <div><span>报价总额</span><strong>CNY {quote.total_amount.toLocaleString()}</strong><small>{quote.valid_until ? `有效期至 ${quote.valid_until}` : "未设置有效期"}</small></div>
      </header>
      <div className="quote-review-sections">
        <section><h3>客户与服务</h3><div className="quote-review-facts">
          <QuoteReviewCell label="客户" value={quote.customer_name}/>
          {visible("quotation_salesperson_user_id","required") && <QuoteReviewCell label="业务员" value={quote.salesperson_name || "—"}/>}
          {visible("quotation_customer_contact_name","required") && <QuoteReviewCell label="联系人" value={quote.customer_contact_name || "—"}/>}
          {visible("quotation_customer_contact_phone","required") && <QuoteReviewCell label="联系电话" value={quote.customer_contact_phone || "—"}/>}
          {visible("quotation_customs_clearance_mode","required") && <QuoteReviewCell label="清关责任" value={quote.customs_clearance_mode === "company" ? "公司代办清关" : "客户自理清关"}/>}
        </div></section>
        <section><h3>运输路线</h3><div className="quote-review-facts">
          <QuoteReviewCell label="起运地区" value={[quote.origin_country, quote.origin_state, quote.origin_city].filter(Boolean).join(" ")}/>
          {visible("quotation_pickup_address","required") && <QuoteReviewCell label="提货地址" value={quote.pickup_address || "—"}/>}
          <QuoteReviewCell label="目的地区" value={[quote.destination_country, quote.destination_state, quote.destination_city].filter(Boolean).join(" ")}/>
          {visible("quotation_destination_warehouse_id","required") && <QuoteReviewCell label="目的仓" value={quote.destination_warehouse_name || "—"}/>}
          {visible("quotation_destination_warehouse_note","optional") && <QuoteReviewCell label="目的仓备注" value={quote.destination_warehouse_note || "—"}/>}
        </div></section>
        <section><h3>货物概况</h3><div className="quote-review-facts">
          {visible("quotation_cargo_description","required") && <QuoteReviewCell label="货物" value={quote.cargo_description || "—"}/>}
          {visible("quotation_pieces","required") && <QuoteReviewCell label="预计件数" value={`${quote.pieces} 件`}/>}
          {visible("quotation_gross_weight_kg","required") && <QuoteReviewCell label="预计重量" value={`${quote.gross_weight_kg} KG`}/>}
          {visible("quotation_volume_cbm","required") && <QuoteReviewCell label="预计体积" value={`${quote.volume_cbm} CBM`}/>}
          {(visible("quotation_length_cm","required") || visible("quotation_width_cm","required") || visible("quotation_height_cm","required")) && <QuoteReviewCell label="预计尺寸" value={`${dimensions} CM`}/>}
          {visible("quotation_notes","optional") && <QuoteReviewCell label="报价备注" value={quote.notes || "—"}/>}
        </div></section>
        <section><h3>费用明细</h3>{charges.length ? <div className="table-wrap"><table className="quote-review-charges"><thead><tr><th>费用名称</th><th>数量</th><th>单价</th><th>金额</th></tr></thead><tbody>{charges.map((charge) => <tr key={`${charge.sort_order}-${charge.description}`}><td>{charge.description}</td><td>{charge.quantity}</td><td>{charge.unit_price.toLocaleString()}</td><td><strong>{charge.amount.toLocaleString()}</strong></td></tr>)}</tbody><tfoot><tr><td colSpan={3}>合计</td><td><strong>CNY {quote.total_amount.toLocaleString()}</strong></td></tr></tfoot></table></div> : <p className="empty-state">当前报价没有费用明细。</p>}</section>
        {customFacts.length > 0 && <section className="span-2"><h3>其他报价信息</h3><div className="quote-review-facts">{customFacts.map((fact) => <QuoteReviewCell key={fact.id} label={fact.label} value={fact.value}/>)}</div></section>}
      </div>
      <footer className="quote-review-actions">
        <div><strong>{canAccept ? "请确认运输条件与费用后再接受" : statusLabel(quote.lifecycle_status)}</strong><span>{canAccept ? "接受后系统将生成唯一运输订单，并进入委托资料补充。" : quote.order_number ? `已生成订单 ${quote.order_number}` : "报价信息仅供查看。"}</span></div>
        {canAccept && <Form method="post"><input type="hidden" name="intent" value="accept"/><input type="hidden" name="id" value={quote.id}/><button className="btn primary" disabled={busy}>{quote.lifecycle_status === "withdrawn" ? "确认重新接受报价" : "确认接受报价"}</button></Form>}
        {quote.lifecycle_status === "accepted" && quote.order_status === "draft" && <Form method="post"><input type="hidden" name="intent" value="withdraw"/><input type="hidden" name="id" value={quote.id}/><ConfirmAction className="btn" title="撤回报价接受" description={`撤回后 ${quote.quote_number} 将恢复为可重新接受状态；已经生成的订单保留为草稿并留下审计记录。`} triggerLabel="撤回接受" confirmLabel="确认撤回" pending={busy}/></Form>}
      </footer>
    </div>
  </Modal>;
}

function QuoteReviewCell({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value || "—"}</strong></div>;
}

function statusLabel(status: Quote["lifecycle_status"]) {
  return { pending: "待确认", accepted: "已接受", withdrawn: "接受已撤回", void: "已作废" }[status];
}

function statusTone(status: Quote["lifecycle_status"]) {
  if (status === "accepted") return "green";
  if (status === "pending") return "orange";
  if (status === "void") return "red";
  return "blue";
}

export function meta() { return [{ title: "报价确认 | 新翎航客户门户" }]; }
