PRAGMA foreign_keys = ON;

-- Entering an assigned PZ is a read/navigation capability.  It must not grant
-- the much broader loading-plan mutation permission.
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('transport.batch.assigned.view','transport','查看本人负责的配载单','仅进入并查看明确分配给本人的 PZ 配载单；具体操作仍由各业务模块权限和负责人关系共同校验');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,'transport.batch.assigned.view'
FROM roles r
WHERE r.code IN ('pos_operation','pos_doc');

-- Finance keeps the independent organization-wide settlement workbench via
-- billing permissions, but ordinary order pages are limited to explicitly
-- assigned costs/review work instead of every order in the organization.
DELETE FROM role_permissions
WHERE permission_code='order.scope.all'
  AND role_id IN (SELECT id FROM roles WHERE code='pos_finance');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,'order.scope.assigned'
FROM roles r
WHERE r.code='pos_finance';

UPDATE position_portal_settings
SET order_scope='current_position',updated_at=datetime('now')
WHERE position_id IN (
  SELECT id FROM positions WHERE code='FINANCE_ACCOUNTING'
);
