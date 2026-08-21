PRAGMA foreign_keys = ON;

-- 汽运国内运输只保留运输安排。旧订舱、运单和文件数据继续留作历史记录，
-- 但不再作为工作流可见字段或隐藏门禁。
UPDATE workflow_step_fields
SET is_active = 0,
    is_required = 0,
    updated_at = datetime('now')
WHERE module_code = 'transport'
  AND field_key IN (
    'waybill_number',
    'waybill_accompanying_at',
    'waybill_shipper_instructions',
    'waybill_customs_notes',
    'waybill_accompanying_documents',
    'waybill_documents_verified',
    'document_waybill'
  );

UPDATE workflow_instance_fields
SET is_active = 0,
    is_required = 0
WHERE module_code = 'transport'
  AND field_key IN (
    'waybill_number',
    'waybill_accompanying_at',
    'waybill_shipper_instructions',
    'waybill_customs_notes',
    'waybill_accompanying_documents',
    'waybill_documents_verified',
    'document_waybill'
  );
