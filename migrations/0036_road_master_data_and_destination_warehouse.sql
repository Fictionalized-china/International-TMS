PRAGMA foreign_keys=OFF;

-- Add border ports to the shared reference-data dictionary while preserving all
-- existing country/province/city and commercial code records.
CREATE TABLE reference_data_0036 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('country','province','city','currency','unit','transport_mode','service_level','cargo_type','lead_source','border_port')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_en TEXT,
  parent_code TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, category, code)
);

INSERT INTO reference_data_0036(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at
FROM reference_data;

DROP TABLE reference_data;
ALTER TABLE reference_data_0036 RENAME TO reference_data;

CREATE INDEX idx_reference_data_org_category ON reference_data(organization_id,category,status,sort_order);
CREATE INDEX idx_reference_data_geo_parent ON reference_data(organization_id,category,parent_code,status,sort_order);

INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'border_port','CN-XJ-KH','霍尔果斯口岸','Khorgos Port','CN-XJ',10,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'border_port','CN-XJ-ALA','阿拉山口口岸','Alashankou Port','CN-XJ',20,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'border_port','CN-XJ-BAK','巴克图口岸','Baketu Port','CN-XJ',30,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'border_port','CN-XJ-TUR','吐尔尕特口岸','Torugart Port','CN-XJ',40,'active',datetime('now'),datetime('now') FROM organizations;

ALTER TABLE warehouses ADD COLUMN warehouse_role TEXT NOT NULL DEFAULT 'domestic_collection'
  CHECK (warehouse_role IN ('domestic_collection','port','overseas_destination'));

ALTER TABLE transport_orders ADD COLUMN overseas_warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE transport_orders ADD COLUMN overseas_warehouse_address_note TEXT;

CREATE INDEX idx_warehouses_org_role ON warehouses(organization_id,warehouse_role,status,code);
CREATE INDEX idx_orders_overseas_warehouse ON transport_orders(organization_id,overseas_warehouse_id,status);

PRAGMA foreign_keys=ON;
