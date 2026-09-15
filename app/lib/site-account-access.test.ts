import { describe, expect, it } from "vitest";
import { canUseAdminSite } from "./site-account-access";

describe("site account admission", () => {
  it("rejects memberships that only belong to a warehouse role", () => {
    expect(canUseAdminSite(["warehouse_operator"])).toBe(false);
    expect(canUseAdminSite(["overseas_warehouse_operator"])).toBe(false);
  });

  it("accepts office roles including payroll-only classifications", () => {
    expect(canUseAdminSite(["owner"])).toBe(true);
    expect(canUseAdminSite(["pos_operation"])).toBe(true);
    expect(canUseAdminSite(["pos_business_route"])).toBe(true);
    expect(canUseAdminSite(["pos_front_loading"])).toBe(true);
  });

  it("does not admit an account without an assigned role", () => {
    expect(canUseAdminSite([])).toBe(false);
  });
});
