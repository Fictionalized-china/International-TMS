import { describe, expect, it } from "vitest";
import {
  canManageOrderModule,
  positionPortalForUser,
  visiblePortalLinks,
} from "./position-portal";

describe("position portal", () => {
  it("maps each position to a focused portal", () => {
    const finance = positionPortalForUser({
      positionCode: "FINANCE",
      roleCodes: ["pos_finance"],
      permissions: ["order.view", "billing.view"],
    });
    expect(finance.title).toBe("财务门户");
    expect(finance.moduleCodes).toEqual(["costs", "review"]);
    expect(visiblePortalLinks(finance, ["order.view", "billing.view"]).map((item) => item.label))
      .toEqual(["费用待办", "费用结算"]);
  });

  it("requires module-specific permission unless the account is elevated", () => {
    expect(canManageOrderModule({
      positionCode: "DOC",
      roleCodes: ["pos_doc"],
      permissions: ["order.module.customs.manage"],
    }, "customs")).toBe(true);
    expect(canManageOrderModule({
      positionCode: "DOC",
      roleCodes: ["pos_doc"],
      permissions: ["order.module.customs.manage"],
    }, "costs")).toBe(false);
    expect(canManageOrderModule({
      positionCode: "OPERATION",
      roleCodes: ["owner"],
      permissions: [],
    }, "costs")).toBe(true);
  });
});
