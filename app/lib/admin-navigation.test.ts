import { describe, expect, it } from "vitest";
import {
  adminNavigationGroupVisibility,
  adminNavigationPermissionGroups,
} from "./admin-navigation";

function user(permissions: string[] = []) {
  return {
    positionCode: "OPERATION",
    roleCodes: ["pos_operation"],
    permissions,
  };
}

describe("admin navigation groups", () => {
  it("always keeps the universal workbench group and hides empty groups", () => {
    expect(adminNavigationGroupVisibility(user())).toEqual({
      workbench: true,
      transport: false,
      businessData: false,
      system: false,
    });
  });

  it("derives group visibility from the same child permissions as the sidebar", () => {
    expect(adminNavigationGroupVisibility(user(["order.view", "carrier.view"]))).toEqual({
      workbench: true,
      transport: true,
      businessData: true,
      system: false,
    });
  });

  it("recognizes batch workspace permissions", () => {
    expect(adminNavigationGroupVisibility(user(["transport.batch.assigned.view"])).transport).toBe(true);
  });

  it("opens billing navigation only when both billing permissions exist", () => {
    expect(adminNavigationGroupVisibility(user(["billing.view"])).transport).toBe(false);
    expect(adminNavigationGroupVisibility(user([
      "billing.view",
      "billing.sensitive.view",
    ])).transport).toBe(true);
  });

  it("publishes one bulk editor for every sidebar group", () => {
    expect(adminNavigationPermissionGroups.map((group) => group.key)).toEqual([
      "workbench",
      "transport",
      "businessData",
      "system",
    ]);
  });
});
