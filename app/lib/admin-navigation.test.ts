import { describe, expect, it } from "vitest";
import {
  adminNavigationGroupVisibility,
  adminNavigationItemVisibility,
  adminNavigationPermissionGroups,
  adminNavigationPermissionItems,
  canAccessWarehouseAdministration,
  canViewAdminNavigationItem,
  inferAdminNavigationMenuPermissions,
  normalizeAdminNavigationPermissions,
} from "./admin-navigation";

function user(permissions: string[] = []) {
  return {
    positionCode: "OPERATION",
    roleCodes: ["pos_operation"],
    permissions,
  };
}

describe("admin navigation permissions", () => {
  it("defines every sidebar entry once inside the four first-level groups", () => {
    expect(adminNavigationPermissionGroups.map((group) => group.key)).toEqual([
      "workbench",
      "transport",
      "businessData",
      "system",
    ]);
    expect(adminNavigationPermissionItems).toHaveLength(20);
    expect(new Set(adminNavigationPermissionItems.map((item) => item.key)).size).toBe(20);
    expect(new Set(adminNavigationPermissionItems.map((item) => item.menuPermissionCode)).size).toBe(20);
  });

  it("does not expose a menu from a business permission alone", () => {
    expect(canViewAdminNavigationItem(user(["order.view"]), "orders")).toBe(false);
    expect(adminNavigationGroupVisibility(user(["order.view"]))).toEqual({
      workbench: false,
      transport: false,
      businessData: false,
      system: false,
    });
  });

  it("does not expose a guarded page when only its menu permission exists", () => {
    expect(canViewAdminNavigationItem(user(["menu.admin.orders.view"]), "orders")).toBe(false);
  });

  it("exposes an independently enabled menu when its read permission exists", () => {
    const visibility = adminNavigationItemVisibility(user([
      "menu.admin.orders.view",
      "order.view",
    ]));
    expect(visibility.orders).toBe(true);
    expect(visibility.quotations).toBe(false);
    expect(adminNavigationGroupVisibility(user([
      "menu.admin.orders.view",
      "order.view",
    ])).transport).toBe(true);
  });

  it("supports universal pages without granting unrelated business permissions", () => {
    expect(canViewAdminNavigationItem(user(["menu.admin.portal.view"]), "portal")).toBe(true);
    expect(canViewAdminNavigationItem(user(["menu.admin.notifications.view"]), "notifications")).toBe(true);
  });

  it("adds only minimum read permissions when a menu is enabled", () => {
    const normalized = normalizeAdminNavigationPermissions([
      "menu.admin.documents.view",
      "menu.admin.cargo.view",
      "menu.admin.security.view",
      "menu.admin.warehouses.view",
    ]);
    expect(normalized).toEqual(expect.arrayContaining([
      "order.module.documents.view",
      "order.module.cargo.view",
      "security.view",
      "warehouse.admin.view",
    ]));
    expect(normalized).not.toEqual(expect.arrayContaining([
      "order.module.documents.manage",
      "order.module.cargo.manage",
      "security.manage",
      "warehouse.manage",
    ]));
  });

  it("requires both billing read permissions", () => {
    expect(canViewAdminNavigationItem(user([
      "menu.admin.billing.view",
      "billing.view",
    ]), "billing")).toBe(false);
    expect(canViewAdminNavigationItem(user([
      "menu.admin.billing.view",
      "billing.view",
      "billing.sensitive.view",
    ]), "billing")).toBe(true);
  });

  it("infers equivalent menu visibility for roles created from legacy permissions", () => {
    const inferred = inferAdminNavigationMenuPermissions(
      ["order.view", "warehouse.admin.view"],
      { positionCode: "OPERATION", roleCodes: ["pos_operation"] },
    );
    expect(inferred).toEqual(expect.arrayContaining([
      "menu.admin.portal.view",
      "menu.admin.notifications.view",
      "menu.admin.orders.view",
      "menu.admin.warehouses.view",
    ]));
    expect(inferred).not.toContain("menu.admin.security.view");
  });

  it("keeps warehouse administration visibility separate from warehouse mutations", () => {
    expect(canAccessWarehouseAdministration(["warehouse.admin.view"])).toBe(true);
    expect(canAccessWarehouseAdministration(["warehouse.manage"])).toBe(true);
    expect(canAccessWarehouseAdministration(["warehouse.view"])).toBe(false);
  });
});
