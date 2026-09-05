-- Keep settlement duties separated: customer service prepares and confirms
-- expenses, while only the cashier records receipts, payments and write-offs.
DELETE FROM role_permissions
WHERE permission_code = 'billing.cash.manage'
  AND role_id IN (
    SELECT id FROM roles WHERE code = 'pos_customer_service'
  );

UPDATE roles
SET description = '订单资料、费用、账单与对账协同；不登记收付款或核销',
    updated_at = CURRENT_TIMESTAMP
WHERE code = 'pos_customer_service';
