import { beforeEach, describe, expect, it, vi } from "vitest";

type OperationalOrder = {
  business_type: string;
  customs_enabled: number;
  warehouse_enabled: number;
  exit_port: string | null;
  overseas_warehouse_id: string | null;
};

type MockStatement = {
  sql: string;
  bindings: unknown[];
  bind: (...bindings: unknown[]) => MockStatement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
};

const state = vi.hoisted(() => ({
  order: null as OperationalOrder | null,
  workflowFields: new Map<string, Array<Record<string, unknown>>>(),
  moduleModes: new Map<string, { module_code: string; enabled: number; is_required: number }>(),
  moduleBlocker: null as { module_name: string } | null,
  ltlPlan: null as Record<string, unknown> | null,
  firstMileAssignment: null as Record<string, unknown> | null,
  mainAssignment: null as { plate_number: string } | null,
  legacyWarehouseReceipt: null as Record<string, unknown> | null,
  warehouseDispatch: null as Record<string, unknown> | null,
  customsDeclarations: [] as Array<{
    clearance_stage: string;
    status: string;
    is_deleted: number;
  }>,
  approvedDocuments: [] as Array<{ document_category: string }>,
  preparedSql: [] as string[],
}));

vi.mock("./workflow-fields.server", () => ({
  loadOrderModuleWorkflowFields: vi.fn(
    async (_organizationId: string, _orderId: string, moduleCode: string) =>
      state.workflowFields.get(moduleCode) ?? [],
  ),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    DB: {
      prepare(sql: string) {
        state.preparedSql.push(sql);
        const statement: MockStatement = {
          sql,
          bindings: [],
          bind(...bindings: unknown[]) {
            statement.bindings = bindings;
            return statement;
          },
          async first<T>() {
            if (sql.includes("FROM transport_orders o")) return state.order as T | null;
            if (sql.includes("SELECT module_name FROM order_module_instances"))
              return state.moduleBlocker as T | null;
            if (sql.includes("COUNT(DISTINCT v.id) vehicle_count"))
              return state.ltlPlan as T | null;
            if (sql.includes("leg_type='first_mile'"))
              return state.firstMileAssignment as T | null;
            if (sql.includes("leg_type='main'"))
              return state.mainAssignment as T | null;
            if (sql.includes("FROM warehouse_receipts r JOIN shipments s"))
              return state.legacyWarehouseReceipt as T | null;
            if (sql.includes("FROM order_module_instances mi") && sql.includes("warehouse_dispatches"))
              return state.warehouseDispatch as T | null;
            return null;
          },
          async all<T>() {
            if (sql.includes("SELECT module_code,enabled,is_required FROM order_module_instances"))
              return { results: [...state.moduleModes.values()] as T[] };
            if (sql.includes("FROM order_customs_declarations d"))
              return { results: [...state.customsDeclarations] as T[] };
            if (sql.includes("SELECT DISTINCT document_category"))
              return { results: [...state.approvedDocuments] as T[] };
            return { results: [] as T[] };
          },
        };
        return statement;
      },
    },
  },
}));

import {
  checkOrderDeparture,
  checkOrderLoadPlan,
  checkOrderPreDepartureDocuments,
} from "./order-readiness.server";

function field(
  moduleCode: string,
  fieldKey: string,
  mode: "required" | "optional" | "hidden",
  present = false,
  stepKey = moduleCode === "warehouse" ? "warehouse_receiving" : "port_loading",
) {
  return {
    id: `${moduleCode}-${fieldKey}`,
    workflowId: "workflow-1",
    stepKey,
    stepName: stepKey,
    moduleCode,
    fieldKey,
    label: fieldKey,
    fieldType: "text",
    isRequired: mode === "required",
    isActive: mode !== "hidden",
    mode,
    sortOrder: 10,
    optionsText: null,
    helpText: null,
    isBuiltIn: true,
    present,
    displayValue: present ? "已填写" : null,
  };
}

function setFields(moduleCode: string, fields: Array<Record<string, unknown>>) {
  state.workflowFields.set(moduleCode, fields);
}

