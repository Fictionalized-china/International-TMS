PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('order.module.consignment.manage','order','办理委托信息','录入和修改订单委托信息'),
  ('order.module.cargo.manage','order','办理货物信息','录入、复核和确认货物'),
  ('order.module.assignment.manage','order','审核与派单','审批订单并分配模块负责人'),
  ('order.module.transport.manage','order','办理国内运输','维护国内承运、车辆、司机和时间'),
  ('order.module.warehouse.manage','order','办理仓库作业','处理收货、齐套、装车和出库'),
  ('order.module.loading.manage','order','办理拼车配载','创建和管理配载批次'),
  ('order.module.documents.manage','order','办理文件单证','上传、审核和归档发运文件'),
  ('order.module.customs.manage','order','办理报关作业','维护申报、查验和放行'),
  ('order.module.tracking.manage','order','办理运输跟踪','登记出境和运输轨迹'),
  ('order.module.overseas_warehouse.manage','order','办理境外仓自提','确认到仓、通知、预约和提货'),
  ('order.module.costs.manage','order','办理费用结算','预录、审核、锁定和结算费用'),
  ('order.module.exceptions.manage','order','办理异常','登记、处理和关闭异常'),
  ('order.module.review.manage','order','办理订单复盘','生成并确认订单复盘');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code LIKE 'order.module.%.manage'
WHERE r.code IN ('owner','boss');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code IN ('dashboard.view','order.view','shipment.view')
WHERE r.code IN (
  'developer','pos_doc','pos_customer_service','pos_finance','pos_sales',
  'pos_overseas','pos_container','pos_sales_assistant','pos_operation',
  'pos_business_route','pos_booking'
);

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'order.module.consignment.manage','order.module.cargo.manage','order.module.costs.manage'
) WHERE r.code IN ('pos_sales','pos_sales_assistant');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'customer.view','order.module.consignment.manage','order.module.cargo.manage',
  'order.module.tracking.manage','order.module.overseas_warehouse.manage',
  'order.module.costs.manage','order.module.exceptions.manage'
) WHERE r.code='pos_customer_service';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'order.module.documents.manage','order.module.customs.manage'
) WHERE r.code='pos_doc';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'billing.view','billing.manage','audit.view','order.module.costs.manage','order.module.review.manage'
) WHERE r.code='pos_finance';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'warehouse.view','warehouse.operate','order.module.warehouse.manage','order.module.loading.manage'
) WHERE r.code='pos_container';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'warehouse.view','warehouse.operate','order.module.tracking.manage',
  'order.module.overseas_warehouse.manage','order.module.exceptions.manage'
) WHERE r.code='pos_overseas';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p ON p.code IN (
  'order.module.assignment.manage','order.module.transport.manage','order.module.warehouse.manage',
  'order.module.loading.manage','order.module.documents.manage','order.module.customs.manage',
  'order.module.tracking.manage','order.module.overseas_warehouse.manage','order.module.costs.manage',
  'order.module.exceptions.manage','order.module.review.manage'
)
WHERE r.code='pos_operation';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'carrier.view','carrier.manage','pricing.view','pricing.manage',
  'order.module.transport.manage','order.module.loading.manage','order.module.costs.manage'
) WHERE r.code='pos_business_route';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'carrier.view','shipment.manage','order.module.transport.manage',
  'order.module.loading.manage','order.module.documents.manage'
) WHERE r.code='pos_booking';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'workflow.view','workflow.manage','workflow.field.manage','master.view',
  'user.view','role.view','audit.view'
) WHERE r.code='developer';
