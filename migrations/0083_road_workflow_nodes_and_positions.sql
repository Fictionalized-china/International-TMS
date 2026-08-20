PRAGMA foreign_keys = ON;

-- Split approval, dispatch, domestic transport and warehouse receiving into
-- explicit nodes. Existing orders keep their data; only the current pointer is
-- recalculated from the order status and module facts.
INSERT OR IGNORE INTO workflow_steps(
  id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,
  is_required,is_active,actor_scope,created_at,updated_at
)
SELECT wd.id||':wf:consignment_approval',wd.id,'consignment_approval','委托审核',
       'order','manual.consignment_approval',20,1,1,'admin',datetime('now'),datetime('now')
FROM workflow_definitions wd
WHERE wd.code IN ('tms-road-pending','tms-default','tms-ftl-standard');

INSERT OR IGNORE INTO workflow_steps(
  id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,
  is_required,is_active,actor_scope,created_at,updated_at
)
SELECT wd.id||':wf:task_assignment',wd.id,'task_assignment','任务分配',
       'order','manual.task_assignment',30,1,1,'admin',datetime('now'),datetime('now')
FROM workflow_definitions wd
WHERE wd.code IN ('tms-road-pending','tms-default','tms-ftl-standard');

INSERT OR IGNORE INTO workflow_steps(
  id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,
  is_required,is_active,actor_scope,created_at,updated_at
)
SELECT wd.id||':wf:warehouse_receiving',wd.id,'warehouse_receiving','国内仓入库',
       'order','manual.warehouse_receiving',50,1,1,'admin',datetime('now'),datetime('now')
FROM workflow_definitions wd
WHERE wd.code IN ('tms-road-pending','tms-default','tms-ftl-standard');

UPDATE workflow_steps
SET name=CASE step_key
      WHEN 'order_creation' THEN '订单创建与委托'
      WHEN 'domestic_execution' THEN '国内运输'
      WHEN 'port_loading' THEN '出口准备与装车出库'
      WHEN 'outbound_transport' THEN '出境运输'
      WHEN 'overseas_pickup' THEN '境外仓与自提'
      WHEN 'reconciliation' THEN '对账结算'
      WHEN 'completion_review' THEN '完成复盘'
      ELSE name END,
    sort_order=CASE step_key
      WHEN 'order_creation' THEN 10
      WHEN 'domestic_execution' THEN 40
      WHEN 'port_loading' THEN 60
      WHEN 'outbound_transport' THEN 70
      WHEN 'overseas_pickup' THEN 80
      WHEN 'reconciliation' THEN 90
      WHEN 'completion_review' THEN 100
      ELSE sort_order END,
    updated_at=datetime('now')
WHERE workflow_id IN (
  SELECT id FROM workflow_definitions
  WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
);

UPDATE workflow_steps
SET is_active=0,updated_at=datetime('now')
WHERE step_key='review_assignment'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions
    WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
  );

UPDATE workflow_step_fields
SET step_id=(
      SELECT ws.id FROM workflow_steps ws
      WHERE ws.workflow_id=workflow_step_fields.workflow_id
        AND ws.step_key='task_assignment'
    ),
    updated_at=datetime('now')
WHERE module_code='assignment'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions
    WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
  );

-- Approval belongs to the consignment review node, not task assignment.
UPDATE workflow_step_fields
SET step_id=(
      SELECT ws.id FROM workflow_steps ws
      WHERE ws.workflow_id=workflow_step_fields.workflow_id
        AND ws.step_key='consignment_approval'
    ),
    module_code='consignment',
    updated_at=datetime('now')
WHERE field_key='approval_result'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions
    WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
  );

UPDATE workflow_step_fields
SET step_id=(
      SELECT ws.id FROM workflow_steps ws
      WHERE ws.workflow_id=workflow_step_fields.workflow_id
        AND ws.step_key='warehouse_receiving'
    ),
    updated_at=datetime('now')
WHERE module_code='warehouse'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions
    WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
  );

UPDATE workflow_instance_fields
SET step_key='task_assignment'
WHERE module_code='assignment'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions
    WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
  );

UPDATE workflow_instance_fields
SET step_key='consignment_approval',module_code='consignment'
WHERE field_key='approval_result'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions
    WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
  );

UPDATE workflow_instance_fields
SET step_key='warehouse_receiving'
WHERE module_code='warehouse'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions
    WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
  );

UPDATE workflow_instances
SET current_step_key=CASE
      WHEN (SELECT status FROM transport_orders o WHERE o.id=workflow_instances.order_id)='submitted'
        THEN 'consignment_approval'
      WHEN (SELECT status FROM transport_orders o WHERE o.id=workflow_instances.order_id)='confirmed'
        THEN 'task_assignment'
      ELSE current_step_key END,
    updated_at=datetime('now')
WHERE order_id IS NOT NULL
  AND current_step_key='review_assignment';

-- Standard positions used by the configurable task chain. Permissions remain
-- in simulation mode for the first showcase release.
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'BOSS','老板','ZJB','active',5,datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'DEVELOPER','开发者','ZJB','active',6,datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'BUSINESS_SUPERVISOR','业务主管','SALER','active',15,datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'OPERATION_SUPERVISOR','操作主管','OP','active',16,datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'TRACKING','运踪岗','OP','active',55,datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'LOADING','前端配载岗','OP','active',57,datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'WAREHOUSE','仓库岗','OP','active',58,datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'OVERSEAS_WAREHOUSE','境外仓库岗','OP','active',59,datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'FINANCE_ACCOUNTING','财务会计岗','ACC','active',31,datetime('now'),datetime('now') FROM organizations;
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,'CASHIER','出纳岗','ACC','active',32,datetime('now'),datetime('now') FROM organizations;
