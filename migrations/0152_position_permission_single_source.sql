PRAGMA foreign_keys = ON;

-- Every position owns exactly one permission profile. The roles table remains
-- the physical template store, while account-role links are compatibility data.
INSERT INTO roles(
  id,organization_id,code,name,description,is_system,status,created_at,updated_at
)
SELECT
  lower(hex(randomblob(16))),position.organization_id,
  CASE position.code
    WHEN 'BOSS' THEN 'boss'
    WHEN 'DEVELOPER' THEN 'developer'
    WHEN 'SALES' THEN 'pos_sales'
    WHEN 'BUSINESS_SUPERVISOR' THEN 'pos_business_supervisor'
    WHEN 'OPERATION_SUPERVISOR' THEN 'pos_operation_supervisor'
    WHEN 'OPERATION' THEN 'pos_operation'
    WHEN 'DOC' THEN 'pos_doc'
    WHEN 'TRACKING' THEN 'pos_tracking'
    WHEN 'CS' THEN 'pos_customer_service'
    WHEN 'BUSINESS_ROUTE' THEN 'pos_business_route'
    WHEN 'LOADING' THEN 'pos_front_loading'
    WHEN 'FINANCE_ACCOUNTING' THEN 'pos_finance'
    WHEN 'CASHIER' THEN 'pos_cashier'
    WHEN 'HR_ADMIN' THEN 'pos_hr_admin'
    WHEN 'WAREHOUSE' THEN 'warehouse_operator'
    WHEN 'OVERSEAS_WAREHOUSE' THEN 'overseas_warehouse_operator'
    ELSE lower(position.code)
  END,
  position.name,position.name || ' position permission profile',
  CASE WHEN position.code IN (
    'BOSS','DEVELOPER','SALES','BUSINESS_SUPERVISOR',
    'OPERATION_SUPERVISOR','OPERATION','DOC','TRACKING','CS',
    'BUSINESS_ROUTE','LOADING','FINANCE_ACCOUNTING','CASHIER','HR_ADMIN',
    'WAREHOUSE','OVERSEAS_WAREHOUSE'
  ) THEN 1 ELSE 0 END,
  'active',datetime('now'),datetime('now')
FROM positions position
WHERE 1
ON CONFLICT(organization_id,code) DO UPDATE SET
  name=excluded.name,
  description=excluded.description,
  status='active',
  updated_at=excluded.updated_at;

-- Keep one deterministic compatibility role link for each positioned account.
DELETE FROM membership_roles
WHERE membership_id IN (
  SELECT membership.id FROM memberships membership
  WHERE membership.position_id IS NOT NULL
);

INSERT OR IGNORE INTO membership_roles(membership_id,role_id)
SELECT membership.id,role.id
FROM memberships membership
JOIN positions position
  ON position.id=membership.position_id
 AND position.organization_id=membership.organization_id
JOIN roles role
  ON role.organization_id=membership.organization_id
 AND role.code=CASE position.code
    WHEN 'BOSS' THEN 'boss'
    WHEN 'DEVELOPER' THEN 'developer'
    WHEN 'SALES' THEN 'pos_sales'
    WHEN 'BUSINESS_SUPERVISOR' THEN 'pos_business_supervisor'
    WHEN 'OPERATION_SUPERVISOR' THEN 'pos_operation_supervisor'
    WHEN 'OPERATION' THEN 'pos_operation'
    WHEN 'DOC' THEN 'pos_doc'
    WHEN 'TRACKING' THEN 'pos_tracking'
    WHEN 'CS' THEN 'pos_customer_service'
    WHEN 'BUSINESS_ROUTE' THEN 'pos_business_route'
    WHEN 'LOADING' THEN 'pos_front_loading'
    WHEN 'FINANCE_ACCOUNTING' THEN 'pos_finance'
    WHEN 'CASHIER' THEN 'pos_cashier'
    WHEN 'HR_ADMIN' THEN 'pos_hr_admin'
    WHEN 'WAREHOUSE' THEN 'warehouse_operator'
    WHEN 'OVERSEAS_WAREHOUSE' THEN 'overseas_warehouse_operator'
    ELSE lower(position.code)
  END;
