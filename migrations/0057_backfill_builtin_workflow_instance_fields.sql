PRAGMA foreign_keys = ON;

-- Older orders were created before the complete field catalog existed. Add
-- only missing system-owned fields from their bound standard template. User
-- custom fields remain snapshot-based and are not retroactively injected.
INSERT OR IGNORE INTO workflow_instance_fields(
  id,
  instance_id,
  workflow_id,
  step_key,
  module_code,
  field_key,
  label,
  field_type,
  is_required,
  is_active,
  sort_order,
  options_text,
  help_text,
  created_at
)
SELECT
  lower(hex(randomblob(16))),
  instance.id,
  template_field.workflow_id,
  template_step.step_key,
  COALESCE(template_field.module_code, 'consignment'),
  template_field.field_key,
  template_field.label,
  template_field.field_type,
  template_field.is_required,
  template_field.is_active,
  template_field.sort_order,
  template_field.options_text,
  template_field.help_text,
  datetime('now')
FROM workflow_instances AS instance
JOIN workflow_definitions AS workflow
  ON workflow.id = instance.workflow_id
JOIN workflow_step_fields AS template_field
  ON template_field.workflow_id = instance.workflow_id
JOIN workflow_steps AS template_step
  ON template_step.id = template_field.step_id
 AND template_step.workflow_id = template_field.workflow_id
WHERE workflow.code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
AND (
  instr(template_field.id, template_field.workflow_id || ':catalog:') = 1
  OR instr(template_field.id, ':wff:') > 0
  OR instr(template_field.id, ':wf-field:') > 0
);
