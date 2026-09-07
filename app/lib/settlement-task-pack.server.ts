import { settlementOrderScopeSql } from "./settlement-workbench-access.server";
import type { SettlementWorkbenchActor } from "./settlement-workbench-access";
import type { SettlementPage, SettlementPageQuery } from "./settlement-workbench-pages.server";
import type { SettlementTaskPackRow } from "./settlement-task-pack";

function candidateSql(scopeSql: string, filtered: boolean) {
  return `FROM transport_orders o
    JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
    WHERE o.organization_id=? AND ${scopeSql} AND o.status!='cancelled'
      AND (EXISTS(SELECT 1 FROM business_expenses candidate_expense WHERE candidate_expense.organization_id=o.organization_id AND candidate_expense.order_id=o.id)
        OR o.current_step_name IN ('对账结算','完成复盘')
        OR o.completion_status!='in_progress')
      ${filtered ? "AND (o.order_number LIKE ? OR c.name LIKE ?)" : ""}`;
}

function bindings(actor: SettlementWorkbenchActor, query: string) {
  const scope = settlementOrderScopeSql(actor, "o");
  const pattern = `%${query}%`;
  return {
    scope,
    values: [actor.organizationId, ...scope.values, ...(query ? [pattern, pattern] : [])] as unknown[],
  };
}

export async function loadSettlementTaskPackCount(
  db: D1Database,
  actor: SettlementWorkbenchActor,
  query = "",
) {
  const bound = bindings(actor, query);
  const result = await db.prepare(`SELECT COUNT(*) total ${candidateSql(bound.scope.sql, Boolean(query))}`)
    .bind(...bound.values).first<{ total: number }>();
  return Number(result?.total || 0);
}

export async function loadSettlementTaskPackPage(
  db: D1Database,
  actor: SettlementWorkbenchActor,
  query: SettlementPageQuery,
  knownTotal?: number,
): Promise<SettlementPage<SettlementTaskPackRow>> {
  const bound = bindings(actor, query.query);
  const total = knownTotal ?? await loadSettlementTaskPackCount(db, actor, query.query);
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(Math.max(1, query.page), pageCount);
  const rows = await db.prepare(`SELECT o.id,o.order_number,c.name customer_name,o.business_type,o.status,
      o.current_step_name,o.completion_status,o.updated_at,
      (SELECT COUNT(*) FROM business_expenses e WHERE e.organization_id=o.organization_id AND e.order_id=o.id) expense_count,
      (SELECT COUNT(*) FROM business_expenses e WHERE e.organization_id=o.organization_id AND e.order_id=o.id AND e.direction='receivable') receivable_count,
      (SELECT COUNT(*) FROM business_expenses e WHERE e.organization_id=o.organization_id AND e.order_id=o.id AND e.direction='payable') payable_count,
      COALESCE((SELECT SUM(e.amount) FROM business_expenses e WHERE e.organization_id=o.organization_id AND e.order_id=o.id),0) expense_amount,
      (SELECT confirmed FROM order_expense_direction_controls control WHERE control.organization_id=o.organization_id AND control.order_id=o.id AND control.direction='receivable') receivable_confirmed,
      (SELECT confirmed FROM order_expense_direction_controls control WHERE control.organization_id=o.organization_id AND control.order_id=o.id AND control.direction='payable') payable_confirmed,
      (SELECT business_reviewed FROM order_expense_direction_controls control WHERE control.organization_id=o.organization_id AND control.order_id=o.id AND control.direction='receivable') receivable_business_reviewed,
      (SELECT business_reviewed FROM order_expense_direction_controls control WHERE control.organization_id=o.organization_id AND control.order_id=o.id AND control.direction='payable') payable_business_reviewed,
      (SELECT finance_reviewed FROM order_expense_direction_controls control WHERE control.organization_id=o.organization_id AND control.order_id=o.id AND control.direction='receivable') receivable_finance_reviewed,
      (SELECT finance_reviewed FROM order_expense_direction_controls control WHERE control.organization_id=o.organization_id AND control.order_id=o.id AND control.direction='payable') payable_finance_reviewed,
      (SELECT COUNT(DISTINCT r.id) FROM settlement_reconciliations r JOIN settlement_reconciliation_lines line ON line.reconciliation_id=r.id AND line.organization_id=r.organization_id JOIN business_expenses e ON e.id=line.expense_id AND e.organization_id=line.organization_id WHERE r.organization_id=o.organization_id AND e.order_id=o.id AND r.status!='withdrawn') reconciliation_count,
      (SELECT COUNT(DISTINCT r.id) FROM settlement_reconciliations r JOIN settlement_reconciliation_lines line ON line.reconciliation_id=r.id AND line.organization_id=r.organization_id JOIN business_expenses e ON e.id=line.expense_id AND e.organization_id=line.organization_id WHERE r.organization_id=o.organization_id AND e.order_id=o.id AND r.status='draft') reconciliation_draft_count,
      (SELECT COUNT(DISTINCT r.id) FROM settlement_reconciliations r JOIN settlement_reconciliation_lines line ON line.reconciliation_id=r.id AND line.organization_id=r.organization_id JOIN business_expenses e ON e.id=line.expense_id AND e.organization_id=line.organization_id WHERE r.organization_id=o.organization_id AND e.order_id=o.id AND r.status='confirmed') reconciliation_confirmed_count,
      COALESCE((SELECT SUM(allocation.amount) FROM settlement_invoice_allocations allocation JOIN settlement_invoice_records invoice ON invoice.id=allocation.invoice_record_id AND invoice.organization_id=allocation.organization_id AND invoice.status!='void' JOIN business_expenses e ON e.id=allocation.expense_id AND e.organization_id=allocation.organization_id WHERE allocation.organization_id=o.organization_id AND e.order_id=o.id),0) invoiced_amount,
      COALESCE((SELECT SUM(allocation.amount) FROM settlement_cash_allocations allocation JOIN settlement_cash_transactions cash ON cash.id=allocation.cash_transaction_id AND cash.organization_id=allocation.organization_id AND cash.status!='void' JOIN business_expenses e ON e.id=allocation.expense_id AND e.organization_id=allocation.organization_id WHERE allocation.organization_id=o.organization_id AND e.order_id=o.id),0) settled_amount,
      (SELECT COUNT(*) FROM order_document_metadata document WHERE document.organization_id=o.organization_id AND document.order_id=o.id AND document.document_category='billing_statement' AND document.review_status!='rejected') billing_document_count,
      (SELECT COUNT(*) FROM order_document_metadata document WHERE document.organization_id=o.organization_id AND document.order_id=o.id AND document.document_category='payment_receipt' AND document.review_status!='rejected') payment_receipt_count,
      (SELECT COUNT(*) FROM order_review_snapshots review WHERE review.organization_id=o.organization_id AND review.order_id=o.id) review_snapshot_count,
      (SELECT review_conclusion FROM order_review_snapshots review WHERE review.organization_id=o.organization_id AND review.order_id=o.id LIMIT 1) review_conclusion
    ${candidateSql(bound.scope.sql, Boolean(query.query))}
    ORDER BY CASE WHEN o.completion_status='completed_settled' AND EXISTS(SELECT 1 FROM order_review_snapshots done_review WHERE done_review.organization_id=o.organization_id AND done_review.order_id=o.id AND NULLIF(TRIM(done_review.review_conclusion),'') IS NOT NULL) THEN 1 ELSE 0 END,
      o.updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...bound.values, query.pageSize, (page - 1) * query.pageSize)
    .all<SettlementTaskPackRow>();
  return { items: rows.results, page, pageCount, pageSize: query.pageSize, total };
}
