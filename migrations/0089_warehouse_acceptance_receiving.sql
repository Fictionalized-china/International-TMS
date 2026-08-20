PRAGMA foreign_keys = ON;

CREATE TABLE warehouse_receipt_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL REFERENCES warehouse_receipts(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  cargo_item_id TEXT NOT NULL REFERENCES order_cargo_items(id) ON DELETE RESTRICT,
  expected_packages INTEGER NOT NULL DEFAULT 0 CHECK(expected_packages >= 0),
  expected_pieces INTEGER NOT NULL DEFAULT 0 CHECK(expected_pieces >= 0),
  expected_weight_kg REAL NOT NULL DEFAULT 0 CHECK(expected_weight_kg >= 0),
  expected_volume_cbm REAL NOT NULL DEFAULT 0 CHECK(expected_volume_cbm >= 0),
  actual_packages INTEGER NOT NULL DEFAULT 0 CHECK(actual_packages >= 0),
  actual_pieces INTEGER NOT NULL DEFAULT 0 CHECK(actual_pieces >= 0),
  actual_weight_kg REAL NOT NULL DEFAULT 0 CHECK(actual_weight_kg >= 0),
  actual_volume_cbm REAL NOT NULL DEFAULT 0 CHECK(actual_volume_cbm >= 0),
  result TEXT NOT NULL DEFAULT 'normal' CHECK(result IN ('normal','exception')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(receipt_id,cargo_item_id)
);

CREATE INDEX idx_warehouse_receipt_items_order
  ON warehouse_receipt_items(organization_id,order_id,cargo_item_id,created_at);

ALTER TABLE warehouse_packages ADD COLUMN cargo_item_id TEXT
  REFERENCES order_cargo_items(id) ON DELETE SET NULL;

CREATE INDEX idx_warehouse_packages_cargo_item
  ON warehouse_packages(organization_id,cargo_item_id,status);
