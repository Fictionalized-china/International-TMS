import { describe, expect, it } from "vitest";
import {
  effectivePermissionCodes,
  isBossBusinessActor,
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

  it("recognizes the boss as a workflow stand-in without elevating other positions", () => {
    expect(isBossBusinessActor({ positionCode: "BOSS", roleCodes: [] })).toBe(true);
    expect(isBossBusinessActor({ positionCode: "SALES", roleCodes: ["boss"] })).toBe(true);
    expect(isBossBusinessActor({ positionCode: "DEVELOPER", roleCodes: ["developer"] })).toBe(false);
    expect(isBossBusinessActor({ positionCode: "SALES", roleCodes: ["pos_sales"] })).toBe(false);
  });
});
