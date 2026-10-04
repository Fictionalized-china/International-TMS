INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN ('order.intake.manage','customer.view','customer.scope.all') WHERE r.code='pos_hr_admin' AND r.status='active';
