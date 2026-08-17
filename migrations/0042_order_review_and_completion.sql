PRAGMA foreign_keys = ON;

ALTER TABLE transport_orders ADD COLUMN completion_status TEXT NOT NULL DEFAULT 'in_progress'
  CHECK(completion_status IN ('in_progress','business_complete_unsettled','completed_settled'));
ALTER TABLE transport_orders ADD COLUMN business_completed_at TEXT;
ALTER TABLE transport_orders ADD COLUMN settlement_completed_at TEXT;

CREATE TABLE order_review_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  readiness_status TEXT NOT NULL CHECK(readiness_status IN ('blocked','business_complete_unsettled','completed_settled')),
  timing_json TEXT NOT NULL,
  planned_pieces INTEGER NOT NULL DEFAULT 0,
  planned_weight_kg REAL NOT NULL DEFAULT 0,
  planned_volume_cbm REAL NOT NULL DEFAULT 0,
  actual_pieces INTEGER NOT NULL DEFAULT 0,
  actual_weight_kg REAL NOT NULL DEFAULT 0,
  actual_volume_cbm REAL NOT NULL DEFAULT 0,
  loaded_pieces INTEGER NOT NULL DEFAULT 0,
  loaded_weight_kg REAL NOT NULL DEFAULT 0,
  loaded_volume_cbm REAL NOT NULL DEFAULT 0,
  finance_json TEXT NOT NULL,
  exception_json TEXT NOT NULL,
  people_json TEXT NOT NULL,
  blocker_json TEXT NOT NULL,
  customer_dispute_summary TEXT,
  review_conclusion TEXT,
  improvement_notes TEXT,
  generated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,order_id)
);

CREATE INDEX idx_order_reviews_org_status
  ON order_review_snapshots(organization_id,readiness_status,updated_at DESC);
CREATE INDEX idx_orders_completion
  ON transport_orders(organization_id,completion_status,updated_at DESC);

UPDATE transport_orders
SET completion_status='business_complete_unsettled',
    business_completed_at=COALESCE(updated_at,created_at)
WHERE status='completed';
