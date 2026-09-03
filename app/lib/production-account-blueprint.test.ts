import { describe, expect, it } from "vitest";
import {
  accessModelPositions,
  accessModelRolePermissions,
} from "./access-model-seed.server";
import { productionAccountBlueprint } from "./production-account-blueprint";
import { canUseAdminSite } from "./site-account-access";

const officePositionCodes = accessModelPositions
  .map(([code]) => code)
  .filter((code) => !["WAREHOUSE", "OVERSEAS_WAREHOUSE"].includes(code));

describe("cloud production account blueprint", () => {
  it("contains exactly one account for every office position, two warehouses and three clients", () => {
    const adminAccounts = productionAccountBlueprint.filter((account) => account.site === "admin");
    const warehouseAccounts = productionAccountBlueprint.filter((account) => account.site === "warehouse");
    const portalAccounts = productionAccountBlueprint.filter((account) => account.site === "portal");

    expect(adminAccounts).toHaveLength(officePositionCodes.length);
    expect(adminAccounts.map((account) => account.positionCode).sort()).toEqual([...officePositionCodes].sort());
    expect(warehouseAccounts.map((account) => account.warehouseRole).sort()).toEqual(["domestic_collection", "overseas_destination"]);
    expect(portalAccounts.map((account) => account.customerNumber).sort()).toEqual([1, 2, 3]);
    expect(new Set(productionAccountBlueprint.map((account) => account.email)).size).toBe(productionAccountBlueprint.length);
  });

  it("keeps warehouse and customer identities out of the management site", () => {
    for (const account of productionAccountBlueprint) {
      const roleCodes = account.roleCode ? [account.roleCode] : [];
      expect(canUseAdminSite(roleCodes)).toBe(account.site === "admin");
    }
  });

  it("keeps sensitive permission blocks on the approved roles only", () => {
    const permissionOwners: Record<string, string[]> = {
      "customer.scope.all": ["pos_customer_service"],
      "billing.sensitive.view": ["pos_customer_service", "pos_finance", "pos_cashier"],
      "billing.expense.approve": ["pos_finance"],
      "billing.cash.manage": ["pos_customer_service", "pos_cashier"],
      "analytics.profit.view": ["pos_finance"],
      "role.manage": ["pos_hr_admin"],
      "security.manage": ["pos_hr_admin"],
    };

    for (const [permission, expectedRoles] of Object.entries(permissionOwners)) {
      const actualRoles = Object.entries(accessModelRolePermissions)
        .filter(([, permissions]) => permissions.includes(permission))
        .map(([role]) => role)
        .sort();
      expect(actualRoles).toEqual([...expectedRoles].sort());
    }
  });

  it("keeps payroll-only positions free of business permissions", () => {
    expect(accessModelRolePermissions.pos_business_route).toBeUndefined();
    expect(accessModelRolePermissions.pos_front_loading).toBeUndefined();
  });

  it("keeps order visibility aligned with each position", () => {
    expect(accessModelRolePermissions.developer).toContain("order.scope.all");
    expect(accessModelRolePermissions.pos_sales).toContain("order.scope.sales_own");
    expect(accessModelRolePermissions.pos_sales).not.toContain("order.scope.all");

    for (const role of ["pos_operation", "pos_tracking", "pos_customer_service", "warehouse_operator", "overseas_warehouse_operator"]) {
      expect(accessModelRolePermissions[role]).toContain("order.scope.assigned");
      expect(accessModelRolePermissions[role]).not.toContain("order.scope.all");
    }

    expect(accessModelRolePermissions.pos_finance).toContain("order.scope.all");
    expect(accessModelRolePermissions.pos_cashier).toContain("order.scope.all");
    expect(accessModelRolePermissions.pos_hr_admin).not.toContain("order.view");
  });
});
