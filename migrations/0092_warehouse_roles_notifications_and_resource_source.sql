PRAGMA foreign_keys = ON;

-- Carrier resources are separated by the transport leg they serve.
ALTER TABLE carriers ADD COLUMN carrier_scope TEXT NOT NULL DEFAULT 'domestic'
  CHECK(carrier_scope IN ('domestic','overseas'));

CREATE INDEX idx_carriers_scope
  ON carriers(organization_id,carrier_scope,status,name);

-- A batch vehicle references the carrier master data selected by the operator.
-- Snapshot columns remain for historical display after master data is edited.
ALTER TABLE transport_batch_vehicles ADD COLUMN vehicle_master_id TEXT
  REFERENCES carrier_vehicles(id) ON DELETE SET NULL;
ALTER TABLE transport_batch_vehicles ADD COLUMN driver_master_id TEXT
  REFERENCES carrier_drivers(id) ON DELETE SET NULL;

CREATE TABLE warehouse_customer_notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  portal_notification_id TEXT REFERENCES portal_notifications(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'notified' CHECK(status IN ('notified','cancelled')),
  notified_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,order_id)
);

CREATE INDEX idx_warehouse_customer_notifications_queue
  ON warehouse_customer_notifications(organization_id,warehouse_id,status,notified_at DESC);

-- Files are controlled by the module where they are collected. The file center
-- is only a searchable index and must never be an independent workflow gate.
UPDATE workflow_step_modules
SET is_active=0,is_required=0,updated_at=datetime('now')
WHERE module_code='documents';

UPDATE order_module_instances
SET enabled=0,is_required=0,status='completed',blocking_reason=NULL,
    completed_at=COALESCE(completed_at,datetime('now')),updated_at=datetime('now')
WHERE module_code='documents';

UPDATE workflow_instance_module_states
SET is_required=0,status='completed',updated_at=datetime('now')
WHERE module_code='documents';
