PRAGMA foreign_keys = ON;

-- The order-creation page is a system business view. Workflow configuration
-- only overrides its required/optional/hidden modes; it must not start from an
-- empty field set. 0110 hid inherited quotation data to avoid duplicate input,
-- but the page now presents those values read-only, so unedited system rows are
-- restored as visible optional facts. Explicit boss edits are identified by
-- their audit log and remain untouched.
WITH baseline(field_key,is_required,is_active) AS (VALUES
  ('customer_id',0,1),
  ('quotation_id',0,1),
  ('order_date',0,1),
  ('business_nature',0,1),
  ('shipper_customer_id',0,1),
  ('pickup_address_id',0,1),
  ('shipper_contact',0,1),
  ('shipper_phone',0,1),
  ('origin_country',0,1),
  ('origin_state',0,1),
  ('origin_city',0,1),
  ('origin_address',0,1),
  ('consignee_name',0,1),
  ('consignee_contact',0,1),
  ('consignee_phone',0,1),
  ('destination_country',0,1),
  ('destination_state',0,1),
  ('destination_city',0,1),
  ('destination_address',0,1),
  ('overseas_warehouse_id',0,1),
  ('overseas_warehouse_address_note',0,1),
  ('requested_pickup_date',0,1),
  ('cargo_ready_at',0,1),
  ('requested_delivery_date',0,1),
  ('ro_agent',0,1),
  ('special_instructions',0,1),
  ('cargo_name_cn',0,1),
  ('cargo_name_en',0,1),
  ('hs_code',0,1),
  ('overseas_hs_code',0,1),
  ('package_type',0,1),
  ('package_count',0,1),
  ('pieces_per_package',0,1),
  ('gross_weight_per_package_kg',0,1),
  ('net_weight_per_package_kg',0,1),
  ('length_cm',0,1),
  ('width_cm',0,1),
  ('height_cm',0,1),
  ('volume_per_package_cbm',0,1),
  ('declared_value',0,1),
  ('currency',0,1),
  ('origin_country_cargo',0,1),
  ('brand_model',0,1),
  ('marks',0,1),
  ('special_attributes',0,1),
  ('cargo_images',0,1),
  ('cargo_notes',0,1),
  ('document_consignment_letter',1,1),
  ('document_contract',0,0)
)
UPDATE workflow_step_fields AS field
SET is_required=(SELECT baseline.is_required FROM baseline WHERE baseline.field_key=field.field_key),
    is_active=(SELECT baseline.is_active FROM baseline WHERE baseline.field_key=field.field_key),
    updated_at=CURRENT_TIMESTAMP
WHERE field.field_key IN (SELECT field_key FROM baseline)
  AND field.step_id IN (
    SELECT step.id FROM workflow_steps step
    WHERE step.workflow_id=field.workflow_id AND step.step_key='order_creation'
  )
  AND NOT EXISTS(
    SELECT 1 FROM audit_logs audit
    WHERE audit.resource_type='workflow_step_field'
      AND audit.resource_id=field.id
  );

-- Current and future order stages follow the repaired definition. Historical
-- stages stay frozen, matching the established no-rollback audit rule.
WITH baseline(field_key) AS (VALUES
  ('customer_id'),('quotation_id'),('order_date'),('business_nature'),
  ('shipper_customer_id'),('pickup_address_id'),('shipper_contact'),('shipper_phone'),
  ('origin_country'),('origin_state'),('origin_city'),('origin_address'),
  ('consignee_name'),('consignee_contact'),('consignee_phone'),
  ('destination_country'),('destination_state'),('destination_city'),('destination_address'),
  ('overseas_warehouse_id'),('overseas_warehouse_address_note'),
  ('requested_pickup_date'),('cargo_ready_at'),('requested_delivery_date'),
  ('ro_agent'),('special_instructions'),
  ('cargo_name_cn'),('cargo_name_en'),('hs_code'),('overseas_hs_code'),
  ('package_type'),('package_count'),('pieces_per_package'),
  ('gross_weight_per_package_kg'),('net_weight_per_package_kg'),
  ('length_cm'),('width_cm'),('height_cm'),('volume_per_package_cbm'),
  ('declared_value'),('currency'),('origin_country_cargo'),('brand_model'),
  ('marks'),('special_attributes'),('cargo_images'),('cargo_notes'),
  ('document_consignment_letter'),('document_contract')
)
UPDATE workflow_instance_fields AS instance_field
SET is_required=(
      SELECT definition_field.is_required
      FROM workflow_step_fields definition_field
      JOIN workflow_steps definition_step ON definition_step.id=definition_field.step_id
      WHERE definition_field.workflow_id=instance_field.workflow_id
        AND definition_step.step_key='order_creation'
        AND definition_field.field_key=instance_field.field_key
        AND COALESCE(definition_field.module_code,'consignment')=instance_field.module_code
      LIMIT 1
    ),
    is_active=(
      SELECT definition_field.is_active
      FROM workflow_step_fields definition_field
      JOIN workflow_steps definition_step ON definition_step.id=definition_field.step_id
      WHERE definition_field.workflow_id=instance_field.workflow_id
        AND definition_step.step_key='order_creation'
        AND definition_field.field_key=instance_field.field_key
        AND COALESCE(definition_field.module_code,'consignment')=instance_field.module_code
      LIMIT 1
    )
WHERE instance_field.step_key='order_creation'
  AND instance_field.field_key IN (SELECT field_key FROM baseline)
  AND EXISTS(
    SELECT 1
    FROM workflow_instances workflow_instance
    JOIN workflow_steps current_step
      ON current_step.workflow_id=workflow_instance.workflow_id
     AND current_step.step_key=workflow_instance.current_step_key
    JOIN workflow_steps target_step
      ON target_step.workflow_id=workflow_instance.workflow_id
     AND target_step.step_key='order_creation'
    JOIN workflow_step_fields definition_field
      ON definition_field.workflow_id=workflow_instance.workflow_id
     AND definition_field.step_id=target_step.id
     AND definition_field.field_key=instance_field.field_key
     AND COALESCE(definition_field.module_code,'consignment')=instance_field.module_code
    WHERE workflow_instance.id=instance_field.instance_id
      AND current_step.sort_order<=target_step.sort_order
      AND NOT EXISTS(
        SELECT 1 FROM audit_logs audit
        WHERE audit.resource_type='workflow_step_field'
          AND audit.resource_id=definition_field.id
      )
  );
