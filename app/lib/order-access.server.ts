import { env } from "cloudflare:workers";
import {
  batchVisibilitySql,
  orderVisibilitySql,
  type OrderAccessUser,
} from "./order-access";

export {
  assignedBatchViewPermission,
  batchVisibilitySql,
  canAccessBatchWorkspace,
  canOperateCurrentOrder,
  canSeeScopedOrder,
  canViewAllOrders,
  orderVisibilitySql,
} from "./order-access";

export async function requireOrderAccess(user: OrderAccessUser, orderId: string | undefined) {
  if (!orderId) throw new Response("订单不存在", { status: 404 });
  const visibility = orderVisibilitySql(user, "o");
  const order = await env.DB.prepare(
    `SELECT o.id FROM transport_orders o
     WHERE o.organization_id=? AND o.id=? AND ${visibility.sql}`,
  ).bind(user.organizationId, orderId, ...visibility.values).first<{ id: string }>();
  if (!order) throw new Response("订单不存在或当前节点尚未分配给您", { status: 404 });
  return order;
}
