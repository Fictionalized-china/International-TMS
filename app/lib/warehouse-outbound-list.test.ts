import { describe, expect, it } from "vitest";
import {
  filterWarehouseOutboundLoadUnits,
  isConsolidatedOutboundTask,
  normalizeWarehouseOutboundListFilters,
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

  it("requires the warehouse to confirm all outbound resources for a full-truck task", () => {
    expect(validateFtlOutboundResourceSelection({
      carrierId: "",
      vehicleId: "vehicle-1",
      driverId: "",
      plannedDepartureAt: "",
    })).toBe("请由仓库确认：境外承运商、出境司机、计划出境发车时间");
    expect(validateFtlOutboundResourceSelection({
      carrierId: "carrier-1",
      vehicleId: "vehicle-1",
      driverId: "driver-1",
      plannedDepartureAt: "2026-09-02T09:00",
    })).toBeNull();
  });
});
