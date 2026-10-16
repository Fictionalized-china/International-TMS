import { describe, expect, it } from "vitest";
import { resolveWarehouseAccess } from "./warehouse-access";

describe("resolveWarehouseAccess", () => {
  const assignments = [
    { warehouse_id: "warehouse-a", access_level: "operator" },
  ];

  it("keeps an explicit warehouse assignment scoped for ordinary managers", () => {
    const access = resolveWarehouseAccess({
      positionCode: "WAREHOUSE",
      roleCodes: ["warehouse_operator"],
      permissions: ["warehouse.manage"],
    }, assignments);

    expect(access.all).toBe(false);
    expect(access.warehouseIds).toEqual(["warehouse-a"]);
  });

  it("does not let a warehouse assignment narrow the boss demonstration account", () => {
    const access = resolveWarehouseAccess({
      positionCode: "BOSS",
      roleCodes: ["boss"],
      permissions: ["warehouse.manage"],
    }, assignments);

    expect(access.all).toBe(true);
    expect(access.warehouseIds).toEqual([]);
  });

  it("recognizes a protected owner role even if its position code is different", () => {
    const access = resolveWarehouseAccess({
      positionCode: "SALES",
      roleCodes: ["owner"],
      permissions: ["warehouse.manage"],
    }, assignments);

    expect(access.all).toBe(true);
  });
});
