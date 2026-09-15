PRAGMA foreign_keys = ON;

-- The independent finance workbench is broader than ordinary order visibility.
-- Keep that expansion explicit: sensitive billing data and order.scope.all are
-- not settlement-scope capabilities.
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('billing.scope.all','billing','全部结算范围','查看并办理组织内全部运输订单关联的费用结算；不扩大普通订单可见范围');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,'billing.scope.all'
FROM roles r
WHERE r.code IN ('pos_finance','pos_cashier');

DELETE FROM role_permissions
WHERE permission_code='billing.scope.all'
  AND role_id IN (SELECT id FROM roles WHERE code='pos_customer_service');
