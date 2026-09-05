import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const gateReason = "当前处于“出境运输”，进入“境外仓与自提”后自动开放";
  const shipment = {
    id: "shipment-1",
    status: "in_transit",
    order_id: "order-1",
    customer_id: "customer-1",
    shipment_number: "SH-001",
    order_number: "SO-001",
    customer_identity_code: "ABCD1234",
    customer_name: "客户一",
    origin_city: "深圳",
    destination_city: "塔什干",
    expected_warehouse_name: "境外仓",
    business_type: "ftl",
    cargo_description: "测试货物",
    pieces: 1,
    gross_weight_kg: 10,
    volume_cbm: 1,
  };
  const pkg = {
    id: "package-1",
    shipment_id: "shipment-1",
    order_id: "order-1",
    barcode: "PKG-001",
    package_number: "PKG-001",
    status: "dispatched",
    warehouse_id: "domestic-warehouse",
    source_warehouse_name: "国内仓",
    receipt_number: "IN-001",
    received_at: "2026-09-06T00:00:00.000Z",
    receipt_status: "completed",
    cargo_name: "测试货物",
    package_type: "carton",
    pieces: 1,
    weight_kg: 10,
    volume_cbm: 1,
    length_cm: 100,
    width_cm: 100,
    height_cm: 100,
  };
  const state = { loaderHasShipment: false };
  const queries: string[] = [];
  const DB = {
    prepare: vi.fn((sql: string) => {
      queries.push(sql);
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => {
          if (sql.includes("FROM warehouse_packages p")) return pkg;
          if (sql.includes("FROM shipments s JOIN transport_orders o") && sql.includes("WHERE s.id=?")) return shipment;
          return null;
        }),
        all: vi.fn(async () => {
          if (sql.includes("FROM shipments s JOIN transport_orders o")) {
            return { results: state.loaderHasShipment ? [shipment] : [] };
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
    shipment,
    pkg,
    state,
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
    loadWorkflowFields: vi.fn(async () => []),
    loadGate: vi.fn(async () => ({
      configured: true,
      visible: true,
      available: false,
      targetStepKey: "overseas_pickup",
      targetStepName: "境外仓与自提",
      reason: gateReason,
      legacyFallback: false,
    })),
    gateSql: vi.fn(() => ({ sql: "FROZEN_WAREHOUSE_GATE", values: ["overseas_warehouse"] })),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/warehouse-context.server", () => ({ loadWarehouseContext: harness.loadWarehouseContext }));
vi.mock("../lib/warehouse-access.server", () => ({ requireWarehouseAssignment: harness.requireWarehouseAssignment }));
vi.mock("../lib/workflow-fields.server", () => ({ loadOrderModuleWorkflowFields: harness.loadWorkflowFields }));
vi.mock("../lib/warehouse-workflow-access.server", () => ({
  loadWarehousePhysicalWorkflowAccess: harness.loadGate,
  warehousePhysicalWorkflowAccessSql: harness.gateSql,
}));

import { action, loader } from "./warehouse.inbound";

function post() {
  return new Request("http://local.test/warehouse/inbound?warehouseId=overseas-warehouse", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      shipmentId: "shipment-1",
      receiptResult: "ready",
      barcode: "PKG-001",
      locationId: "location-1",
    }),
  });
}

describe("overseas warehouse inbound frozen workflow gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.queries.length = 0;
    harness.state.loaderHasShipment = false;
  });

  it("rejects a forged inbound POST before any warehouse mutation", async () => {
    await expect(action({ request: post(), params: {}, context: undefined } as never))
      .resolves.toEqual({ formError: harness.gateReason });

    expect(harness.loadGate).toHaveBeenCalledWith(
      harness.DB,
      "org-1",
      "order-1",
      "overseas_warehouse",
      { userId: "warehouse-user", positionCode: "OVERSEAS_WAREHOUSE" },
    );
    expect(harness.loadWorkflowFields).not.toHaveBeenCalled();
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("filters candidates with the same frozen gate and shows its reason for a blocked scan", async () => {
    const result = await loader({
      request: new Request("http://local.test/warehouse/inbound?warehouseId=overseas-warehouse&reference=PKG-001"),
      params: {},
      context: undefined,
    } as never);

    expect(harness.gateSql).toHaveBeenCalledWith(
      "o",
      "overseas_warehouse",
      { userId: "warehouse-user", positionCode: "OVERSEAS_WAREHOUSE" },
    );
    expect(harness.queries.some((sql) => sql.includes("FROZEN_WAREHOUSE_GATE"))).toBe(true);
    expect(result.selectedShipment).toBeUndefined();
    expect(result.scannedPackage).toBeNull();
    expect(result.lookupError).toBe(harness.gateReason);
    expect(harness.loadGate).toHaveBeenCalledWith(
      harness.DB,
      "org-1",
      "order-1",
      "overseas_warehouse",
      { userId: "warehouse-user", positionCode: "OVERSEAS_WAREHOUSE" },
    );
  });
});
