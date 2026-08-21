import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/warehouse.notifications";
import { requireSessionUser } from "../lib/auth.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { advanceOverseasOrder } from "../lib/overseas-warehouse.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";

type NoticeRow = {
  order_id: string;
  order_number: string;
  batch_number: string;
  customer_id: string;
  customer_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  actual_arrival_at: string | null;
  pieces: number;
  weight_kg: number;
  volume_cbm: number;
  status: string;
  notified_at: string | null;
};

const statusLabels: Record<string, string> = {
  arrived: "已入库待通知",
  notified: "已通知",
  appointment: "已预约自提",
  picked_up: "已自提",
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const { selected: warehouse } = await loadWarehouseContext(request, user);
  if (warehouse.warehouse_role !== "overseas_destination")
    throw new Response("通知客户仅供境外目的仓使用", { status: 404 });

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "all";
  const allowedStatuses = new Set(["all", "arrived", "notified", "appointment", "picked_up"]);
  const selectedStatus = allowedStatuses.has(status) ? status : "all";
  const rows = await env.DB.prepare(
    `SELECT op.order_id,o.order_number,b.batch_number,o.customer_id,c.name customer_name,
            COALESCE(o.consignee_contact,o.shipper_contact) contact_name,
            COALESCE(o.consignee_phone,o.shipper_phone) contact_phone,
            op.actual_arrival_at,op.status,op.notified_at,
            COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.warehouse_id=op.warehouse_id AND r.status='completed'),o.pieces) pieces,
            COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.warehouse_id=op.warehouse_id AND r.status='completed'),o.gross_weight_kg) weight_kg,
            COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.warehouse_id=op.warehouse_id AND r.status='completed'),o.volume_cbm) volume_cbm
       FROM overseas_warehouse_operations op
       JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
       JOIN transport_batches b ON b.id=op.batch_id AND b.organization_id=op.organization_id
       JOIN customers c ON c.id=o.customer_id
      WHERE op.organization_id=? AND op.warehouse_id=? AND op.status!='cancelled'
        AND (?='all' OR op.status=?)
        AND (?='' OR o.order_number LIKE '%'||?||'%' OR b.batch_number LIKE '%'||?||'%' OR c.name LIKE '%'||?||'%')
      ORDER BY CASE op.status WHEN 'arrived' THEN 0 WHEN 'notified' THEN 1 WHEN 'appointment' THEN 2 ELSE 3 END,
               op.actual_arrival_at DESC,o.order_number`,
  ).bind(
    user.organizationId, warehouse.id,
    selectedStatus, selectedStatus,
    q, q, q, q,
  ).all<NoticeRow>();

  return {
    user,
    warehouse,
    rows: rows.results,
    q,
    status: selectedStatus,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request, "warehouse.operate", "warehouse");
  const { selected: warehouse } = await loadWarehouseContext(request, user);
  if (warehouse.warehouse_role !== "overseas_destination")
    return { formError: "通知客户仅供境外目的仓使用" };
  await requireWarehouseAssignment(user, warehouse.id, "operator");

  const form = await request.formData();
  if (valueOf(form, "intent") !== "notify") return { formError: "无效操作" };
  const orderIds = [...new Set(form.getAll("orderId").map(String).filter(Boolean))];
  if (!orderIds.length) return { formError: "请至少选择一张已入库待通知的订单" };

  const placeholders = orderIds.map(() => "?").join(",");
  const eligible = await env.DB.prepare(
    `SELECT op.order_id,o.order_number,o.customer_id
       FROM overseas_warehouse_operations op
       JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
      WHERE op.organization_id=? AND op.warehouse_id=? AND op.status='arrived'
        AND op.order_id IN (${placeholders})`,
  ).bind(user.organizationId, warehouse.id, ...orderIds).all<{
    order_id: string;
    order_number: string;
    customer_id: string;
  }>();
  if (eligible.results.length !== orderIds.length)
    return { formError: "所选订单中包含尚未完成境外仓验收或已经通知的订单，请刷新后重选" };

  const now = new Date().toISOString();
  for (const order of eligible.results) {
    await advanceOverseasOrder({
      organizationId: user.organizationId,
      orderId: order.order_id,
      action: "notify",
      occurredAt: now,
      actorUserId: user.userId,
      notes: `${warehouse.name} 已确认货物到仓，可安排自提`,
    });
    const portalNotificationId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO portal_notifications(id,organization_id,customer_id,user_id,type,title,message,link,is_read,created_at)
         VALUES(?,?,?,NULL,'shipment',?,?,?,0,?)`,
      ).bind(
        portalNotificationId,user.organizationId,order.customer_id,
        `订单 ${order.order_number} 已到仓`,
        `货物已到达 ${warehouse.name}，请登录客户门户查看并安排自提。`,
        `/portal/orders?order=${encodeURIComponent(order.order_number)}`,now,
      ),
      env.DB.prepare(
        `INSERT INTO warehouse_customer_notifications(
           id,organization_id,warehouse_id,order_id,portal_notification_id,status,
           notified_by_user_id,notified_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,'notified',?,?,?,?)
         ON CONFLICT(organization_id,order_id) DO UPDATE SET
           warehouse_id=excluded.warehouse_id,portal_notification_id=excluded.portal_notification_id,
           status='notified',notified_by_user_id=excluded.notified_by_user_id,
           notified_at=excluded.notified_at,updated_at=excluded.updated_at`,
      ).bind(
        crypto.randomUUID(),user.organizationId,warehouse.id,order.order_id,
        portalNotificationId,user.userId,now,now,now,
      ),
    ]);
  }

  await writeAudit({
    request,
    action: "warehouse.customer.notify_batch",
    resourceType: "transport_order",
    resourceId: eligible.results.map((item) => item.order_id).join(","),
    organizationId: user.organizationId,
    actorUserId: user.userId,
    metadata: { warehouseId: warehouse.id, orderCount: eligible.results.length },
  });
  return { success: `已向 ${eligible.results.length} 张订单的客户发送系统内和客户门户通知` };
}

export default function WarehouseNotifications({ loaderData, actionData }: Route.ComponentProps) {
  const waitingCount = loaderData.rows.filter((item) => item.status === "arrived").length;
  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">CUSTOMER NOTICE</p>
        <h1>通知客户</h1>
        <p>境外仓验收完成后，从这里批量通知客户安排自提。</p>
      </div>
      <span className="status-pill">{waitingCount} 票待通知</span>
    </header>
    {(actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`}>{actionData.formError ?? actionData.success}</div>}
    <section className="panel">
      <Form method="get" className="filter-bar compact">
        <label className="field"><span>订单号 / 配载单号 / 客户</span><input name="q" defaultValue={loaderData.q} placeholder="输入关键词" /></label>
        <label className="field"><span>订单状态</span><select name="status" defaultValue={loaderData.status}><option value="all">全部</option><option value="arrived">已入库待通知</option><option value="notified">已通知</option><option value="appointment">已预约自提</option><option value="picked_up">已自提</option></select></label>
        <button className="secondary">筛选</button>
        <Link className="text-button" to="/warehouse/notifications">重置</Link>
      </Form>
    </section>
    <Form method="post" className="panel">
      <input type="hidden" name="intent" value="notify" />
      <div className="panel-header"><div><h2>到仓订单</h2><p>只有“已入库待通知”的订单可以勾选并批量通知。</p></div><button className="primary" disabled={!waitingCount}>批量通知客户</button></div>
      <div className="table-wrap"><table><thead><tr><th>选择</th><th>订单号</th><th>配载单</th><th>客户与联系人</th><th>实际到仓</th><th>实收数据</th><th>订单状态</th><th>操作</th></tr></thead><tbody>{loaderData.rows.map((item) => <tr key={item.order_id}>
        <td><input type="checkbox" name="orderId" value={item.order_id} disabled={item.status !== "arrived"} aria-label={`选择订单 ${item.order_number}`} /></td>
        <td><strong>{item.order_number}</strong></td>
        <td>{item.batch_number}</td>
        <td><strong>{item.customer_name}</strong><small>{item.contact_name || "未填联系人"} · {item.contact_phone || "未填电话"}</small></td>
        <td>{item.actual_arrival_at ? new Date(item.actual_arrival_at).toLocaleString("zh-CN") : "—"}</td>
        <td>{item.pieces} 件<small>{Number(item.weight_kg || 0).toFixed(2)} KG · {Number(item.volume_cbm || 0).toFixed(3)} CBM</small></td>
        <td><span className={`status-pill ${item.status === "arrived" ? "warning" : "success"}`}>{statusLabels[item.status] || item.status}</span>{item.notified_at && <small>{new Date(item.notified_at).toLocaleString("zh-CN")}</small>}</td>
        <td><Link className="text-button" to={`/admin/orders/${item.order_id}`}>查看订单</Link></td>
      </tr>)}</tbody></table></div>
      {!loaderData.rows.length && <p className="empty-state">当前筛选条件下没有境外仓订单。</p>}
    </Form>
  </>;
}

export function meta() { return [{ title: "通知客户 | International TMS" }]; }
