-- 商务岗负责在配载成单前寻找并录入境外承运商、车辆和司机。
UPDATE roles
SET description='维护境外承运商、车辆和司机等配载前置运输资源',
    status='active',
    updated_at=datetime('now')
WHERE code='pos_business_route';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code IN (
  'dashboard.view',
  'carrier.view',
  'carrier.manage',
  'menu.admin.carriers.view'
)
WHERE r.code='pos_business_route' AND r.status='active';