function frozenModule(
  moduleCode: string,
  stepKey: string,
  stepName: string,
) {
  return {
    ...field(moduleCode, "__frozen_workflow_field_scope__", "hidden", true, stepKey),
    id: `${moduleCode}-scope-${stepKey}`,
    stepName,
    fieldType: "scope",
  };
}

function baseOrder(overrides: Partial<OperationalOrder> = {}): OperationalOrder {
  return {
    business_type: "other",
    customs_enabled: 0,
    warehouse_enabled: 0,
    exit_port: "PORT-1",
    overseas_warehouse_id: "warehouse-overseas",
    ...overrides,
  };
}

function configureNonBlockingFields() {
  setFields("consignment", [
    field("consignment", "business_type", "optional", true, "order_creation"),
    field("consignment", "exit_port", "optional", true, "order_creation"),
    field("consignment", "overseas_warehouse_id", "optional", true, "order_creation"),
    field("consignment", "document_consignment_letter", "hidden", false, "order_creation"),
  ]);
  setFields("warehouse", [field("warehouse", "warehouse_receipt", "optional")]);
  setFields("loading", [
    field("loading", "exit_port", "optional", true),
    field("loading", "loading_scan_confirmation", "hidden"),
  ]);
  setFields("transport", [
    field("transport", "domestic_plate_number", "optional", true, "domestic_execution"),
  ]);
  setFields("customs", [
    field("customs", "customs_declarations", "hidden", false, "outbound_transport"),
    field("customs", "customs_release", "hidden", false, "outbound_transport"),
    field("customs", "document_commercial_invoice", "hidden", false, "outbound_transport"),
    field("customs", "document_packing_list", "hidden", false, "outbound_transport"),
    field("customs", "document_customs_document", "hidden", false, "outbound_transport"),
  ]);
}

