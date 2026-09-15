PRAGMA foreign_keys = ON;

-- Roles remain as historical records, but inactive roles cannot be assigned to
-- new accounts. Existing role inserts keep working through the default.
ALTER TABLE roles ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('active','disabled'));

-- Account-level permission blocks. `deny` always wins over both role grants and
-- account-level `allow`; owner/boss accounts are protected in application code.
CREATE TABLE membership_permission_overrides (
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(membership_id,permission_code)
);

CREATE INDEX idx_membership_permission_overrides_effective
  ON membership_permission_overrides(membership_id,effect,permission_code);

INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('order.scope.assigned','order','当前任务与岗位待认领池','查看派给本人以及当前节点尚未派人且由本人岗位负责的订单'),
  ('order.scope.sales_own','order','本人业务订单','业务岗查看由本人创建、本人报价或本人负责客户的订单全程'),
  ('order.scope.all','order','全部订单范围','查看组织内全部运输订单'),
  ('customer.scope.own','crm','本人客户范围','仅查看和维护由本人负责的客户'),
  ('customer.scope.all','crm','全部客户范围','查看组织内全部客户'),
  ('customer.sensitive.view','crm','查看客户敏感资料','查看客户联系人、联系方式、税务和详细地址等敏感资料'),
  ('billing.sensitive.view','billing','查看敏感费用','查看应收、应付、利润和回款数据'),
  ('billing.expense.approve','billing','审批费用','审批、驳回和锁定费用'),
  ('billing.cash.manage','billing','管理收付款','登记收款、付款和核销'),
  ('analytics.business.view','analytics','查看业务分析','查看业务量和履约统计'),
  ('analytics.profit.view','analytics','查看利润汇总','查看收入、成本和利润汇总'),
  ('data.export','analytics','导出业务数据','导出获授权范围内的业务与财务数据'),
  ('driver.rest.manage','driver','登记司机休息状态','维护自有司机工作与休息状态');

-- 人事行政采用独立部门；地区差异不改变岗位权限。
INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,NULL,'HR','人事行政部','active',50,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM departments d WHERE d.organization_id=o.id AND d.code='HR'
);

UPDATE departments SET name='人事行政部',status='active',sort_order=50,updated_at=datetime('now')
WHERE code='HR';

-- The official organization positions. Technical warehouse positions remain
-- available to warehouse-site accounts and are not part of this office matrix.
UPDATE positions SET name='业务岗',department_code='SALER',status='active',sort_order=10,updated_at=datetime('now') WHERE code='SALES';
UPDATE positions SET name='单证（操作岗）',department_code='OP',status='active',sort_order=20,updated_at=datetime('now') WHERE code='OPERATION';
UPDATE positions SET name='运踪岗',department_code='OP',status='active',sort_order=30,updated_at=datetime('now') WHERE code='TRACKING';
UPDATE positions SET name='客服岗',department_code='OP',status='active',sort_order=40,updated_at=datetime('now') WHERE code='CS';
UPDATE positions SET name='商务报价岗',department_code='BUS',status='active',sort_order=50,updated_at=datetime('now') WHERE code='BUSINESS_ROUTE';
UPDATE positions SET name='前端配载岗',department_code='OP',status='active',sort_order=60,updated_at=datetime('now') WHERE code='LOADING';
UPDATE positions SET name='财务会计岗',department_code='ACC',status='active',sort_order=70,updated_at=datetime('now') WHERE code='FINANCE_ACCOUNTING';
UPDATE positions SET name='出纳岗',department_code='ACC',status='active',sort_order=80,updated_at=datetime('now') WHERE code='CASHIER';

INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'HR_ADMIN','人事行政岗','HR','active',90,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='HR_ADMIN');

UPDATE positions SET name='人事行政岗',department_code='HR',status='active',sort_order=90,updated_at=datetime('now')
WHERE code='HR_ADMIN';

-- Move accounts off superseded office positions before disabling them.
-- Existing warehouse-site grants are authoritative: those accounts remain
-- warehouse operators instead of being converted into payroll-only roles.
UPDATE memberships
SET position_id=(
      SELECT target.id FROM positions target
      WHERE target.organization_id=memberships.organization_id
        AND target.code=CASE WHEN EXISTS(
          SELECT 1 FROM warehouse_user_access wua
          JOIN warehouses w ON w.id=wua.warehouse_id AND w.organization_id=wua.organization_id
          WHERE wua.organization_id=memberships.organization_id
            AND wua.user_id=memberships.user_id
            AND w.warehouse_role='overseas_destination'
        ) THEN 'OVERSEAS_WAREHOUSE' ELSE 'WAREHOUSE' END
      LIMIT 1
    ),
    updated_at=datetime('now')
