PRAGMA foreign_keys = ON;

-- 早期目录初始化会把所有“新系统字段”统一降成选填，询价原生字段也因此
-- 可能出现 0 必填 / 19 选填。本迁移只修复具有系统 catalog ID、从未更新、
-- 且没有任何字段配置审计的自动生成行；老板编辑过的行绝不覆盖。
UPDATE workflow_step_fields
SET is_required=CASE field_key
      WHEN 'quotation_destination_warehouse_note' THEN 0
      WHEN 'quotation_notes' THEN 0
      WHEN 'quotation_valid_until' THEN 0
      ELSE 1
    END,
    is_active=1,
    updated_at=CURRENT_TIMESTAMP
WHERE id=workflow_id || ':catalog:' || COALESCE(module_code,'consignment') || ':' || field_key
  AND created_at=updated_at
  AND NOT EXISTS(
    SELECT 1 FROM audit_logs audit
    WHERE audit.resource_type='workflow_step_field'
      AND audit.resource_id=workflow_step_fields.id
  )
  AND field_key IN (
    'quotation_customer_contact_name','quotation_customer_contact_phone',
    'quotation_salesperson_user_id','quotation_customs_clearance_mode',
    'quotation_origin_region','quotation_pickup_address',
    'quotation_destination_region','quotation_destination_warehouse_id',
    'quotation_destination_warehouse_note','quotation_cargo_description',
    'quotation_notes','quotation_pieces','quotation_gross_weight_kg',
    'quotation_length_cm','quotation_width_cm','quotation_height_cm',
    'quotation_volume_cbm','quotation_charge_items','quotation_valid_until'
  )
  AND step_id IN (
    SELECT s.id
    FROM workflow_steps s
    JOIN workflow_definitions wd ON wd.id=s.workflow_id
    WHERE s.step_key='quotation' AND wd.road_load_type IN ('ftl','ltl')
  );

-- 仅同步仍处于询价节点的报价实例。已建单、已越过询价的历史快照保持冻结。
UPDATE workflow_instance_fields AS instance_field
SET is_required=COALESCE((
      SELECT definition_field.is_required
      FROM workflow_step_fields definition_field
      JOIN workflow_steps definition_step ON definition_step.id=definition_field.step_id
      WHERE definition_field.workflow_id=instance_field.workflow_id
        AND definition_step.step_key='quotation'
        AND definition_field.field_key=instance_field.field_key
        AND COALESCE(definition_field.module_code,'consignment')=instance_field.module_code
      LIMIT 1
    ),instance_field.is_required),
    is_active=COALESCE((
      SELECT definition_field.is_active
      FROM workflow_step_fields definition_field
      JOIN workflow_steps definition_step ON definition_step.id=definition_field.step_id
      WHERE definition_field.workflow_id=instance_field.workflow_id
        AND definition_step.step_key='quotation'
        AND definition_field.field_key=instance_field.field_key
        AND COALESCE(definition_field.module_code,'consignment')=instance_field.module_code
      LIMIT 1
    ),instance_field.is_active)
WHERE instance_field.step_key='quotation'
  AND EXISTS(
    SELECT 1
    FROM workflow_instances wi
    JOIN workflow_steps current_step
      ON current_step.workflow_id=wi.workflow_id AND current_step.step_key=wi.current_step_key
    JOIN workflow_steps target_step
      ON target_step.workflow_id=wi.workflow_id AND target_step.step_key='quotation'
    WHERE wi.id=instance_field.instance_id
      AND current_step.sort_order<=target_step.sort_order
  );
