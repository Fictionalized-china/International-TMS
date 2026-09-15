PRAGMA foreign_keys = ON;

-- The route is an operator note recorded after warehouse receipt, not a
-- mandatory master-data decision. Port and customs location remain gates.
UPDATE workflow_step_fields
SET is_required = 0,
    updated_at = datetime('now')
WHERE module_code = 'loading'
  AND field_key = 'route_code';

UPDATE workflow_instance_fields
SET is_required = 0
WHERE module_code = 'loading'
  AND field_key = 'route_code';
