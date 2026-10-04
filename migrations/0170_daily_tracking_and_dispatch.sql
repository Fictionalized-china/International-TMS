ALTER TABLE transport_orders ADD COLUMN planned_port_arrival_at TEXT;
CREATE TABLE order_daily_tracking (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  shipment_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_at TEXT NOT NULL,
  location TEXT NOT NULL,
  vehicle_reference TEXT,
  notes TEXT NOT NULL,
  visible_to_customer INTEGER NOT NULL DEFAULT 1,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,actor_user_id,request_id)
);
CREATE INDEX daily_tracking_order ON order_daily_tracking(organization_id,order_id,event_at);
CREATE TABLE order_dispatch_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  planned_port_arrival_at TEXT NOT NULL,
  requested_by_user_id TEXT,
  carrier_id TEXT,
  vehicle_id TEXT,
  driver_id TEXT,
  freight_amount REAL,
  freight_currency TEXT,
  exchange_rate REAL,
  resource_notes TEXT,
  fulfilled_by_user_id TEXT,
  fulfilled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,order_id)
);
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
('tracking.daily.manage','shipment','登记每日运踪','按流程策略填写国内及境外每日运踪，不改变主流程节点'),
('dispatch.request','shipment','发起找车任务','完整订单发起商务找车需求'),
('dispatch.manage','shipment','办理商务找车','反馈承运商、车辆、司机与费用资源，不取得订单其他修改权限');
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
('dispatch.cost.view','billing','查看找车运价','独立控制商务找车运价读取，不开放其他账务金额');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN ('tracking.daily.manage','dispatch.request','dispatch.manage')
WHERE r.code IN ('owner','boss','developer') AND r.status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'dispatch.cost.view' FROM roles WHERE code IN ('owner','boss','developer','pos_business_route','pos_operation_supervisor') AND status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'tracking.daily.manage' FROM roles WHERE code='pos_tracking' AND status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'dispatch.request' FROM roles WHERE code IN ('pos_tracking','pos_operation','pos_operation_supervisor') AND status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'dispatch.manage' FROM roles WHERE code='pos_business_route' AND status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN ('order.view','shipment.view','menu.admin.tracking_center.view','menu.admin.orders.view')
WHERE r.code='pos_business_route' AND r.status='active';
UPDATE position_portal_settings SET business_data_scope='company'
WHERE position_id IN (SELECT id FROM positions WHERE code='BUSINESS_ROUTE') AND business_data_scope='self';
