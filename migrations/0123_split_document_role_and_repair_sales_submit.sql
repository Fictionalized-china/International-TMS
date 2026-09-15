PRAGMA foreign_keys = ON;

-- Split document/customs duties from the merged operation/tracking role.
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'DOC','单证岗','OP','active',50,datetime('now'),datetime('now') FROM organizations o;

UPDATE positions SET name='操作岗（含运踪）',department_code='OP',status='active',sort_order=40,updated_at=datetime('now') WHERE code='OPERATION';
UPDATE positions SET name='单证岗',department_code='OP',status='active',sort_order=50,updated_at=datetime('now') WHERE code='DOC';
UPDATE positions SET status='disabled',updated_at=datetime('now') WHERE code='TRACKING';

INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_doc','单证岗','负责订单发运文件、报关申报资料与海关放行',1,'active',datetime('now'),datetime('now')
FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_doc');

UPDATE roles SET name='操作岗（含运踪）',description='负责运输安排、车辆与轨迹跟踪以及执行异常处理',status='active',updated_at=datetime('now') WHERE code='pos_operation';
UPDATE roles SET name='单证岗',description='负责订单发运文件、报关申报资料与海关放行',status='active',updated_at=datetime('now') WHERE code='pos_doc';
UPDATE roles SET status='disabled',updated_at=datetime('now') WHERE code='pos_tracking';

DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code IN ('pos_sales','pos_operation','pos_doc'));

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','customer.view','customer.manage','customer.scope.own','customer.sensitive.view',
  'sales.view','sales.manage','quote.view','quote.manage','order.view',
  'order.scope.assigned','order.scope.sales_own'
) WHERE r.code='pos_sales';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.manage','order.scope.assigned','shipment.view','shipment.manage','carrier.view',
  'order.module.transport.manage','order.module.tracking.manage','order.module.exceptions.manage'
) WHERE r.code='pos_operation';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.manage','order.scope.assigned','shipment.view',
  'order.module.documents.manage','order.module.customs.manage'
) WHERE r.code='pos_doc';

INSERT OR IGNORE INTO membership_roles(membership_id,role_id)
SELECT m.id,r.id
FROM memberships m
JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
JOIN roles r ON r.organization_id=m.organization_id AND r.code='pos_doc'
WHERE p.code='DOC' AND m.status='active';

INSERT OR IGNORE INTO position_portal_settings(
  id,organization_id,position_id,order_scope,default_filter,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),p.organization_id,p.id,'current_position','open',datetime('now'),datetime('now')
FROM positions p WHERE p.code='DOC' AND p.status='active';
