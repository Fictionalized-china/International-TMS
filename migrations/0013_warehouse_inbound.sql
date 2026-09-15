PRAGMA foreign_keys = ON;

CREATE TABLE warehouse_receipts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receipt_number TEXT NOT NULL,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES warehouse_locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('draft','completed','cancelled')),
  total_packages INTEGER NOT NULL DEFAULT 0 CHECK (total_packages >= 0),
  total_pieces INTEGER NOT NULL DEFAULT 0 CHECK (total_pieces >= 0),
  total_weight_kg REAL NOT NULL DEFAULT 0 CHECK (total_weight_kg >= 0),
  total_volume_cbm REAL NOT NULL DEFAULT 0 CHECK (total_volume_cbm >= 0),
  notes TEXT,
  received_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, receipt_number)
);

CREATE TABLE warehouse_packages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL REFERENCES warehouse_receipts(id) ON DELETE CASCADE,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES warehouse_locations(id) ON DELETE RESTRICT,
  barcode TEXT NOT NULL,
  package_number TEXT NOT NULL,
  pieces INTEGER NOT NULL DEFAULT 1 CHECK (pieces > 0),
  weight_kg REAL CHECK (weight_kg IS NULL OR weight_kg > 0),
  volume_cbm REAL CHECK (volume_cbm IS NULL OR volume_cbm > 0),
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','allocated','dispatched','exception')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, barcode),
  UNIQUE (organization_id, package_number)
);

CREATE INDEX idx_warehouse_receipts_org_time ON warehouse_receipts(organization_id,received_at DESC);
CREATE INDEX idx_warehouse_receipts_shipment ON warehouse_receipts(shipment_id);
CREATE INDEX idx_warehouse_packages_location ON warehouse_packages(location_id,status);
CREATE INDEX idx_warehouse_packages_shipment ON warehouse_packages(shipment_id,status);
