-- A NOT NULL guard aborts the entire transaction if a conditional reservation lost a race.
CREATE TABLE settlement_commit_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE settlement_reconciliations ADD COLUMN payment_reserved_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE settlement_reconciliations ADD COLUMN payment_write_token TEXT;
UPDATE settlement_reconciliations SET payment_reserved_amount=COALESCE((SELECT SUM(t.amount) FROM settlement_cash_transactions t WHERE t.organization_id=settlement_reconciliations.organization_id AND t.payment_reconciliation_id=settlement_reconciliations.id AND t.status!='void'),0);
ALTER TABLE settlement_cash_transactions ADD COLUMN request_id TEXT;
ALTER TABLE settlement_cash_transactions ADD COLUMN payload_hash TEXT;
CREATE UNIQUE INDEX cash_submission_once ON settlement_cash_transactions(organization_id,created_by_user_id,request_id);
ALTER TABLE settlement_cash_transactions ADD COLUMN allocation_reserved_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE settlement_cash_transactions ADD COLUMN allocation_write_token TEXT;
UPDATE settlement_cash_transactions SET allocation_reserved_amount=COALESCE((SELECT SUM(a.amount) FROM settlement_cash_allocations a WHERE a.organization_id=settlement_cash_transactions.organization_id AND a.cash_transaction_id=settlement_cash_transactions.id),0);
ALTER TABLE business_expenses ADD COLUMN cash_reserved_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE business_expenses ADD COLUMN cash_write_token TEXT;
UPDATE business_expenses SET cash_reserved_amount=COALESCE((SELECT SUM(a.amount) FROM settlement_cash_allocations a JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.organization_id=a.organization_id AND t.status!='void' WHERE a.organization_id=business_expenses.organization_id AND a.expense_id=business_expenses.id),0);
