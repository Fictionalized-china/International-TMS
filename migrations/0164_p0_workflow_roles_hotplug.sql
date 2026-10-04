PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('transport.batch.plan','transport','生成配载单','操作主管选择运输资源、订单和负责人后一次生成配载单');

-- P0 role model: sales submits directly to operation supervisor; tracking is independent.
INSERT OR IGNORE INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'TRACKING','运踪岗','OP','active',45,datetime('now'),datetime('now')
FROM organizations o;

UPDATE positions
   SET status='disabled',updated_at=datetime('now')
 WHERE code='BUSINESS_SUPERVISOR';
UPDATE positions
   SET name='操作岗',department_code='OP',status='active',sort_order=40,updated_at=datetime('now')
 WHERE code='OPERATION';
UPDATE positions
   SET name='运踪岗',department_code='OP',status='active',sort_order=45,updated_at=datetime('now')
 WHERE code='TRACKING';

INSERT INTO roles(id,organization_id,code,name,description,is_system,status,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'pos_tracking','运踪岗','负责全部在途订单的调度跟踪、时效预警和客户轨迹更新',1,'active',datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='pos_tracking'
);

UPDATE roles SET status='disabled',updated_at=datetime('now') WHERE code='pos_business_supervisor';
UPDATE roles
   SET name='操作岗',description='负责运输安排、费用补录和执行异常处理',status='active',updated_at=datetime('now')
 WHERE code='pos_operation';
UPDATE roles
   SET name='操作主管',description='直接审核业务员录入的订单并统筹任务与配载',status='active',updated_at=datetime('now')
 WHERE code='pos_operation_supervisor';
UPDATE roles
   SET name='运踪岗',description='负责全部在途订单的调度跟踪、时效预警和客户轨迹更新',status='active',updated_at=datetime('now')
 WHERE code='pos_tracking';

DELETE FROM role_permissions
 WHERE role_id IN (
   SELECT id FROM roles
    WHERE code IN ('pos_business_supervisor','pos_operation','pos_operation_supervisor','pos_tracking')
 );

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.manage','order.scope.assigned','shipment.view','carrier.view',
  'order.module.consignment.manage','order.module.assignment.manage','order.module.loading.manage','order.module.costs.manage',
  'transport.batch.plan','transport.batch.approve'
) WHERE r.code='pos_operation_supervisor' AND r.status='active';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.manage','order.scope.assigned','shipment.view','shipment.manage','carrier.view',
  'transport.batch.assigned.view','order.module.transport.manage','order.module.costs.manage','order.module.exceptions.manage'
) WHERE r.code='pos_operation' AND r.status='active';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view','order.view','order.scope.all','shipment.view','shipment.manage',
  'transport.batch.assigned.view','order.module.tracking.manage','menu.admin.tracking_center.view'
) WHERE r.code='pos_tracking' AND r.status='active';

INSERT OR IGNORE INTO membership_roles(membership_id,role_id)
SELECT m.id,r.id
  FROM memberships m
  JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
  JOIN roles r ON r.organization_id=m.organization_id AND r.code='pos_tracking'
 WHERE p.code='TRACKING' AND m.status='active';

INSERT OR IGNORE INTO position_portal_settings(
  id,organization_id,position_id,order_scope,default_filter,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),p.organization_id,p.id,'all_orders','open',datetime('now'),datetime('now')
  FROM positions p WHERE p.code='TRACKING';
UPDATE position_portal_settings
   SET order_scope='all_orders',updated_at=datetime('now')
 WHERE position_id IN (SELECT id FROM positions WHERE code='TRACKING');

-- Quotation remains a sales tool, but is no longer a node in the three road-order workflows.
UPDATE workflow_steps
   SET is_active=0,is_required=0,updated_at=datetime('now')
 WHERE step_key='quotation'
   AND workflow_id IN (
     SELECT id FROM workflow_definitions
      WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
   );
UPDATE workflow_step_modules
   SET is_active=0,is_required=0,updated_at=datetime('now')
 WHERE step_id IN (
   SELECT id FROM workflow_steps
    WHERE step_key='quotation'
      AND workflow_id IN (
        SELECT id FROM workflow_definitions
         WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
      )
 );
UPDATE workflow_module_tasks
   SET is_active=0,is_required=0,updated_at=datetime('now')
 WHERE step_module_id IN (
   SELECT module.id
     FROM workflow_step_modules module
     JOIN workflow_steps step ON step.id=module.step_id
    WHERE step.step_key='quotation'
      AND step.workflow_id IN (
        SELECT id FROM workflow_definitions
         WHERE code IN ('tms-road-pending','tms-default','tms-ftl-standard')
      )
 );

-- Only orders still parked on the retired quotation node move forward. Completed history is untouched.
UPDATE workflow_instance_task_states
   SET status='completed',completed_at=COALESCE(completed_at,datetime('now')),updated_at=datetime('now')
 WHERE instance_module_state_id IN (
   SELECT module_state.id
     FROM workflow_instance_module_states module_state
     JOIN workflow_instance_step_states step_state ON step_state.id=module_state.instance_step_state_id
     JOIN workflow_instances instance ON instance.id=step_state.instance_id
    WHERE step_state.step_key='quotation' AND instance.order_id IS NOT NULL
      AND instance.current_step_key='quotation' AND instance.status='active'
 );
