PRAGMA foreign_keys = ON;

ALTER TABLE warehouse_receipts ADD COLUMN package_type TEXT;
ALTER TABLE warehouse_receipts ADD COLUMN evidence_note TEXT;

CREATE TABLE warehouse_receipt_differences (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL REFERENCES warehouse_receipts(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  planned_pieces INTEGER NOT NULL DEFAULT 0,
  planned_weight_kg REAL NOT NULL DEFAULT 0,
  planned_volume_cbm REAL NOT NULL DEFAULT 0,
  actual_pieces INTEGER NOT NULL DEFAULT 0,
  actual_weight_kg REAL NOT NULL DEFAULT 0,
  actual_volume_cbm REAL NOT NULL DEFAULT 0,
  max_difference_percent REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled')),
  fee_impact_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(fee_impact_confirmed IN (0,1)),
  notes TEXT,
  confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(receipt_id)
);

CREATE INDEX idx_receipt_differences_order
  ON warehouse_receipt_differences(organization_id,order_id,status,max_difference_percent);

ALTER TABLE transport_batches ADD COLUMN road_status TEXT NOT NULL DEFAULT 'waiting_loading'
  CHECK(road_status IN (
    'waiting_loading','preplanned','loaded_waiting_exit','outbound_in_transit',
    'overseas_arrived','waiting_pickup','pickup_completed','cancelled'
  ));

CREATE TABLE transport_exit_confirmations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transport_batches(id) ON DELETE CASCADE,
  actual_exit_at TEXT NOT NULL,
  exit_port TEXT NOT NULL,
  exit_vehicle_plate TEXT NOT NULL,
  overseas_vehicle_plate TEXT,
  proof_reference TEXT,
  notes TEXT,
  confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id)
);

CREATE INDEX idx_exit_confirmations_org_time
  ON transport_exit_confirmations(organization_id,actual_exit_at DESC);

UPDATE transport_batches
SET road_status=CASE status
  WHEN 'planning' THEN 'waiting_loading'
  WHEN 'loading' THEN 'preplanned'
  WHEN 'departed' THEN 'outbound_in_transit'
  WHEN 'arrived' THEN 'overseas_arrived'
  WHEN 'cancelled' THEN 'cancelled'
  ELSE 'waiting_loading'
END;

UPDATE transport_batches
SET road_status='loaded_waiting_exit'
WHERE status!='cancelled'
  AND EXISTS (
    SELECT 1
    FROM transport_batch_orders bo
    JOIN shipments s ON s.order_id=bo.order_id
    JOIN warehouse_dispatches d ON d.shipment_id=s.id AND d.status='dispatched'
    WHERE bo.batch_id=transport_batches.id AND bo.status!='removed'
  );