WHERE position_id IN (
    SELECT id FROM positions WHERE code IN ('CONTAINER','OVERSEAS')
  )
  AND EXISTS(
    SELECT 1 FROM warehouse_user_access wua
    WHERE wua.organization_id=memberships.organization_id
      AND wua.user_id=memberships.user_id
  );

UPDATE memberships
SET position_id=(
      SELECT replacement.id FROM positions old_position
      JOIN positions replacement
        ON replacement.organization_id=old_position.organization_id
       AND replacement.code=CASE old_position.code
         WHEN 'DOC' THEN 'OPERATION'
         WHEN 'OVERSEAS' THEN 'OPERATION'
         WHEN 'BOOKING' THEN 'OPERATION'
         WHEN 'SALES_ASSISTANT' THEN 'SALES'
         WHEN 'FINANCE' THEN 'FINANCE_ACCOUNTING'
         WHEN 'CONTAINER' THEN 'LOADING'
       END
      WHERE old_position.id=memberships.position_id
      LIMIT 1
    ),
    updated_at=datetime('now')
WHERE position_id IN (
  SELECT id FROM positions
  WHERE code IN ('DOC','OVERSEAS','BOOKING','SALES_ASSISTANT','FINANCE','CONTAINER')
);

UPDATE memberships
SET department_id=(
      SELECT d.id FROM positions p
      JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code
      WHERE p.id=memberships.position_id LIMIT 1
    ),
    title=(SELECT p.name FROM positions p WHERE p.id=memberships.position_id LIMIT 1),
    updated_at=datetime('now')
WHERE position_id IS NOT NULL;

UPDATE positions SET status='disabled',updated_at=datetime('now')
WHERE code IN ('DOC','OVERSEAS','BOOKING','SALES_ASSISTANT','FINANCE','CONTAINER');

-- Add/relabel the roles that mirror the official positions.
INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_tracking','运踪岗','车辆资料与每日运踪更新',1,'active',datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_tracking');
INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_front_loading','前端配载岗','仅用于岗位与薪资归类，默认不授予系统权限',1,'active',datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_front_loading');
INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_cashier','出纳岗','收付款登记与核销',1,'active',datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_cashier');
INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_hr_admin','人事行政岗','账号、组织、岗位和权限维护',1,'active',datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_hr_admin');
INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'warehouse_operator','仓库作业账号','仓库站点收货、装车、出库与异常处理',1,'active',datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='warehouse_operator');
INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'overseas_warehouse_operator','境外仓库作业账号','境外仓库到仓、通知与提货处理',1,'active',datetime('now'),datetime('now') FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='overseas_warehouse_operator');

UPDATE roles SET name='业务岗',description='开发并维护本人客户、创建报价、查看本人订单全程',status='active',updated_at=datetime('now') WHERE code='pos_sales';
UPDATE roles SET name='单证（操作岗）',description='从上门提货到妥投签收的订单执行',status='active',updated_at=datetime('now') WHERE code='pos_operation';
UPDATE roles SET name='客服岗',description='订单资料、应收应付、账单、对账与收款协同',status='active',updated_at=datetime('now') WHERE code='pos_customer_service';
UPDATE roles SET name='商务报价岗',description='仅用于岗位与薪资归类，默认不授予系统权限',status='active',updated_at=datetime('now') WHERE code='pos_business_route';
UPDATE roles SET name='财务会计岗',description='财务查询导出、费用管理、回款统计与线上审批',status='active',updated_at=datetime('now') WHERE code='pos_finance';
UPDATE roles SET status='disabled',updated_at=datetime('now')
WHERE code IN ('pos_doc','pos_overseas','pos_booking','pos_sales_assistant','pos_container');

-- Replace old position roles on migrated accounts while keeping unrelated
-- custom roles intact.
INSERT OR IGNORE INTO membership_roles(membership_id,role_id)
SELECT m.id,r.id
FROM memberships m
JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
JOIN roles r ON r.organization_id=m.organization_id AND r.code=CASE p.code
  WHEN 'SALES' THEN 'pos_sales'
  WHEN 'OPERATION' THEN 'pos_operation'
  WHEN 'TRACKING' THEN 'pos_tracking'
  WHEN 'CS' THEN 'pos_customer_service'
  WHEN 'BUSINESS_ROUTE' THEN 'pos_business_route'
  WHEN 'LOADING' THEN 'pos_front_loading'
  WHEN 'FINANCE_ACCOUNTING' THEN 'pos_finance'
  WHEN 'CASHIER' THEN 'pos_cashier'
  WHEN 'HR_ADMIN' THEN 'pos_hr_admin'
