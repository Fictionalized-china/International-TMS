PRAGMA foreign_keys = ON;

-- Published workflow versions use suffixed codes (for example tms-default-v3)
-- while retaining the base template family id. Cover both identities.
UPDATE workflow_steps
   SET is_active=0,is_required=0,updated_at=datetime('now')
 WHERE step_key='quotation'
   AND workflow_id IN (
     SELECT id FROM workflow_definitions
      WHERE code LIKE 'tms-road-pending%'
         OR code LIKE 'tms-default%'
         OR code LIKE 'tms-ftl-standard%'
         OR template_family_id LIKE '%:tms-road-pending'
         OR template_family_id LIKE '%:tms-default'
         OR template_family_id LIKE '%:tms-ftl-standard'
   );

UPDATE workflow_step_modules
   SET is_active=0,is_required=0,updated_at=datetime('now')
 WHERE step_id IN (
   SELECT step.id
     FROM workflow_steps step
     JOIN workflow_definitions definition ON definition.id=step.workflow_id
    WHERE step.step_key='quotation'
      AND (
        definition.code LIKE 'tms-road-pending%'
        OR definition.code LIKE 'tms-default%'
        OR definition.code LIKE 'tms-ftl-standard%'
        OR definition.template_family_id LIKE '%:tms-road-pending'
        OR definition.template_family_id LIKE '%:tms-default'
        OR definition.template_family_id LIKE '%:tms-ftl-standard'
      )
 );

UPDATE workflow_module_tasks
   SET is_active=0,is_required=0,updated_at=datetime('now')
 WHERE step_module_id IN (
   SELECT module.id
     FROM workflow_step_modules module
     JOIN workflow_steps step ON step.id=module.step_id
     JOIN workflow_definitions definition ON definition.id=step.workflow_id
    WHERE step.step_key='quotation'
      AND (
        definition.code LIKE 'tms-road-pending%'
        OR definition.code LIKE 'tms-default%'
        OR definition.code LIKE 'tms-ftl-standard%'
        OR definition.template_family_id LIKE '%:tms-road-pending'
        OR definition.template_family_id LIKE '%:tms-default'
        OR definition.template_family_id LIKE '%:tms-ftl-standard'
      )
 );

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
