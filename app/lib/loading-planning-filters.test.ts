import { describe, expect, it } from "vitest";
import { emptyLoadingPlanningFilters, filterLoadingPlanningCandidates, hiddenLoadingPlanningSelections } from "./loading-planning-filters";

const rows = [
  { order_id: "1", order_number: "SO-ABC", customer_name: "客户甲", cargo_description: "机器", cargo_names: "配件", warehouse_id: "w1", overseas_warehouse_id: "d1", destination_country: "俄罗斯", destination_state: null, destination_city: "莫斯科", exit_port: "KH", exit_port_name: "霍尔果斯" },
  { order_id: "2", order_number: "SO-DEF", customer_name: "客户乙", cargo_description: null, cargo_names: "服装", warehouse_id: "w2", overseas_warehouse_id: "d2", destination_country: "哈萨克斯坦", destination_state: "州", destination_city: "阿拉木图", exit_port: null, exit_port_name: null },
];

describe("authorized loading pool filters", () => {
  it("keeps an empty filter identical and combines warehouse, destination, customer and text conditions", () => {
    expect(filterLoadingPlanningCandidates(rows, emptyLoadingPlanningFilters)).toEqual(rows);
    expect(filterLoadingPlanningCandidates(rows, { ...emptyLoadingPlanningFilters, q: " abc ", warehouseId: "w1", destinationWarehouseId: "d1", customer: "甲", destination: "莫斯科", port: "霍尔果斯" })).toEqual([rows[0]]);
    expect(filterLoadingPlanningCandidates(rows, { ...emptyLoadingPlanningFilters, warehouseId: "w1", destinationWarehouseId: "d2" })).toEqual([]);
  });
  it("searches cargo names and port codes without inventing matches for null fields", () => {
    expect(filterLoadingPlanningCandidates(rows, { ...emptyLoadingPlanningFilters, q: "配件", port: "kh" })).toEqual([rows[0]]);
    expect(filterLoadingPlanningCandidates(rows, { ...emptyLoadingPlanningFilters, q: "null" })).toEqual([]);
    expect(filterLoadingPlanningCandidates(rows, { ...emptyLoadingPlanningFilters, customer: "' OR 1=1 --" })).toEqual([]);
  });
  it("submits selected orders hidden by later filters once, without adding unselected orders", () => {
    const visible = filterLoadingPlanningCandidates(rows, { ...emptyLoadingPlanningFilters, customer: "乙" });
    const hidden = hiddenLoadingPlanningSelections(rows, visible);
    expect(hidden.map(row => row.order_id)).toEqual(["1"]);
    expect([...hidden, ...visible].map(row => row.order_id)).toEqual(["1", "2"]);
    expect(hiddenLoadingPlanningSelections([], visible)).toEqual([]);
  });
});
