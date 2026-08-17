PRAGMA foreign_keys = ON;

CREATE TABLE warehouse_user_access (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL CHECK (access_level IN ('viewer','operator','manager')),
  granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (warehouse_id, user_id)
);

CREATE INDEX idx_warehouse_user_access_user ON warehouse_user_access(organization_id,user_id,access_level);
CREATE INDEX idx_warehouse_user_access_warehouse ON warehouse_user_access(warehouse_id,access_level);
