PRAGMA foreign_keys = ON;

ALTER TABLE quotations ADD COLUMN origin_state TEXT;
ALTER TABLE quotations ADD COLUMN pickup_address TEXT;
ALTER TABLE quotations ADD COLUMN destination_state TEXT;
ALTER TABLE quotations ADD COLUMN destination_warehouse_id TEXT
  REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE quotations ADD COLUMN destination_warehouse_note TEXT;
ALTER TABLE quotations ADD COLUMN estimated_length_cm REAL NOT NULL DEFAULT 0
  CHECK(estimated_length_cm >= 0);
ALTER TABLE quotations ADD COLUMN estimated_width_cm REAL NOT NULL DEFAULT 0
  CHECK(estimated_width_cm >= 0);
ALTER TABLE quotations ADD COLUMN estimated_height_cm REAL NOT NULL DEFAULT 0
  CHECK(estimated_height_cm >= 0);
ALTER TABLE quotations ADD COLUMN customs_clearance_mode TEXT NOT NULL DEFAULT 'company'
  CHECK(customs_clearance_mode IN ('company','customer'));

ALTER TABLE transport_orders ADD COLUMN customs_clearance_mode TEXT NOT NULL DEFAULT 'company'
  CHECK(customs_clearance_mode IN ('company','customer'));

ALTER TABLE warehouse_receipt_items ADD COLUMN actual_length_cm REAL NOT NULL DEFAULT 0
  CHECK(actual_length_cm >= 0);
ALTER TABLE warehouse_receipt_items ADD COLUMN actual_width_cm REAL NOT NULL DEFAULT 0
  CHECK(actual_width_cm >= 0);
ALTER TABLE warehouse_receipt_items ADD COLUMN actual_height_cm REAL NOT NULL DEFAULT 0
  CHECK(actual_height_cm >= 0);

CREATE UNIQUE INDEX idx_transport_orders_unique_quotation
  ON transport_orders(quotation_id)
  WHERE quotation_id IS NOT NULL;
