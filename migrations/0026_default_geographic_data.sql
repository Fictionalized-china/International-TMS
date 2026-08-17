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
