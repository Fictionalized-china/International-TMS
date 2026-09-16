import { env } from "cloudflare:workers";
import { redirect } from "react-router";
import type { Route } from "./+types/portal.pickup-appointment";
import { writeAudit } from "../lib/audit.server";
import { syncOrderWorkflowSnapshot } from "../lib/order-modules.server";
import {
  formatPickupAppointment,
  isPickupAppointmentDate,
  isPickupAppointmentPeriod,
} from "../lib/pickup-appointment";
import {
  portalContextIdFromRequest,
  portalContextualPath,
} from "../lib/portal-session-context";
import { requirePortalCustomer } from "../lib/portal.server";
import { valueOf } from "../lib/validation";

type AppointmentOrder = {
  operation_id: string;
  order_number: string;
  operation_status: string;
  warehouse_name: string | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  const contextId = portalContextIdFromRequest(request);
  return redirect(contextId ? portalContextualPath("/portal", contextId) : "/portal");
}

export async function action({ request }: Route.ActionArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const form = await request.formData();
  const orderId = valueOf(form, "orderId");
  const appointmentDate = valueOf(form, "appointmentDate");
  const appointmentPeriod = valueOf(form, "appointmentPeriod");
  const returnTo = valueOf(form, "returnTo") === "/portal/orders"
    ? "/portal/orders"
    : "/portal";
  const contextId = portalContextIdFromRequest(request);

  const respond = (key: "appointmentResult" | "appointmentError", message: string) => {
    const target = new URL(returnTo, request.url);
    target.searchParams.set(key, message);
    const path = `${target.pathname}${target.search}`;
    return redirect(contextId ? portalContextualPath(path, contextId) : path);
  };

  if (!orderId || !isPickupAppointmentDate(appointmentDate))
    return respond("appointmentError", "请选择有效的提货日期");
  const todayInShanghai = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (appointmentDate < todayInShanghai)
    return respond("appointmentError", "提货日期不能早于今天");
  if (!isPickupAppointmentPeriod(appointmentPeriod))
    return respond("appointmentError", "请选择上午、下午或晚上");

  const order = await env.DB.prepare(
    `SELECT op.id operation_id,o.order_number,op.status operation_status,w.name warehouse_name
       FROM transport_orders o
       JOIN overseas_warehouse_operations op
         ON op.id=(
           SELECT latest.id FROM overseas_warehouse_operations latest
           WHERE latest.organization_id=o.organization_id AND latest.order_id=o.id
             AND latest.status!='cancelled'
           ORDER BY latest.created_at DESC LIMIT 1
         )
       LEFT JOIN warehouses w ON w.id=op.warehouse_id AND w.organization_id=op.organization_id
      WHERE o.id=? AND o.organization_id=? AND o.customer_id=?`,
  ).bind(orderId, user.organizationId, customer.id).first<AppointmentOrder>();
  if (!order)
    return respond("appointmentError", "订单不存在，或还没有到达境外目的仓");
  if (!["notified", "appointment"].includes(order.operation_status))
    return respond("appointmentError", "当前状态还不能预约提货");

  const now = new Date().toISOString();
  const displayAppointment = formatPickupAppointment(appointmentDate, appointmentPeriod);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE overseas_warehouse_operations
          SET status='appointment',appointment_at=?,appointment_period=?,updated_by_user_id=?,updated_at=?
        WHERE id=? AND organization_id=? AND status IN ('notified','appointment')`,
    ).bind(appointmentDate, appointmentPeriod, user.userId, now, order.operation_id, user.organizationId),
    env.DB.prepare(
      `UPDATE order_module_instances
          SET status='in_progress',current_step_code='appointment',current_step_name='客户已预约，等待扫码自提',
              progress_percent=75,started_at=COALESCE(started_at,?),blocking_reason=NULL,updated_at=?
        WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1 AND status!='completed'`,
    ).bind(now, now, user.organizationId, orderId),
    env.DB.prepare(
      `INSERT INTO order_tracking_milestones(
         id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,
         visible_to_customer,created_by_user_id,created_at
       ) SELECT ?,?,?,'pickup_appointment','客户预约提货',?,?,?,1,?,?
         WHERE EXISTS(
           SELECT 1 FROM overseas_warehouse_operations
           WHERE id=? AND organization_id=? AND status='appointment'
             AND appointment_at=? AND appointment_period=?
         )`,
    ).bind(
      crypto.randomUUID(),
      user.organizationId,
      orderId,
      now,
      order.warehouse_name || "境外目的仓",
      displayAppointment,
      user.userId,
      now,
      order.operation_id,
      user.organizationId,
      appointmentDate,
      appointmentPeriod,
    ),
  ]);
  const saved = await env.DB.prepare(
    `SELECT 1 FROM overseas_warehouse_operations
      WHERE id=? AND organization_id=? AND status='appointment'
        AND appointment_at=? AND appointment_period=?`,
  ).bind(
    order.operation_id,
    user.organizationId,
    appointmentDate,
    appointmentPeriod,
  ).first();
  if (!saved)
    return respond("appointmentError", "订单状态刚刚发生变化，请刷新后重新确认");
  await syncOrderWorkflowSnapshot(user.organizationId, orderId);
  await writeAudit({
    request,
    action: "portal.pickup.appointment",
    resourceType: "transport_order",
    resourceId: orderId,
    organizationId: user.organizationId,
    actorUserId: user.userId,
    metadata: { appointmentDate, appointmentPeriod },
  });
  return respond(
    "appointmentResult",
    `${order.order_number} 已预约 ${displayAppointment} 提货，仓库已同步`,
  );
}
