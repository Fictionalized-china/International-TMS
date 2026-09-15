PRAGMA foreign_keys = ON;

CREATE TABLE warehouses (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  country_code TEXT,
  city TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, code)
);

CREATE TABLE warehouse_zones (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  zone_type TEXT NOT NULL DEFAULT 'storage' CHECK (zone_type IN ('receiving','storage','sorting','staging','exception','dispatch')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (warehouse_id, code)
);

CREATE TABLE warehouse_locations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL REFERENCES warehouse_zones(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  barcode TEXT,
  capacity_cbm REAL CHECK (capacity_cbm IS NULL OR capacity_cbm > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (warehouse_id, code),
  UNIQUE (organization_id, barcode)
);

ALTER TABLE warehouse_operations ADD COLUMN warehouse_location_id TEXT REFERENCES warehouse_locations(id) ON DELETE SET NULL;

CREATE INDEX idx_warehouses_org ON warehouses(organization_id,status);
CREATE INDEX idx_warehouse_zones_parent ON warehouse_zones(warehouse_id,status);
CREATE INDEX idx_warehouse_locations_zone ON warehouse_locations(zone_id,status);

INSERT INTO warehouses(id,organization_id,code,name,country_code,city,status,created_at,updated_at)
SELECT 'warehouse-' || id,id,'MAIN','默认仓库','CN','乌鲁木齐','active',datetime('now'),datetime('now') FROM organizations;

INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,zone_type,status,created_at,updated_at)
SELECT 'zone-receiving-' || id,id,'warehouse-' || id,'RCV','收货区','receiving','active',datetime('now'),datetime('now') FROM organizations;

INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,barcode,status,created_at,updated_at)
SELECT 'location-receiving-' || id,id,'warehouse-' || id,'zone-receiving-' || id,'RCV-01','收货暂存位','RCV-01-' || substr(id,1,8),'active',datetime('now'),datetime('now') FROM organizations;