UPDATE workflow_instance_module_states
   SET status='completed',updated_at=datetime('now')
 WHERE instance_step_state_id IN (
   SELECT step_state.id
     FROM workflow_instance_step_states step_state
     JOIN workflow_instances instance ON instance.id=step_state.instance_id
    WHERE step_state.step_key='quotation' AND instance.order_id IS NOT NULL
      AND instance.current_step_key='quotation' AND instance.status='active'
 );
UPDATE workflow_instance_step_states
   SET status='completed',completed_at=COALESCE(completed_at,datetime('now')),updated_at=datetime('now')
 WHERE step_key='quotation' AND instance_id IN (
   SELECT id FROM workflow_instances
    WHERE order_id IS NOT NULL AND current_step_key='quotation' AND status='active'
 );
UPDATE workflow_instance_step_states
   SET status='active',started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now')
 WHERE step_key='order_creation' AND instance_id IN (
   SELECT id FROM workflow_instances
    WHERE order_id IS NOT NULL AND current_step_key='quotation' AND status='active'
 );
UPDATE workflow_instances
   SET current_step_key='order_creation',updated_at=datetime('now')
 WHERE order_id IS NOT NULL AND current_step_key='quotation' AND status='active';

-- New and not-yet-completed tracking work is hot-plugged to the independent tracking role.
UPDATE workflow_step_modules
   SET responsibility_position_code='TRACKING',updated_at=datetime('now')
 WHERE module_code='tracking';
UPDATE workflow_module_tasks
   SET responsibility_position_code='TRACKING',updated_at=datetime('now')
 WHERE step_module_id IN (SELECT id FROM workflow_step_modules WHERE module_code='tracking');
UPDATE workflow_step_fields
   SET handler_position_codes='TRACKING',updated_at=datetime('now')
 WHERE module_code='tracking';

UPDATE workflow_instance_module_states
   SET responsibility_position_code='TRACKING',updated_at=datetime('now')
 WHERE module_code='tracking' AND status<>'completed';
UPDATE workflow_instance_task_states
   SET responsibility_position_code='TRACKING',assignee_user_id=NULL,updated_at=datetime('now')
 WHERE status<>'completed' AND instance_module_state_id IN (
   SELECT id FROM workflow_instance_module_states WHERE module_code='tracking'
 );
UPDATE workflow_instance_fields
   SET handler_position_codes='TRACKING'
 WHERE module_code='tracking' AND instance_id IN (
   SELECT step_state.instance_id
     FROM workflow_instance_step_states step_state
    WHERE step_state.step_key=workflow_instance_fields.step_key
      AND step_state.status<>'completed'
 );

-- Settlement fields keep their configurable required/optional/hidden mode,
-- while their eligible positions follow the P0 receivable and payable chains.
UPDATE workflow_step_fields
   SET label=CASE field_key
         WHEN 'customer_service_confirmation' THEN '费用发起 / 确认'
         WHEN 'business_review' THEN '业务执行 / 主管复核'
         WHEN 'finance_review' THEN '主管 / 财务审批'
       END,
       help_text=CASE field_key
         WHEN 'customer_service_confirmation' THEN '应收由客服确认；应付由操作岗发起申请。'
         WHEN 'business_review' THEN '应收由操作岗复核；应付由操作主管审批。'
         WHEN 'finance_review' THEN '应收由操作主管审批；应付由财务审批。'
       END,
       handler_position_codes=CASE field_key
         WHEN 'customer_service_confirmation' THEN 'CS,OPERATION'
         WHEN 'business_review' THEN 'OPERATION,OPERATION_SUPERVISOR'
         WHEN 'finance_review' THEN 'OPERATION_SUPERVISOR,FINANCE_ACCOUNTING'
       END,
       updated_at=datetime('now')
 WHERE module_code='costs'
   AND field_key IN ('customer_service_confirmation','business_review','finance_review');

UPDATE workflow_instance_fields
   SET label=CASE field_key
         WHEN 'customer_service_confirmation' THEN '费用发起 / 确认'
         WHEN 'business_review' THEN '业务执行 / 主管复核'
         WHEN 'finance_review' THEN '主管 / 财务审批'
       END,
       help_text=CASE field_key
         WHEN 'customer_service_confirmation' THEN '应收由客服确认；应付由操作岗发起申请。'
         WHEN 'business_review' THEN '应收由操作岗复核；应付由操作主管审批。'
         WHEN 'finance_review' THEN '应收由操作主管审批；应付由财务审批。'
       END,
       handler_position_codes=CASE field_key
         WHEN 'customer_service_confirmation' THEN 'CS,OPERATION'
         WHEN 'business_review' THEN 'OPERATION,OPERATION_SUPERVISOR'
         WHEN 'finance_review' THEN 'OPERATION_SUPERVISOR,FINANCE_ACCOUNTING'
       END
 WHERE module_code='costs'
   AND field_key IN ('customer_service_confirmation','business_review','finance_review')
   AND instance_id IN (
     SELECT step_state.instance_id
       FROM workflow_instance_step_states step_state
      WHERE step_state.step_key=workflow_instance_fields.step_key
        AND step_state.status<>'completed'
   );
