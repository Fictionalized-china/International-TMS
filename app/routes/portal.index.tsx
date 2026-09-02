import { env } from "cloudflare:workers";
import type { Route } from "./+types/portal.index";
import { PortalLink as Link } from "../components/PortalNavigation";
import { OrderMarkLabelModal } from "../components/OrderMarkLabelModal";
import { PortalPickupAppointment } from "../components/PortalPickupAppointment";
import type { OrderMarkLabel } from "../lib/order-mark-label.server";
import { requirePortalCustomer } from "../lib/portal.server";
import { normalizePortalNotificationLink } from "../lib/portal-notification-links";

type Contact = { id: string; name: string; title: string | null; email: string | null; phone: string | null; is_primary: number };
type Address = { id: string; label: string; country_code: string; city: string; address_line1: string; is_default: number };
type RecentOrder = OrderMarkLabel & {
  quote_number: string | null;
  business_type: "ftl" | "ltl";
  current_step_name: string | null;
  exception_status: string | null;
  quote_withdrawn: number;
  updated_at: string;
  overseas_operation_status: string | null;
  pickup_appointment_at: string | null;
  pickup_appointment_period: string | null;
};
type PendingQuote = {
  id: string;
  quote_number: string;
  road_load_type: "ftl" | "ltl";
  cargo_description: string;
  origin_city: string;
  destination_city: string;
  total_amount: number;
  valid_until: string | null;
  created_at: string;
};
type Notice = { id: string; type: string; title: string; message: string; link: string | null; is_read: number; created_at: string };

