PRAGMA foreign_keys = ON;

-- Keep the built-in road templates aligned with the canonical ten-step order UI.
-- User-created workflow templates are intentionally left unchanged.
UPDATE workflow_steps
SET name = CASE step_key
  WHEN 'order_creation' THEN '委托资料补充'
  WHEN 'overseas_pickup' THEN '客户自提与签收'
  ELSE name
END,
updated_at = datetime('now')
WHERE workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-road-pending', 'tms-default', 'tms-ftl-standard')
)
AND step_key IN ('order_creation', 'overseas_pickup');

UPDATE workflow_instance_step_states
SET step_name = CASE step_key
  WHEN 'order_creation' THEN '委托资料补充'
  WHEN 'overseas_pickup' THEN '客户自提与签收'
  ELSE step_name
END,
updated_at = datetime('now')
WHERE workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-road-pending', 'tms-default', 'tms-ftl-standard')
)
AND step_key IN ('order_creation', 'overseas_pickup');
