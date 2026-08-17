PRAGMA foreign_keys = ON;

ALTER TABLE memberships ADD COLUMN position_id TEXT REFERENCES positions(id) ON DELETE SET NULL;

INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('carrier.view','carrier','查看承运商','查看国内承运商、车队、联系人和联系方式'),
  ('carrier.manage','carrier','管理承运商','新增、修改、停用承运商主数据');

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

UPDATE departments SET name='业务部', sort_order=10, updated_at=datetime('now') WHERE code='SALER';
UPDATE departments SET name='商务部', sort_order=20, updated_at=datetime('now') WHERE code='BUS';
UPDATE departments SET name='操作部', sort_order=30, updated_at=datetime('now') WHERE code='OP';
UPDATE departments SET name='财务部', sort_order=40, updated_at=datetime('now') WHERE code='ACC';
UPDATE departments SET name='总经办', sort_order=50, updated_at=datetime('now') WHERE code='ZJB';

INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'BOSS','老板','ZJB','active',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='BOSS');
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

UPDATE positions SET name='老板', department_code='ZJB', sort_order=1, updated_at=datetime('now') WHERE code='BOSS';
UPDATE positions SET name='单证', department_code='OP', sort_order=10, updated_at=datetime('now') WHERE code='DOC';
UPDATE positions SET name='客服', department_code='OP', sort_order=20, updated_at=datetime('now') WHERE code='CS';
UPDATE positions SET name='财务', department_code='ACC', sort_order=30, updated_at=datetime('now') WHERE code='FINANCE';
UPDATE positions SET name='业务员', department_code='SALER', sort_order=40, updated_at=datetime('now') WHERE code='SALES';
UPDATE positions SET name='海外人员', department_code='OP', sort_order=50, updated_at=datetime('now') WHERE code='OVERSEAS';
UPDATE positions SET name='箱管', department_code='OP', sort_order=60, updated_at=datetime('now') WHERE code='CONTAINER';
UPDATE positions SET name='业务助理', department_code='SALER', sort_order=70, updated_at=datetime('now') WHERE code='SALES_ASSISTANT';
UPDATE positions SET name='操作', department_code='OP', sort_order=80, updated_at=datetime('now') WHERE code='OPERATION';
UPDATE positions SET name='商务/航线', department_code='BUS', sort_order=90, updated_at=datetime('now') WHERE code='BUSINESS_ROUTE';
UPDATE positions SET name='订舱人员', department_code='BUS', sort_order=100, updated_at=datetime('now') WHERE code='BOOKING';

INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'boss','老板','拥有所有岗位权限',1,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='boss');

INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_doc','单证','单证岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_doc');
INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_customer_service','客服','客服岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_customer_service');
INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_finance','财务','财务岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_finance');
INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_sales','业务员','业务员岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_sales');
INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_overseas','海外人员','海外岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_overseas');
INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_container','箱管','箱管岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_container');
INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_sales_assistant','业务助理','业务助理岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_sales_assistant');
INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_operation','操作','操作岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_operation');
INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_business_route','商务/航线','商务航线岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_business_route');
INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_booking','订舱人员','订舱岗位权限',1,datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_booking');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p
WHERE r.code='boss';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN ('carrier.view','carrier.manage')
WHERE r.code='owner' AND r.is_system=1;

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code IN ('dashboard.view','order.view','shipment.view')
WHERE r.code IN ('pos_doc','pos_customer_service','pos_sales','pos_overseas','pos_container','pos_sales_assistant','pos_operation','pos_business_route','pos_booking');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code IN ('order.manage','shipment.manage','workflow.view','warehouse.view','carrier.view')
WHERE r.code IN ('pos_doc','pos_customer_service','pos_operation','pos_business_route','pos_booking');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code IN ('warehouse.view','warehouse.operate')
WHERE r.code IN ('pos_operation','pos_container','pos_overseas');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code IN ('billing.view','billing.manage','audit.view')
WHERE r.code='pos_finance';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code IN ('customer.view','customer.manage','sales.view','sales.manage','quote.view','quote.manage','order.view','order.manage')
WHERE r.code IN ('pos_sales','pos_sales_assistant');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code IN ('carrier.view','carrier.manage','pricing.view','pricing.manage')
WHERE r.code IN ('pos_business_route','pos_booking');

UPDATE memberships
SET position_id=(
  SELECT p.id
  FROM positions p
  WHERE p.organization_id=memberships.organization_id
    AND p.code=CASE
      WHEN lower(COALESCE(memberships.title,'')) LIKE '%finance%' OR memberships.title LIKE '%财务%' THEN 'FINANCE'
      WHEN lower(COALESCE(memberships.title,'')) LIKE '%warehouse%' OR memberships.title LIKE '%仓%' THEN 'CONTAINER'
      ELSE 'OPERATION'
    END
  LIMIT 1
)
WHERE position_id IS NULL;

INSERT OR IGNORE INTO shipments(id,organization_id,shipment_number,order_id,customer_id,current_location,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.organization_id,
       'SHP-AUTO-' || replace(o.order_number,'-',''),
       o.id,o.customer_id,o.origin_city,o.created_at,o.updated_at
FROM transport_orders o
WHERE NOT EXISTS (SELECT 1 FROM shipments s WHERE s.organization_id=o.organization_id AND s.order_id=o.id);

INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,created_by_user_id,created_at)
SELECT lower(hex(randomblob(16))),s.id,'booked',s.current_location,'迁移补齐：订单已有但缺少运单，系统自动补建',s.created_at,o.created_by_user_id,s.created_at
FROM shipments s
JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
WHERE NOT EXISTS (SELECT 1 FROM shipment_events e WHERE e.shipment_id=s.id AND e.status='booked');
