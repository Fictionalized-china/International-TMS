import { describe, expect, it } from "vitest";
import {
  canManageOrderModule,
  positionPortalForUser,
  visiblePortalLinks,
} from "./position-portal";

describe("position portal", () => {
  it("maps each position to a focused portal", () => {
    const finance = positionPortalForUser({
      positionCode: "FINANCE_ACCOUNTING",
      roleCodes: ["pos_finance"],
      permissions: ["order.view", "billing.view", "billing.sensitive.view"],
    });
    expect(finance.title).toBe("财务会计岗门户");
    expect(finance.moduleCodes).toEqual(["costs", "review"]);
    expect(visiblePortalLinks(finance, ["order.view", "billing.view", "billing.sensitive.view"]).map((item) => item.label))
      .toEqual(["费用待办", "费用结算"]);
    expect(visiblePortalLinks(finance, ["order.view", "billing.view"]).map((item) => item.label))
      .toEqual(["费用待办"]);
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

  it("shows the PZ entry to operation and document users only with the narrow batch permission", () => {
    for (const positionCode of ["OPERATION", "DOC"]) {
      const config = positionPortalForUser({
        positionCode,
        roleCodes: [positionCode === "OPERATION" ? "pos_operation" : "pos_doc"],
        permissions: ["order.view", "transport.batch.assigned.view"],
      });
      expect(visiblePortalLinks(config, ["order.view", "transport.batch.assigned.view"]) 
        .some((link) => link.href === "/admin/loading")).toBe(true);
      expect(visiblePortalLinks(config, ["order.view"])
        .some((link) => link.href === "/admin/loading")).toBe(false);
    }
  });
});
