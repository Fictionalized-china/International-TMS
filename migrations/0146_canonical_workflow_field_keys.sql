PRAGMA foreign_keys = ON;

-- A few early migrations introduced native fields before their final names
-- were established. The configuration page consequently exposed both names,
-- while the native forms only read the canonical name. Preserve an explicitly
-- newer legacy policy, then retire the duplicate definition.
UPDATE workflow_step_fields AS canonical
SET is_required = (
      SELECT legacy.is_required
      FROM workflow_step_fields AS legacy
      WHERE legacy.workflow_id=canonical.workflow_id
        AND legacy.step_id=canonical.step_id
        AND COALESCE(legacy.module_code,'consignment')=COALESCE(canonical.module_code,'consignment')
        AND legacy.field_key=CASE canonical.field_key
          WHEN 'domestic_carrier_id' THEN 'carrier_name'
          WHEN 'domestic_vehicle_type' THEN 'vehicle_type'
          WHEN 'domestic_plate_number' THEN 'vehicle_plate'
          WHEN 'domestic_driver_name' THEN 'driver_name'
          WHEN 'domestic_driver_phone' THEN 'driver_phone'
          WHEN 'domestic_actual_pickup_at' THEN 'actual_pickup_at'
          WHEN 'primary_operator' THEN 'operator'
          WHEN 'origin_address' THEN 'pickup_address'
          WHEN 'requested_pickup_date' THEN 'pickup_time'
          WHEN 'overseas_warehouse_id' THEN 'overseas_warehouse'
          WHEN 'shipper_contact' THEN 'pickup_contact'
          WHEN 'shipper_phone' THEN 'pickup_phone'
        END
        AND legacy.updated_at>canonical.updated_at
      LIMIT 1
    ),
    is_active = (
      SELECT legacy.is_active
      FROM workflow_step_fields AS legacy
      WHERE legacy.workflow_id=canonical.workflow_id
        AND legacy.step_id=canonical.step_id
        AND COALESCE(legacy.module_code,'consignment')=COALESCE(canonical.module_code,'consignment')
        AND legacy.field_key=CASE canonical.field_key
          WHEN 'domestic_carrier_id' THEN 'carrier_name'
          WHEN 'domestic_vehicle_type' THEN 'vehicle_type'
          WHEN 'domestic_plate_number' THEN 'vehicle_plate'
          WHEN 'domestic_driver_name' THEN 'driver_name'
          WHEN 'domestic_driver_phone' THEN 'driver_phone'
          WHEN 'domestic_actual_pickup_at' THEN 'actual_pickup_at'
          WHEN 'primary_operator' THEN 'operator'
          WHEN 'origin_address' THEN 'pickup_address'
          WHEN 'requested_pickup_date' THEN 'pickup_time'
          WHEN 'overseas_warehouse_id' THEN 'overseas_warehouse'
          WHEN 'shipper_contact' THEN 'pickup_contact'
          WHEN 'shipper_phone' THEN 'pickup_phone'
        END
        AND legacy.updated_at>canonical.updated_at
      LIMIT 1
    ),
    handler_position_codes = COALESCE((
      SELECT legacy.handler_position_codes
      FROM workflow_step_fields AS legacy
      WHERE legacy.workflow_id=canonical.workflow_id
        AND legacy.step_id=canonical.step_id
        AND COALESCE(legacy.module_code,'consignment')=COALESCE(canonical.module_code,'consignment')
        AND legacy.field_key=CASE canonical.field_key
          WHEN 'domestic_carrier_id' THEN 'carrier_name'
          WHEN 'domestic_vehicle_type' THEN 'vehicle_type'
          WHEN 'domestic_plate_number' THEN 'vehicle_plate'
          WHEN 'domestic_driver_name' THEN 'driver_name'
          WHEN 'domestic_driver_phone' THEN 'driver_phone'
          WHEN 'domestic_actual_pickup_at' THEN 'actual_pickup_at'
          WHEN 'primary_operator' THEN 'operator'
          WHEN 'origin_address' THEN 'pickup_address'
          WHEN 'requested_pickup_date' THEN 'pickup_time'
          WHEN 'overseas_warehouse_id' THEN 'overseas_warehouse'
          WHEN 'shipper_contact' THEN 'pickup_contact'
          WHEN 'shipper_phone' THEN 'pickup_phone'
        END
        AND legacy.updated_at>canonical.updated_at
      LIMIT 1
    ), canonical.handler_position_codes),
    updated_at = datetime('now')
