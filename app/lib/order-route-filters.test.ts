import { describe, expect, it } from "vitest";
import {
  matchesOrderRouteFilters,
  orderRouteFilterCount,
  readOrderRouteFilters,
} from "./order-route-filters";

describe("order route filters", () => {
  const order = {
    origin_country: "中国",
    origin_state: "广东省",
    origin_city: "深圳市",
    origin_address: "云海路 1 号",
    exit_port: "CN-XJ-ALA",
    exit_port_name: "阿拉山口口岸",
    destination_country: "乌兹别克斯坦",
    destination_city: "塔什干",
    destination_address: "工业园 2 号",
    overseas_warehouse_name: "塔什干演示目的仓",
  };

  it("reads and trims advanced route filters", () => {
    const params = new URLSearchParams("origin=%20深圳%20&exitPort=ALA&destination=%20塔什干%20");
    expect(readOrderRouteFilters(params)).toEqual({ origin: "深圳", exitPort: "ALA", destination: "塔什干" });
  });

  it("matches origin, exit port and destination independently", () => {
    expect(matchesOrderRouteFilters(order, { origin: "广东", exitPort: "阿拉山口", destination: "目的仓" })).toBe(true);
    expect(matchesOrderRouteFilters(order, { origin: "上海", exitPort: "", destination: "" })).toBe(false);
    expect(orderRouteFilterCount({ origin: "深圳", exitPort: "", destination: "塔什干" })).toBe(2);
  });
});
