import { describe, expect, it, vi } from "vitest";
import { loadOrderGuidance } from "./order-guidance.server";

describe("loadOrderGuidance D1 binding safety", () => {
  it("loads guidance for 300 orders without exceeding 100 bindings per query", async () => {
    const bindingCounts: number[] = [];
    const prepare = vi.fn(() => ({
      bind: (...bindings: unknown[]) => ({
        all: async () => {
          bindingCounts.push(bindings.length);
          if (bindings.length > 100) throw new Error("too many SQL variables");
          return {
            results: bindings.slice(1).map((orderId) => ({
              order_id: orderId,
              module_code: "cargo",
              module_name: "货物信息",
              enabled: 1,
              is_required: 1,
              status: "not_started",
              current_step_code: null,
              current_step_name: "货物复核",
              blocking_reason: null,
              assignee_name: null,
              progress_percent: 0,
            })),
          };
        },
      }),
    }));
    const db = { prepare } as unknown as D1Database;
    const orders = Array.from({ length: 300 }, (_, index) => ({
      id: `order-${index}`,
      status: "draft",
    }));

    const guidance = await loadOrderGuidance(db, "org-1", orders);

    expect(guidance.size).toBe(300);
    expect([...guidance.keys()]).toEqual(orders.map((order) => order.id));
    expect(Math.max(...bindingCounts)).toBeLessThanOrEqual(100);
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it("does not prepare a query for an empty order list", async () => {
    const prepare = vi.fn();
    const result = await loadOrderGuidance(
      { prepare } as unknown as D1Database,
      "org-1",
      [],
    );
    expect(result.size).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });
});