END
WHERE p.code IN ('SALES','OPERATION','TRACKING','CS','BUSINESS_ROUTE','LOADING','FINANCE_ACCOUNTING','CASHIER','HR_ADMIN');

INSERT OR IGNORE INTO membership_roles(membership_id,role_id)
SELECT m.id,r.id
FROM memberships m
JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
JOIN roles r ON r.organization_id=m.organization_id AND r.code=CASE p.code
  WHEN 'WAREHOUSE' THEN 'warehouse_operator'
  WHEN 'OVERSEAS_WAREHOUSE' THEN 'overseas_warehouse_operator'
END
WHERE p.code IN ('WAREHOUSE','OVERSEAS_WAREHOUSE');

DELETE FROM membership_roles
WHERE role_id IN (SELECT id FROM roles WHERE status='disabled');

-- Exact default permission bundles for the official roles. Account overrides
-- can add or withdraw individual blocks later.
DELETE FROM role_permissions
WHERE role_id IN (
  SELECT id FROM roles WHERE code IN (
    'pos_sales','pos_operation','pos_tracking','pos_customer_service',
    'pos_business_route','pos_front_loading','pos_finance','pos_cashier','pos_hr_admin'
  )
);

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','customer.view','customer.manage','customer.scope.own',
  'customer.sensitive.view','sales.view','sales.manage','quote.view','quote.manage',
  'order.view','order.scope.assigned','order.scope.sales_own'
) WHERE r.code='pos_sales';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.manage','order.scope.assigned','shipment.view','shipment.manage','carrier.view',
  'order.module.assignment.manage','order.module.transport.manage','order.module.warehouse.manage',
  'order.module.loading.manage','order.module.documents.manage','order.module.customs.manage',
  'order.module.overseas_warehouse.manage','order.module.exceptions.manage','order.module.review.manage'
) WHERE r.code='pos_operation';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.scope.assigned','shipment.view','shipment.manage',
  'order.module.tracking.manage'
) WHERE r.code='pos_tracking';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','customer.view','customer.scope.all','customer.sensitive.view',
  'order.view','order.manage','order.scope.assigned','billing.view','billing.manage','billing.sensitive.view',
  'billing.cash.manage','order.module.consignment.manage','order.module.cargo.manage',
  'order.module.costs.manage'
) WHERE r.code='pos_customer_service';

-- pos_business_route and pos_front_loading intentionally receive zero blocks.

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.manage','order.scope.all','billing.view','billing.manage',
  'billing.sensitive.view','billing.expense.approve','analytics.business.view',
  'analytics.profit.view','data.export','audit.view','order.module.costs.manage',
  'order.module.review.manage'
) WHERE r.code='pos_finance';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.scope.all','billing.view','billing.sensitive.view',
  'billing.cash.manage','data.export'
) WHERE r.code='pos_cashier';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','organization.view','user.view','user.manage','role.view','role.manage',
  'department.view','department.manage','security.manage','audit.view'
) WHERE r.code='pos_hr_admin';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.scope.assigned','warehouse.view','warehouse.operate',
  'order.module.warehouse.manage','order.module.loading.manage','order.module.exceptions.manage'
) WHERE r.code='warehouse_operator';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.scope.assigned','warehouse.view','warehouse.operate',
  'order.module.overseas_warehouse.manage','order.module.exceptions.manage'
) WHERE r.code='overseas_warehouse_operator';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code='order.scope.all'
WHERE r.code='developer';

-- Owner and boss are immutable superusers. Keep the physical role rows in sync
-- as well so warehouse-site admission and legacy permission checks still work.
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p
WHERE r.code IN ('owner','boss');

INSERT OR IGNORE INTO position_portal_settings(
  id,organization_id,position_id,order_scope,default_filter,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),p.organization_id,p.id,
       CASE WHEN p.code IN ('BOSS','DEVELOPER','FINANCE_ACCOUNTING','CASHIER') THEN 'all_orders' ELSE 'current_position' END,
       'open',datetime('now'),datetime('now')
FROM positions p
WHERE p.status='active';