export async function loader({ request }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const url = new URL(request.url);
  const [contacts, addresses, summary] = await Promise.all([
    env.DB.prepare("SELECT id,name,title,email,phone,is_primary FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC,name LIMIT 4").bind(customer.id).all<Contact>(),
    env.DB.prepare("SELECT id,label,country_code,city,address_line1,is_default FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,label LIMIT 4").bind(customer.id).all<Address>(),
    env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM transport_orders WHERE organization_id=? AND customer_id=? AND status NOT IN ('completed','cancelled')) orders,
        (SELECT COUNT(*) FROM shipments WHERE organization_id=? AND customer_id=? AND status NOT IN ('delivered','cancelled')) shipments,
        (SELECT COALESCE(SUM(total_amount-paid_amount),0) FROM invoices WHERE organization_id=? AND customer_id=? AND status IN ('issued','partially_paid','overdue')) outstanding,
        (SELECT COUNT(*) FROM quotations WHERE organization_id=? AND customer_id=? AND lifecycle_status='pending') pending_quotes`,
    ).bind(
      user.organizationId, customer.id,
      user.organizationId, customer.id,
      user.organizationId, customer.id,
      user.organizationId, customer.id,
    ).first<{ orders: number; shipments: number; outstanding: number; pending_quotes: number }>(),
  ]);
  const [recentOrders, pendingQuotes, notices, unread] = await Promise.all([
    env.DB.prepare(
      `SELECT o.id,o.order_number,c.name customer_name,q.quote_number,o.business_type,o.cargo_description,
              o.pieces,o.gross_weight_kg,o.volume_cbm,o.origin_country,o.origin_state,o.origin_city,
              o.destination_country,o.destination_state,o.destination_city,w.name overseas_warehouse_name,
              o.current_step_name,o.status,o.exception_status,o.updated_at,
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
        WHERE o.organization_id=? AND o.customer_id=?
        ORDER BY o.updated_at DESC LIMIT 8`,
    ).bind(user.organizationId, customer.id).all<RecentOrder>(),
    env.DB.prepare(
      `SELECT id,quote_number,road_load_type,cargo_description,origin_city,destination_city,
              total_amount,valid_until,created_at
         FROM quotations
        WHERE organization_id=? AND customer_id=? AND lifecycle_status='pending'
        ORDER BY created_at DESC LIMIT 8`,
    ).bind(user.organizationId, customer.id).all<PendingQuote>(),
    env.DB.prepare("SELECT id,type,title,message,link,is_read,created_at FROM portal_notifications WHERE organization_id=? AND customer_id=? AND (user_id IS NULL OR user_id=?) ORDER BY created_at DESC LIMIT 6").bind(user.organizationId, customer.id, user.userId).all<Notice>(),
    env.DB.prepare("SELECT COUNT(*) count FROM portal_notifications WHERE organization_id=? AND customer_id=? AND (user_id IS NULL OR user_id=?) AND is_read=0").bind(user.organizationId, customer.id, user.userId).first<{ count: number }>(),
  ]);
  return {
    customer,
    contacts: contacts.results,
    addresses: addresses.results,
    recentOrders: recentOrders.results,
    pendingQuotes: pendingQuotes.results,
    notices: notices.results,
    appointmentResult: url.searchParams.get("appointmentResult") || "",
    appointmentError: url.searchParams.get("appointmentError") || "",
    summary: {
      orders: Number(summary?.orders ?? 0),
      shipments: Number(summary?.shipments ?? 0),
      outstanding: Number(summary?.outstanding ?? 0),
      pendingQuotes: Number(summary?.pending_quotes ?? 0),
      unread: Number(unread?.count ?? 0),
    },
  };
}

export default function PortalIndex({ loaderData }: Route.ComponentProps) {
  return <div className="page prototype-page portal-home-page">
    <div className="breadcrumb">客户门户 / 我的首页</div>
    <header className="page-head">
      <div><p className="prototype-kicker">CUSTOMER PORTAL</p><h1>{loaderData.customer.name}</h1><p>客户代码 {loaderData.customer.code} · 账户状态 {loaderData.customer.status === "active" ? "正常" : loaderData.customer.status}</p></div>
      <span className="pill portal-enabled">门户已启用</span>
    </header>
    {loaderData.appointmentResult && <p className="alert success">{loaderData.appointmentResult}</p>}
    {loaderData.appointmentError && <p className="alert error">{loaderData.appointmentError}</p>}

    <section className="kpis portal-home-kpis" aria-label="业务摘要">
      <div><span>执行中订单</span><b>{loaderData.summary.orders}</b><small>{loaderData.summary.pendingQuotes ? `另有 ${loaderData.summary.pendingQuotes} 份报价待确认` : "当前无待确认报价"}</small></div>
      <div><span>在途运单</span><b>{loaderData.summary.shipments}</b><small>运输执行中</small></div>
      <div><span>待付余额</span><b>{loaderData.summary.outstanding.toLocaleString()}</b><small>已开具账单</small></div>
      <div><span>未读消息</span><b>{loaderData.summary.unread}</b><small>报价、运输与账单通知</small></div>
    </section>

    <section className="table-panel portal-home-orders">
      <div className="table-panel-head"><div><b>待确认与最近订单</b><span>待确认报价优先显示；接受后系统自动生成正式订单。</span></div><Link className="btn small" to="/portal/orders">查看全部订单</Link></div>
      <div className="table-wrap"><table><thead><tr><th>订单 / 报价</th><th>类型</th><th>货物</th><th>线路</th><th>当前节点</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {loaderData.pendingQuotes.map((quote) => <tr key={`quote-${quote.id}`} className="portal-quote-pending-row">
          <td><Link className="order-id" to={quotationDetailLink(quote.id)}>{quote.quote_number}</Link><small className="subline">报价待确认</small></td>
          <td><span className={`pill ${quote.road_load_type === "ltl" ? "ltl" : ""}`}>{quote.road_load_type === "ltl" ? "拼车" : "整车"}</span></td>
          <td><span className="cell-main">{quote.cargo_description || "货物待补充"}</span><small className="subline">CNY {Number(quote.total_amount || 0).toLocaleString()}</small></td>
          <td>{quote.origin_city} → {quote.destination_city}</td>
          <td>客户确认报价</td>
          <td><span className="status orange">待确认</span>{quote.valid_until && <small className="subline">有效期至 {quote.valid_until}</small>}</td>
          <td><Link className="btn primary small" to={quotationDetailLink(quote.id)}>查看并确认</Link></td>
        </tr>)}
        {loaderData.recentOrders.map((order) => <tr key={order.id} className={order.exception_status && order.exception_status !== "normal" ? "row-alert" : ""}>
          <td><b className="order-id">{order.order_number}</b><small className="subline">{order.quote_number || "历史订单"}</small></td>
          <td><span className={`pill ${order.business_type === "ltl" ? "ltl" : ""}`}>{order.business_type === "ltl" ? "拼车" : "整车"}</span></td>
          <td><span className="cell-main">{order.cargo_description || "货物待补充"}</span></td>
          <td>{order.origin_city} → {order.destination_city}</td>
          <td>{order.current_step_name || "待同步"}</td>
          <td><span className={`status ${statusTone(order.status, order.exception_status)}`}>{statusLabel(order.status)}</span></td>
          <td><div className="portal-order-actions"><PortalPickupAppointment order={order} returnTo="/portal"/><Link className="btn small" to={`/portal/tracking?order=${encodeURIComponent(order.order_number)}`}>查看轨迹</Link>{markLabelAvailable(order) && <OrderMarkLabelModal order={order} />}</div></td>
        </tr>)}
        {!loaderData.pendingQuotes.length && !loaderData.recentOrders.length && <tr><td className="empty" colSpan={7}>暂无待确认报价或订单。</td></tr>}
      </tbody></table></div>
    </section>

    <div className="portal-home-lower">
      <section className="table-panel">
        <div className="table-panel-head"><div><b>最新消息</b><span>报价、运输和账单状态集中显示。</span></div><Link className="btn small" to="/portal/notifications">消息中心</Link></div>
        <div className="portal-home-message-list">{loaderData.notices.map((notice) => <Link to={normalizePortalNotificationLink(notice.link) || "/portal/notifications"} key={notice.id} className={notice.is_read ? "" : "unread"}><span className="status blue">{noticeTypeLabel(notice.type)}</span><strong>{notice.title}</strong><small>{notice.message}</small><time>{new Date(notice.created_at).toLocaleString("zh-CN")}</time></Link>)}{!loaderData.notices.length && <p className="empty-state">暂无消息。</p>}</div>
      </section>
      <section className="table-panel portal-home-profile">
        <div className="table-panel-head"><div><b>常用资料</b><span>下单与业务沟通时直接复用。</span></div><Link className="btn small" to="/portal/account?tab=contacts">维护资料</Link></div>
        <div className="portal-home-profile-grid">
          <div><b>联系人</b>{loaderData.contacts.map((contact) => <span key={contact.id}><strong>{contact.name}</strong><small>{contact.phone || contact.email || contact.title || "—"}</small></span>)}{!loaderData.contacts.length && <em>暂无联系人</em>}</div>
          <div><b>常用地址</b>{loaderData.addresses.map((address) => <span key={address.id}><strong>{address.label}</strong><small>{address.country_code} {address.city} {address.address_line1}</small></span>)}{!loaderData.addresses.length && <em>暂无常用地址</em>}</div>
        </div>
      </section>
    </div>
  </div>;
}

function statusLabel(status: string) {
  return ({ draft: "待补充委托资料", submitted: "待审核", confirmed: "已审核，待派单", in_execution: "运输执行中", completed: "已完成", cancelled: "已取消" } as Record<string, string>)[status] || status;
}
function statusTone(status: string, exceptionStatus: string | null) {
  if (status === "completed") return "green";
  if ((exceptionStatus && exceptionStatus !== "normal") || status === "cancelled") return "red";
  if (["draft", "submitted"].includes(status)) return "orange";
  return "blue";
}
function noticeTypeLabel(type: string) {
  return ({ quote: "报价", order: "订单", shipment: "运输", invoice: "账单", payment: "付款", system: "系统" } as Record<string, string>)[type] || type;
}

function markLabelAvailable(order: RecentOrder) {
  return Boolean(order.label_generated_at) && order.quote_withdrawn !== 1 && order.status !== "cancelled";
}

export function quotationDetailLink(quotationId: string) {
  return `/portal/quotes?status=pending&quote=${encodeURIComponent(quotationId)}`;
}

export function meta() { return [{ title: "客户门户 | 新翎航 TMS" }]; }
