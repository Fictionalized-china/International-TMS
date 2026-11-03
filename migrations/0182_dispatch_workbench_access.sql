INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
 ('tracking.center.view','transport','查看调度与运踪总览','独立于普通运单档案，查看跨订单运踪与时效预警'),
 ('dispatch.view','transport','查看商务找车工作台','查看整车订单及拼车配载单找车需求'),
 ('menu.admin.dispatch.view','navigation','显示找车菜单','在汽运业务下显示与订单中心同级的找车入口');

-- Repair the legacy operation grant; future grants remain administrator-configurable.
DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code='pos_operation')
AND permission_code IN ('order.module.tracking.manage','tracking.daily.manage','tracking.center.view','menu.admin.tracking_center.view');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT DISTINCT role_id,'tracking.center.view' FROM role_permissions
WHERE permission_code IN ('tracking.daily.manage','order.module.tracking.manage','transport.batch.plan','transport.batch.approve');

DELETE FROM role_permissions WHERE permission_code='menu.admin.tracking_center.view'
AND NOT EXISTS(SELECT 1 FROM role_permissions capability
  WHERE capability.role_id=role_permissions.role_id AND capability.permission_code='tracking.center.view');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT DISTINCT role_id,'dispatch.view' FROM role_permissions WHERE permission_code='dispatch.manage';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT DISTINCT role_id,'menu.admin.dispatch.view' FROM role_permissions WHERE permission_code='dispatch.view';
