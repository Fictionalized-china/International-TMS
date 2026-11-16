export const hrCashStates = { unrecorded: "未登记费用", unconfirmed: "费用待确认", unpaid: "未核销", partial: "部分核销", cleared: "已核销" } as const;
export type HrCashState = keyof typeof hrCashStates;
export type HrConsignmentFilters = { from: string; to: string; commercial: string; salesperson: string; businessType: string; businessMajor?: string; businessKind?: string; receipt: string; payment: string };
const calendarDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function readHrConsignmentFilters(params: URLSearchParams, defaults: { from: string; to: string }): HrConsignmentFilters {
  const read = (key: string) => (params.get(key) ?? "").trim();
  const filters = { from: params.has("from") ? read("from") : defaults.from, to: params.has("to") ? read("to") : defaults.to, commercial: read("commercial"), salesperson: read("salesperson"), businessType: read("businessType"), businessMajor: read("businessMajor"), businessKind: read("businessKind"), receipt: read("receipt"), payment: read("payment") };
  if([filters.businessMajor,filters.businessKind].some(value=>value.length>120||/[\u0000-\u001f\u007f]/.test(value)))throw new Error("业务分类筛选过长或包含非法字符");
  if ((filters.from && !calendarDate(filters.from)) || (filters.to && !calendarDate(filters.to)) || (filters.from && filters.to && filters.from > filters.to)) throw new Error("委托日期范围无效");
  if (filters.businessType && !["ltl", "ftl"].includes(filters.businessType)) throw new Error("装车方式无效");
  if ([filters.receipt, filters.payment].some(value => value && !Object.hasOwn(hrCashStates, value))) throw new Error("核销状态无效");
  return filters;
}
