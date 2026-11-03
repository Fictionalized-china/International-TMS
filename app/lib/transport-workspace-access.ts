import { canAccessSettlementWorkbench } from "./billing-access";

export function canViewTrackingCenter(actor: { permissions: readonly string[] }) {
  return actor.permissions.includes("tracking.center.view") && actor.permissions.includes("shipment.view");
}

export function canViewOrderWorkbench(actor: { permissions: readonly string[] }, workspace: string) {
  if (!actor.permissions.includes("order.view")) return false;
  if (workspace === "tracking") return canViewTrackingCenter(actor);
  if (workspace === "costs") return canAccessSettlementWorkbench(actor.permissions);
  return ["tasks", "documents", "customs"].includes(workspace);
}

export function dispatchWorkspaceHref(orderId?: string) {
  return orderId ? `/admin/dispatch?orderId=${encodeURIComponent(orderId)}` : "/admin/dispatch";
}

/** Old dispatch tasks were linked as though dispatch were an order module. */
export function orderTaskWorkspaceHref(orderId: string, moduleCode: string) {
  return moduleCode === "dispatch" ? dispatchWorkspaceHref(orderId)
    : `/admin/orders/${encodeURIComponent(orderId)}/modules/${encodeURIComponent(moduleCode)}`;
}
