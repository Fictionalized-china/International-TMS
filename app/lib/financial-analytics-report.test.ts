import { describe, expect, it } from "vitest";
import { buildFinancialAnalyticsReport } from "./financial-analytics-report";

describe("financial analytics report", () => {
  it("builds every document section from confirmed settlement data", () => {
    const report = buildFinancialAnalyticsReport({
      today: new Date("2026-09-26T00:00:00.000Z"),
      orders: [
        { id: "o1", orderNumber: "SO-1", businessType: "ftl", customerId: "c1", customerName: "客户甲", destinationCountry: "哈萨克斯坦", exitPort: "霍尔果斯", salespersonId: "u1", salespersonName: "销售甲", grossWeightKg: 100, volumeCbm: 1 },
        { id: "o2", orderNumber: "SO-2", businessType: "ltl", customerId: "c2", customerName: "客户乙", destinationCountry: "乌兹别克斯坦", exitPort: "乌恰", salespersonId: "u2", salespersonName: "销售乙", grossWeightKg: 500, volumeCbm: 1 },
      ],
      expenses: [
        { id: "r1", orderId: "o1", direction: "receivable", stage: "reconciled", chargeCode: "FREIGHT", chargeName: "运费", counterpartyName: "客户甲", baseAmount: 1000, allocatedAmount: 400, settlementConfirmedAt: "2026-08-01", dueDate: "2026-08-31" },
        { id: "p1", orderId: "o1", direction: "payable", stage: "reconciled", chargeCode: "DOMESTIC_FREIGHT", chargeName: "国内运费", counterpartyName: "车队甲", baseAmount: 600, allocatedAmount: 100, settlementConfirmedAt: "2026-08-01", dueDate: "2026-08-31" },
        { id: "tax", orderId: "o1", direction: "payable", stage: "reconciled", chargeCode: "CUSTOMS_TAX", chargeName: "过关税费", counterpartyName: "口岸", baseAmount: 50, allocatedAmount: 0, settlementConfirmedAt: "2026-08-01", dueDate: "2026-08-31" },
        { id: "r2", orderId: "o2", direction: "receivable", stage: "estimated", chargeCode: "FREIGHT", chargeName: "运费", counterpartyName: "客户乙", baseAmount: 800, allocatedAmount: 0, settlementConfirmedAt: null, dueDate: null },
      ],
      vehicles: [
        { orderId: "o1", batchId: "b1", batchNumber: "PZ-1", vehicleNo: "新A001", borderPort: "霍尔果斯", departedAt: "2026-08-01" },
        { orderId: "o1", batchId: "b1", batchNumber: "PZ-1", vehicleNo: "新A002", borderPort: "霍尔果斯", departedAt: "2026-08-01" },
      ],
    });
    expect(report.overview).toMatchObject({ revenue: 1000, directCost: 600, grossProfit: 400, abnormalExpense: 50, estimatedRevenue: 1800 });
    expect(report.productLines).toHaveLength(2);
    expect(report.multiVehicleOrders).toHaveLength(2);
    expect(report.customerContribution[0].customerName).toBe("客户甲");
    expect(report.customerReceivables[0]).toMatchObject({ balance: 600, creditStatus: "预警" });
    expect(report.portContribution[0].portName).toBe("霍尔果斯");
    expect(report.costStructure[0].category).toBe("国内运费");
    expect(report.receivables.total).toBe(600);
    expect(report.supplierPayments[0].supplierName).toBe("车队甲");
    expect(report.teamOutput.some((row) => row.productLine === "总计")).toBe(true);
    expect(report.negativeProfit).toHaveLength(2);
    expect(report.chargeableWeights).toEqual([
      { orderId: "o1", chargeableWeightKg: 300 },
      { orderId: "o2", chargeableWeightKg: 500 },
    ]);
  });

  it("uses the loading batch port when the order port is still empty", () => {
    const report = buildFinancialAnalyticsReport({
      orders: [
        { id: "o1", orderNumber: "SO-1", businessType: "ftl", customerId: "c1", customerName: "客户甲", destinationCountry: "哈萨克斯坦", exitPort: "", salespersonId: "u1", salespersonName: "销售甲", grossWeightKg: 100, volumeCbm: 1 },
      ],
      expenses: [
        { id: "r1", orderId: "o1", direction: "receivable", stage: "reconciled", chargeCode: "FREIGHT", chargeName: "运费", counterpartyName: "客户甲", baseAmount: 1000, allocatedAmount: 0, settlementConfirmedAt: "2026-09-01", dueDate: "2026-09-30" },
        { id: "p1", orderId: "o1", direction: "payable", stage: "reconciled", chargeCode: "PORT", chargeName: "口岸服务费", counterpartyName: "口岸", baseAmount: 200, allocatedAmount: 0, settlementConfirmedAt: "2026-09-01", dueDate: "2026-09-30" },
      ],
      vehicles: [
        { orderId: "o1", batchId: "b1", batchNumber: "PZ-1", vehicleNo: "新A001", borderPort: "UQIA", departedAt: "2026-09-01" },
      ],
    });

    expect(report.portContribution[0]).toMatchObject({ portName: "UQIA", revenue: 1000, cost: 200 });
    expect(report.portCostStructure[0]).toMatchObject({ portName: "UQIA", totalCost: 200 });
    expect(report.vehicleAnalysis).toContainEqual(expect.objectContaining({ dimension: "按口岸", businessType: "UQIA" }));
  });
});
