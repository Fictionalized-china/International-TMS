PRAGMA foreign_keys = ON;

ALTER TABLE business_expenses ADD COLUMN source_type TEXT;
ALTER TABLE business_expenses ADD COLUMN source_id TEXT;

CREATE UNIQUE INDEX idx_expenses_source
  ON business_expenses(organization_id,source_type,source_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

CREATE TABLE transport_cost_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transport_batches(id) ON DELETE CASCADE,
  charge_code TEXT NOT NULL,
  charge_name TEXT NOT NULL,
  counterparty_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  exchange_rate REAL NOT NULL DEFAULT 1 CHECK(exchange_rate > 0),
  total_amount REAL NOT NULL CHECK(total_amount > 0),
  allocation_method TEXT NOT NULL CHECK(allocation_method IN ('weight','volume','equal')),
  total_actual_weight_kg REAL NOT NULL DEFAULT 0 CHECK(total_actual_weight_kg >= 0),
  total_actual_volume_cbm REAL NOT NULL DEFAULT 0 CHECK(total_actual_volume_cbm >= 0),
  density_kg_per_cbm REAL NOT NULL DEFAULT 0 CHECK(density_kg_per_cbm >= 0),
  density_result TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','cancelled')),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE transport_cost_allocation_lines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  allocation_id TEXT NOT NULL REFERENCES transport_cost_allocations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  actual_weight_kg REAL NOT NULL DEFAULT 0 CHECK(actual_weight_kg >= 0),
  actual_volume_cbm REAL NOT NULL DEFAULT 0 CHECK(actual_volume_cbm >= 0),
  suggested_ratio REAL NOT NULL DEFAULT 0 CHECK(suggested_ratio >= 0),
  suggested_amount REAL NOT NULL DEFAULT 0 CHECK(suggested_amount >= 0),
  adjusted_amount REAL,
  adjustment_reason TEXT,
  final_amount REAL NOT NULL DEFAULT 0 CHECK(final_amount >= 0),
  expense_id TEXT REFERENCES business_expenses(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(allocation_id,order_id)
);

CREATE INDEX idx_cost_allocations_batch
  ON transport_cost_allocations(organization_id,batch_id,status,created_at DESC);
CREATE INDEX idx_cost_allocation_lines
  ON transport_cost_allocation_lines(organization_id,allocation_id,order_id);
