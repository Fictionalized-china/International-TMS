-- D1 serializes writes, so database triggers are the final concurrency guard
-- when two browser sessions submit the same settlement action at nearly the
-- same time. Application validation remains responsible for friendly prompts.

CREATE TRIGGER IF NOT EXISTS settlement_reconciliation_line_scope_guard
BEFORE INSERT ON settlement_reconciliation_lines
WHEN NOT EXISTS (
       SELECT 1 FROM business_expenses expense
       WHERE expense.id=NEW.expense_id
         AND expense.organization_id=NEW.organization_id
     )
  OR NOT EXISTS (
       SELECT 1 FROM settlement_reconciliations reconciliation
       WHERE reconciliation.id=NEW.reconciliation_id
         AND reconciliation.organization_id=NEW.organization_id
     )
BEGIN
  SELECT RAISE(ABORT, '对账费用与对账单不属于同一组织');
END;

CREATE TRIGGER IF NOT EXISTS settlement_reconciliation_line_active_guard
BEFORE INSERT ON settlement_reconciliation_lines
WHEN EXISTS (
  SELECT 1
  FROM settlement_reconciliation_lines existing_line
  JOIN settlement_reconciliations existing_reconciliation
    ON existing_reconciliation.id=existing_line.reconciliation_id
   AND existing_reconciliation.organization_id=existing_line.organization_id
  WHERE existing_line.organization_id=NEW.organization_id
    AND existing_line.expense_id=NEW.expense_id
    AND existing_reconciliation.status!='withdrawn'
)
BEGIN
  SELECT RAISE(ABORT, '该费用已归入其他有效对账单');
END;

CREATE TRIGGER IF NOT EXISTS settlement_invoice_allocation_scope_guard
BEFORE INSERT ON settlement_invoice_allocations
WHEN NOT EXISTS (
  SELECT 1
  FROM settlement_invoice_records invoice
  JOIN settlement_reconciliation_lines line
    ON line.reconciliation_id=invoice.reconciliation_id
   AND line.expense_id=NEW.expense_id
   AND line.organization_id=NEW.organization_id
  WHERE invoice.id=NEW.invoice_record_id
    AND invoice.organization_id=NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, '开票分摊与对账费用不匹配');
END;

CREATE TRIGGER IF NOT EXISTS settlement_invoice_allocation_amount_guard
BEFORE INSERT ON settlement_invoice_allocations
WHEN NEW.amount + COALESCE((
       SELECT SUM(existing.amount)
       FROM settlement_invoice_allocations existing
       JOIN settlement_invoice_records invoice
         ON invoice.id=existing.invoice_record_id
        AND invoice.status!='void'
       WHERE existing.organization_id=NEW.organization_id
         AND existing.expense_id=NEW.expense_id
     ),0) > COALESCE((
       SELECT line.amount
       FROM settlement_invoice_records invoice
       JOIN settlement_reconciliation_lines line
         ON line.reconciliation_id=invoice.reconciliation_id
        AND line.expense_id=NEW.expense_id
        AND line.organization_id=NEW.organization_id
       WHERE invoice.id=NEW.invoice_record_id
         AND invoice.organization_id=NEW.organization_id
       LIMIT 1
     ),0) + 0.009
BEGIN
  SELECT RAISE(ABORT, '开票分摊金额超过费用未开票余额');
END;

CREATE TRIGGER IF NOT EXISTS settlement_cash_allocation_scope_guard
BEFORE INSERT ON settlement_cash_allocations
WHEN NOT EXISTS (
  SELECT 1
  FROM settlement_cash_transactions cash
  JOIN settlement_reconciliations reconciliation
    ON reconciliation.id=NEW.reconciliation_id
   AND reconciliation.organization_id=NEW.organization_id
  JOIN settlement_reconciliation_lines line
    ON line.reconciliation_id=reconciliation.id
   AND line.expense_id=NEW.expense_id
   AND line.organization_id=NEW.organization_id
  WHERE cash.id=NEW.cash_transaction_id
    AND cash.organization_id=NEW.organization_id
    AND cash.status!='void'
    AND reconciliation.status='confirmed'
    AND cash.direction=CASE reconciliation.direction
      WHEN 'receivable' THEN 'receipt' ELSE 'payment' END
    AND cash.counterparty_name=reconciliation.counterparty_name
    AND cash.currency=reconciliation.currency
)
BEGIN
  SELECT RAISE(ABORT, '收付款流水与对账单或费用不匹配');
END;

CREATE TRIGGER IF NOT EXISTS settlement_cash_transaction_amount_guard
BEFORE INSERT ON settlement_cash_allocations
WHEN NEW.amount + COALESCE((
       SELECT SUM(existing.amount)
       FROM settlement_cash_allocations existing
       WHERE existing.organization_id=NEW.organization_id
         AND existing.cash_transaction_id=NEW.cash_transaction_id
     ),0) > COALESCE((
       SELECT cash.amount
       FROM settlement_cash_transactions cash
       WHERE cash.id=NEW.cash_transaction_id
         AND cash.organization_id=NEW.organization_id
         AND cash.status!='void'
     ),0) + 0.009
BEGIN
  SELECT RAISE(ABORT, '核销金额超过流水未分配余额');
END;

CREATE TRIGGER IF NOT EXISTS settlement_cash_expense_amount_guard
BEFORE INSERT ON settlement_cash_allocations
WHEN NEW.amount + COALESCE((
       SELECT SUM(existing.amount)
       FROM settlement_cash_allocations existing
       JOIN settlement_cash_transactions cash
         ON cash.id=existing.cash_transaction_id
        AND cash.status!='void'
       WHERE existing.organization_id=NEW.organization_id
         AND existing.expense_id=NEW.expense_id
     ),0) > COALESCE((
       SELECT line.amount
       FROM settlement_reconciliation_lines line
       WHERE line.reconciliation_id=NEW.reconciliation_id
         AND line.expense_id=NEW.expense_id
         AND line.organization_id=NEW.organization_id
       LIMIT 1
     ),0) + 0.009
BEGIN
  SELECT RAISE(ABORT, '核销金额超过费用未核销余额');
END;
