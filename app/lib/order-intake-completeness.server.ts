import { env } from "cloudflare:workers";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { evaluateOrderIntakeCompleteness, type CurrentOrderIntakeFacts } from "./order-intake-completeness";

/** Internal read-only service. Route callers must first apply their order scope. */
export async function loadOrderIntakeCompleteness(organizationId: string, orderId: string, additionalRequiredNativeKeys: readonly string[] = []) {
  const order = await env.DB.prepare("SELECT * FROM transport_orders WHERE id=? AND organization_id=?").bind(orderId, organizationId).first<Record<string, unknown>>();
  if (!order) throw new Error("订单不存在或不属于当前组织");
  const [cargo, expenses, services, policy] = await Promise.all([
    env.DB.prepare("SELECT * FROM order_cargo_items WHERE organization_id=? AND order_id=? ORDER BY line_no,id").bind(organizationId, orderId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM business_expenses WHERE organization_id=? AND order_id=? AND stage!='cancelled' ORDER BY created_at,id").bind(organizationId, orderId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT service_code,status FROM order_services WHERE organization_id=? AND order_id=? ORDER BY service_code").bind(organizationId, orderId).all<Record<string, unknown>>(),
    loadBusinessProcessPolicy(organizationId),
  ]);
  const facts: CurrentOrderIntakeFacts = { order, cargo: cargo.results, expenses: expenses.results, services: services.results };
  return evaluateOrderIntakeCompleteness(facts, policy, additionalRequiredNativeKeys);
}
