PRAGMA foreign_keys = ON;

CREATE TABLE order_cargo_images (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  cargo_item_id TEXT NOT NULL REFERENCES order_cargo_items(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  data_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_order_cargo_images_item ON order_cargo_images(cargo_item_id,sort_order);
CREATE INDEX idx_order_cargo_images_order ON order_cargo_images(order_id,created_at);
