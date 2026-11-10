-- An incomplete draft is not an order, fee, inventory or workflow fact.
CREATE TABLE order_intake_drafts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted')),
  linked_order_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_order_intake_drafts_owner ON order_intake_drafts(organization_id,created_by_user_id,status,updated_at);
