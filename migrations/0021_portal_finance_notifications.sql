CREATE TABLE payment_submissions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  reference TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_notes TEXT,
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE payment_attachments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_submission_id TEXT NOT NULL REFERENCES payment_submissions(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data_url TEXT NOT NULL,
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE invoice_disputes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('amount','duplicate','service','tax','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','processing','resolved','rejected')),
  submitted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE portal_notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('quote','order','shipment','invoice','payment','system')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE portal_notification_preferences (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_quote INTEGER NOT NULL DEFAULT 1 CHECK (email_quote IN (0,1)),
  email_order INTEGER NOT NULL DEFAULT 1 CHECK (email_order IN (0,1)),
  email_shipment INTEGER NOT NULL DEFAULT 1 CHECK (email_shipment IN (0,1)),
  email_invoice INTEGER NOT NULL DEFAULT 1 CHECK (email_invoice IN (0,1)),
  email_payment INTEGER NOT NULL DEFAULT 1 CHECK (email_payment IN (0,1)),
  in_app_enabled INTEGER NOT NULL DEFAULT 1 CHECK (in_app_enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id)
);

CREATE INDEX idx_payment_customer ON payment_submissions(customer_id, submitted_at DESC);
CREATE INDEX idx_payment_invoice ON payment_submissions(invoice_id, status);
CREATE INDEX idx_dispute_customer ON invoice_disputes(customer_id, created_at DESC);
CREATE INDEX idx_dispute_invoice ON invoice_disputes(invoice_id, status);
CREATE INDEX idx_portal_notification_user ON portal_notifications(customer_id, user_id, is_read, created_at DESC);
