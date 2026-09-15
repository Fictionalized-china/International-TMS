PRAGMA foreign_keys = ON;

-- Some quotation fields are displayed under cargo/costs even though the
-- quotation node is operated through its consignment module. If a field has
-- no same-module responsibility, inherit the configured responsibility of
-- the node instead of leaving an active field with nobody allowed to fill it.
UPDATE workflow_step_fields
SET handler_position_codes = (
  SELECT GROUP_CONCAT(position_code, ',')
  FROM (
    SELECT position_code
    FROM (
      SELECT module.responsibility_position_code position_code
      FROM workflow_step_modules module
      WHERE module.workflow_id=workflow_step_fields.workflow_id
        AND module.step_id=workflow_step_fields.step_id
        AND module.is_active=1
        AND module.responsibility_position_code IS NOT NULL
      UNION
      SELECT task.responsibility_position_code position_code
      FROM workflow_step_modules module
      JOIN workflow_module_tasks task
        ON task.workflow_id=module.workflow_id
       AND task.step_module_id=module.id
       AND task.is_active=1
      WHERE module.workflow_id=workflow_step_fields.workflow_id
        AND module.step_id=workflow_step_fields.step_id
        AND module.is_active=1
        AND task.responsibility_position_code IS NOT NULL
    )
    ORDER BY position_code
  )
)
WHERE COALESCE(handler_position_codes,'')='';

UPDATE workflow_instance_fields
SET handler_position_codes = COALESCE((
  SELECT definition.handler_position_codes
  FROM workflow_step_fields definition
  JOIN workflow_steps step
    ON step.id=definition.step_id
   AND step.workflow_id=definition.workflow_id
  WHERE definition.workflow_id=workflow_instance_fields.workflow_id
    AND step.step_key=workflow_instance_fields.step_key
    AND COALESCE(definition.module_code,'consignment')=workflow_instance_fields.module_code
    AND definition.field_key=workflow_instance_fields.field_key
  LIMIT 1
), handler_position_codes)
WHERE COALESCE(handler_position_codes,'')='';
