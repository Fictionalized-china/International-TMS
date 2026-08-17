PRAGMA foreign_keys = ON;

CREATE TABLE warehouse_dispatches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dispatch_number TEXT NOT NULL,
  sorting_batch_id TEXT NOT NULL REFERENCES warehouse_sorting_batches(id) ON DELETE RESTRICT,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  vehicle_plate TEXT NOT NULL,
  driver_name TEXT NOT NULL,
  driver_phone TEXT,
  carrier_name TEXT,
  seal_number TEXT,
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'loading' CHECK (status IN ('loading','dispatched','cancelled')),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  dispatched_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dispatched_at TEXT,
  UNIQUE (organization_id, dispatch_number),
  UNIQUE (sorting_batch_id)
);

CREATE TABLE warehouse_dispatch_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES warehouse_dispatches(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','loaded','exception')),
  loaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  loaded_at TEXT,
  notes TEXT,
  UNIQUE (dispatch_id, package_id)
);

CREATE INDEX idx_dispatches_org_status ON warehouse_dispatches(organization_id,status,updated_at DESC);
CREATE INDEX idx_dispatch_items_dispatch ON warehouse_dispatch_items(dispatch_id,status);
CREATE INDEX idx_dispatch_items_package ON warehouse_dispatch_items(package_id);
