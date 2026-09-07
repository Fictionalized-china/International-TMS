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
    customs_clearance_mode: "company",
    volume_cbm: 1,
  };
  const pkg = {
    id: "package-1",
    shipment_id: "shipment-1",
    order_id: "order-1",
    barcode: "PKG-001",
    package_number: "PKG-001",
    status: "dispatched",
    label_kind: "oul",
    lifecycle_status: "in_transit",
    warehouse_id: "domestic-warehouse",
    overseas_warehouse_id: "overseas-warehouse",
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
  const state = {
    loaderHasShipment: false,
    customsGates: [] as Array<Record<string, unknown>>,
    batchRows: [] as Array<Record<string, unknown>>,
  };
  const queries: string[] = [];
  const DB = {
    prepare: vi.fn((sql: string) => {
      queries.push(sql);
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => {
          if (sql.includes("FROM warehouse_packages p")) return pkg;
          if (sql.includes("FROM shipments s JOIN transport_orders o") && sql.includes("WHERE s.id=?")) return shipment;
          if (sql.includes("FROM order_tracking_milestones") && sql.includes("milestone_code='exported'")) return {
            event_at: "2026-09-06T01:00:00.000Z",
          };
          if (sql.includes("customs_clearance_mode") && sql.includes("exited")) return {
            exited: 1,
            order_number: shipment.order_number,
            customs_clearance_mode: "company",
          };
          return null;
        }),
        all: vi.fn(async () => {
          if (sql.includes("SELECT b.batch_number,b.road_status") || sql.includes("SELECT bo.order_id,o.overseas_warehouse_id")) {
            return { results: state.batchRows };
          }
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
      reason: gateReason as string | null,
      legacyFallback: false,
    })),
    gateSql: vi.fn(() => ({ sql: "FROZEN_WAREHOUSE_GATE", values: ["overseas_warehouse"] })),
    loadCustomsGates: vi.fn(async () => state.customsGates),
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
vi.mock("../lib/overseas-inbound-policy.server", () => ({
  loadOverseasInboundCustomsGates: harness.loadCustomsGates,
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
    harness.state.customsGates = [];
    harness.state.batchRows = [];
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

  it("shows the shared customs blocker at lookup time and does not open the receiving form", async () => {
    harness.state.loaderHasShipment = true;
    harness.state.customsGates = [{
      orderId: "order-1",
      required: true,
      cleared: false,
      blocked: true,
      configurationValid: true,
      targetStepKey: "destination_clearance",
      targetStepName: "目的地清关",
      message: "订单 SO-001 的冻结工作流要求先完成“目的地海关放行”（节点“目的地清关”）",
    }];

    const result = await loader({
      request: new Request("http://local.test/warehouse/inbound?warehouseId=overseas-warehouse&reference=PKG-001"),
      params: {},
      context: undefined,
    } as never);

    expect(harness.loadCustomsGates).toHaveBeenCalledWith("org-1", [{
      orderId: "order-1",
      orderNumber: "SO-001",
      customsClearanceMode: "company",
    }]);
    expect(result.lookupError).toContain("目的地海关放行");
    expect(result.selectedShipment).toBeUndefined();
    expect(result.scannedPackage).toBeNull();
    expect(harness.loadWorkflowFields).not.toHaveBeenCalled();
  });

  it("keeps the workbench open when the shared gate says a future or optional field is not blocking", async () => {
    harness.state.loaderHasShipment = true;
    harness.state.customsGates = [{
      orderId: "order-1",
      required: false,
      cleared: false,
      blocked: false,
      configurationValid: true,
      targetStepKey: "future_customs",
      targetStepName: "后续清关",
      message: null,
    }];

    const result = await loader({
      request: new Request("http://local.test/warehouse/inbound?warehouseId=overseas-warehouse&reference=PKG-001"),
      params: {},
      context: undefined,
    } as never);

    expect(result.lookupError).toBe("");
    expect(result.selectedShipment).toEqual(harness.shipment);
    expect(result.scannedPackage).toEqual(harness.pkg);
    expect(harness.loadWorkflowFields).toHaveBeenCalled();
  });

  it("uses the same dynamic customs reason for a forged POST before mutation", async () => {
    harness.loadGate.mockResolvedValueOnce({
      configured: true,
      visible: true,
      available: true,
      targetStepKey: "overseas_pickup",
      targetStepName: "境外仓与自提",
      reason: null,
      legacyFallback: false,
    });
    harness.state.customsGates = [{
      orderId: "order-1",
      required: true,
      cleared: false,
      blocked: true,
      configurationValid: true,
      targetStepKey: "destination_clearance",
      targetStepName: "目的地清关",
      message: "订单 SO-001 的冻结工作流要求先完成“目的地海关放行”（节点“目的地清关”）",
    }];

    await expect(action({ request: post(), params: {}, context: undefined } as never))
      .resolves.toEqual({ formError: harness.state.customsGates[0].message });

    expect(harness.loadCustomsGates).toHaveBeenCalledWith("org-1", [{
      orderId: "order-1",
      orderNumber: "SO-001",
      customsClearanceMode: "company",
    }]);
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("limits a PZ warehouse entry to its database-mounted orders", async () => {
    harness.state.loaderHasShipment = true;
    harness.state.batchRows = [{
      batch_number: "PZ-001",
      road_status: "outbound_in_transit",
      order_id: "order-2",
      order_number: "SO-002",
      overseas_warehouse_id: "overseas-warehouse",
    }];

    const result = await loader({
      request: new Request("http://local.test/warehouse/inbound?warehouseId=overseas-warehouse&batchId=batch-1&orderIds=order-2&reference=PKG-001"),
      params: {},
      context: undefined,
    } as never);

    expect(result.batchContext).toEqual({
      id: "batch-1",
      number: "PZ-001",
      orderIds: ["order-2"],
      orderNumbers: ["SO-002"],
      error: "",
    });
    expect(result.selectedShipment).toBeUndefined();
    expect(result.lookupError).toContain("不属于当前 PZ 配载单");
    expect(harness.loadCustomsGates).not.toHaveBeenCalled();
    expect(harness.loadWorkflowFields).not.toHaveBeenCalled();
  });

  it("opens one scanned order inside a valid PZ prefilter and keeps customs evaluation", async () => {
    harness.state.loaderHasShipment = true;
    harness.state.batchRows = [{
      batch_number: "PZ-001",
      road_status: "outbound_in_transit",
      order_id: "order-1",
      order_number: "SO-001",
      overseas_warehouse_id: "overseas-warehouse",
    }];
    harness.state.customsGates = [{
      orderId: "order-1",
      required: false,
      cleared: false,
      blocked: false,
      configurationValid: true,
      targetStepKey: "future_customs",
      targetStepName: "后续清关",
      message: null,
    }];

    const result = await loader({
      request: new Request("http://local.test/warehouse/inbound?warehouseId=overseas-warehouse&batchId=batch-1&orderIds=order-1&reference=PKG-001"),
      params: {},
      context: undefined,
    } as never);

    expect(result.batchContext?.orderIds).toEqual(["order-1"]);
    expect(result.selectedShipment).toEqual(harness.shipment);
    expect(result.scannedPackage).toEqual(harness.pkg);
    expect(result.lookupError).toBe("");
    expect(harness.loadCustomsGates).toHaveBeenCalledWith("org-1", [{
      orderId: "order-1",
      orderNumber: "SO-001",
      customsClearanceMode: "company",
    }]);
  });

  it("blocks the PZ entry explicitly before the overseas receiving stage opens", async () => {
    harness.state.loaderHasShipment = true;
    harness.state.batchRows = [{
      batch_number: "PZ-001",
      road_status: "loading",
      order_id: "order-1",
      order_number: "SO-001",
      overseas_warehouse_id: "overseas-warehouse",
    }];

    const result = await loader({
      request: new Request("http://local.test/warehouse/inbound?warehouseId=overseas-warehouse&batchId=batch-1&orderIds=order-1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.batchContext?.error).toContain("尚未进入境外目的仓收货阶段");
    expect(result.batchContext?.orderIds).toEqual([]);
    expect(result.selectedShipment).toBeUndefined();
  });

  it("rejects a forged POST outside the PZ query scope before workflow mutation", async () => {
    const request = new Request("http://local.test/warehouse/inbound?warehouseId=overseas-warehouse&batchId=batch-1&orderIds=order-2", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        shipmentId: "shipment-1",
        receiptResult: "ready",
        barcode: "PKG-001",
        locationId: "location-1",
      }),
    });

    await expect(action({ request, params: {}, context: undefined } as never)).resolves.toEqual({
      formError: "当前 PZ 挂载范围或目的仓与数据库记录不一致，已拒绝收货提交",
    });
    expect(harness.loadGate).not.toHaveBeenCalled();
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });

  it("keeps the frozen workflow gate after a valid PZ scope is verified", async () => {
    harness.state.batchRows = [{
      batch_number: "PZ-001",
      road_status: "outbound_in_transit",
      order_id: "order-1",
      order_number: "SO-001",
      overseas_warehouse_id: "overseas-warehouse",
    }];
    const request = new Request("http://local.test/warehouse/inbound?warehouseId=overseas-warehouse&batchId=batch-1&orderIds=order-1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        shipmentId: "shipment-1",
        receiptResult: "ready",
        barcode: "PKG-001",
        locationId: "location-1",
      }),
    });

    await expect(action({ request, params: {}, context: undefined } as never)).resolves.toEqual({
      formError: harness.gateReason,
    });
    expect(harness.loadGate).toHaveBeenCalledWith(
      harness.DB,
      "org-1",
      "order-1",
      "overseas_warehouse",
      { userId: "warehouse-user", positionCode: "OVERSEAS_WAREHOUSE" },
    );
    expect(harness.DB.batch).not.toHaveBeenCalled();
  });
});
