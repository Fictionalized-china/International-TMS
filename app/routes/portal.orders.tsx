import { env } from "cloudflare:workers";
import type { Route } from "./+types/portal.orders";
import { PortalForm as Form, PortalLink as Link } from "../components/PortalNavigation";
import { OrderMarkLabelModal } from "../components/OrderMarkLabelModal";
import { PortalPickupAppointment } from "../components/PortalPickupAppointment";
import type { OrderMarkLabel } from "../lib/order-mark-label.server";
import { requirePortalCustomer } from "../lib/portal.server";

type PortalOrder = OrderMarkLabel & {
  quote_number: string | null;
  business_type: "ftl" | "ltl";
  current_step_name: string | null;
  exception_status: string | null;
  quote_withdrawn: number;
  created_at: string;
  overseas_operation_status: string | null;
  pickup_appointment_at: string | null;
  pickup_appointment_period: string | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("keyword") || "").trim();
  const status = url.searchParams.get("status") || "";
  const where = ["o.organization_id=?", "o.customer_id=?"];
  const values: unknown[] = [user.organizationId, customer.id];
  if (keyword) {
    where.push("(o.order_number LIKE ? OR q.quote_number LIKE ? OR o.cargo_description LIKE ?)");
    const pattern = `%${keyword}%`;
    values.push(pattern, pattern, pattern);
  }
  if (status) {
    where.push("o.status=?");
    values.push(status);
  }
  const rows = await env.DB.prepare(
    `SELECT o.id,o.order_number,c.name customer_name,q.quote_number,o.business_type,o.cargo_description,o.pieces,
      o.gross_weight_kg,o.volume_cbm,o.origin_country,o.origin_state,o.origin_city,o.destination_country,
      o.destination_state,o.destination_city,w.name overseas_warehouse_name,o.status,o.current_step_name,
      o.exception_status,o.created_at,
      op.status overseas_operation_status,op.appointment_at pickup_appointment_at,
      op.appointment_period pickup_appointment_period,
      CASE
        WHEN q.accepted_at IS NOT NULL THEN q.accepted_at
        WHEN o.quotation_id IS NULL AND o.status IN ('confirmed','in_execution','completed') THEN o.created_at
        ELSE ''
      END label_generated_at,o.quote_withdrawn
     FROM transport_orders o
     JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
     LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
     LEFT JOIN warehouses w ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
     LEFT JOIN overseas_warehouse_operations op ON op.id=(
       SELECT latest.id FROM overseas_warehouse_operations latest
       WHERE latest.organization_id=o.organization_id AND latest.order_id=o.id
         AND latest.status!='cancelled'
       ORDER BY latest.created_at DESC LIMIT 1
     )
     WHERE ${where.join(" AND ")}
     ORDER BY o.created_at DESC`,
  ).bind(...values).all<PortalOrder>();
  return {
    orders: rows.results,
    filters: { keyword, status },
    appointmentResult: url.searchParams.get("appointmentResult") || "",
    appointmentError: url.searchParams.get("appointmentError") || "",
  };
}

export default function PortalOrders({ loaderData }: Route.ComponentProps) {
  return (
    <div className="page prototype-page">
      <div className="breadcrumb">客户门户 / 我的订单</div>
      <header className="page-head"><div><h1>我的订单</h1><p>订单由已接受报价自动生成，可在此查看当前节点与运输状态。</p></div><Link className="btn primary" to="/portal/quotes">查看报价</Link></header>
      {loaderData.appointmentResult && <p className="alert success">{loaderData.appointmentResult}</p>}
      {loaderData.appointmentError && <p className="alert error">{loaderData.appointmentError}</p>}
      <Form method="get" action="." className="filters order-table-filters">
        <label className="field wide"><span>快速查找</span><input className="control" name="keyword" data-keyboard-search defaultValue={loaderData.filters.keyword} placeholder="订单号、报价号或货物"/></label>
        <label className="field"><span>订单状态</span><select className="control filled" name="status" defaultValue={loaderData.filters.status}><option value="">全部</option>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <button className="btn primary">筛选</button><Link className="btn" to="/portal/orders">重置</Link>
      </Form>
      <section className="table-panel">
        <div className="table-panel-head"><div><b>订单列表</b><span>业务办理由新翎航负责，客户门户仅显示真实进度。</span></div><span>{loaderData.orders.length} 单</span></div>
        <div className="table-wrap"><table><thead><tr><th>订单 / 报价</th><th>类型</th><th>货物</th><th>运输线路</th><th>当前节点</th><th>状态</th><th>查看</th></tr></thead><tbody>
          {loaderData.orders.map((order) => <tr key={order.id} className={order.status !== "completed" && order.exception_status && order.exception_status !== "normal" ? "row-alert" : ""}>
            <td><b className="order-id">{order.order_number}</b><small className="subline">{order.quote_number || "历史订单"}</small></td>
            <td><span className={`pill ${order.business_type === "ltl" ? "ltl" : ""}`}>{order.business_type === "ltl" ? "拼车" : "整车"}</span></td>
            <td><b>{order.cargo_description}</b><small className="subline">{order.pieces} 件 · {order.gross_weight_kg} KG · {order.volume_cbm} CBM</small></td>
            <td><b>{order.origin_state || ""}{order.origin_city} → {order.destination_state || ""}{order.destination_city}</b><small className="subline">{order.overseas_warehouse_name || "目的仓待补"}</small></td>
            <td>{order.current_step_name || "待同步"}</td>
            <td><span className={`status ${statusTone(order.status, order.exception_status)}`}>{statusLabel(order.status)}</span></td>
            <td><div className="portal-order-actions"><PortalPickupAppointment order={order} returnTo="/portal/orders"/><Link className="btn small" to={`/portal/tracking?order=${encodeURIComponent(order.order_number)}`}>查看轨迹</Link>{markLabelAvailable(order) && <OrderMarkLabelModal order={order} />}</div></td>
          </tr>)}
          {!loaderData.orders.length && <tr><td className="empty" colSpan={7}>暂无订单；接受有效报价后系统会自动创建。</td></tr>}
        </tbody></table></div>
      </section>
    </div>
  );
}

const statusOptions = [
  { value: "draft", label: "待补充委托资料" },
  { value: "submitted", label: "待审核" },
  { value: "confirmed", label: "已审核，待派单" },
  { value: "in_execution", label: "运输执行中" },
  { value: "completed", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];

function statusLabel(status: string) { return statusOptions.find((option) => option.value === status)?.label || status; }
function statusTone(status: string, exceptionStatus: string | null) {
  if (status === "completed") return "green";
  if (exceptionStatus && exceptionStatus !== "normal") return "red";
  if (status === "cancelled") return "red";
  if (["draft", "submitted"].includes(status)) return "orange";
  return "blue";
}

function markLabelAvailable(order: PortalOrder) {
  return Boolean(order.label_generated_at) && order.quote_withdrawn !== 1 && order.status !== "cancelled";
}

export function meta() { return [{ title: "我的订单 | 新翎航客户门户" }]; }