describe("order readiness follows the bound workflow field modes", () => {
  beforeEach(() => {
    state.order = baseOrder();
    state.workflowFields.clear();
    state.moduleModes.clear();
    state.moduleBlocker = null;
    state.ltlPlan = null;
    state.firstMileAssignment = null;
    state.mainAssignment = null;
    state.legacyWarehouseReceipt = null;
    state.warehouseDispatch = null;
    state.customsDeclarations.length = 0;
    state.approvedDocuments.length = 0;
    state.preparedSql.length = 0;
    configureNonBlockingFields();
  });

  it("uses the loading rule when an identically named consignment field is optional", async () => {
    state.order = baseOrder({ exit_port: null });
    setFields("loading", [
      field("loading", "exit_port", "required", false),
      field("loading", "loading_scan_confirmation", "hidden"),
    ]);

    const result = await checkOrderLoadPlan("org-1", "order-1");

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("订单尚未确定出境口岸");
  });

  it("keeps required consignment gates when the frozen module legitimately spans multiple steps", async () => {
    state.order = baseOrder({ overseas_warehouse_id: null });
    setFields("consignment", [
      field("consignment", "overseas_warehouse_id", "required", false, "order_creation"),
      frozenModule("consignment", "quotation", "询价报价"),
      frozenModule("consignment", "order_creation", "委托资料补充"),
      frozenModule("consignment", "consignment_approval", "委托审核"),
    ]);

    const result = await checkOrderLoadPlan("org-1", "order-1");

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("订单尚未确定境外目的仓");
    expect(result.reasons.some((reason)=>reason.includes("重复办理节点"))).toBe(false);
  });

  it("fails pre-departure documents closed when a frozen module placement is malformed", async () => {
    setFields("transport", [
      frozenModule("transport", "domestic_execution", "国内运输"),
      frozenModule("transport", "duplicate_transport", "重复国内运输"),
    ]);

    const result = await checkOrderPreDepartureDocuments("org-1", "order-1");

    expect(result).toEqual({
      ready: false,
      reasons: ["国内运输冻结工作流配置异常：模块存在重复办理节点"],
    });
  });

  it("lets an unresolved transport type pass only when that field is non-required", async () => {
    state.order = baseOrder({ business_type: "pending" });
    setFields("consignment", [
      field("consignment", "business_type", "optional", false, "order_creation"),
      field("consignment", "exit_port", "optional", true, "order_creation"),
      field("consignment", "overseas_warehouse_id", "optional", true, "order_creation"),
    ]);

    const optional = await checkOrderLoadPlan("org-1", "order-1");
    setFields("consignment", [
      field("consignment", "business_type", "required", false, "order_creation"),
      field("consignment", "exit_port", "optional", true, "order_creation"),
      field("consignment", "overseas_warehouse_id", "optional", true, "order_creation"),
    ]);
    const required = await checkOrderLoadPlan("org-1", "order-1");

    expect(optional.ready).toBe(true);
    expect(required.reasons).toContain("已接受报价尚未确定本单是整车还是拼车");
  });

  it("does not let an optional warehouse receipt field block loading", async () => {
    state.order = baseOrder({ warehouse_enabled: 1 });

    const optional = await checkOrderLoadPlan("org-1", "order-1");
    setFields("warehouse", [field("warehouse", "warehouse_receipt", "required")]);
    const required = await checkOrderLoadPlan("org-1", "order-1");

    expect(optional.ready).toBe(true);
    expect(required.ready).toBe(false);
    expect(required.reasons).toContain("国内仓入库必填项未完成：warehouse_receipt");
  });

  it("uses a custom frozen warehouse target instead of the canonical warehouse step", async () => {
    state.order = baseOrder({ warehouse_enabled: 1 });
    setFields("warehouse", [
      field("warehouse", "warehouse_receipt", "required", false, "custom_inbound"),
      frozenModule("warehouse", "custom_inbound", "自定义入仓复核"),
    ]);

    const result = await checkOrderLoadPlan("org-1", "order-1");

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("“自定义入仓复核”必填项未完成：warehouse_receipt");
  });

  it("uses a custom frozen loading target instead of port_loading", async () => {
    state.order = baseOrder({ business_type: "ftl" });
    setFields("loading", [
      field("loading", "loading_instruction", "required", false, "custom_loading"),
      frozenModule("loading", "custom_loading", "自定义装车复核"),
    ]);

    const result = await checkOrderLoadPlan("org-1", "order-1");

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("“自定义装车复核”必填项未完成：loading_instruction");
  });

  it("fails closed when a frozen loading module has no valid placement", async () => {
    setFields("loading", [
      frozenModule("loading", "__frozen_unplaced_module__", "无有效节点"),
    ]);

    const result = await checkOrderLoadPlan("org-1", "order-1");

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("装车与出库冻结工作流配置异常：模块缺少有效办理节点");
  });

  it("does not query or block customs when declaration and release are optional or hidden", async () => {
    state.order = baseOrder({ customs_enabled: 1 });
    setFields("customs", [
      field("customs", "customs_declarations", "optional", false, "outbound_transport"),
      field("customs", "customs_release", "hidden", false, "outbound_transport"),
      field("customs", "document_commercial_invoice", "hidden", false, "outbound_transport"),
      field("customs", "document_packing_list", "hidden", false, "outbound_transport"),
      field("customs", "document_customs_document", "hidden", false, "outbound_transport"),
    ]);

    const result = await checkOrderDeparture("org-1", "order-1");

    expect(result).toEqual({ ready: true, reasons: [] });
    expect(
      state.preparedSql.some((sql) => sql.includes("FROM order_customs_declarations d")),
    ).toBe(false);
  });

  it("does not let required fields in an optional customs module block departure", async () => {
    state.order = baseOrder({ customs_enabled: 1 });
    state.moduleModes.set("customs", { module_code: "customs", enabled: 1, is_required: 0 });
    setFields("customs", [
      field("customs", "customs_declarations", "required", false, "outbound_transport"),
      field("customs", "customs_release", "required", false, "outbound_transport"),
      field("customs", "document_commercial_invoice", "required", false, "outbound_transport"),
    ]);

    const result = await checkOrderDeparture("org-1", "order-1");

    expect(result).toEqual({ ready: true, reasons: [] });
    expect(state.preparedSql.some((sql) => sql.includes("FROM order_customs_declarations d"))).toBe(false);
    expect(state.preparedSql.some((sql) => sql.includes("SELECT DISTINCT document_category"))).toBe(false);
  });

  it("does not let required loading fields in an optional module create a load-plan gate", async () => {
    state.order = baseOrder({ business_type: "ltl" });
    state.moduleModes.set("loading", { module_code: "loading", enabled: 1, is_required: 0 });
    setFields("loading", [field("loading", "main_plate_number", "required", false)]);

    const result = await checkOrderLoadPlan("org-1", "order-1");

    expect(result).toEqual({ ready: true, reasons: [] });
  });

  it("blocks an unreleased origin declaration only when customs release is required", async () => {
    state.order = baseOrder({ customs_enabled: 1 });
    state.customsDeclarations.push({
      clearance_stage: "origin",
      status: "declared",
      is_deleted: 0,
    });
    setFields("customs", [
      field("customs", "customs_declarations", "optional", true, "outbound_transport"),
      field("customs", "customs_release", "required", false, "outbound_transport"),
    ]);

    const result = await checkOrderDeparture("org-1", "order-1");

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("起运地报关尚未全部放行（已放行 0/1 张）");
  });

  it("allows a transit declaration when declarations are required but origin release is optional", async () => {
    state.order = baseOrder({ customs_enabled: 1 });
    state.customsDeclarations.push({
      clearance_stage: "transit",
      status: "declared",
      is_deleted: 0,
    });
    setFields("customs", [
      field("customs", "customs_declarations", "required", true, "outbound_transport"),
      field("customs", "customs_release", "optional", false, "outbound_transport"),
    ]);

    const result = await checkOrderDeparture("org-1", "order-1");

    expect(result).toEqual({ ready: true, reasons: [] });
  });

  it("requires warehouse dispatch only when scan confirmation is required", async () => {
    state.order = baseOrder({ warehouse_enabled: 1 });
    setFields("loading", [
      field("loading", "exit_port", "optional", true),
      field("loading", "loading_scan_confirmation", "optional"),
    ]);

    const optional = await checkOrderDeparture("org-1", "order-1");
    setFields("loading", [
      field("loading", "exit_port", "optional", true),
      field("loading", "loading_scan_confirmation", "required"),
    ]);
    const required = await checkOrderDeparture("org-1", "order-1");

    expect(optional.ready).toBe(true);
    expect(required.ready).toBe(false);
    expect(required.reasons).toContain("仓库尚未完成实际装车与出库交接");
  });

  it("treats an actual-plate mismatch as nonblocking for optional plate fields", async () => {
    state.order = baseOrder({ business_type: "ltl" });
    state.ltlPlan = {
      id: "batch-1",
      vehicle_count: 1,
      plated_vehicle_count: 1,
      typed_vehicle_count: 1,
      driver_vehicle_count: 1,
      phoned_vehicle_count: 1,
      carrier_ready: 1,
      warehouse_ready: 1,
      port_ready: 1,
      customs_location_ready: 1,
      departure_ready: 1,
      arrival_ready: 1,
      plate_match: 0,
    };
    setFields("loading", [field("loading", "main_plate_number", "optional", true)]);

    const optional = await checkOrderLoadPlan("org-1", "order-1", "ACTUAL-1");
    setFields("loading", [field("loading", "main_plate_number", "required", true)]);
    const required = await checkOrderLoadPlan("org-1", "order-1", "ACTUAL-1");

    expect(optional.ready).toBe(true);
    expect(required.ready).toBe(false);
    expect(required.reasons).toContain("车牌 ACTUAL-1 不在当前配载计划中");
  });

  it("checks every vehicle for a required driver phone", async () => {
    state.order = baseOrder({ business_type: "ltl" });
    state.ltlPlan = {
      id: "batch-1",
      vehicle_count: 2,
      plated_vehicle_count: 2,
      typed_vehicle_count: 2,
      driver_vehicle_count: 2,
      phoned_vehicle_count: 1,
      carrier_ready: 1,
      warehouse_ready: 1,
      port_ready: 1,
      customs_location_ready: 1,
      departure_ready: 1,
      arrival_ready: 1,
      plate_match: 1,
    };
    setFields("loading", [field("loading", "main_driver_phone", "required", true)]);

    const result = await checkOrderLoadPlan("org-1", "order-1");

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("配载车辆尚未完整登记司机电话");
  });

  it("only treats blocked or exceptional modules as gates when the module is required", async () => {
    await checkOrderLoadPlan("org-1", "order-1");

    const blockerQuery = state.preparedSql.find((sql) =>
      sql.includes("SELECT module_name FROM order_module_instances"),
    );
    expect(blockerQuery).toContain("is_required=1");
  });

  describe("full-truck warehouse creation context", () => {
    const completeSubmission = {
      exitPort: "HORGOS",
      customsLocation: "URUMQI",
      carrierId: "carrier-1",
      vehicleCount: 1,
      vehicleType: "厢式货车",
      vehiclePlate: "粤B12345",
      driverName: "测试司机",
      driverPhone: "13800000000",
      plannedDepartureAt: "2026-09-06T09:00",
      plannedArrivalAt: "2026-09-09T09:00",
    };

    const creationFieldModes = (
      mode: "required" | "optional" | "hidden" = "required",
    ) => [
      field("loading", "exit_port", mode, false),
      field("loading", "customs_location", mode, false),
      field("loading", "main_carrier_id", mode, false),
      field("loading", "main_vehicle_type", mode, false),
      field("loading", "main_plate_number", mode, false),
      field("loading", "main_driver_name", mode, false),
      field("loading", "main_driver_phone", mode, false),
      field("loading", "planned_exit_at", mode, false),
      field("loading", "planned_arrival_at", mode, false),
    ];

    const overseasCreationFieldModes = (
      mode: "required" | "optional" | "hidden" = "required",
    ) => [
      field("loading", "overseas_carrier_name", mode, false),
      field("loading", "overseas_vehicle_type", mode, false),
      field("loading", "overseas_vehicle_count", mode, false),
      field("loading", "overseas_vehicle_plate", mode, false),
      field("loading", "overseas_driver_name", mode, false),
      field("loading", "overseas_driver_phone", mode, false),
    ];

    beforeEach(() => {
      state.order = baseOrder({ business_type: "ftl", exit_port: null });
      setFields("loading", creationFieldModes());
    });

    it("keeps strict readiness as the default for existing callers", async () => {
      const result = await checkOrderLoadPlan("org-1", "order-1");

      expect(result.ready).toBe(false);
      expect(result.reasons).toContain("订单尚未确定出境口岸");
      expect(result.reasons.some((reason) => reason.includes("整车装车方案必填项未完成")))
        .toBe(true);
    });

    it("lets the warehouse enter an FTL creation page when every blocker is supplied on that page", async () => {
      const result = await checkOrderLoadPlan(
        "org-1",
        "order-1",
        undefined,
        undefined,
        { mode: "entry" },
      );

      expect(result).toEqual({ ready: true, reasons: [] });
    });

    it("also defers overseas transport aliases supplied by the FTL creation page", async () => {
      setFields("loading", [
        ...creationFieldModes(),
        ...overseasCreationFieldModes(),
      ]);

      const result = await checkOrderLoadPlan(
        "org-1",
        "order-1",
        undefined,
        undefined,
        { mode: "entry" },
      );

      expect(result).toEqual({ ready: true, reasons: [] });
    });

    it("validates overseas transport aliases from the current FTL selection", async () => {
      setFields("loading", [
        ...creationFieldModes(),
        ...overseasCreationFieldModes(),
      ]);

      const result = await checkOrderLoadPlan(
        "org-1",
        "order-1",
        undefined,
        undefined,
        {
          mode: "submit",
          values: completeSubmission,
        },
      );

      expect(result).toEqual({ ready: true, reasons: [] });
    });

    it("rejects a required overseas vehicle count when no vehicle is selected", async () => {
      setFields("loading", overseasCreationFieldModes());

      const result = await checkOrderLoadPlan(
        "org-1",
        "order-1",
        undefined,
        undefined,
        {
          mode: "submit",
          values: { ...completeSubmission, vehicleCount: 0 },
        },
      );

      expect(result.ready).toBe(false);
      expect(result.reasons.some((reason) => reason.includes("overseas_vehicle_count"))).toBe(true);
    });

    it("does not defer a required consignment exit port at FTL creation entry", async () => {
      setFields("consignment", [
        field("consignment", "business_type", "optional", true, "order_creation"),
        field("consignment", "exit_port", "required", false, "order_creation"),
        field("consignment", "overseas_warehouse_id", "optional", true, "order_creation"),
      ]);

      const result = await checkOrderLoadPlan(
        "org-1",
        "order-1",
        undefined,
        undefined,
        { mode: "entry" },
      );

      expect(result).toEqual({
        ready: false,
        reasons: ["订单尚未确定出境口岸"],
      });
    });

    it("does not defer a loading field that the FTL creation page does not provide", async () => {
      setFields("loading", [
        ...creationFieldModes(),
        field("loading", "loading_instruction", "required", false),
      ]);

      const result = await checkOrderLoadPlan(
        "org-1",
        "order-1",
        undefined,
        undefined,
        { mode: "entry" },
      );

      expect(result).toEqual({
        ready: false,
        reasons: ["整车装车方案必填项未完成：loading_instruction"],
      });
    });

    it("prevalidates an FTL submit from the current resolved values instead of stale database presence", async () => {
      const result = await checkOrderLoadPlan(
        "org-1",
        "order-1",
        undefined,
        undefined,
        { mode: "submit", values: completeSubmission },
      );

      expect(result).toEqual({ ready: true, reasons: [] });
    });

    it.each([
      ["exitPort", "exit_port"],
      ["customsLocation", "customs_location"],
      ["carrierId", "main_carrier_id"],
      ["vehicleType", "main_vehicle_type"],
      ["vehiclePlate", "main_plate_number"],
      ["driverName", "main_driver_name"],
      ["driverPhone", "main_driver_phone"],
      ["plannedDepartureAt", "planned_exit_at"],
      ["plannedArrivalAt", "planned_arrival_at"],
    ] as const)("blocks submit when current %s is missing", async (valueKey, fieldKey) => {
      const result = await checkOrderLoadPlan(
        "org-1",
        "order-1",
        undefined,
        undefined,
        {
          mode: "submit",
          values: { ...completeSubmission, [valueKey]: "" },
        },
      );

      expect(result).toEqual({
        ready: false,
        reasons: valueKey === "exitPort"
          ? ["订单尚未确定出境口岸"]
          : [`整车装车方案必填项未完成：${fieldKey}`],
      });
    });

    it.each(["optional", "hidden"] as const)(
      "does not block submit when current creation fields are %s and empty",
      async (mode) => {
        setFields("loading", creationFieldModes(mode));

        const result = await checkOrderLoadPlan(
          "org-1",
          "order-1",
          undefined,
          undefined,
          {
            mode: "submit",
            values: {
              exitPort: "",
              customsLocation: "",
              carrierId: "",
              vehicleType: "",
              vehicleCount: 0,
              vehiclePlate: "",
              driverName: "",
              driverPhone: "",
              plannedDepartureAt: "",
              plannedArrivalAt: "",
            },
          },
        );

        expect(result).toEqual({ ready: true, reasons: [] });
      },
    );
  });

  it("uses the custom frozen customs target for departure readiness", async () => {
    state.order = baseOrder({ customs_enabled: 1 });
    setFields("customs", [
      field("customs", "customs_declarations", "optional", true, "custom_customs"),
      field("customs", "customs_release", "optional", true, "custom_customs"),
      field("customs", "declaration_number", "required", false, "custom_customs"),
      frozenModule("customs", "custom_customs", "自定义报关核验"),
    ]);

    const result = await checkOrderDeparture("org-1", "order-1");

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("“自定义报关核验”必填资料未补齐：declaration_number");
  });
});
