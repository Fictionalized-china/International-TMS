PRAGMA foreign_keys = ON;

CREATE TABLE warehouse_operations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('receive','measure','dispatch','exception','resume','deliver')),
  location TEXT,
  measured_pieces INTEGER CHECK (measured_pieces IS NULL OR measured_pieces > 0),
  measured_weight_kg REAL CHECK (measured_weight_kg IS NULL OR measured_weight_kg > 0),
  measured_volume_cbm REAL CHECK (measured_volume_cbm IS NULL OR measured_volume_cbm > 0),
  notes TEXT,
  signed_by TEXT,
  operator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_warehouse_operations_shipment ON warehouse_operations(shipment_id,occurred_at DESC);
CREATE INDEX idx_warehouse_operations_org_time ON warehouse_operations(organization_id,occurred_at DESC);
