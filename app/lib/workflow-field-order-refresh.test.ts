import { describe, expect, it, vi } from "vitest";
import { refreshOrdersForWorkflowFieldChanges } from "./workflow-field-order-refresh";

describe("workflow field order refresh", () => {
  it("refreshes current and future order snapshots for fields outside the costs module", async () => {
    const listAffectedOrderIds = vi.fn(async () => ["order-1"]);
    const syncCostsModuleStatus = vi.fn(async () => undefined);
    const syncOrderWorkflowSnapshot = vi.fn(async () => undefined);

    const result = await refreshOrdersForWorkflowFieldChanges({
      changes: [
        { moduleCode: "tracking", stepKey: "outbound_transport" },
      ],
      listAffectedOrderIds,
      syncCostsModuleStatus,
      syncOrderWorkflowSnapshot,
    });

    expect(result).toEqual({ matchedOrders: 1, refreshedOrders: 1 });
    expect(listAffectedOrderIds).toHaveBeenCalledWith(["outbound_transport"]);
    expect(syncCostsModuleStatus).not.toHaveBeenCalled();
    expect(syncOrderWorkflowSnapshot).toHaveBeenCalledWith("order-1");
  });

  it("never advances workflow or creates business records while refreshing field gates", async () => {
    const events: string[] = [];
    const result = await refreshOrdersForWorkflowFieldChanges({
      changes: [{ moduleCode: "consignment", stepKey: "order_creation" }],
      listAffectedOrderIds: async () => ["order-current", "order-future"],
      syncCostsModuleStatus: async () => events.push("costs"),
      syncOrderWorkflowSnapshot: async (orderId) => events.push(`snapshot:${orderId}`),
    });

    expect(events).toEqual([
      "snapshot:order-current",
      "snapshot:order-future",
    ]);
    expect(result).toEqual({ matchedOrders: 2, refreshedOrders: 2 });
  });

  it("refreshes a costs gate placed on a custom workflow step", async () => {
    const listAffectedOrderIds = vi.fn(async () => ["order-1"]);
    const syncCostsModuleStatus = vi.fn(async () => undefined);
    const syncOrderWorkflowSnapshot = vi.fn(async () => undefined);

    const result = await refreshOrdersForWorkflowFieldChanges({
      changes: [
        { moduleCode: "costs", stepKey: "customer_defined_settlement" },
      ],
      listAffectedOrderIds,
      syncCostsModuleStatus,
      syncOrderWorkflowSnapshot,
    });

    expect(listAffectedOrderIds).toHaveBeenCalledWith([
      "customer_defined_settlement",
    ]);
    expect(syncCostsModuleStatus).toHaveBeenCalledWith("order-1");
    expect(syncOrderWorkflowSnapshot).toHaveBeenCalledWith("order-1");
    expect(result).toEqual({ matchedOrders: 1, refreshedOrders: 1 });
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
