PRAGMA foreign_keys = ON;

-- Migration 0046 predated module_code. Its instance snapshot initially stored
-- these transport fields under consignment. Correct transport/tracking copies
-- now exist, and the stale copies have no business values.
DELETE FROM workflow_instance_fields
WHERE module_code = 'consignment'
AND field_key IN (
  'carrier_name',
  'driver_name',
  'driver_phone',
  'vehicle_type',
  'overseas_carrier_name',
  'overseas_driver_name',
  'overseas_driver_phone',
  'overseas_vehicle_plate',
  'overseas_vehicle_type'
)
AND NOT EXISTS (
  SELECT 1
  FROM order_custom_workflow_field_values AS field_value
  WHERE field_value.field_instance_id = workflow_instance_fields.id
);
