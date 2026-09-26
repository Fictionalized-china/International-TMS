import { describe, expect, it } from "vitest";
import { analyticsVisibility } from "./analytics-access";

describe("analytics visibility", () => {
  it("requires business analytics permission for the page", () => {
    expect(analyticsVisibility([]).canView).toBe(false);
    expect(analyticsVisibility(["analytics.business.view"]).canView).toBe(true);
  });

  it("keeps receivable, payable, profit and export independently configurable", () => {
    expect(analyticsVisibility([
      "analytics.business.view",
      "analytics.receivable.view",
    ])).toMatchObject({
      canView: true,
      canViewReceivable: true,
      canViewPayable: false,
      canViewProfit: false,
      canConfigure: false,
      canFillManual: false,
      canExport: false,
    });
    expect(analyticsVisibility([
      "analytics.business.view",
      "analytics.payable.view",
      "analytics.profit.view",
      "analytics.config.manage",
      "analytics.manual.fill",
      "data.export",
    ])).toMatchObject({
      canViewPayable: true,
      canViewProfit: true,
      canConfigure: true,
      canFillManual: true,
      canExport: true,
    });
  });
});
