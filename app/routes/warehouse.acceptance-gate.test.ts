import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const gateReason = "当前处于“国内运输”，进入“国内仓入库”后自动开放";
  const order = {
    id: "order-1",
    order_number: "SO-001",
    status: "in_execution",
    business_type: "ftl",
    customer_id: "customer-1",
    customer_name: "客户一",
    customer_identity_code: "ABCD1234",
    shipper_contact: null,
    shipper_phone: null,
    origin_city: "深圳",
    origin_address: "测试地址",
    shipment_id: "shipment-1",
    shipment_number: "SH-001",
    carrier_name: null,
    vehicle_summary: null,
  };
  const state = { gateAvailable: false };
  const DB = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => {
          if (sql.includes("SELECT o.id,o.order_number,o.customer_id")) return order;
          return null;
        }),
        all: vi.fn(async () => {
          if (sql.includes("SELECT o.id,o.order_number,o.status")) return { results: [order] };
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
    order,
    state,
    DB,
    requireSessionUser: vi.fn(async () => ({
      organizationId: "org-1",
      userId: "warehouse-user",
      positionCode: "WAREHOUSE",
      permissions: ["warehouse.view", "warehouse.operate"],
    })),
    loadWarehouseContext: vi.fn(async () => ({
      selected: { id: "warehouse-1", name: "国内仓", warehouse_role: "domestic_collection" },
      selectedAccessLevel: "operator",
    })),
    requireWarehouseAssignment: vi.fn(async () => undefined),
    loadWorkflowFields: vi.fn(async () => []),
    loadGate: vi.fn(async () => ({
      configured: true,
      visible: true,
      available: state.gateAvailable,
      targetStepKey: "warehouse_receiving",
      targetStepName: "国内仓入库",
      reason: state.gateAvailable ? null : gateReason,
      legacyFallback: false,
    })),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/warehouse-context.server", () => ({ loadWarehouseContext: harness.loadWarehouseContext }));
vi.mock("../lib/warehouse-access.server", () => ({ requireWarehouseAssignment: harness.requireWarehouseAssignment }));
vi.mock("../lib/workflow-fields.server", () => ({ loadOrderModuleWorkflowFields: harness.loadWorkflowFields }));
vi.mock("../lib/warehouse-workflow-access.server", () => ({
  loadWarehousePhysicalWorkflowAccess: harness.loadGate,
}));

import { action, loader } from "./warehouse.acceptance";

function post() {
  return new Request("http://local.test/warehouse/acceptance?warehouseId=warehouse-1", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      orderId: "order-1",
      locationId: "location-1",
      receiptResult: "ready",
    }),
  });
}

describe("domestic warehouse acceptance frozen workflow gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.gateAvailable = false;
  });

  it("rejects a forged acceptance POST before any receipt mutation", async () => {
    await expect(action({
      request: post(),
      params: {},
      context: undefined,
    } as never)).resolves.toEqual({ formError: harness.gateReason });

    expect(harness.loadGate).toHaveBeenCalledWith(
      harness.DB,
      "org-1",
      "order-1",
      "warehouse",
      { userId: "warehouse-user", positionCode: "WAREHOUSE" },
    );
    expect(harness.loadWorkflowFields).not.toHaveBeenCalled();
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("uses the same gate for a scanned candidate and returns its reason to the UI", async () => {
    const result = await loader({
      request: new Request("http://local.test/warehouse/acceptance?warehouseId=warehouse-1&reference=SO-001"),
      params: {},
      context: undefined,
    } as never);

    expect(result.order).toBeNull();
    expect(result.lookupError).toBe(harness.gateReason);
    expect(harness.loadGate).toHaveBeenCalledWith(
      harness.DB,
      "org-1",
      "order-1",
      "warehouse",
      { userId: "warehouse-user", positionCode: "WAREHOUSE" },
    );
    expect(harness.loadWorkflowFields).not.toHaveBeenCalled();
  });
});
