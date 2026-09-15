PRAGMA foreign_keys = ON;

CREATE TABLE warehouse_stocktakes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stocktake_number TEXT NOT NULL,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES warehouse_locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'counting' CHECK (status IN ('counting','completed','cancelled')),
  expected_packages INTEGER NOT NULL DEFAULT 0,
  counted_packages INTEGER NOT NULL DEFAULT 0,
  shortage_packages INTEGER NOT NULL DEFAULT 0,
  overage_packages INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (organization_id, stocktake_number)
);

CREATE TABLE warehouse_stocktake_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stocktake_id TEXT NOT NULL REFERENCES warehouse_stocktakes(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE CASCADE,
  expected_quantity INTEGER NOT NULL DEFAULT 1 CHECK (expected_quantity IN (0,1)),
  counted_quantity INTEGER NOT NULL DEFAULT 0 CHECK (counted_quantity IN (0,1)),
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','matched','shortage','overage')),
  counted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  counted_at TEXT,
  UNIQUE (stocktake_id, package_id)
);

CREATE INDEX idx_stocktakes_org_status ON warehouse_stocktakes(organization_id,status,updated_at DESC);
CREATE INDEX idx_stocktake_items_parent ON warehouse_stocktake_items(stocktake_id,result);
