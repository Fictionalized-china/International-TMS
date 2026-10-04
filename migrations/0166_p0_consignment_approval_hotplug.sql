PRAGMA foreign_keys = ON;

-- The business-supervisor position is retired. New definitions already use
-- OPERATION_SUPERVISOR; hot-plug unfinished frozen orders without rewriting
-- completed audit history.
UPDATE workflow_step_modules
   SET responsibility_position_code='OPERATION_SUPERVISOR',updated_at=datetime('now')
 WHERE responsibility_position_code='BUSINESS_SUPERVISOR'
   AND step_id IN (
     SELECT id FROM workflow_steps WHERE step_key='consignment_approval'
   );

UPDATE workflow_module_tasks
   SET responsibility_position_code='OPERATION_SUPERVISOR',updated_at=datetime('now')
 WHERE responsibility_position_code='BUSINESS_SUPERVISOR'
   AND step_module_id IN (
     SELECT module.id
       FROM workflow_step_modules module
       JOIN workflow_steps step ON step.id=module.step_id
      WHERE step.step_key='consignment_approval'
   );

UPDATE workflow_step_fields
   SET handler_position_codes=trim(
         replace(
           ','||replace(COALESCE(handler_position_codes,''),' ','')||',',
           ',BUSINESS_SUPERVISOR,',
           ',OPERATION_SUPERVISOR,'
         ),
         ','
       ),
       updated_at=datetime('now')
 WHERE step_id IN (
     SELECT id FROM workflow_steps WHERE step_key='consignment_approval'
   )
   AND instr(','||replace(COALESCE(handler_position_codes,''),' ','')||',',',BUSINESS_SUPERVISOR,')>0;

UPDATE workflow_instance_module_states
   SET responsibility_position_code='OPERATION_SUPERVISOR',updated_at=datetime('now')
 WHERE responsibility_position_code='BUSINESS_SUPERVISOR'
   AND status NOT IN ('completed','not_applicable')
   AND instance_step_state_id IN (
     SELECT id FROM workflow_instance_step_states WHERE step_key='consignment_approval'
   );

UPDATE workflow_instance_task_states
   SET responsibility_position_code='OPERATION_SUPERVISOR',assignee_user_id=NULL,updated_at=datetime('now')
 WHERE responsibility_position_code='BUSINESS_SUPERVISOR'
   AND status NOT IN ('completed','not_applicable')
   AND instance_module_state_id IN (
     SELECT module_state.id
       FROM workflow_instance_module_states module_state
       JOIN workflow_instance_step_states step_state
         ON step_state.id=module_state.instance_step_state_id
      WHERE step_state.step_key='consignment_approval'
   );

UPDATE workflow_instance_fields
   SET handler_position_codes=trim(
         replace(
           ','||replace(COALESCE(handler_position_codes,''),' ','')||',',
           ',BUSINESS_SUPERVISOR,',
           ',OPERATION_SUPERVISOR,'
         ),
         ','
       )
 WHERE step_key='consignment_approval'
   AND instr(','||replace(COALESCE(handler_position_codes,''),' ','')||',',',BUSINESS_SUPERVISOR,')>0
   AND instance_id IN (
     SELECT instance_id
       FROM workflow_instance_step_states
      WHERE step_key='consignment_approval'
        AND status NOT IN ('completed','not_applicable')
   );
