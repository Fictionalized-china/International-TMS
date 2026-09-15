PRAGMA foreign_keys = ON;

-- Reset only system-owned fields. User-created workflow fields keep their
-- configured required/optional mode.
UPDATE workflow_step_fields
SET is_required = 0,
    updated_at = datetime('now')
WHERE workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
)
AND (
  instr(id, workflow_id || ':catalog:') = 1
  OR instr(id, ':wff:') > 0
  OR instr(id, ':wf-field:') > 0
);

-- Fields confirmed as mandatory in the legacy operating forms form the
-- default required baseline for both LTL and FTL standard workflows.
UPDATE workflow_step_fields
SET is_required = 1,
    updated_at = datetime('now')
WHERE workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
)
AND field_key IN (
  'customer_id',
  'order_date',
  'business_nature',
  'shipper_customer_id',
  'shipper_contact',
  'shipper_phone',
  'origin_country',
  'origin_state',
  'origin_city',
  'origin_address',
  'consignee_name',
  'destination_country',
  'destination_state',
  'destination_city',
  'destination_address',
  'cargo_name_cn',
  'package_type',
  'package_count',
  'pieces_per_package',
  'gross_weight_per_package_kg',
  'volume_per_package_cbm',
  'primary_operator',
  'domestic_carrier_id',
  'domestic_planned_departure_at',
  'main_carrier_id',
  'main_vehicle_type',
  'planned_exit_at',
  'declaration_stage',
  'declaration_status',
  'declaration_number',
  'declaration_type',
  'declaration_title',
  'declaring_company',
  'declared_at',
  'declared_amount',
  'declaration_currency',
  'declaration_gross_weight',
  'actual_departure_at',
  'actual_exit_at',
  'tracking_milestone',
  'tracking_event_at',
  'tracking_location',
  'overseas_arrival_at',
  'overseas_pickup_contact',
  'pickup_completed_at',
  'pre_receivable_expenses',
  'pre_payable_expenses',
  'receivable_expenses',
  'payable_expenses',
  'expense_currency',
  'expense_exchange_rate',
  'expense_direction',
  'expense_charge_name',
  'expense_counterparty',
  'expense_quantity',
  'expense_unit_price'
)
AND (
  instr(id, workflow_id || ':catalog:') = 1
  OR instr(id, ':wff:') > 0
  OR instr(id, ':wf-field:') > 0
);

-- Existing orders use a snapshot of their template fields. Apply the same
-- baseline to those snapshots so old and new orders behave consistently.
UPDATE workflow_instance_fields AS instance_field
SET is_required = 0
WHERE workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
)
AND EXISTS (
  SELECT 1
  FROM workflow_step_fields AS template_field
  JOIN workflow_steps AS template_step
    ON template_step.id = template_field.step_id
   AND template_step.workflow_id = template_field.workflow_id
  WHERE template_field.workflow_id = instance_field.workflow_id
    AND template_step.step_key = instance_field.step_key
    AND COALESCE(template_field.module_code, 'consignment') = instance_field.module_code
    AND template_field.field_key = instance_field.field_key
    AND (
      instr(template_field.id, template_field.workflow_id || ':catalog:') = 1
      OR instr(template_field.id, ':wff:') > 0
      OR instr(template_field.id, ':wf-field:') > 0
    )
);

UPDATE workflow_instance_fields AS instance_field
SET is_required = 1
WHERE workflow_id IN (
  SELECT id
  FROM workflow_definitions
  WHERE code IN ('tms-default', 'tms-ftl-standard', 'tms-road-pending')
)
AND field_key IN (
  'customer_id',
  'order_date',
  'business_nature',
  'shipper_customer_id',
  'shipper_contact',
  'shipper_phone',
  'origin_country',
  'origin_state',
  'origin_city',
  'origin_address',
  'consignee_name',
  'destination_country',
  'destination_state',
  'destination_city',
  'destination_address',
  'cargo_name_cn',
  'package_type',
  'package_count',
  'pieces_per_package',
  'gross_weight_per_package_kg',
  'volume_per_package_cbm',
  'primary_operator',
  'domestic_carrier_id',
  'domestic_planned_departure_at',
  'main_carrier_id',
  'main_vehicle_type',
  'planned_exit_at',
  'declaration_stage',
  'declaration_status',
  'declaration_number',
  'declaration_type',
  'declaration_title',
  'declaring_company',
  'declared_at',
  'declared_amount',
  'declaration_currency',
  'declaration_gross_weight',
  'actual_departure_at',
  'actual_exit_at',
  'tracking_milestone',
  'tracking_event_at',
  'tracking_location',
  'overseas_arrival_at',
  'overseas_pickup_contact',
  'pickup_completed_at',
  'pre_receivable_expenses',
  'pre_payable_expenses',
  'receivable_expenses',
  'payable_expenses',
  'expense_currency',
  'expense_exchange_rate',
  'expense_direction',
  'expense_charge_name',
  'expense_counterparty',
  'expense_quantity',
  'expense_unit_price'
)
AND EXISTS (
  SELECT 1
  FROM workflow_step_fields AS template_field
  JOIN workflow_steps AS template_step
    ON template_step.id = template_field.step_id
   AND template_step.workflow_id = template_field.workflow_id
  WHERE template_field.workflow_id = instance_field.workflow_id
    AND template_step.step_key = instance_field.step_key
    AND COALESCE(template_field.module_code, 'consignment') = instance_field.module_code
    AND template_field.field_key = instance_field.field_key
    AND (
      instr(template_field.id, template_field.workflow_id || ':catalog:') = 1
      OR instr(template_field.id, ':wff:') > 0
      OR instr(template_field.id, ':wf-field:') > 0
    )
);
