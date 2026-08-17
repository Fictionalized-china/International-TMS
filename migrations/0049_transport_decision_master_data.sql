PRAGMA foreign_keys=OFF;

CREATE TABLE reference_data_0049 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('country','province','city','currency','unit','transport_mode','service_level','cargo_type','lead_source','border_port','customs_place','transit_place','route')),
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

INSERT INTO reference_data_0049(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at FROM reference_data;

DROP TABLE reference_data;
ALTER TABLE reference_data_0049 RENAME TO reference_data;
CREATE INDEX idx_reference_data_org_category ON reference_data(organization_id,category,status,sort_order);
CREATE INDEX idx_reference_data_geo_parent ON reference_data(organization_id,category,parent_code,status,sort_order);

INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'customs_place','CN-XJ-KH-CUSTOMS','霍尔果斯起运地清关','Khorgos Origin Customs',NULL,10,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'customs_place','CN-XJ-ALA-CUSTOMS','阿拉山口起运地清关','Alashankou Origin Customs',NULL,20,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'transit_place','KZ-ALA','阿拉木图','Almaty',NULL,10,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'transit_place','KZ-SHY','奇姆肯特','Shymkent',NULL,20,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'route','CN-KH-KZ-UZ','深圳/乌鲁木齐－霍尔果斯－阿拉木图－塔什干','China-Khorgos-Almaty-Tashkent',NULL,10,'active',datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO reference_data(id,organization_id,category,code,name,name_en,parent_code,sort_order,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'route','CN-ALA-KZ-UZ','深圳/乌鲁木齐－阿拉山口－阿拉木图－塔什干','China-Alashankou-Almaty-Tashkent',NULL,20,'active',datetime('now'),datetime('now') FROM organizations;

PRAGMA foreign_keys=ON;
