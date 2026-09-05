import { describe, expect, it } from "vitest";
import { canOperateWarehouseUi } from "./warehouse-ui-access";

describe("warehouse UI mutation visibility", () => {
  it.each(["operator", "manager"])(
    "shows physical controls to a warehouse.operate user with %s access",
    (accessLevel) => {
      expect(canOperateWarehouseUi(
        { permissions: ["warehouse.view", "warehouse.operate"] },
        accessLevel,
      )).toBe(true);
    },
  );

  it("hides physical controls from an explicitly viewer-only warehouse assignment", () => {
    expect(canOperateWarehouseUi(
      { permissions: ["warehouse.view", "warehouse.operate"] },
      "viewer",
    )).toBe(false);
  });

  it("still requires warehouse.operate even when the access row says manager", () => {
    expect(canOperateWarehouseUi({ permissions: ["warehouse.view"] }, "manager"))
      .toBe(false);
  });

  it("allows an explicit warehouse manager permission to override a viewer row", () => {
    expect(canOperateWarehouseUi(
      { permissions: ["warehouse.view", "warehouse.operate", "warehouse.manage"] },
      "viewer",
    )).toBe(true);
  });
});
