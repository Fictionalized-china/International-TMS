import type { SessionUser } from "./auth.server";
import { orderVisibilitySql } from "./order-access";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";
import { businessDateTimeLabel } from "./business-time";
import { reportCsv } from "./hr-reports";
import { statusLabel } from "./order-workflow";
import { hrCashStates, readHrConsignmentFilters, type HrCashState, type HrConsignmentFilters } from "./hr-consignments";
type Candidate = { id: string; order_number: string; order_date: string | null; created_at: string; customer_name: string; business_type: string; status: string; quote_commercial_user_id: string | null; quote_commercial_name_snapshot: string | null; salesperson_user_id: string | null; salesperson_name: string | null; creator_name: string | null };
type Fee = { order_id: string; direction: string; stage: string; amount: number; exchange_rate: number; allocated: number };
type Direction = { count: number; pending: number; estimated: number; confirmed: number; allocated: number; outstanding: number; invalid: boolean };
const direction = (): Direction => ({ count: 0, pending: 0, estimated: 0, confirmed: 0, allocated: 0, outstanding: 0, invalid: false });
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const cashState = (value: Direction): HrCashState => !value.count ? "unrecorded" : value.invalid || value.pending ? "unconfirmed" : value.outstanding <= 0.009 ? "cleared" : value.allocated > 0.009 ? "partial" : "unpaid";
export async function loadHrConsignments(db: D1Database, current: SessionUser, filters: HrConsignmentFilters) {
  if (!current.permissions.includes("hr.report.view")) throw new Error("没有人事报表权限");
  // Revalidate even for a direct service call; no SQL fragments come from the URL.
  filters = readHrConsignmentFilters(new URLSearchParams(filters), { from: "", to: "" });
  const scope = orderVisibilitySql(current, "o"), conditions = ["o.organization_id=?", scope.sql], values: (string | number)[] = [current.organizationId, ...scope.values];
  const creationUtc = "SUBSTR(REPLACE(o.created_at,'T',' '),1,19)";
  if (filters.from) {
    conditions.push(`((NULLIF(TRIM(o.order_date),'') IS NOT NULL AND o.order_date>=?) OR (NULLIF(TRIM(o.order_date),'') IS NULL AND ${creationUtc}>=?))`);
    values.push(filters.from, new Date(`${filters.from}T00:00:00+08:00`).toISOString().slice(0, 19).replace("T", " "));
  }
  if (filters.to) {
    conditions.push(`((NULLIF(TRIM(o.order_date),'') IS NOT NULL AND o.order_date<=?) OR (NULLIF(TRIM(o.order_date),'') IS NULL AND ${creationUtc}<?))`);
    values.push(filters.to, new Date(Date.parse(`${filters.to}T00:00:00+08:00`) + 86400000).toISOString().slice(0, 19).replace("T", " "));
  }
  const candidates = (await db.prepare(`SELECT o.id,o.order_number,o.order_date,o.created_at,c.name customer_name,o.business_type,o.status,
    o.quote_commercial_user_id,o.quote_commercial_name_snapshot,o.salesperson_user_id,sales.display_name salesperson_name,creator.display_name creator_name
    FROM transport_orders o JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
    LEFT JOIN users sales ON sales.id=o.salesperson_user_id LEFT JOIN users creator ON creator.id=o.created_by_user_id
    WHERE ${conditions.join(" AND ")} ORDER BY o.created_at DESC,o.id`).bind(...values).all<Candidate>()).results;
  const people = (key: "quote_commercial_user_id" | "salesperson_user_id", name: "quote_commercial_name_snapshot" | "salesperson_name") => {
    const peopleById = new Map<string, { id: string; name: string }>();
    // Rows are newest first. Keep the most recent recorded name per identity;
    // an old order must not overwrite the filter label of a renamed employee.
    for (const row of candidates) if (row[key] && !peopleById.has(row[key]!)) peopleById.set(row[key]!, { id: row[key]!, name: row[name] || "历史姓名未记录" });
    const options = [...peopleById.values()];
    const names = new Map<string, number>();
    for (const person of options) names.set(person.name, (names.get(person.name) ?? 0) + 1);
    return options.map(person => ({ ...person, name: names.get(person.name)! > 1 ? `${person.name}（${person.id.slice(-8)}）` : person.name }));
  };
  const commercialOptions = people("quote_commercial_user_id", "quote_commercial_name_snapshot"), salespersonOptions = people("salesperson_user_id", "salesperson_name");
  const selected = candidates.filter(row => (!filters.commercial || row.quote_commercial_user_id === filters.commercial) && (!filters.salesperson || row.salesperson_user_id === filters.salesperson) && (!filters.businessType || row.business_type === filters.businessType));
  const amounts = new Map<string, { receivable: Direction; payable: Direction; allocation: number }>();
  for (const chunk of chunkD1Values(selected.map(row => row.id), 1)) {
    const fees = await db.prepare(`SELECT e.order_id,e.direction,e.stage,e.amount,e.exchange_rate,
      COALESCE((SELECT SUM(a.amount) FROM settlement_cash_allocations a JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.organization_id=a.organization_id
        WHERE a.organization_id=e.organization_id AND a.expense_id=e.id AND t.status!='void' AND t.currency=e.currency
          AND t.direction=CASE e.direction WHEN 'receivable' THEN 'receipt' ELSE 'payment' END),0) allocated
      FROM business_expenses e WHERE e.organization_id=? AND e.order_id IN (${d1Placeholders(chunk.length)}) AND e.stage!='cancelled'`).bind(current.organizationId, ...chunk).all<Fee>();
    for (const fee of fees.results) {
      if (fee.direction !== "receivable" && fee.direction !== "payable") continue;
      const all = amounts.get(fee.order_id) ?? { receivable: direction(), payable: direction(), allocation: 0 }, target = all[fee.direction];
      const amount = Number(fee.amount), rate = Number(fee.exchange_rate), allocated = Number(fee.allocated);
      target.count++;
      if (![amount, rate, allocated].every(Number.isFinite) || amount < 0 || rate <= 0 || allocated < 0) target.invalid = true;
      else {
        if (fee.stage === "estimated") { target.pending++; target.estimated += round(amount * rate); }
        else target.confirmed += round(amount * rate);
        target.allocated += round(allocated * rate);
        // Check each fee before summing: overpayment on one line cannot settle another.
        target.outstanding += Math.max(0, amount - allocated);
      }
      amounts.set(fee.order_id, all);
    }
    const allocations = await db.prepare(`SELECT l.order_id,SUM(l.final_amount*h.exchange_rate) amount FROM transport_cost_allocation_lines l
      JOIN transport_cost_allocations h ON h.id=l.allocation_id AND h.organization_id=l.organization_id AND h.status='confirmed'
      JOIN business_expenses e ON e.id=l.expense_id AND e.organization_id=l.organization_id AND e.order_id=l.order_id AND e.stage!='cancelled'
      WHERE l.organization_id=? AND l.order_id IN (${d1Placeholders(chunk.length)}) GROUP BY l.order_id`).bind(current.organizationId, ...chunk).all<{ order_id: string; amount: number }>();
    for (const allocation of allocations.results) {
      const all = amounts.get(allocation.order_id); if (all) all.allocation = Number(allocation.amount);
    }
  }
  const sensitive = current.permissions.includes("hr.report.amount.view");
  const rows = selected.map(row => {
    const a = amounts.get(row.id) ?? { receivable: direction(), payable: direction(), allocation: 0 };
    const receiptState = cashState(a.receivable), paymentState = cashState(a.payable);
    return {
      ...row, order_date: row.order_date || businessDateTimeLabel(row.created_at).slice(0, 10),
      receiptState, paymentState,
      commissionEligible: receiptState === "cleared" && !["draft", "submitted", "cancelled"].includes(row.status),
      amounts: sensitive ? {
        estimatedReceivable: a.receivable.invalid ? null : round(a.receivable.estimated), confirmedReceivable: a.receivable.invalid ? null : round(a.receivable.confirmed),
        estimatedPayable: a.payable.invalid ? null : round(a.payable.estimated), confirmedPayable: a.payable.invalid ? null : round(a.payable.confirmed),
        receiptAllocated: a.receivable.invalid ? null : round(a.receivable.allocated), paymentAllocated: a.payable.invalid ? null : round(a.payable.allocated),
        confirmedAllocation: Number.isFinite(a.allocation) ? round(a.allocation) : null,
      } : null,
    };
  }).filter(row => (!filters.receipt || row.receiptState === filters.receipt) && (!filters.payment || row.paymentState === filters.payment));
  return { rows, commercialOptions, salespersonOptions, filters };
}
export type HrConsignmentRow = Awaited<ReturnType<typeof loadHrConsignments>>["rows"][number];
export function hrConsignmentCsv(rows: readonly HrConsignmentRow[]) {
  return reportCsv([["订单", "接单日期", "客户", "装车方式", "业务状态", "报价商务标识", "报价商务（订单快照）", "业务员标识", "业务员", "实际录单人", "预估应收CNY", "确认应收CNY", "预估应付CNY", "确认应付CNY", "已确认配载分摊CNY（已含于应付，不另加）", "收款核销CNY", "付款核销CNY", "应收核销状态", "应付核销状态", "符合现有回款提成登记口径"],
    ...rows.map(row => [row.order_number, row.order_date, row.customer_name, row.business_type === "ltl" ? "拼车" : row.business_type === "ftl" ? "整车" : row.business_type, statusLabel(row.status), row.quote_commercial_user_id, row.quote_commercial_name_snapshot || "历史未记录", row.salesperson_user_id, row.salesperson_name, row.creator_name,
      row.amounts?.estimatedReceivable, row.amounts?.confirmedReceivable, row.amounts?.estimatedPayable, row.amounts?.confirmedPayable, row.amounts?.confirmedAllocation, row.amounts?.receiptAllocated, row.amounts?.paymentAllocated, hrCashStates[row.receiptState], hrCashStates[row.paymentState], row.commissionEligible ? "是；比例/金额由人事人工核定" : "否"])]);
}
