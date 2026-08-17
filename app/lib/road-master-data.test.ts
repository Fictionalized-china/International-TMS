import { describe, expect, it } from "vitest";
import {
  defaultZonesForRole,
  isCollectionWarehouseRole,
  isWarehouseRole,
  warehouseRoleLabels,
} from "./road-master-data";

describe("road master data", () => {
  it("accepts only supported warehouse roles", () => {
    expect(isWarehouseRole("port")).toBe(true);
    expect(isWarehouseRole("overseas_destination")).toBe(true);
    expect(isWarehouseRole("other")).toBe(false);
  });

  it("uses simple role-specific default zones", () => {
    expect(defaultZonesForRole("domestic_collection").map((item) => item.name)).toEqual([
      "收货区",
      "待配载区",
      "发货区",
    ]);
    expect(defaultZonesForRole("overseas_destination").map((item) => item.name)).toEqual([
      "到仓区",
      "待提货区",
      "已预约区",
      "异常区",
    ]);
  });

  it("separates loading warehouses from overseas destination warehouses", () => {
    expect(isCollectionWarehouseRole("domestic_collection")).toBe(true);
    expect(isCollectionWarehouseRole("port")).toBe(true);
    expect(isCollectionWarehouseRole("overseas_destination")).toBe(false);
    expect(warehouseRoleLabels.overseas_destination).toBe("境外目的仓");
  });
});
