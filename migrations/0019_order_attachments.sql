PRAGMA foreign_keys = ON;

CREATE TABLE order_attachments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  data_url TEXT NOT NULL,
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('portal','admin')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_order_attachments_order ON order_attachments(order_id,created_at);
CREATE INDEX idx_order_attachments_customer ON order_attachments(organization_id,customer_id,created_at DESC);
