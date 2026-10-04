CREATE TABLE order_commission_records(organization_id TEXT NOT NULL,order_id TEXT NOT NULL,amount REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',paid_on TEXT,notes TEXT,revision INTEGER NOT NULL DEFAULT 1,updated_by_user_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(organization_id,order_id));
CREATE TABLE order_commission_history(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,order_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL,paid_on TEXT,notes TEXT,revision INTEGER NOT NULL,actor_user_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE hr_report_snapshots(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,period_kind TEXT NOT NULL,date_from TEXT NOT NULL,date_to TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(organization_id,period_kind,date_from,date_to));
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
('hr.report.view','analytics','查看人事回款及发车报表','查看权限范围内已回款订单、业务员与车辆统计'),
('hr.report.amount.view','analytics','查看人事报表金额及毛利','独立控制报表回款、毛利与提成金额读取'),
('hr.commission.manage','analytics','登记提成与发放状态','人工登记提成，不预设提成公式');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN ('hr.report.view','hr.report.amount.view','hr.commission.manage','order.view','shipment.view','order.scope.all','data.export') WHERE r.code IN ('owner','boss','developer','pos_hr_admin') AND r.status='active';
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
('menu.admin.hr_reports.view','menu','人事回款与提成报表菜单','显示人事报表入口'),
('menu.admin.settlement_approvals.view','menu','出境后费用审批菜单','显示按方向办理费用审批入口');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'menu.admin.hr_reports.view' FROM roles WHERE code IN ('owner','boss','developer','pos_hr_admin') AND status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'menu.admin.settlement_approvals.view' FROM roles WHERE code IN ('owner','boss','developer','pos_sales','pos_customer_service','pos_operation','pos_operation_supervisor','pos_business_route','pos_finance') AND status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'menu.admin.tracking_center.view' FROM roles WHERE code='pos_hr_admin' AND status='active';
UPDATE position_portal_settings SET business_data_scope='company' WHERE position_id IN (SELECT id FROM positions WHERE code='HR_ADMIN') AND business_data_scope='self';
