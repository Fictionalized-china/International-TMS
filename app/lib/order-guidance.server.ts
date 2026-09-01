import {
  orderNextGuidance,
  type GuidanceModule,
} from "./order-guidance";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";

export type OrderGuidanceOrder = {
  id: string;
  status: string;
};

export type OrderGuidance = ReturnType<typeof orderNextGuidance>;

/**
 * Loads one shared next-action result for a list of orders. List pages must use
 * this helper instead of maintaining their own status wording.
 */
export async function loadOrderGuidance(
  db: D1Database,
  organizationId: string,
  orders: OrderGuidanceOrder[],
) {
  const uniqueOrders = [...new Map(orders.map((order) => [order.id, order])).values()];
  if (!uniqueOrders.length) return new Map<string, OrderGuidance>();
  const orderIds = uniqueOrders.map((order) => order.id);
  const modules: Array<GuidanceModule & { order_id: string }> = [];
  for (const chunk of chunkD1Values(orderIds, 1)) {
    const result = await db.prepare(
      `SELECT m.order_id,m.module_code,m.module_name,m.enabled,m.is_required,m.status,
              m.current_step_code,m.current_step_name,m.blocking_reason,assignee.display_name assignee_name,m.progress_percent
         FROM order_module_instances m
         LEFT JOIN users assignee ON assignee.id=m.assignee_user_id
        WHERE m.organization_id=? AND m.order_id IN (${d1Placeholders(chunk.length)})`,
    ).bind(organizationId, ...chunk).all<GuidanceModule & { order_id: string }>();
    modules.push(...result.results);
  }
  return new Map(
    uniqueOrders.map((order) => [
      order.id,
      orderNextGuidance({
        orderId: order.id,
        orderStatus: order.status,
        modules: modules.filter((module) => module.order_id === order.id),
      }),
    ]),
  );
}
