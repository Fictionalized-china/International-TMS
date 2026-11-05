import type { CashTransactionRow, ReconciliationRow } from "./settlement-workbench.server";

/** Match the service's direction, party, currency and payment-statement binding. */
export function matchingStatementCash(row: ReconciliationRow, cash: CashTransactionRow[]) {
  return cash.filter(item => item.direction === (row.direction === "receivable" ? "receipt" : "payment") &&
    item.counterparty_name === row.counterparty_name && item.currency === row.currency &&
    (!item.payment_reconciliation_id || item.payment_reconciliation_id === row.id) &&
    item.amount - item.allocated_amount > 0.009);
}

export function cashRegistrationRemaining(row: ReconciliationRow) {
  const registered = row.direction === "payable"
    ? row.registered_payment_amount ?? row.settled_amount
    : row.settled_amount;
  return Math.max(0, Math.round((row.total_amount - registered) * 100) / 100);
}
