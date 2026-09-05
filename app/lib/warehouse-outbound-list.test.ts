import { describe, expect, it } from "vitest";
import {
  findWarehouseOutboundLoadUnit,
  filterWarehouseOutboundLoadUnits,
  isConsolidatedOutboundTask,
  normalizeWarehouseOutboundListFilters,
  validateFtlOutboundRouteSubmission,
  validateFtlOutboundRouteFields,
  validateFtlOutboundResourceSelection,
} from "./warehouse-outbound-list";

const units = [
  {
    order_number: "SO-FTL-001",
    batch_number: "SORT-001",
    order_numbers: "SO-FTL-001",
    customer_name: "测试客户甲",
    customer_names: "测试客户甲",
    customer_identity_code: "A2B3C",
    customer_identity_codes: "A2B3C",
    destination_location: "乌兹别克斯坦 塔什干",
    business_type: "ftl",
    ready: true,
  },
  {
    order_number: "SO-LTL-002",
    batch_number: "PZ-002",
    order_numbers: "SO-LTL-002、SO-LTL-003",
    customer_name: "测试客户乙",
    customer_names: "测试客户乙、测试客户丙",
    customer_identity_code: "D4E5F",
    customer_identity_codes: "D4E5F、G6H7J",
    destination_location: "哈萨克斯坦 阿拉木图",
    business_type: "ltl",
    ready: false,
  },
];

describe("warehouse outbound order list", () => {
  it("normalizes invalid URL filters to the complete in-warehouse list", () => {
    expect(normalizeWarehouseOutboundListFilters(new URLSearchParams("q=SO&type=other&readiness=unknown"))).toEqual({
      query: "SO",
      businessType: "all",
      readiness: "all",
    });
  });

  it("filters by readiness, transport type and searchable business identifiers", () => {
    expect(filterWarehouseOutboundLoadUnits(units, { query: "PZ-002", businessType: "ltl", readiness: "blocked" }))
      .toEqual([units[1]]);
    expect(filterWarehouseOutboundLoadUnits(units, { query: "测试客户甲", businessType: "all", readiness: "ready" }))
      .toEqual([units[0]]);
  });

  it("never treats a full-truck task as a consolidation task", () => {
    expect(isConsolidatedOutboundTask("ftl", "legacy-batch-id")).toBe(false);
    expect(isConsolidatedOutboundTask("ltl", "pz-batch-id")).toBe(true);
    expect(isConsolidatedOutboundTask("ltl", null)).toBe(false);
  });

  it("opens the same loading-task unit from either the warehouse batch or PZ batch id", () => {
    const loadUnits = [
      { id: "sorting-batch-1", transport_batch_id: "pz-batch-1" },
      { id: "sorting-batch-2", transport_batch_id: null },
    ];
    expect(findWarehouseOutboundLoadUnit(loadUnits, "sorting-batch-1")).toBe(loadUnits[0]);
    expect(findWarehouseOutboundLoadUnit(loadUnits, "pz-batch-1")).toBe(loadUnits[0]);
    expect(findWarehouseOutboundLoadUnit(loadUnits, "missing")).toBeNull();
  });

  it("requires only workflow-required outbound resources for a full-truck task", () => {
    expect(validateFtlOutboundResourceSelection({
      carrierId: "",
      vehicleId: "vehicle-1",
      driverId: "",
      plannedDepartureAt: "",
      policies: {
        carrier: { isActive: true, isRequired: false },
        vehicle: { isActive: true, isRequired: true },
        driver: { isActive: true, isRequired: false },
        plannedDeparture: { isActive: false, isRequired: false },
      },
    })).toBeNull();
    expect(validateFtlOutboundResourceSelection({
      carrierId: "",
      vehicleId: "",
      driverId: "",
      plannedDepartureAt: "",
      policies: {
        carrier: { isActive: true, isRequired: false },
        vehicle: { isActive: true, isRequired: true },
        driver: { isActive: true, isRequired: false },
        plannedDeparture: { isActive: false, isRequired: false },
      },
    })).toBe("请由仓库确认工作流必填项：出境车辆");
  });

  it("rejects attempts to submit fields hidden by the workflow", () => {
    expect(validateFtlOutboundResourceSelection({
      carrierId: "carrier-1",
      vehicleId: "",
      driverId: "",
      plannedDepartureAt: "2026-09-02T09:00",
      policies: {
        carrier: { isActive: false, isRequired: false },
        vehicle: { isActive: false, isRequired: false },
        driver: { isActive: false, isRequired: false },
        plannedDeparture: { isActive: false, isRequired: false },
      },
    })).toBe("当前工作流已隐藏：境外承运商、计划出境发车时间，不能提交这些字段");
  });

  it("validates full-truck route fields against the effective workflow rules", () => {
    expect(validateFtlOutboundRouteFields({
      exitPort: "",
      customsLocation: "",
      policies: {
        exit_port: { isRequired: true },
        customs_location: { isRequired: false },
      },
    })).toBe("请补齐工作流必填项：出境口岸");
    expect(validateFtlOutboundRouteFields({
      exitPort: "霍尔果斯口岸",
      customsLocation: "",
      policies: {
        exit_port: { isRequired: true },
        customs_location: { isRequired: false },
      },
    })).toBeNull();
  });

  it("rejects a route-field mutation when that field is hidden", () => {
    expect(validateFtlOutboundRouteSubmission({
      exitPort: "HORGOS",
      customsLocation: "",
      policies: {
        exit_port: { isActive: false },
        customs_location: { isActive: true },
      },
    })).toBe("当前工作流已隐藏出境口岸，不能在此登记");
  });
});
