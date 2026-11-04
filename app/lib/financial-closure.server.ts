import type { SessionUser } from "./auth.server";
import type { loadMeetingSettlement, loadMeetingSettlementDirections } from "./meeting-settlement.server";
import { isBossBusinessActor } from "./permission-blocks";
import { canCreateReceivableStatement } from "./settlement-workbench-access";

/** Same evidence is used by stage progress and the final atomic archive guard. */
function cashTotal(alias: string) {
  return `COALESCE((SELECT SUM(cash_line.amount) FROM settlement_cash_allocations cash_line
    JOIN settlement_cash_transactions cash_entry ON cash_entry.id=cash_line.cash_transaction_id AND cash_entry.organization_id=cash_line.organization_id
    WHERE cash_line.expense_id=${alias}.id AND cash_line.organization_id=${alias}.organization_id AND cash_entry.status!='void'
    AND cash_entry.currency=${alias}.currency AND cash_entry.direction=CASE WHEN ${alias}.direction='receivable' THEN 'receipt' ELSE 'payment' END),0)`;
}
function reconciledTotal(alias: string) {
  return `COALESCE((SELECT SUM(statement_line.amount) FROM settlement_reconciliation_lines statement_line
    JOIN settlement_reconciliations statement_entry ON statement_entry.id=statement_line.reconciliation_id AND statement_entry.organization_id=statement_line.organization_id
    WHERE statement_line.expense_id=${alias}.id AND statement_line.organization_id=${alias}.organization_id AND statement_entry.status='confirmed'
    AND statement_entry.direction=${alias}.direction AND statement_entry.currency=${alias}.currency),0)`;
}
export function financialClosurePredicate() {
  return `NOT EXISTS(SELECT 1 FROM business_expenses closure_expense WHERE closure_expense.organization_id=? AND closure_expense.order_id=?
    AND closure_expense.stage!='cancelled' AND closure_expense.amount>0
    AND (ROUND(closure_expense.amount-${cashTotal("closure_expense")},2)>0 OR ROUND(closure_expense.amount-${reconciledTotal("closure_expense")},2)>0))`;
}
export async function loadFinancialClosure(db: D1Database, org: string, orderId: string) {
  const rows = (await db.prepare(`SELECT e.direction,e.currency,e.amount,${cashTotal("e")} allocated,${reconciledTotal("e")} reconciled
    FROM business_expenses e WHERE e.organization_id=? AND e.order_id=? AND e.stage!='cancelled' AND e.amount>0`).bind(org, orderId)
    .all<{ direction: "receivable" | "payable"; currency: string; amount: number; allocated: number; reconciled: number }>()).results;
  const balances = new Map<string, { direction: "receivable" | "payable"; currency: string; outstanding: number; unreconciled: number }>();
  for (const row of rows) {
    const key = `${row.direction}:${row.currency}`;
    const entry = balances.get(key) ?? { direction: row.direction, currency: row.currency, outstanding: 0, unreconciled: 0 };
    if (![row.amount, row.allocated, row.reconciled].every(value => Number.isFinite(Number(value)))) throw new Error("费用结算金额无效，不能确认归档");
    entry.outstanding += Math.max(0, Math.round((Number(row.amount) - Number(row.allocated)) * 100));
    entry.unreconciled += Math.max(0, Math.round((Number(row.amount) - Number(row.reconciled)) * 100));
    balances.set(key, entry);
  }
  const amounts = [...balances.values()].map(row => ({ ...row, outstanding: row.outstanding / 100, unreconciled: row.unreconciled / 100 }));
  const blockers = amounts.flatMap(row => {
    const label = row.direction === "receivable" ? "应收" : "应付";
    return [row.unreconciled > 0.009 ? `${label}账单尚未确认对账（${row.currency}）` : null,
      row.outstanding > 0.009 ? `${label}尚未完成真实收付款核销（${row.currency}）` : null].filter((value): value is string => Boolean(value));
  });
  return { complete: blockers.length === 0, blockers, amounts };
}
export async function loadSettlementHandoff(db: D1Database, state: Awaited<ReturnType<typeof loadMeetingSettlement>>, actor: SessionUser, directions: Awaited<ReturnType<typeof loadMeetingSettlementDirections>>) {
  const closure = await loadFinancialClosure(db, actor.organizationId, state.order.id);
  const canReview = isBossBusinessActor(actor) || (state.order.finance_user_id === actor.userId && actor.permissions.includes("order.module.review.manage"));
  const statements = actor.permissions.includes("billing.view") && actor.permissions.includes("billing.sensitive.view") && actor.permissions.includes("billing.manage");
  const cash = actor.permissions.includes("billing.view") && actor.permissions.includes("billing.sensitive.view") && actor.permissions.includes("billing.cash.manage");
  const signed = directions.every(direction => !direction.hasExpenses || direction.actions.filter(action => action.active && (action.required || action.configuredRelease)).every(action => action.completed));
  const offlineRequired = state.policy["payable.offline_approval_required"] === "1" && closure.amounts.some(row => row.direction === "payable");
  const offlineRecorded = offlineRequired ? Boolean(await db.prepare("SELECT 1 FROM order_payable_offline_approvals WHERE organization_id=? AND order_id=?").bind(actor.organizationId, state.order.id).first()) : false;
  const phase = !signed ? "signatures" : closure.amounts.some(row => row.unreconciled > 0.009) ? "statements" : !closure.complete ? "cash" : "review";
  const configurationIssue = state.policy["settlement.require_cash_before_archive"] === "1" && !closure.complete &&
    ((closure.amounts.some(row => row.unreconciled > 0.009) && !state.fields.some(field => field.fieldKey === "reconciliation_statement" && field.isActive)) ||
     !state.fields.some(field => ["cash_records", "writeoff_records"].includes(field.fieldKey) && field.isActive))
    ? "本单严格归档要求财务闭环，但冻结流程关闭了对账或资金办理项；请管理员修正流程配置，或明确切换为业务先归档模式。" : null;
  return { phase, canStatements: statements, statementDirection: canCreateReceivableStatement(actor, state.policy) ? "" : "payable", canCash: cash, canReview, financiallyClosed: closure.complete,
    offlineRequired, offlineRecorded, canRecordOffline: signed && (isBossBusinessActor(actor) || (state.order.finance_user_id === actor.userId && actor.permissions.includes("settlement.offline_approval.record"))),
    configurationIssue,
    archived: state.order.status === "completed" && state.order.completion_status === "completed_settled",
    canRecover: canReview && state.order.status === "completed" && state.order.completion_status === "business_complete_unsettled" && !closure.complete };
}
