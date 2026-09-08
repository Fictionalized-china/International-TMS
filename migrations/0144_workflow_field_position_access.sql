PRAGMA foreign_keys = ON;

-- Field handling belongs to positions. Concrete accounts are still selected
-- by the salesperson binding and the order-assignment workflow.
ALTER TABLE workflow_step_fields ADD COLUMN handler_position_codes TEXT;
ALTER TABLE workflow_instance_fields ADD COLUMN handler_position_codes TEXT;

-- Seed every existing field from the positions already responsible for
-- the field's module/tasks. The value is a stable comma-separated position
-- set so definition rows and instance snapshots share one frozen contract.
UPDATE workflow_step_fields
SET handler_position_codes = COALESCE((
  SELECT GROUP_CONCAT(position_code, ',')
  FROM (
    SELECT position_code
    FROM (
      SELECT module.responsibility_position_code position_code
      FROM workflow_step_modules module
      WHERE module.workflow_id=workflow_step_fields.workflow_id
        AND module.step_id=workflow_step_fields.step_id
        AND module.module_code=COALESCE(workflow_step_fields.module_code,'consignment')
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
        AND module.module_code=COALESCE(workflow_step_fields.module_code,'consignment')
        AND module.is_active=1
        AND task.responsibility_position_code IS NOT NULL
    )
    ORDER BY position_code
  )
),(
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
));

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
), '');

-- Account-level workflow qualification was an abandoned model. It conflicts
-- with position policy plus concrete order assignment, so remove it entirely.
DROP INDEX IF EXISTS idx_membership_workflow_access_effective;
DROP TABLE IF EXISTS membership_workflow_access_overrides;
