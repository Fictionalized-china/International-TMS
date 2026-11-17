CREATE TABLE physical_operation_sync_jobs (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
 order_id TEXT NOT NULL REFERENCES transport_orders(id), warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
 kind TEXT NOT NULL CHECK(kind IN ('domestic_receipt','overseas_pickup','overseas_receipt')),
 source_id TEXT NOT NULL,payload_json TEXT NOT NULL,actor_user_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed')),
 lease_token TEXT,lease_until TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(organization_id,kind,source_id)
);
CREATE INDEX idx_physical_sync_pending ON physical_operation_sync_jobs(organization_id,order_id,status,created_at);
