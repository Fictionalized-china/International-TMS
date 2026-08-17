PRAGMA foreign_keys = ON;

CREATE TABLE warehouse_sorting_batches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_number TEXT NOT NULL,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  target_location_id TEXT NOT NULL REFERENCES warehouse_locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','staged','verified','cancelled')),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  verified_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  UNIQUE (organization_id, batch_number)
);

CREATE TABLE warehouse_sorting_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES warehouse_sorting_batches(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'sorted' CHECK (status IN ('sorted','verified','exception')),
  sorted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  verified_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sorted_at TEXT NOT NULL,
  verified_at TEXT,
  notes TEXT,
  UNIQUE (batch_id, package_id)
);

CREATE TABLE warehouse_package_movements (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('inbound','sort','stage','verify','dispatch','move','exception')),
  from_location_id TEXT REFERENCES warehouse_locations(id) ON DELETE SET NULL,
  to_location_id TEXT REFERENCES warehouse_locations(id) ON DELETE SET NULL,
  batch_id TEXT REFERENCES warehouse_sorting_batches(id) ON DELETE SET NULL,
  operator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sorting_batches_org_status ON warehouse_sorting_batches(organization_id,status,updated_at DESC);
CREATE INDEX idx_sorting_items_batch ON warehouse_sorting_items(batch_id,status);
CREATE INDEX idx_package_movements_package ON warehouse_package_movements(package_id,occurred_at DESC);

INSERT INTO warehouse_package_movements(id,organization_id,package_id,operation_type,to_location_id,operator_user_id,notes,occurred_at,created_at)
SELECT 'movement-inbound-' || id,organization_id,id,'inbound',location_id,NULL,'历史入库记录',created_at,created_at FROM warehouse_packages;
