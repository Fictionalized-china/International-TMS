PRAGMA foreign_keys = ON;

CREATE TABLE settlement_reconciliations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_number TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')),
  counterparty_name TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  settlement_entity TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_amount REAL NOT NULL CHECK(total_amount > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','withdrawn')),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,document_number)
);

CREATE TABLE settlement_reconciliation_lines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reconciliation_id TEXT NOT NULL REFERENCES settlement_reconciliations(id) ON DELETE CASCADE,
  expense_id TEXT NOT NULL REFERENCES business_expenses(id) ON DELETE RESTRICT,
  amount REAL NOT NULL CHECK(amount > 0),
  created_at TEXT NOT NULL,
  UNIQUE(reconciliation_id,expense_id)
);

CREATE TABLE settlement_invoice_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  record_number TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL REFERENCES settlement_reconciliations(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')),
  counterparty_name TEXT NOT NULL,
  invoice_company TEXT NOT NULL,
  invoice_type TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_code TEXT,
  invoice_date TEXT NOT NULL,
  tax_rate REAL NOT NULL DEFAULT 0 CHECK(tax_rate >= 0),
  title_name TEXT NOT NULL,
  tax_number TEXT,
  address_phone TEXT,
  bank_account TEXT,
  currency TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount > 0),
  exchange_rate REAL NOT NULL DEFAULT 1 CHECK(exchange_rate > 0),
  attachment_reference TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','void')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,record_number)
);

CREATE TABLE settlement_invoice_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_record_id TEXT NOT NULL REFERENCES settlement_invoice_records(id) ON DELETE CASCADE,
  expense_id TEXT NOT NULL REFERENCES business_expenses(id) ON DELETE RESTRICT,
  amount REAL NOT NULL CHECK(amount > 0),
  created_at TEXT NOT NULL,
  UNIQUE(invoice_record_id,expense_id)
);

CREATE TABLE settlement_cash_transactions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_number TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('receipt','payment')),
  counterparty_name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount > 0),
  occurred_on TEXT NOT NULL,
  settlement_entity TEXT NOT NULL,
  account_name TEXT NOT NULL,
  handled_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  evidence_reference TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'unallocated' CHECK(status IN ('unallocated','partially_allocated','allocated','void')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,transaction_number)
);

CREATE TABLE settlement_cash_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cash_transaction_id TEXT NOT NULL REFERENCES settlement_cash_transactions(id) ON DELETE RESTRICT,
  reconciliation_id TEXT NOT NULL REFERENCES settlement_reconciliations(id) ON DELETE RESTRICT,
  expense_id TEXT NOT NULL REFERENCES business_expenses(id) ON DELETE RESTRICT,
  amount REAL NOT NULL CHECK(amount > 0),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_reconciliations_org ON settlement_reconciliations(organization_id,direction,status,created_at DESC);
CREATE INDEX idx_reconciliation_expense ON settlement_reconciliation_lines(organization_id,expense_id);
CREATE INDEX idx_invoice_reconciliation ON settlement_invoice_records(organization_id,reconciliation_id,status);
CREATE INDEX idx_invoice_expense ON settlement_invoice_allocations(organization_id,expense_id);
CREATE INDEX idx_cash_org ON settlement_cash_transactions(organization_id,direction,status,occurred_on DESC);
CREATE INDEX idx_cash_expense ON settlement_cash_allocations(organization_id,expense_id);
