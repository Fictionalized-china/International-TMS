import { describe, expect, it, vi } from "vitest";
import { refreshOrdersForWorkflowFieldChanges } from "./workflow-field-order-refresh";

describe("workflow field order refresh", () => {
  it("does not query or refresh orders for fields outside costs reconciliation", async () => {
    const listAffectedOrderIds = vi.fn(async () => ["order-1"]);
    const syncCostsModuleStatus = vi.fn(async () => undefined);
    const syncOrderWorkflowSnapshot = vi.fn(async () => undefined);

    const result = await refreshOrdersForWorkflowFieldChanges({
      changes: [
        { moduleCode: "tracking", stepKey: "outbound_transport" },
        { moduleCode: "costs", stepKey: "order_creation" },
      ],
      listAffectedOrderIds,
      syncCostsModuleStatus,
      syncOrderWorkflowSnapshot,
    });

    expect(result).toEqual({ matchedOrders: 0, refreshedOrders: 0 });
    expect(listAffectedOrderIds).not.toHaveBeenCalled();
    expect(syncCostsModuleStatus).not.toHaveBeenCalled();
    expect(syncOrderWorkflowSnapshot).not.toHaveBeenCalled();
  });

  it("deduplicates affected orders and refreshes costs before each workflow snapshot", async () => {
    const events: string[] = [];
    const listAffectedOrderIds = vi.fn(async () => ["order-1", "order-2", "order-1"]);
    const syncCostsModuleStatus = vi.fn(async (orderId: string) => {
      events.push(`costs:${orderId}`);
    });
    const syncOrderWorkflowSnapshot = vi.fn(async (orderId: string) => {
      events.push(`workflow:${orderId}`);
    });

    const result = await refreshOrdersForWorkflowFieldChanges({
      changes: [
        { moduleCode: "costs", stepKey: "reconciliation" },
        { moduleCode: "costs", stepKey: "reconciliation" },
      ],
      listAffectedOrderIds,
      syncCostsModuleStatus,
      syncOrderWorkflowSnapshot,
    });

    expect(listAffectedOrderIds).toHaveBeenCalledOnce();
    expect(listAffectedOrderIds).toHaveBeenCalledWith(["reconciliation"]);
    expect(syncCostsModuleStatus).toHaveBeenCalledTimes(2);
    expect(syncOrderWorkflowSnapshot).toHaveBeenCalledTimes(2);
    for (const orderId of ["order-1", "order-2"]) {
      expect(events.indexOf(`costs:${orderId}`)).toBeLessThan(
        events.indexOf(`workflow:${orderId}`),
      );
    }
    expect(result).toEqual({ matchedOrders: 2, refreshedOrders: 2 });
  });
});
