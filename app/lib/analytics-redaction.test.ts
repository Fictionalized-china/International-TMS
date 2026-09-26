import { describe, expect, it } from "vitest";
import { analyticsVisibility } from "./analytics-access";
import { redactFinancialReport } from "./analytics-redaction";
import { buildFinancialAnalyticsReport } from "./financial-analytics-report";

describe("financial analytics response redaction", () => {
  const report = buildFinancialAnalyticsReport({
    orders: [{ id: "o1", orderNumber: "SO-1", businessType: "ftl", customerId: "c1", customerName: "客户甲", destinationCountry: "哈萨克斯坦", exitPort: "霍尔果斯", salespersonId: "u1", salespersonName: "销售甲", grossWeightKg: 100, volumeCbm: 1 }],
    expenses: [
      { id: "r1", orderId: "o1", direction: "receivable", stage: "reconciled", chargeCode: "FREIGHT", chargeName: "运费", counterpartyName: "客户甲", baseAmount: 1000, allocatedAmount: 0, settlementConfirmedAt: "2026-09-01", dueDate: "2026-09-20" },
      { id: "p1", orderId: "o1", direction: "payable", stage: "reconciled", chargeCode: "DOMESTIC", chargeName: "国内运费", counterpartyName: "供应商甲", baseAmount: 600, allocatedAmount: 0, settlementConfirmedAt: "2026-09-01", dueDate: "2026-09-20" },
    ],
    vehicles: [],
  });

  it("does not serialize unauthorized financial values", () => {
    const redacted = redactFinancialReport(report, analyticsVisibility(["analytics.business.view"]));
    expect(redacted.overview).toMatchObject({ revenue: 0, directCost: 0, grossProfit: 0 });
    expect(redacted.customerContribution).toEqual([]);
    expect(redacted.customerReceivables).toEqual([]);
    expect(redacted.costStructure).toEqual([]);
    expect(redacted.portContribution).toEqual([]);
    expect(redacted.teamOutput).toEqual([]);
    expect(JSON.stringify(redacted)).not.toContain("1000");
    expect(JSON.stringify(redacted)).not.toContain("600");
  });

  it("keeps only the explicitly authorized receivable view", () => {
    const redacted = redactFinancialReport(report, analyticsVisibility(["analytics.business.view", "analytics.receivable.view"]));
    expect(redacted.overview.revenue).toBe(1000);
    expect(redacted.overview.directCost).toBe(0);
    expect(redacted.overview.grossProfit).toBe(0);
    expect(redacted.customerContribution).toHaveLength(1);
    expect(redacted.costStructure).toEqual([]);
  });
});
