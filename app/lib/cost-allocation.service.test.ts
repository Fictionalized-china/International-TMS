import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
  rows: [{ order_id: "order-1" }],
  assertOpen: vi.fn(async () => gate.rows),
}));

vi.mock("./batch-cost-allocation-action-policy.server", () => ({
  assertBatchCostAllocationActionOpen: gate.assertOpen,
}));

import {
  confirmCostAllocation,
  createCostAllocation,
  updateCostAllocation,
} from "./cost-allocation.server";

function database(input: { zeroChanges?: boolean } = {}) {
  const events: string[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => {
        if (sql.startsWith("SELECT id,batch_id,total_amount,status"))
          return { id: "allocation-1", batch_id: "batch-1", total_amount: 100, status: "draft" };
        if (sql.startsWith("SELECT * FROM transport_cost_allocations"))
          return {
            id: "allocation-1", batch_id: "batch-1", total_amount: 100,
            status: "draft", charge_code: "FREIGHT", charge_name: "运费",
            counterparty_name: "承运商", currency: "CNY", exchange_rate: 1,
            notes: null,
          };
        return null;
      }),
      all: vi.fn(async () => {
        if (sql.includes("FROM transport_cost_allocation_lines") && sql.includes("actual_weight_kg"))
          return { results: [{ id: "line-1", order_id: "order-1", actual_weight_kg: 100, actual_volume_cbm: 1 }] };
        if (sql.includes("FROM transport_cost_allocation_lines") && sql.includes("suggested_amount"))
          return { results: [{ id: "line-1", order_id: "order-1", suggested_amount: 100, final_amount: 100, adjustment_reason: null }] };
        if (sql.includes("FROM transport_batch_orders"))
          return { results: [{ order_id: "order-1", order_number: "SO-1", customer_name: "客户", receipt_count: 1, actual_weight_kg: 100, actual_volume_cbm: 1 }] };
        return { results: [] };
      }),
    })),
  }));
  const batch = vi.fn(async (statements: unknown[]) => {
    events.push("batch");
    return statements.map(() => ({ meta: { changes: input.zeroChanges ? 0 : 1 } }));
  });
  return { db: { prepare, batch } as unknown as D1Database, events, batch };
}

describe("cost allocation mutation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.rows = [{ order_id: "order-1" }];
  });

  it("revalidates actor, members and workflow immediately before create writes", async () => {
    const harness = database();
    const assertCanMutate = vi.fn(async (context) => {
      harness.events.push("assert");
      expect(context).toMatchObject({ batchId: "batch-1", allocationId: null, orderIds: ["order-1"] });
    });
    await createCostAllocation(harness.db, {
      organizationId: "org-1", batchId: "batch-1", chargeCode: "FREIGHT",
      chargeName: "运费", counterpartyName: "承运商", currency: "CNY",
      exchangeRate: 1, totalAmount: 100, method: "equal", userId: "user-1",
      now: "2026-09-06T00:00:00Z", assertCanMutate,
    });
    expect(harness.events).toEqual(["assert", "batch"]);
  });

  it("revalidates immediately before update and uses conditional draft writes", async () => {
    const harness = database();
    const assertCanMutate = vi.fn(async () => { harness.events.push("assert"); });
    await updateCostAllocation(harness.db, {
      organizationId: "org-1", allocationId: "allocation-1", method: "equal",
      adjustments: [{ lineId: "line-1", amount: 100, reason: "" }],
      now: "2026-09-06T00:00:00Z", assertCanMutate,
    });
    expect(harness.events).toEqual(["assert", "batch"]);
    expect(harness.db.prepare).toHaveBeenCalledWith(expect.stringContaining("allocation.status='draft'"));
  });

  it("revalidates immediately before confirm and reports a double-submit conflict", async () => {
    const harness = database({ zeroChanges: true });
    const assertCanMutate = vi.fn(async () => { harness.events.push("assert"); });
    await expect(confirmCostAllocation(harness.db, {
      organizationId: "org-1", allocationId: "allocation-1", userId: "user-1",
      now: "2026-09-06T00:00:00Z", assertCanMutate,
    })).rejects.toThrow("状态已被其他人更新");
    expect(harness.events).toEqual(["assert", "batch"]);
  });
});
