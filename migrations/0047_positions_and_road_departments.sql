PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  department_code TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, code)
);

INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,NULL,'SALER','业务部','active',10,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.organization_id=o.id AND d.code='SALER');

INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,NULL,'BUS','商务部','active',20,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.organization_id=o.id AND d.code='BUS');

INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,NULL,'OP','操作部','active',30,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.organization_id=o.id AND d.code='OP');

INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,NULL,'ACC','财务部','active',40,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.organization_id=o.id AND d.code='ACC');

INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,NULL,'ZJB','总经办','active',50,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.organization_id=o.id AND d.code='ZJB');

INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'DOC','单证','OP','active',10,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='DOC');
INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'CS','客服','OP','active',20,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='CS');
INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'FINANCE','财务','ACC','active',30,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='FINANCE');
INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'SALES','业务员','SALER','active',40,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='SALES');
INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'OVERSEAS','海外人员','OP','active',50,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='OVERSEAS');
INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'CONTAINER','箱管','OP','active',60,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='CONTAINER');
INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'SALES_ASSISTANT','业务助理','SALER','active',70,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='SALES_ASSISTANT');
INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'OPERATION','操作','OP','active',80,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='OPERATION');
INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'BUSINESS_ROUTE','商务/航线','BUS','active',90,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='BUSINESS_ROUTE');
INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'BOOKING','订舱人员','BUS','active',100,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='BOOKING');
