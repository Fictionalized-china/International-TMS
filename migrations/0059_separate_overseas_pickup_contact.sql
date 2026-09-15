PRAGMA foreign_keys = ON;

-- Domestic pickup contact and overseas self-pickup contact are different
-- business facts. Older templates used one key for both, which could satisfy
-- the overseas gate with the domestic contact by mistake.
INSERT OR IGNORE INTO workflow_step_fields(
  id, workflow_id, step_id, field_key, label, field_type, is_required,
  is_active, sort_order, options_text, help_text, created_at, updated_at,
  module_code
)
SELECT
  old_field.id || ':overseas-contact',
  old_field.workflow_id,
  old_field.step_id,
  'overseas_pickup_contact',
  old_field.label,
  old_field.field_type,
  1,
  old_field.is_active,
  old_field.sort_order,
  old_field.options_text,
  old_field.help_text,
  old_field.created_at,
  datetime('now'),
  old_field.module_code
FROM workflow_step_fields AS old_field
WHERE old_field.module_code = 'overseas_warehouse'
AND old_field.field_key = 'pickup_contact'
AND old_field.workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
);

INSERT OR IGNORE INTO workflow_instance_fields(
  id, instance_id, workflow_id, step_key, module_code, field_key, label,
  field_type, is_required, is_active, sort_order, options_text, help_text,
  created_at
)
SELECT
  lower(hex(randomblob(16))),
  old_field.instance_id,
  old_field.workflow_id,
  old_field.step_key,
  old_field.module_code,
  'overseas_pickup_contact',
  old_field.label,
  old_field.field_type,
  1,
  old_field.is_active,
  old_field.sort_order,
  old_field.options_text,
  old_field.help_text,
  old_field.created_at
FROM workflow_instance_fields AS old_field
WHERE old_field.module_code = 'overseas_warehouse'
AND old_field.field_key = 'pickup_contact'
AND old_field.workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
);

UPDATE order_custom_workflow_field_values AS field_value
SET field_instance_id = (
  SELECT new_field.id
  FROM workflow_instance_fields AS old_field
  JOIN workflow_instance_fields AS new_field
    ON new_field.instance_id = old_field.instance_id
   AND new_field.step_key = old_field.step_key
   AND new_field.module_code = old_field.module_code
   AND new_field.field_key = 'overseas_pickup_contact'
  WHERE old_field.id = field_value.field_instance_id
    AND old_field.module_code = 'overseas_warehouse'
    AND old_field.field_key = 'pickup_contact'
)
WHERE EXISTS (
  SELECT 1
  FROM workflow_instance_fields AS old_field
  JOIN workflow_instance_fields AS new_field
    ON new_field.instance_id = old_field.instance_id
   AND new_field.step_key = old_field.step_key
   AND new_field.module_code = old_field.module_code
   AND new_field.field_key = 'overseas_pickup_contact'
  WHERE old_field.id = field_value.field_instance_id
    AND old_field.module_code = 'overseas_warehouse'
    AND old_field.field_key = 'pickup_contact'
);

DELETE FROM workflow_instance_fields
WHERE module_code = 'overseas_warehouse'
AND field_key = 'pickup_contact'
AND workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
);

DELETE FROM workflow_step_fields
WHERE module_code = 'overseas_warehouse'
AND field_key = 'pickup_contact'
AND workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
);

-- The legacy order-creation alias is redundant with shipper_contact. Keep it
-- visible for compatible templates but do not let it create a duplicate gate.
UPDATE workflow_step_fields
SET is_required = 0,
    updated_at = datetime('now')
WHERE module_code = 'consignment'
AND field_key = 'pickup_contact'
AND workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
);

UPDATE workflow_instance_fields
SET is_required = 0
WHERE module_code = 'consignment'
AND field_key = 'pickup_contact'
AND workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
);
