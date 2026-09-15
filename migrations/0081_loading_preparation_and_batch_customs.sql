PRAGMA foreign_keys = ON;

ALTER TABLE transport_batches ADD COLUMN customs_location TEXT;

-- Route decisions belong to loading preparation after the domestic warehouse
-- confirms the cargo. Remove the stale warehouse copies and make the loading
-- copies available for every workflow template. Port and customs location are
-- mandatory; the free-text route description remains optional.
UPDATE workflow_step_fields
SET is_active = 0,
    is_required = 0,
    updated_at = datetime('now')
WHERE module_code = 'warehouse'
  AND field_key IN ('exit_port', 'customs_location', 'transit_locations', 'route_code');

UPDATE workflow_step_fields
SET is_active = 1,
    is_required = CASE
      WHEN field_key IN ('exit_port', 'customs_location') THEN 1
      ELSE 0
    END,
    updated_at = datetime('now')
WHERE module_code = 'loading'
  AND field_key IN ('exit_port', 'customs_location', 'transit_locations', 'route_code');

UPDATE workflow_instance_fields
SET is_active = 0,
    is_required = 0
WHERE module_code = 'warehouse'
  AND field_key IN ('exit_port', 'customs_location', 'transit_locations', 'route_code');

UPDATE workflow_instance_fields
SET is_active = 1,
    is_required = CASE
      WHEN field_key IN ('exit_port', 'customs_location') THEN 1
      ELSE 0
    END
WHERE module_code = 'loading'
  AND field_key IN ('exit_port', 'customs_location', 'transit_locations', 'route_code');

UPDATE transport_batches
SET customs_location = (
  SELECT o.customs_location
  FROM transport_batch_orders bo
  JOIN transport_orders o ON o.id = bo.order_id
  WHERE bo.batch_id = transport_batches.id
    AND bo.status != 'removed'
    AND NULLIF(TRIM(o.customs_location), '') IS NOT NULL
  ORDER BY bo.sequence_no
  LIMIT 1
)
WHERE customs_location IS NULL;
