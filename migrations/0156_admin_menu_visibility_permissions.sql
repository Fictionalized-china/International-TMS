PRAGMA foreign_keys = ON;

-- 侧栏菜单可见性与业务操作权限分离。菜单权限只负责显示入口；
-- 页面读取和写操作继续由各业务模块权限控制。
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('menu.admin.portal.view','navigation','显示任务工作台菜单','在管理端侧栏显示任务工作台入口'),
  ('menu.admin.notifications.view','navigation','显示通知菜单','在管理端侧栏显示通知入口'),
  ('menu.admin.dashboard.view','navigation','显示运营总览菜单','在管理端侧栏显示运营总览入口'),
  ('menu.admin.quotations.view','navigation','显示询价与报价菜单','在管理端侧栏显示询价与报价入口'),
  ('menu.admin.orders.view','navigation','显示订单中心菜单','在管理端侧栏显示订单中心入口'),
  ('menu.admin.loading.view','navigation','显示配载单跟踪菜单','在管理端侧栏显示配载单跟踪入口'),
  ('menu.admin.documents.view','navigation','显示文件中心菜单','在管理端侧栏显示文件中心入口'),
  ('menu.admin.shipments.view','navigation','显示运输单据菜单','在管理端侧栏显示运输单据入口'),
  ('menu.admin.billing.view','navigation','显示费用结算菜单','在管理端侧栏显示费用结算入口'),
  ('menu.admin.cargo.view','navigation','显示货物信息菜单','在管理端侧栏显示货物信息入口'),
  ('menu.admin.customers.view','navigation','显示客户管理菜单','在管理端侧栏显示客户管理入口'),
  ('menu.admin.sales.view','navigation','显示销售管理菜单','在管理端侧栏显示销售管理入口'),
  ('menu.admin.logistics_products.view','navigation','显示物流产品菜单','在管理端侧栏显示物流产品入口'),
  ('menu.admin.carriers.view','navigation','显示承运商管理菜单','在管理端侧栏显示承运商管理入口'),
  ('menu.admin.workflow.view','navigation','显示业务工作流菜单','在管理端侧栏显示业务工作流入口'),
  ('menu.admin.master_data.view','navigation','显示基础数据菜单','在管理端侧栏显示基础数据入口'),
  ('menu.admin.warehouses.view','navigation','显示仓库管理菜单','在管理端侧栏显示仓库管理入口'),
  ('menu.admin.organization_access.view','navigation','显示组织与权限菜单','在管理端侧栏显示组织与权限入口'),
  ('menu.admin.security.view','navigation','显示安全中心菜单','在管理端侧栏显示安全中心入口'),
  ('menu.admin.audit.view','navigation','显示审计日志菜单','在管理端侧栏显示审计日志入口'),
  ('order.module.documents.view','order','查看文件中心','查看授权订单及配载单的文件，不包含上传、编辑或审核'),
  ('order.module.cargo.view','order','查看货物信息','查看授权订单的货物与包装信息，不包含编辑'),
  ('security.view','identity','查看安全中心','查看组织内有效会话和登录风险，不包含撤销会话或解除限制');

-- 既有管理权限自动包含对应的只读能力。
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'order.module.documents.view' FROM role_permissions
WHERE permission_code='order.module.documents.manage';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'order.module.cargo.view' FROM role_permissions
WHERE permission_code='order.module.cargo.manage';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'security.view' FROM role_permissions
WHERE permission_code='security.manage';

-- 工作台和通知过去固定显示，因此为所有现有启用角色保留原体验。
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'menu.admin.portal.view' FROM roles WHERE status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'menu.admin.notifications.view' FROM roles WHERE status='active';

-- 其余菜单按升级前的实际显示条件回填，升级不会增减现有入口。
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.dashboard.view' FROM role_permissions WHERE permission_code='dashboard.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.quotations.view' FROM role_permissions WHERE permission_code='quote.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.orders.view' FROM role_permissions WHERE permission_code='order.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.loading.view' FROM role_permissions
WHERE permission_code IN ('transport.batch.assigned.view','transport.batch.approve','order.module.loading.manage','order.module.costs.manage');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'menu.admin.loading.view' FROM roles WHERE status='active' AND code IN ('owner','boss','developer');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.documents.view' FROM role_permissions WHERE permission_code='order.module.documents.manage';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.shipments.view' FROM role_permissions WHERE permission_code='shipment.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT billing.role_id,'menu.admin.billing.view'
FROM role_permissions billing
WHERE billing.permission_code='billing.view'
  AND EXISTS(SELECT 1 FROM role_permissions sensitive WHERE sensitive.role_id=billing.role_id AND sensitive.permission_code='billing.sensitive.view');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.cargo.view' FROM role_permissions WHERE permission_code='order.module.cargo.manage';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.customers.view' FROM role_permissions WHERE permission_code='customer.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.sales.view' FROM role_permissions WHERE permission_code='sales.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.logistics_products.view' FROM role_permissions WHERE permission_code='pricing.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.carriers.view' FROM role_permissions WHERE permission_code='carrier.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.workflow.view' FROM role_permissions WHERE permission_code='workflow.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.master_data.view' FROM role_permissions WHERE permission_code='master.view';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.warehouses.view' FROM role_permissions WHERE permission_code IN ('warehouse.admin.view','warehouse.manage');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.organization_access.view' FROM role_permissions WHERE permission_code IN ('department.view','user.view','role.view');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.security.view' FROM role_permissions WHERE permission_code='security.manage';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.audit.view' FROM role_permissions WHERE permission_code='audit.view';
