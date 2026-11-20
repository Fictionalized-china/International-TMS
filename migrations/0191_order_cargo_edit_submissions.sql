CREATE TABLE order_cargo_edit_submissions (
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),
 order_id TEXT NOT NULL REFERENCES transport_orders(id),actor_user_id TEXT NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,cargo_item_id TEXT NOT NULL REFERENCES order_cargo_items(id),
 mode TEXT NOT NULL CHECK(mode IN ('create','update')),package_count INTEGER NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(organization_id,actor_user_id,request_key)
);
