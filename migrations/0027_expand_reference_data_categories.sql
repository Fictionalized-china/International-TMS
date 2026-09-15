PRAGMA foreign_keys=OFF;

CREATE TABLE reference_data_new (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('country','province','city','currency','unit','transport_mode','service_level','cargo_type','lead_source')),
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

INSERT INTO reference_data_new(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at FROM reference_data;

DROP TABLE reference_data;
ALTER TABLE reference_data_new RENAME TO reference_data;

CREATE INDEX IF NOT EXISTS idx_reference_data_org_category ON reference_data(organization_id, category, status, sort_order);
CREATE INDEX IF NOT EXISTS idx_reference_data_geo_parent ON reference_data(organization_id, category, parent_code, status, sort_order);

INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'province','CN-XJ','新疆维吾尔自治区','Xinjiang','CN',10,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'province','CN-GD','广东省','Guangdong','CN',20,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'province','UZ-TK','塔什干市','Tashkent City','UZ',10,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'city','CN-XJ-URC','乌鲁木齐市','Urumqi','CN-XJ',10,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'city','CN-GD-SZX','深圳市','Shenzhen','CN-GD',10,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'city','UZ-TK-TAS','塔什干','Tashkent','UZ-TK',10,'active',datetime('now'),datetime('now') FROM organizations;

PRAGMA foreign_keys=ON;
