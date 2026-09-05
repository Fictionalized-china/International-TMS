PRAGMA foreign_keys = ON;

-- The order salesperson must inspect the expenses they sign off, but does not
-- need organization-wide settlement, bank or payment-document visibility.
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('billing.assigned_expense.review','billing','查看本人订单费用摘要','仅查看并审核本人订单的费用事实，不开放全组织结算、银行或收付款凭证');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role.id,'billing.assigned_expense.review'
FROM roles AS role
WHERE role.code='pos_sales' AND role.status='active';
