PRAGMA foreign_keys = ON;

-- 已接受报价中的客户、线路、联系人、仓库、货物和费用数据只读继承到订单。
-- 委托资料补充不再重复采集这些字段；保留字段与历史值，仅将其隐藏。
WITH inherited_quote_fields(field_key) AS (
  VALUES
    ('customer_reference'),
    ('customer_id'),
    ('pickup_address'),
    ('quotation_id'),
    ('pickup_contact'),
    ('order_date'),
    ('pickup_time'),
    ('business_nature'),
    ('overseas_warehouse'),
    ('shipper_customer_id'),
    ('pickup_address_id'),
    ('shipper_contact'),
    ('shipper_phone'),
    ('origin_country'),
    ('origin_state'),
    ('origin_city'),
    ('origin_address'),
    ('consignee_name'),
    ('consignee_contact'),
    ('consignee_phone'),
    ('destination_country'),
    ('destination_state'),
    ('destination_city'),
    ('destination_address'),
    ('overseas_warehouse_id'),
    ('overseas_warehouse_address_note'),
    ('requested_pickup_date'),
    ('cargo_ready_at'),
    ('requested_delivery_date'),
    ('ro_agent'),
    ('special_instructions'),
    ('cargo_name_cn'),
    ('cargo_name_en'),
    ('hs_code'),
    ('overseas_hs_code'),
    ('package_type'),
    ('package_count'),
    ('pieces_per_package'),
    ('gross_weight_per_package_kg'),
    ('net_weight_per_package_kg'),
    ('length_cm'),
    ('width_cm'),
    ('height_cm'),
    ('volume_per_package_cbm'),
    ('declared_value'),
    ('currency'),
    ('origin_country_cargo'),
    ('brand_model'),
    ('marks'),
    ('special_attributes'),
    ('cargo_images'),
    ('cargo_notes'),
    ('document_contract'),
    ('pre_receivable_expenses')
)
UPDATE workflow_step_fields
SET is_required = 0,
    is_active = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE field_key IN (SELECT field_key FROM inherited_quote_fields)
  AND step_id IN (
    SELECT id FROM workflow_steps WHERE step_key = 'order_creation'
  );

WITH inherited_quote_fields(field_key) AS (
  VALUES
    ('customer_reference'),
    ('customer_id'),
    ('pickup_address'),
    ('quotation_id'),
    ('pickup_contact'),
    ('order_date'),
    ('pickup_time'),
    ('business_nature'),
    ('overseas_warehouse'),
    ('shipper_customer_id'),
    ('pickup_address_id'),
    ('shipper_contact'),
    ('shipper_phone'),
    ('origin_country'),
    ('origin_state'),
    ('origin_city'),
    ('origin_address'),
    ('consignee_name'),
    ('consignee_contact'),
    ('consignee_phone'),
    ('destination_country'),
    ('destination_state'),
    ('destination_city'),
    ('destination_address'),
    ('overseas_warehouse_id'),
    ('overseas_warehouse_address_note'),
    ('requested_pickup_date'),
    ('cargo_ready_at'),
    ('requested_delivery_date'),
    ('ro_agent'),
    ('special_instructions'),
    ('cargo_name_cn'),
    ('cargo_name_en'),
    ('hs_code'),
    ('overseas_hs_code'),
    ('package_type'),
    ('package_count'),
    ('pieces_per_package'),
    ('gross_weight_per_package_kg'),
    ('net_weight_per_package_kg'),
    ('length_cm'),
    ('width_cm'),
    ('height_cm'),
    ('volume_per_package_cbm'),
    ('declared_value'),
    ('currency'),
    ('origin_country_cargo'),
    ('brand_model'),
    ('marks'),
    ('special_attributes'),
    ('cargo_images'),
    ('cargo_notes'),
    ('document_contract'),
    ('pre_receivable_expenses')
)
UPDATE workflow_instance_fields
SET is_required = 0,
    is_active = 0
WHERE step_key = 'order_creation'
  AND field_key IN (SELECT field_key FROM inherited_quote_fields);

-- 委托书是该节点唯一的系统默认必填门禁。
UPDATE workflow_step_fields
SET is_required = 1,
    is_active = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE field_key = 'document_consignment_letter'
  AND module_code = 'consignment'
  AND step_id IN (
    SELECT id FROM workflow_steps WHERE step_key = 'order_creation'
  );

UPDATE workflow_instance_fields
SET is_required = 1,
    is_active = 1
WHERE step_key = 'order_creation'
  AND field_key = 'document_consignment_letter'
  AND module_code = 'consignment';

-- 字段隐藏后关闭对应的未完成补录任务，历史值和任务记录仍保留审计。
UPDATE workflow_supplement_tasks
SET status = 'cancelled',
    resolution_note = '字段改为从已接受报价只读继承，不再在委托资料补充阶段重复填写。',
    completed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE target_step_key = 'order_creation'
  AND status = 'open'
  AND field_key <> 'document_consignment_letter'
  AND EXISTS (
    SELECT 1
    FROM workflow_instance_fields f
    WHERE f.instance_id = workflow_supplement_tasks.instance_id
      AND f.module_code = workflow_supplement_tasks.module_code
      AND f.field_key = workflow_supplement_tasks.field_key
      AND f.is_active = 0
  );
