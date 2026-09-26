import { analyticsVisibility } from "./analytics-access";
import { buildFinancialAnalyticsReport } from "./financial-analytics-report";

export function redactFinancialReport(
  report: ReturnType<typeof buildFinancialAnalyticsReport>,
  access: ReturnType<typeof analyticsVisibility>,
) {
  return {
    ...report,
    overview: {
      revenue: access.canViewReceivable ? report.overview.revenue : 0,
      estimatedRevenue: access.canViewReceivable ? report.overview.estimatedRevenue : 0,
      directCost: access.canViewPayable ? report.overview.directCost : 0,
      estimatedCost: access.canViewPayable ? report.overview.estimatedCost : 0,
      grossProfit: access.canViewProfit ? report.overview.grossProfit : 0,
      grossMargin: access.canViewProfit ? report.overview.grossMargin : null,
      estimatedProfit: access.canViewProfit ? report.overview.estimatedProfit : 0,
      abnormalExpense: access.canViewPayable || access.canViewProfit ? report.overview.abnormalExpense : 0,
      abnormalIncome: access.canViewReceivable || access.canViewProfit ? report.overview.abnormalIncome : 0,
    },
    productLines: report.productLines.map((row) => ({
      ...row,
      sales: access.canViewReceivable ? row.sales : 0,
      salesShare: access.canViewReceivable ? row.salesShare : null,
      grossProfit: access.canViewProfit ? row.grossProfit : 0,
      grossProfitShare: access.canViewProfit ? row.grossProfitShare : null,
      grossMargin: access.canViewProfit ? row.grossMargin : null,
    })),
    customerContribution: access.canViewReceivable ? report.customerContribution.map((row) => ({
      ...row,
      grossProfit: access.canViewProfit ? row.grossProfit : 0,
      grossProfitShare: access.canViewProfit ? row.grossProfitShare : null,
      grossMargin: access.canViewProfit ? row.grossMargin : null,
    })) : [],
    customerReceivables: access.canViewReceivable ? report.customerReceivables : [],
    portContribution: access.canViewProfit ? report.portContribution : [],
    costStructure: access.canViewPayable ? report.costStructure : [],
    businessCostDistribution: access.canViewPayable ? report.businessCostDistribution : [],
    portCostStructure: access.canViewPayable ? report.portCostStructure : [],
    cargoDamage: access.canViewPayable ? report.cargoDamage : [],
    receivables: access.canViewReceivable ? report.receivables : {
      total: 0, normal: 0, overdue: 0, days31to60: 0, days61to90: 0, daysOver90: 0,
      weightedAgingDays: 0, dso: 0, collectionRate: null, badDebtReserve: 0, badDebtReserveRate: 0,
    },
    supplierPayments: access.canViewPayable ? report.supplierPayments : [],
    teamOutput: access.canViewProfit ? report.teamOutput : [],
    negativeProfit: access.canViewProfit ? report.negativeProfit : [],
  };
}
