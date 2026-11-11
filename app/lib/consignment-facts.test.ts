import { describe, expect, it } from "vitest";
import { consignmentCargoSummary, consignmentIntakeOperations } from "./consignment-facts";

const row = { declared_quantity: 10, declared_unit: "台", package_count: 2, pieces_per_package: 1, gross_weight_per_package_kg: 12, volume_per_package_cbm: 0 };
describe("current consignment display facts", () => {
  it("keeps actual services instead of the initial plan, including completed service", () => {
    const raw = JSON.stringify({ headCarrier: "头程计划", entrustedServices: ["pickup", "warehouse"] });
    const services = [{ service_code: "pickup", status: "cancelled" }, { service_code: "packing", status: "requested" }, { service_code: "warehouse", status: "completed" }];
    expect(consignmentIntakeOperations(raw, services)).toEqual({ headCarrier: "头程计划", entrustedServices: ["packing", "warehouse"] });
    expect(JSON.parse(raw).entrustedServices).toEqual(["pickup", "warehouse"]);
  });
  it("does not fall back to opening services when all actual services are cancelled", () => {
    expect(consignmentIntakeOperations(JSON.stringify({ entrustedServices: ["pickup"] }), [{ service_code: "pickup", status: "cancelled" }]).entrustedServices).toEqual([]);
  });
  it("separates declared quantity from planned packages and physical measurements", () => {
    expect(consignmentCargoSummary([row], "件")).toEqual({ quantityLabel: "10 台", packageCount: 2, grossWeight: 24, volume: 0 });
  });
  it("groups the same product unit without adding unlike units", () => {
    expect(consignmentCargoSummary([row, { ...row, declared_quantity: 3 }, { ...row, declared_quantity: 5, declared_unit: "套" }], "件").quantityLabel).toBe("13 台、5 套");
  });
  it("uses the documented product-count fallback only for historical NULL", () => {
    expect(consignmentCargoSummary([{ ...row, declared_quantity: null, declared_unit: null, pieces_per_package: 3 }], "套").quantityLabel).toBe("6 套");
    expect(consignmentCargoSummary([{ ...row, declared_quantity: 0 }], "件").quantityLabel).toBe("1 条商品数量待补录");
  });
  it("does not round away a small declared quantity or volume", () => {
    const summary = consignmentCargoSummary([{ ...row, declared_quantity: 0.0000001, volume_per_package_cbm: 0.0000001 }], "件");
    expect(summary.quantityLabel).toBe("0.0000001 台"); expect(summary.volume).toBe(0.0000002);
  });
  it("has a clear empty state and does not mutate cargo rows", () => {
    expect(consignmentCargoSummary([], "件").quantityLabel).toBe("尚未记录商品数量");
    const original = structuredClone(row); consignmentCargoSummary([row], "件"); expect(row).toEqual(original);
  });
});
