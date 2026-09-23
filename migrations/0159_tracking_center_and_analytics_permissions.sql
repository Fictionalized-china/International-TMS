PRAGMA foreign_keys = ON;

-- 新增一级入口及财务汇总字段级权限。菜单、页面读取、金额字段和导出分别授权。
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('menu.admin.tracking_center.view','navigation','显示调度与运踪菜单','在管理端侧栏显示调度、运踪与时效预警入口'),
  ('menu.admin.analytics.view','navigation','显示汇总分析菜单','在管理端侧栏显示汇总分析入口'),
  ('analytics.receivable.view','analytics','查看应收汇总','查看汇总分析中的应收金额，不包含应付、毛利或导出'),
  ('analytics.payable.view','analytics','查看应付与成本汇总','查看汇总分析中的应付及成本金额，不包含应收、毛利或导出');

-- 升级现有角色时只恢复其原本具备的相邻能力，不新增业务写权限。
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.tracking_center.view'
FROM role_permissions WHERE permission_code='shipment.view';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT role_id,'menu.admin.analytics.view'
FROM role_permissions WHERE permission_code='analytics.business.view';

-- 现有财务岗原本已能查看完整财务与毛利，补齐拆分后的应收、应付权限。
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'analytics.receivable.view' FROM roles
WHERE status='active' AND code IN ('owner','boss','pos_finance');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'analytics.payable.view' FROM roles
WHERE status='active' AND code IN ('owner','boss','pos_finance');

-- 系统所有者继续具备新入口；普通岗位仍由角色配置显式授权。
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'menu.admin.tracking_center.view' FROM roles
WHERE status='active' AND code IN ('owner','boss');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'menu.admin.analytics.view' FROM roles
WHERE status='active' AND code IN ('owner','boss');
