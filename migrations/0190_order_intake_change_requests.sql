-- Proposed corrections are not order facts until an authorized reviewer applies them.
CREATE TABLE order_intake_change_requests (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
 order_id TEXT NOT NULL REFERENCES transport_orders(id),kind TEXT NOT NULL DEFAULT 'plan' CHECK(kind IN ('plan','cargo')),
 request_key TEXT NOT NULL,request_hash TEXT NOT NULL,source_hash TEXT NOT NULL,
 before_json TEXT NOT NULL,proposed_json TEXT NOT NULL,changes_json TEXT NOT NULL,
 reason TEXT NOT NULL,requested_by_user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn')),
 pending_order_id TEXT,reviewed_by_user_id TEXT REFERENCES users(id),review_notes TEXT,
 created_at TEXT NOT NULL,reviewed_at TEXT,
 UNIQUE(organization_id,requested_by_user_id,request_key),
 UNIQUE(organization_id,pending_order_id),
 CHECK((status='pending' AND pending_order_id IS NOT NULL AND pending_order_id=order_id) OR (status!='pending' AND pending_order_id IS NULL))
);
CREATE INDEX idx_intake_changes_order ON order_intake_change_requests(organization_id,order_id,created_at);
