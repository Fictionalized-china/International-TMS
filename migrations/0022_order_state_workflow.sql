PRAGMA foreign_keys = ON;

ALTER TABLE transport_orders ADD COLUMN workflow_instance_id TEXT REFERENCES workflow_instances(id) ON DELETE SET NULL;
ALTER TABLE transport_orders ADD COLUMN current_step_code TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE transport_orders ADD COLUMN current_step_name TEXT NOT NULL DEFAULT '草稿';
ALTER TABLE transport_orders ADD COLUMN current_assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transport_orders ADD COLUMN workflow_updated_at TEXT;
ALTER TABLE transport_orders ADD COLUMN is_overdue INTEGER NOT NULL DEFAULT 0 CHECK (is_overdue IN (0,1));
ALTER TABLE transport_orders ADD COLUMN exception_status TEXT NOT NULL DEFAULT 'normal' CHECK (exception_status IN ('normal','warning','exception'));

CREATE TABLE order_workflow_transitions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_code TEXT NOT NULL,
  action_name TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  target_step_code TEXT NOT NULL,
  target_step_name TEXT NOT NULL,
  requires_assignee INTEGER NOT NULL DEFAULT 0 CHECK (requires_assignee IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, action_code)
);

CREATE TABLE order_workflow_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  action_code TEXT NOT NULL,
  action_name TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  from_step_code TEXT,
  to_step_code TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_orders_workflow_snapshot ON transport_orders(organization_id,current_step_code,current_assignee_user_id,workflow_updated_at);
CREATE INDEX idx_order_workflow_transition ON order_workflow_transitions(organization_id,from_status,is_active,sort_order);
CREATE INDEX idx_order_workflow_history ON order_workflow_history(order_id,occurred_at DESC);

INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,created_at,updated_at)
SELECT o.id||':owf:submit',o.id,'submit','提交审批','draft','submitted','approval','操作审批',1,10,datetime('now'),datetime('now') FROM organizations o;
INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,created_at,updated_at)
SELECT o.id||':owf:approve',o.id,'approve','审批通过','submitted','confirmed','dispatch','调度派单',1,20,datetime('now'),datetime('now') FROM organizations o;
INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,created_at,updated_at)
SELECT o.id||':owf:reject',o.id,'reject','审批退回','submitted','draft','draft','资料修改',0,21,datetime('now'),datetime('now') FROM organizations o;
INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,created_at,updated_at)
SELECT o.id||':owf:dispatch',o.id,'dispatch','确认派单','confirmed','in_execution','execution','运输执行',1,30,datetime('now'),datetime('now') FROM organizations o;
INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,created_at,updated_at)
SELECT o.id||':owf:complete',o.id,'complete','确认完成','in_execution','completed','completed','已完成',0,40,datetime('now'),datetime('now') FROM organizations o;
INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,created_at,updated_at)
SELECT o.id||':owf:cancel_draft',o.id,'cancel_draft','取消订单','draft','cancelled','cancelled','已取消',0,90,datetime('now'),datetime('now') FROM organizations o;
INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,created_at,updated_at)
SELECT o.id||':owf:cancel_submitted',o.id,'cancel_submitted','取消订单','submitted','cancelled','cancelled','已取消',0,91,datetime('now'),datetime('now') FROM organizations o;
INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,created_at,updated_at)
SELECT o.id||':owf:cancel_confirmed',o.id,'cancel_confirmed','取消订单','confirmed','cancelled','cancelled','已取消',0,92,datetime('now'),datetime('now') FROM organizations o;

UPDATE transport_orders SET
  workflow_instance_id=(SELECT wi.id FROM workflow_instances wi WHERE wi.order_id=transport_orders.id LIMIT 1),
  current_step_code=CASE status WHEN 'draft' THEN 'draft' WHEN 'submitted' THEN 'approval' WHEN 'confirmed' THEN 'dispatch' WHEN 'in_execution' THEN 'execution' WHEN 'completed' THEN 'completed' ELSE 'cancelled' END,
  current_step_name=CASE status WHEN 'draft' THEN '草稿' WHEN 'submitted' THEN '操作审批' WHEN 'confirmed' THEN '调度派单' WHEN 'in_execution' THEN '运输执行' WHEN 'completed' THEN '已完成' ELSE '已取消' END,
  workflow_updated_at=updated_at;

INSERT INTO order_workflow_history(id,organization_id,order_id,action_code,action_name,from_status,to_status,from_step_code,to_step_code,actor_user_id,occurred_at)
SELECT 'owf-init-'||id,organization_id,id,'initialize','初始化流程',status,status,NULL,current_step_code,created_by_user_id,COALESCE(workflow_updated_at,created_at)
FROM transport_orders;
