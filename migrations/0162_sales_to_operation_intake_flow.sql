PRAGMA foreign_keys = ON;

-- Runtime instances already own frozen module/task snapshots. These definition
-- updates therefore affect only orders instantiated after this migration.
UPDATE workflow_step_modules
   SET is_required=0,
       responsibility_position_code='SALES',
       updated_at=CURRENT_TIMESTAMP
 WHERE module_code='consignment'
   AND step_id IN (
     SELECT id FROM workflow_steps WHERE step_key='quotation'
   );

UPDATE workflow_module_tasks
   SET is_required=0,
       responsibility_position_code='SALES',
       instructions='询价报价是可选销售工具；线下确认的业务可直接录单。',
       updated_at=CURRENT_TIMESTAMP
 WHERE step_module_id IN (
   SELECT module.id
     FROM workflow_step_modules module
     JOIN workflow_steps step ON step.id=module.step_id
    WHERE step.step_key='quotation' AND module.module_code='consignment'
 );

UPDATE workflow_step_modules
   SET is_required=0,
       responsibility_position_code='SALES',
       updated_at=CURRENT_TIMESTAMP
 WHERE module_code='costs'
   AND step_id IN (
     SELECT id FROM workflow_steps WHERE step_key='order_creation'
   );

UPDATE workflow_module_tasks
   SET responsibility_position_code='SALES',
       instructions='整车补齐六类开单费用，拼车至少补齐提货费；明确为零也必须录入。',
       updated_at=CURRENT_TIMESTAMP
 WHERE step_module_id IN (
   SELECT module.id
     FROM workflow_step_modules module
     JOIN workflow_steps step ON step.id=module.step_id
    WHERE step.step_key='order_creation' AND module.module_code='costs'
 );

UPDATE workflow_step_modules
   SET responsibility_position_code='OPERATION_SUPERVISOR',
       updated_at=CURRENT_TIMESTAMP
 WHERE module_code='consignment'
   AND step_id IN (
     SELECT id FROM workflow_steps WHERE step_key='consignment_approval'
   );

UPDATE workflow_module_tasks
   SET responsibility_position_code='OPERATION_SUPERVISOR',
       instructions='操作主管核对委托资料与开单费用并明确通过或退回。',
       updated_at=CURRENT_TIMESTAMP
 WHERE step_module_id IN (
   SELECT module.id
     FROM workflow_step_modules module
     JOIN workflow_steps step ON step.id=module.step_id
    WHERE step.step_key='consignment_approval' AND module.module_code='consignment'
 );

UPDATE workflow_step_modules
   SET responsibility_position_code='OPERATION_SUPERVISOR',
       updated_at=CURRENT_TIMESTAMP
 WHERE module_code='loading'
   AND step_id IN (
     SELECT id FROM workflow_steps WHERE step_key='port_loading'
   );

UPDATE workflow_module_tasks
   SET responsibility_position_code='OPERATION_SUPERVISOR',
       instructions='操作主管根据已登记的境外运输资源确定整车或拼车配载；仓库只执行扫码装车、出库与交接。',
       updated_at=CURRENT_TIMESTAMP
 WHERE step_module_id IN (
   SELECT module.id
     FROM workflow_step_modules module
     JOIN workflow_steps step ON step.id=module.step_id
    WHERE step.step_key='port_loading' AND module.module_code='loading'
 );

UPDATE workflow_step_fields
   SET help_text='操作主管查看完整委托资料和开单费用后通过或退回。',
       updated_at=CURRENT_TIMESTAMP
 WHERE field_key='approval_result'
   AND module_code='consignment';

UPDATE order_workflow_transitions
   SET target_step_name='操作主管审批',updated_at=CURRENT_TIMESTAMP
 WHERE action_code='submit' AND from_status='draft';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'order.module.costs.manage' FROM roles
WHERE status='active' AND code IN ('pos_sales','pos_operation','pos_operation_supervisor');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'order.module.consignment.manage' FROM roles
WHERE status='active' AND code='pos_operation_supervisor';

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'order.module.loading.manage' FROM roles
WHERE status='active' AND code='pos_operation_supervisor';
