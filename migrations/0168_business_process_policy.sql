CREATE TABLE business_process_policies (
  organization_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  policy_value TEXT NOT NULL,
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, policy_key),
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);
CREATE TABLE business_process_policy_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX business_process_policy_history_org ON business_process_policy_history(organization_id,created_at);
ALTER TABLE customers ADD COLUMN cs_order_entry_enabled INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
('order.intake.manage','order','直接录单与提交','按可配置岗位及客户代录标记直接录单；不授予报价修改权限');
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
('workflow.process_policy.manage','workflow','配置跨模块业务策略','指定配置人员维护录单、调度、运踪与签核规则；不授予其他审批权限');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'order.intake.manage' FROM roles WHERE code IN ('pos_sales','pos_customer_service','owner','boss','developer') AND status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'workflow.process_policy.manage' FROM roles WHERE code IN ('owner','boss','developer') AND status='active';

-- Reading scope only: no new order mutation permission is granted here.
UPDATE position_portal_settings SET business_data_scope='company',order_scope='all_orders'
WHERE position_id IN (SELECT id FROM positions WHERE code='TRACKING')
  AND business_data_scope='self' AND order_scope='all_orders';
