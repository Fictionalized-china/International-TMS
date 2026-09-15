PRAGMA foreign_keys = ON;

-- Keep the approver hand-off explicit: salesperson -> business supervisor ->
-- operation supervisor -> concrete operation account.
ALTER TABLE transport_orders ADD COLUMN operation_supervisor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

-- A PZ document has its own approval lifecycle. Operational status remains
-- unchanged so historical loading/dispatch data keeps its original meaning.
ALTER TABLE transport_batches ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'draft'
  CHECK(approval_status IN ('draft','submitted','approved','rejected'));
ALTER TABLE transport_batches ADD COLUMN operation_supervisor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transport_batches ADD COLUMN operation_assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transport_batches ADD COLUMN submitted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transport_batches ADD COLUMN submitted_at TEXT;
ALTER TABLE transport_batches ADD COLUMN approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transport_batches ADD COLUMN approved_at TEXT;
ALTER TABLE transport_batches ADD COLUMN approval_notes TEXT;

UPDATE transport_batches
SET approval_status='approved',
    submitted_by_user_id=created_by_user_id,
    submitted_at=created_at,
    approved_at=created_at
WHERE batch_number LIKE 'PZ-%';

CREATE INDEX idx_transport_orders_operation_supervisor
  ON transport_orders(organization_id,operation_supervisor_user_id,status);
CREATE INDEX idx_transport_batches_approval_assignment
  ON transport_batches(organization_id,approval_status,operation_supervisor_user_id,operation_assignee_user_id);

INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('transport.batch.approve','transport','审核拼车配载单','审核仓库提交的拼车配载单并指定整批操作负责人');

INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'BUSINESS_SUPERVISOR','业务主管','SALER','active',20,datetime('now'),datetime('now')
FROM organizations o;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'OPERATION_SUPERVISOR','操作主管','OP','active',30,datetime('now'),datetime('now')
FROM organizations o;

UPDATE positions SET name='业务主管',department_code='SALER',status='active',sort_order=20,updated_at=datetime('now')
WHERE code='BUSINESS_SUPERVISOR';
UPDATE positions SET name='操作主管',department_code='OP',status='active',sort_order=30,updated_at=datetime('now')
WHERE code='OPERATION_SUPERVISOR';
UPDATE positions SET name='操作岗（含单证与运踪）',department_code='OP',status='active',sort_order=40,updated_at=datetime('now')
WHERE code='OPERATION';

-- Existing tracking memberships are preserved but moved into the merged
-- operation position. Production account preparation later keeps one account.
UPDATE memberships
SET position_id=(
      SELECT target.id FROM positions old_position
      JOIN positions target ON target.organization_id=old_position.organization_id AND target.code='OPERATION'
      WHERE old_position.id=memberships.position_id LIMIT 1
    ),
    department_id=(
      SELECT d.id FROM departments d
      WHERE d.organization_id=memberships.organization_id AND d.code='OP' LIMIT 1
    ),
    title='操作岗（含单证与运踪）',
    updated_at=datetime('now')
WHERE position_id IN (SELECT id FROM positions WHERE code='TRACKING');

UPDATE positions SET status='disabled',updated_at=datetime('now') WHERE code='TRACKING';

INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_business_supervisor','业务主管','查看全部订单并审批指向本人的委托',1,'active',datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_business_supervisor');
INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_operation_supervisor','操作主管','接收审批订单、分配操作人员并审核拼车配载单',1,'active',datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_operation_supervisor');

UPDATE roles SET name='业务主管',description='查看全部订单并审批指向本人的委托',status='active',updated_at=datetime('now')
WHERE code='pos_business_supervisor';
UPDATE roles SET name='操作主管',description='接收审批订单、分配操作人员并审核拼车配载单',status='active',updated_at=datetime('now')
WHERE code='pos_operation_supervisor';
UPDATE roles SET name='操作岗（含单证与运踪）',description='负责运输安排、逐票文件、报关放行与全程运踪',status='active',updated_at=datetime('now')
WHERE code='pos_operation';
UPDATE roles SET status='disabled',updated_at=datetime('now') WHERE code='pos_tracking';

INSERT OR IGNORE INTO membership_roles(membership_id,role_id)
SELECT m.id,r.id
FROM memberships m
JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
JOIN roles r ON r.organization_id=m.organization_id AND r.code=CASE p.code
  WHEN 'BUSINESS_SUPERVISOR' THEN 'pos_business_supervisor'
  WHEN 'OPERATION_SUPERVISOR' THEN 'pos_operation_supervisor'
  WHEN 'OPERATION' THEN 'pos_operation'
END
WHERE p.code IN ('BUSINESS_SUPERVISOR','OPERATION_SUPERVISOR','OPERATION');

DELETE FROM membership_roles
WHERE role_id IN (SELECT id FROM roles WHERE code='pos_tracking');

DELETE FROM role_permissions
WHERE role_id IN (
  SELECT id FROM roles WHERE code IN ('pos_business_supervisor','pos_operation_supervisor','pos_operation')
);

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.scope.all'
) WHERE r.code='pos_business_supervisor';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.manage','order.scope.assigned','shipment.view','carrier.view',
  'order.module.assignment.manage','transport.batch.approve'
) WHERE r.code='pos_operation_supervisor';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.manage','order.scope.assigned','shipment.view','shipment.manage','carrier.view',
  'order.module.transport.manage','order.module.documents.manage','order.module.customs.manage',
  'order.module.tracking.manage','order.module.exceptions.manage'
) WHERE r.code='pos_operation';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,'transport.batch.approve' FROM roles r
WHERE r.code IN ('owner','boss');

INSERT OR IGNORE INTO position_portal_settings(
  id,organization_id,position_id,order_scope,default_filter,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),p.organization_id,p.id,
       CASE WHEN p.code='BUSINESS_SUPERVISOR' THEN 'all_orders' ELSE 'current_position' END,
       'open',datetime('now'),datetime('now')
FROM positions p
WHERE p.code IN ('BUSINESS_SUPERVISOR','OPERATION_SUPERVISOR') AND p.status='active';

UPDATE order_workflow_transitions
SET requires_assignee=1,updated_at=datetime('now')
WHERE action_code='approve' AND from_status='submitted' AND to_status='confirmed';
