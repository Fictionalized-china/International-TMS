import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const queries: string[] = [];
  const state = { allowed: true };
  const DB = {
    prepare: vi.fn((sql: string) => {
      queries.push(sql);
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => sql.includes("SELECT COUNT(*) count") ? { count: 1 } : null),
        all: vi.fn(async () => {
          if (sql.includes("FROM warehouse_receipt_differences d")) return { results: [{
            order_id: "order-1",
            order_number: "SO-001",
            customer_name: "客户一",
            receipt_numbers: "IN-001",
            difference_count: 1,
            max_difference_percent: 8,
            updated_at: "2026-09-06T00:00:00.000Z",
          }] };
          return { results: [] };
        }),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      };
      return statement;
    }),
    batch: vi.fn(async () => []),
  };
  return {
    queries,
    state,
    DB,
    requireSessionUser: vi.fn(async () => ({
      organizationId: "org-1",
      userId: "warehouse-user",
      positionCode: "WAREHOUSE",
      permissions: ["warehouse.view", "warehouse.operate"],
    })),
    loadWarehouseContext: vi.fn(async () => ({
      selected: { id: "warehouse-1", name: "目的仓", warehouse_role: "overseas_destination" },
    })),
    requireWarehouseAssignment: vi.fn(async () => undefined),
    loadScope: vi.fn(async () => ({
      enabled: state.allowed,
      responsibilityPositionCodes: state.allowed ? ["WAREHOUSE"] : ["FINANCE_ACCOUNTING"],
    })),
    writeAudit: vi.fn(async () => undefined),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/warehouse-context.server", () => ({ loadWarehouseContext: harness.loadWarehouseContext }));
vi.mock("../lib/warehouse-access.server", () => ({ requireWarehouseAssignment: harness.requireWarehouseAssignment }));
vi.mock("../lib/order-modules.server", () => ({ loadOrderModuleActionScope: harness.loadScope }));
vi.mock("../lib/audit.server", () => ({ writeAudit: harness.writeAudit }));
vi.mock("../lib/order-exception-status.server", () => ({ synchronizeOrderExceptionStatuses: vi.fn() }));

import { action, loader } from "./warehouse.exceptions";

function request(method = "GET") {
  return new Request("http://local.test/warehouse/exceptions?warehouseId=warehouse-1", method === "GET" ? undefined : {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "confirm_receipt_difference", orderId: "order-1" }),
  });
}

describe("warehouse receipt difference confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.queries.length = 0;
    harness.state.allowed = true;
  });

  it("lists only the selected warehouse's differences and derives action access from the frozen workflow", async () => {
    const result = await loader({ request: request(), params: {}, context: undefined } as never);

    expect(result.differences).toHaveLength(1);
    expect(result.differences[0].can_confirm).toBe(true);
    expect(harness.queries.some(sql => sql.includes("r.warehouse_id=?"))).toBe(true);
    expect(harness.loadScope).toHaveBeenCalledWith("org-1", "order-1", "warehouse");
  });

  it("confirms only the current warehouse's pending differences", async () => {
    await expect(action({ request: request("POST"), params: {}, context: undefined } as never))
      .resolves.toEqual({ success: "仓库实收差异及费用影响已确认，结算阻断已解除" });

    expect(harness.requireWarehouseAssignment).toHaveBeenCalledWith(expect.anything(), "warehouse-1", "operator");
    expect(harness.DB.batch).toHaveBeenCalledTimes(1);
    expect(harness.queries.some(sql => sql.includes("receipt_id IN (SELECT id FROM warehouse_receipts"))).toBe(true);
    expect(harness.writeAudit).toHaveBeenCalledTimes(1);
  });

  it("rejects a forged confirmation when the frozen workflow assigns another position", async () => {
    harness.state.allowed = false;

    await expect(action({ request: request("POST"), params: {}, context: undefined } as never))
      .resolves.toEqual({ formError: "当前订单冻结工作流未启用仓库差异确认" });
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });
});
