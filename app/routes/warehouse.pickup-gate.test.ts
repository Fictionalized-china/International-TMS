import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const gateReason = "当前处于“境外仓入库”，进入“客户自提”后自动开放";
  const pkg = {
    id: "package-1",
    status: "in_stock",
    location_id: "location-1",
    barcode: "PKG-001",
    order_id: "order-1",
    order_number: "SO-001",
    pickup_contact: "张三",
    operation_status: "notified",
    package_number: "PKG-001",
    pieces: 1,
    weight_kg: 10,
    volume_cbm: 1,
  };
  const queries: string[] = [];
  const DB = {
    prepare: vi.fn((sql: string) => {
      queries.push(sql);
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => {
          if (sql.includes("FROM warehouse_packages p") && sql.includes("p.barcode=?")) return pkg;
          return null;
        }),
        all: vi.fn(async () => {
          if (sql.includes("FROM warehouse_packages p") && sql.includes("s.order_id=?")) {
            return { results: [pkg] };
          }
          return { results: [] };
        }),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      };
      return statement;
    }),
    batch: vi.fn(async () => []),
  };
  return {
    gateReason,
    pkg,
    queries,
    DB,
    requireSessionUser: vi.fn(async () => ({
      organizationId: "org-1",
      userId: "warehouse-user",
      positionCode: "OVERSEAS_WAREHOUSE",
      permissions: ["warehouse.view", "warehouse.operate"],
    })),
    loadWarehouseContext: vi.fn(async () => ({
      selected: { id: "overseas-warehouse", name: "境外仓", warehouse_role: "overseas_destination" },
      selectedAccessLevel: "operator",
    })),
    requireWarehouseAssignment: vi.fn(async () => undefined),
    loadGate: vi.fn(async () => ({
      configured: true,
      visible: true,
      available: false,
      targetStepKey: "customer_pickup",
      targetStepName: "客户自提",
      reason: gateReason,
      legacyFallback: false,
    })),
    gateSql: vi.fn(() => ({ sql: "FROZEN_PICKUP_GATE", values: ["overseas_warehouse"] })),
    visibilitySql: vi.fn(() => ({ sql: "FROZEN_PICKUP_HISTORY", values: ["overseas_warehouse"] })),
    advanceOverseasOrder: vi.fn(async () => undefined),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/warehouse-context.server", () => ({ loadWarehouseContext: harness.loadWarehouseContext }));
vi.mock("../lib/warehouse-access.server", () => ({ requireWarehouseAssignment: harness.requireWarehouseAssignment }));
vi.mock("../lib/overseas-warehouse.server", () => ({ advanceOverseasOrder: harness.advanceOverseasOrder }));
vi.mock("../lib/warehouse-workflow-access.server", () => ({
  loadWarehousePhysicalWorkflowAccess: harness.loadGate,
  warehousePhysicalWorkflowAccessSql: harness.gateSql,
  warehousePhysicalWorkflowVisibilitySql: harness.visibilitySql,
}));

import { action, loader } from "./warehouse.pickup";

function post(values: Record<string, string>) {
  return new Request("http://local.test/warehouse/pickup?warehouseId=overseas-warehouse", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}

describe("overseas pickup frozen workflow gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.queries.length = 0;
  });

  it("rejects a forged confirmation before reading or mutating pickup inventory", async () => {
    await expect(action({
      request: post({ intent: "confirm_pickup", orderId: "order-1" }),
      params: {},
      context: undefined,
    } as never)).resolves.toEqual({ formError: harness.gateReason });

    expect(harness.loadGate).toHaveBeenCalledWith(
      harness.DB,
      "org-1",
      "order-1",
      "overseas_warehouse",
      { userId: "warehouse-user", positionCode: "OVERSEAS_WAREHOUSE" },
    );
    expect(harness.DB.prepare).not.toHaveBeenCalled();
    expect(harness.DB.batch).not.toHaveBeenCalled();
    expect(harness.advanceOverseasOrder).not.toHaveBeenCalled();
  });

  it("rejects a forged package scan before changing its stock status", async () => {
    await expect(action({
      request: post({ intent: "scan", barcode: "PKG-001" }),
      params: {},
      context: undefined,
    } as never)).resolves.toEqual({ formError: harness.gateReason });

    expect(harness.loadGate).toHaveBeenCalledWith(
      harness.DB,
      "org-1",
      "order-1",
      "overseas_warehouse",
      { userId: "warehouse-user", positionCode: "OVERSEAS_WAREHOUSE" },
    );
    expect(harness.DB.batch).not.toHaveBeenCalled();
    const prepared = harness.DB.prepare.mock.results.map((item) => item.value);
    expect(prepared.every((statement) => statement.run.mock.calls.length === 0)).toBe(true);
  });

  it("filters the queue and confirmation UI with the same frozen gate reason", async () => {
    const result = await loader({
      request: new Request("http://local.test/warehouse/pickup?warehouseId=overseas-warehouse&orderId=order-1"),
      params: {},
      context: undefined,
    } as never);

    expect(harness.gateSql).toHaveBeenCalledWith(
      "o",
      "overseas_warehouse",
      { userId: "warehouse-user", positionCode: "OVERSEAS_WAREHOUSE" },
    );
    expect(harness.visibilitySql).toHaveBeenCalledWith(
      "o",
      "overseas_warehouse",
    );
    expect(harness.queries.some((sql) => sql.includes("FROZEN_PICKUP_GATE"))).toBe(true);
    expect(harness.queries.some((sql) => sql.includes("FROZEN_PICKUP_HISTORY"))).toBe(true);
    expect(result.activeOrder).toBeNull();
    expect(result.packages).toEqual([]);
    expect(result.workflowGateReason).toBe(harness.gateReason);
  });
});
