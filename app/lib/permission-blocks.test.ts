import { describe, expect, it } from "vitest";
import {
  effectivePermissionCodes,
  isProtectedAccessRole,
} from "./permission-blocks";

describe("effectivePermissionCodes", () => {
  it("merges inherited permissions with account allows", () => {
    expect(effectivePermissionCodes({
      inherited: ["order.view"],
      overrides: [{ code: "quote.manage", effect: "allow" }],
    })).toEqual(["order.view", "quote.manage"]);
  });

  it("lets an account deny override inherited and account allows", () => {
    expect(effectivePermissionCodes({
      inherited: ["order.view", "billing.view"],
      overrides: [
        { code: "order.view", effect: "allow" },
        { code: "order.view", effect: "deny" },
      ],
    })).toEqual(["billing.view"]);
  });

  it("keeps owner and boss permissions immutable", () => {
    expect(effectivePermissionCodes({
      inherited: [],
      overrides: [{ code: "order.view", effect: "deny" }],
      allPermissions: ["order.view", "role.manage"],
      protectedRole: true,
    })).toEqual(["order.view", "role.manage"]);
    expect(isProtectedAccessRole(["pos_sales", "boss"])).toBe(true);
  });
});
