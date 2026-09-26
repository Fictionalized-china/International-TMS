export const VOLUMETRIC_WEIGHT_KG_PER_CBM = 300;

export type AnalyticsCalculationMode = "automatic" | "manual";
export type AnalyticsDateSource =
  | "order_created"
  | "actual_departure"
  | "actual_arrival"
  | "customer_signed"
  | "settlement_confirmed"
  | "bill_created"
  | "agreed_due"
  | "cash_occurred"
  | "manual";

export type AnalyticsSensitivity = "business" | "receivable" | "payable" | "profit";

export type AnalyticsMetricDefinition = {
  code: string;
  section: string;
  label: string;
  sensitivity: AnalyticsSensitivity;
  defaultDateSource: AnalyticsDateSource;
  unit: "amount" | "count" | "ratio" | "days";
};

export const analyticsMetricDefinitions: readonly AnalyticsMetricDefinition[] = [
  { code: "revenue", section: "公司整体财务全景", label: "总收入", sensitivity: "receivable", defaultDateSource: "settlement_confirmed", unit: "amount" },
  { code: "direct_cost", section: "公司整体财务全景", label: "运营总成本（直接成本）", sensitivity: "payable", defaultDateSource: "settlement_confirmed", unit: "amount" },
  { code: "gross_profit", section: "公司整体财务全景", label: "毛利润", sensitivity: "profit", defaultDateSource: "settlement_confirmed", unit: "amount" },
  { code: "ticket_count", section: "产品线利润分析", label: "票数", sensitivity: "business", defaultDateSource: "settlement_confirmed", unit: "count" },
  { code: "departure_count", section: "汽运运输分析", label: "总发车数", sensitivity: "business", defaultDateSource: "actual_departure", unit: "count" },
  { code: "customer_contribution", section: "客户贡献分析", label: "客户贡献", sensitivity: "receivable", defaultDateSource: "settlement_confirmed", unit: "amount" },
  { code: "port_contribution", section: "口岸贡献分析", label: "口岸贡献", sensitivity: "profit", defaultDateSource: "settlement_confirmed", unit: "amount" },
  { code: "operating_cost", section: "成本分析", label: "运营成本结构", sensitivity: "payable", defaultDateSource: "settlement_confirmed", unit: "amount" },
  { code: "cargo_damage", section: "货损与绿通", label: "货损赔偿金额", sensitivity: "payable", defaultDateSource: "settlement_confirmed", unit: "amount" },
  { code: "receivable_balance", section: "应收账款", label: "当前应收账款总额", sensitivity: "receivable", defaultDateSource: "agreed_due", unit: "amount" },
  { code: "dso", section: "应收账款", label: "DSO", sensitivity: "receivable", defaultDateSource: "agreed_due", unit: "days" },
  { code: "collection_rate", section: "应收账款", label: "回款率", sensitivity: "receivable", defaultDateSource: "cash_occurred", unit: "ratio" },
  { code: "bad_debt_reserve", section: "应收账款", label: "坏账准备金额", sensitivity: "receivable", defaultDateSource: "manual", unit: "amount" },
  { code: "supplier_payable", section: "供应商付款", label: "供应商应付余额", sensitivity: "payable", defaultDateSource: "agreed_due", unit: "amount" },
  { code: "team_output", section: "团队人效与产出", label: "团队产出", sensitivity: "profit", defaultDateSource: "settlement_confirmed", unit: "amount" },
  { code: "negative_profit_rate", section: "风险预警", label: "负毛利票数占比", sensitivity: "profit", defaultDateSource: "settlement_confirmed", unit: "ratio" },
] as const;

export function metricDefinition(code: string) {
  return analyticsMetricDefinitions.find((item) => item.code === code);
}

export function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

export function volumetricWeightKg(volumeCbm: number): number {
  return Math.max(0, safeNumber(volumeCbm)) * VOLUMETRIC_WEIGHT_KG_PER_CBM;
}

export function chargeableWeightKg(actualWeightKg: number, volumeCbm: number): number {
  return Math.max(Math.max(0, safeNumber(actualWeightKg)), volumetricWeightKg(volumeCbm));
}

export function allocateByChargeableWeight<T extends { actualWeightKg: number; volumeCbm: number }>(
  rows: readonly T[],
  totalAmount: number,
): Array<T & { chargeableWeightKg: number; ratio: number; allocatedAmount: number }> {
  const weights = rows.map((row) => chargeableWeightKg(row.actualWeightKg, row.volumeCbm));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const safeTotal = Math.max(0, safeNumber(totalAmount));
  let allocated = 0;
  return rows.map((row, index) => {
    const ratio = totalWeight > 0 ? weights[index] / totalWeight : rows.length ? 1 / rows.length : 0;
    const amount = index === rows.length - 1
      ? Math.max(0, Math.round((safeTotal - allocated) * 100) / 100)
      : Math.round(safeTotal * ratio * 100) / 100;
    allocated += amount;
    return { ...row, chargeableWeightKg: weights[index], ratio, allocatedAmount: amount };
  });
}

const excludedProfitKeywords = ["税", "关税", "赔偿", "货损", "罚款"];

export function isExcludedFromGrossProfit(chargeCode: string, chargeName: string): boolean {
  const value = `${chargeCode} ${chargeName}`.toLocaleLowerCase("zh-CN");
  return excludedProfitKeywords.some((keyword) => value.includes(keyword));
}

export type CostCategory =
  | "国内代理费"
  | "国内运费"
  | "境外运费"
  | "仓储费"
  | "转关费"
  | "口岸服务费"
  | "税费与保险"
  | "赔偿及罚款"
  | "其他费用";

export function classifyCost(chargeCode: string, chargeName: string): CostCategory {
  const value = `${chargeCode} ${chargeName}`.toLocaleLowerCase("zh-CN");
  if (/赔偿|货损|罚款/.test(value)) return "赔偿及罚款";
  if (/税|保险/.test(value)) return "税费与保险";
  if (/仓|storage/.test(value)) return "仓储费";
  if (/转关|transit/.test(value)) return "转关费";
  if (/口岸|port/.test(value)) return "口岸服务费";
  if (/境外|oversea|international/.test(value)) return "境外运费";
  if (/国内|domestic|freight/.test(value)) return "国内运费";
  if (/代理|agent/.test(value)) return "国内代理费";
  return "其他费用";
}

export type AgingBand = "未到期" | "1-15天" | "16-30天" | "31-60天" | "60天以上";

export function overdueDays(dueDate: string | null, today = new Date()): number {
  if (!dueDate) return 0;
  const due = new Date(`${dueDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(due.getTime())) return 0;
  const current = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.floor((current - due.getTime()) / 86_400_000));
}

export function agingBand(days: number): AgingBand {
  if (days <= 0) return "未到期";
  if (days <= 15) return "1-15天";
  if (days <= 30) return "16-30天";
  if (days <= 60) return "31-60天";
  return "60天以上";
}

export function creditStatus(days: number): "正常" | "预警" | "严重预警" | "坏账风险" {
  if (days <= 15) return "正常";
  if (days <= 30) return "预警";
  if (days <= 60) return "严重预警";
  return "坏账风险";
}

export function comparisonLabel(current: number, previous: number, hasPreviousData = true): string {
  if (!hasPreviousData) return "暂无可比数据";
  if (previous === 0 && current > 0) return "新增";
  if (previous === 0 && current === 0) return "—";
  const change = (current - previous) / Math.abs(previous);
  return `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
}
