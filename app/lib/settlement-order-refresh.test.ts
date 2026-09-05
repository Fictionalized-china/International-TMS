import { describe, expect, it, vi } from "vitest";
import { refreshSettlementAffectedOrders } from "./settlement-order-refresh";

describe("settlement affected order refresh", () => {
  it("deduplicates orders and refreshes costs, workflow, then review for each order", async () => {
    const events: string[] = [];
    const syncCostsModuleStatus = vi.fn(async (orderId: string) => {
      events.push(`costs:${orderId}`);
    });
    const syncOrderWorkflowSnapshot = vi.fn(async (orderId: string) => {
      events.push(`workflow:${orderId}`);
    });
    const refreshOrderCompletionStatus = vi.fn(async (orderIds: readonly string[]) => {
      events.push(`review:${orderIds.join(",")}`);
    });

    const refreshed = await refreshSettlementAffectedOrders({
      orderIds: ["order-1", "order-2", "order-1", null, ""],
      syncCostsModuleStatus,
      syncOrderWorkflowSnapshot,
      refreshOrderCompletionStatus,
    });

    expect(refreshed).toEqual(["order-1", "order-2"]);
    expect(events).toEqual([
      "costs:order-1",
      "workflow:order-1",
      "review:order-1",
      "costs:order-2",
      "workflow:order-2",
      "review:order-2",
    ]);
  });

  it("does not advance workflow or review when the configured costs gate cannot refresh", async () => {
    const syncCostsModuleStatus = vi.fn(async () => {
      throw new Error("cost gate failed");
    });
    const syncOrderWorkflowSnapshot = vi.fn(async () => undefined);
    const refreshOrderCompletionStatus = vi.fn(async () => undefined);

    await expect(refreshSettlementAffectedOrders({
      orderIds: ["order-1"],
      syncCostsModuleStatus,
      syncOrderWorkflowSnapshot,
      refreshOrderCompletionStatus,
    })).rejects.toThrow("cost gate failed");

    expect(syncOrderWorkflowSnapshot).not.toHaveBeenCalled();
    expect(refreshOrderCompletionStatus).not.toHaveBeenCalled();
  });
});
