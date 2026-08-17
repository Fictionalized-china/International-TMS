PRAGMA foreign_keys = ON;

ALTER TABLE transport_batches ADD COLUMN overseas_carrier_name TEXT;
ALTER TABLE transport_batches ADD COLUMN overseas_vehicle_type TEXT;
ALTER TABLE transport_batches ADD COLUMN overseas_vehicle_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE transport_batches ADD COLUMN overseas_vehicle_plate TEXT;
ALTER TABLE transport_batches ADD COLUMN overseas_driver_name TEXT;
ALTER TABLE transport_batches ADD COLUMN overseas_driver_phone TEXT;

DELETE FROM workflow_step_fields
WHERE field_key IN (
  'overseas_carrier_name',
  'overseas_vehicle_type',
  'overseas_vehicle_plate',
  'overseas_driver_name',
  'overseas_driver_phone'
)
AND step_id IN (SELECT id FROM workflow_steps WHERE step_key='outbound_transport')
AND EXISTS (
  SELECT 1
  FROM workflow_step_fields existing
  JOIN workflow_steps target ON target.id=existing.step_id
  WHERE existing.workflow_id=workflow_step_fields.workflow_id
    AND existing.field_key=workflow_step_fields.field_key
    AND target.step_key='port_loading'
);

UPDATE workflow_step_fields
SET step_id=(
      SELECT s.id FROM workflow_steps s
      WHERE s.workflow_id=workflow_step_fields.workflow_id AND s.step_key='port_loading'
      LIMIT 1
    ),
    is_required=1,
    updated_at=datetime('now')
WHERE field_key IN (
  'overseas_carrier_name','overseas_vehicle_type','overseas_vehicle_plate',
  'overseas_driver_name','overseas_driver_phone'
)
AND step_id IN (SELECT id FROM workflow_steps WHERE step_key='outbound_transport')
AND EXISTS (
  SELECT 1 FROM workflow_steps s
  WHERE s.workflow_id=workflow_step_fields.workflow_id AND s.step_key='port_loading'
);

UPDATE workflow_step_fields
SET is_required=1,updated_at=datetime('now')
WHERE field_key IN (
  'overseas_carrier_name','overseas_vehicle_type','overseas_vehicle_count',
  'overseas_vehicle_plate','overseas_driver_name','overseas_driver_phone'
)
AND step_id IN (SELECT id FROM workflow_steps WHERE step_key='port_loading');

INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,sort_order,help_text,created_at,updated_at
)
SELECT
  s.id || ':overseas_vehicle_count',
  s.workflow_id,
  s.id,
  'overseas_vehicle_count',
  '境外车辆数目',
  'number',
  1,
  76,
  '确定整车或拼车方案后登记的境外运输车辆数量。',
  datetime('now'),
  datetime('now')
FROM workflow_steps s
WHERE s.step_key='port_loading';