WHERE canonical.field_key IN (
  'domestic_carrier_id','domestic_vehicle_type','domestic_plate_number',
  'domestic_driver_name','domestic_driver_phone','domestic_actual_pickup_at',
  'primary_operator','origin_address','requested_pickup_date',
  'overseas_warehouse_id','shipper_contact','shipper_phone'
)
AND EXISTS (
  SELECT 1
  FROM workflow_step_fields AS legacy
  WHERE legacy.workflow_id=canonical.workflow_id
    AND legacy.step_id=canonical.step_id
    AND COALESCE(legacy.module_code,'consignment')=COALESCE(canonical.module_code,'consignment')
    AND legacy.field_key=CASE canonical.field_key
      WHEN 'domestic_carrier_id' THEN 'carrier_name'
      WHEN 'domestic_vehicle_type' THEN 'vehicle_type'
      WHEN 'domestic_plate_number' THEN 'vehicle_plate'
      WHEN 'domestic_driver_name' THEN 'driver_name'
      WHEN 'domestic_driver_phone' THEN 'driver_phone'
      WHEN 'domestic_actual_pickup_at' THEN 'actual_pickup_at'
      WHEN 'primary_operator' THEN 'operator'
      WHEN 'origin_address' THEN 'pickup_address'
      WHEN 'requested_pickup_date' THEN 'pickup_time'
      WHEN 'overseas_warehouse_id' THEN 'overseas_warehouse'
      WHEN 'shipper_contact' THEN 'pickup_contact'
      WHEN 'shipper_phone' THEN 'pickup_phone'
    END
    AND legacy.updated_at>canonical.updated_at
);

-- Current and future nodes adopt the canonical definition immediately.
-- Completed and not-applicable nodes retain their frozen historical snapshot.
UPDATE workflow_instance_fields AS instance_field
SET is_required = COALESCE((
      SELECT definition.is_required
      FROM workflow_step_fields AS definition
      JOIN workflow_steps AS step ON step.id=definition.step_id
      WHERE definition.workflow_id=instance_field.workflow_id
        AND step.step_key=instance_field.step_key
        AND COALESCE(definition.module_code,'consignment')=instance_field.module_code
        AND definition.field_key=instance_field.field_key
      LIMIT 1
    ), instance_field.is_required),
    is_active = COALESCE((
      SELECT definition.is_active
      FROM workflow_step_fields AS definition
      JOIN workflow_steps AS step ON step.id=definition.step_id
      WHERE definition.workflow_id=instance_field.workflow_id
        AND step.step_key=instance_field.step_key
        AND COALESCE(definition.module_code,'consignment')=instance_field.module_code
        AND definition.field_key=instance_field.field_key
      LIMIT 1
    ), instance_field.is_active),
    handler_position_codes = COALESCE((
      SELECT definition.handler_position_codes
      FROM workflow_step_fields AS definition
      JOIN workflow_steps AS step ON step.id=definition.step_id
      WHERE definition.workflow_id=instance_field.workflow_id
        AND step.step_key=instance_field.step_key
        AND COALESCE(definition.module_code,'consignment')=instance_field.module_code
        AND definition.field_key=instance_field.field_key
      LIMIT 1
    ), instance_field.handler_position_codes)
WHERE instance_field.field_key IN (
  'domestic_carrier_id','domestic_vehicle_type','domestic_plate_number',
  'domestic_driver_name','domestic_driver_phone','domestic_actual_pickup_at',
  'primary_operator','origin_address','requested_pickup_date',
  'overseas_warehouse_id','shipper_contact','shipper_phone'
)
AND EXISTS (
  SELECT 1
  FROM workflow_instance_step_states AS state
  WHERE state.instance_id=instance_field.instance_id
    AND state.step_key=instance_field.step_key
    AND state.status NOT IN ('completed','not_applicable')
);

-- Do not let a stale alias render as a second custom field on an open node.
UPDATE workflow_instance_fields AS instance_field
SET is_required=0,is_active=0
WHERE instance_field.field_key IN (
  'carrier_name','vehicle_type','vehicle_plate','driver_name','driver_phone',
  'actual_pickup_at','operator','pickup_address','pickup_time',
  'overseas_warehouse','pickup_contact','pickup_phone'
)
AND EXISTS (
  SELECT 1
  FROM workflow_instance_step_states AS state
  WHERE state.instance_id=instance_field.instance_id
    AND state.step_key=instance_field.step_key
    AND state.status NOT IN ('completed','not_applicable')
);

DELETE FROM workflow_step_fields
WHERE field_key IN (
  'carrier_name','vehicle_type','vehicle_plate','driver_name','driver_phone',
  'actual_pickup_at','operator','pickup_address','pickup_time',
  'overseas_warehouse','pickup_contact','pickup_phone'
)
AND (
  (COALESCE(module_code,'consignment')='transport' AND step_id IN (
    SELECT id FROM workflow_steps WHERE step_key='domestic_execution'
  ))
  OR (COALESCE(module_code,'consignment')='assignment' AND step_id IN (
    SELECT id FROM workflow_steps WHERE step_key='task_assignment'
  ))
  OR (COALESCE(module_code,'consignment')='consignment' AND step_id IN (
    SELECT id FROM workflow_steps WHERE step_key='order_creation'
  ))
);
