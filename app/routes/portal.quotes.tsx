import { env } from "cloudflare:workers";
import { useNavigation } from "react-router";
import type { Route } from "./+types/portal.quotes";
import { PortalForm as Form, PortalLink as Link } from "../components/PortalNavigation";
import { acceptQuotation, withdrawQuotationAcceptance } from "../lib/quotation-lifecycle.server";
import { requirePortalCustomer } from "../lib/portal.server";
import { valueOf } from "../lib/validation";
import { ConfirmAction } from "../components/ConfirmAction";

type Quote = {
  id: string;
  quote_number: string;
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
  const lifecycle = url.searchParams.get("status") || "";
  const params: unknown[] = [user.organizationId, customer.id];
  let where = "q.organization_id=? AND q.customer_id=?";
  if (["pending", "accepted", "withdrawn", "void"].includes(lifecycle)) {
    where += " AND q.lifecycle_status=?";
    params.push(lifecycle);
  }
  const [quoteRows, chargeRows] = await Promise.all([
    env.DB.prepare(
      `SELECT q.id,q.quote_number,q.origin_country,q.origin_state,q.origin_city,q.pickup_address,
        q.destination_country,q.destination_state,q.destination_city,w.name destination_warehouse_name,
        q.destination_warehouse_note,q.customs_clearance_mode,q.road_load_type,q.cargo_description,
        q.pieces,q.gross_weight_kg,q.volume_cbm,q.estimated_length_cm,q.estimated_width_cm,
        q.estimated_height_cm,q.total_amount,q.valid_until,q.lifecycle_status,
        o.id order_id,o.order_number,o.status order_status,o.current_step_code,q.created_at
       FROM quotations q
       LEFT JOIN warehouses w ON w.id=q.destination_warehouse_id AND w.organization_id=q.organization_id
       LEFT JOIN transport_orders o ON o.organization_id=q.organization_id AND o.quotation_id=q.id
       WHERE ${where}
       ORDER BY q.created_at DESC`,
    ).bind(...params).all<Quote>(),
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
  return { quotes: quoteRows.results, charges: Object.fromEntries(charges), lifecycle };
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
        <div className={`alert ${actionData.formError ? "error" : "success"}`}>{actionData.formError || actionData.success}</div>
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
              {loaderData.quotes.map((quote) => (
                <tr key={quote.id}>
                  <td><b className="order-id">{quote.quote_number}</b><small className="subline">{new Date(quote.created_at).toLocaleString("zh-CN")}</small></td>
                  <td><span className={`pill ${quote.road_load_type === "ltl" ? "ltl" : ""}`}>{quote.road_load_type === "ltl" ? "拼车" : "整车"}</span><small className="subline">汽运 · {quote.customs_clearance_mode === "company" ? "公司代办清关" : "客户自理清关"}</small></td>
                  <td><b>{quote.origin_state || ""}{quote.origin_city} → {quote.destination_state || ""}{quote.destination_city}</b><small className="subline">提货：{quote.pickup_address || "未填写"}</small><small className="subline">目的仓：{quote.destination_warehouse_name || "未填写"}{quote.destination_warehouse_note ? ` · ${quote.destination_warehouse_note}` : ""}</small></td>
                  <td><b>{quote.cargo_description}</b><small className="subline">{quote.pieces} 件 · {quote.gross_weight_kg} KG · {quote.volume_cbm} CBM</small><small className="subline">预计 {quote.estimated_length_cm} × {quote.estimated_width_cm} × {quote.estimated_height_cm} CM</small></td>
                  <td><b>CNY {quote.total_amount.toLocaleString()}</b><QuoteChargeSummary charges={loaderData.charges[quote.id] || []} /></td>
                  <td><span className={`status ${statusTone(quote.lifecycle_status)}`}>{statusLabel(quote.lifecycle_status)}</span>{quote.valid_until && <small className="subline">有效期至 {quote.valid_until}</small>}{quote.order_id && <Link className="subline order-id" to="/portal/orders">订单 {quote.order_number}</Link>}</td>
                  <td><QuoteActions quote={quote} busy={busy} /></td>
                </tr>
              ))}
              {!loaderData.quotes.length && <tr><td className="empty" colSpan={7}>暂无报价</td></tr>}
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

function QuoteActions({ quote, busy }: { quote: Quote; busy: boolean }) {
  if (quote.lifecycle_status === "pending" || quote.lifecycle_status === "withdrawn") {
    return <Form method="post"><input type="hidden" name="intent" value="accept"/><input type="hidden" name="id" value={quote.id}/><button className="btn primary" disabled={busy}>{quote.lifecycle_status === "withdrawn" ? "重新接受" : "接受报价"}</button></Form>;
  }
  if (quote.lifecycle_status === "accepted" && quote.order_status === "draft") {
    return <Form method="post"><input type="hidden" name="intent" value="withdraw"/><input type="hidden" name="id" value={quote.id}/><ConfirmAction className="btn" title="撤回报价接受" description={`撤回后 ${quote.quote_number} 将恢复为可重新接受状态；已经生成的订单保留为草稿并留下审计记录。`} triggerLabel="撤回接受" confirmLabel="确认撤回" pending={busy}/></Form>;
  }
  return quote.lifecycle_status === "accepted" ? <span className="subline">订单已进入业务流程</span> : <span className="subline">无可用操作</span>;
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
