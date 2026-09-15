PRAGMA foreign_keys = ON;

CREATE TABLE overseas_warehouse_operations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transport_batches(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'waiting_arrival' CHECK(status IN ('waiting_arrival','arrived','notified','appointment','picked_up','cancelled')),
  actual_arrival_at TEXT,
  notified_at TEXT,
  appointment_at TEXT,
  pickup_at TEXT,
  pickup_contact TEXT,
  pickup_proof_reference TEXT,
  notes TEXT,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id,order_id)
);

CREATE INDEX idx_overseas_operations_order ON overseas_warehouse_operations(organization_id,order_id,status);
CREATE INDEX idx_overseas_operations_batch ON overseas_warehouse_operations(batch_id,status,updated_at);
