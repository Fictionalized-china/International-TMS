-- 报关单（customs_document）确保在配载出库前必填
-- migration 0066 已设置 is_required=1，此处为补充保障，确保模板和快照都一致
UPDATE workflow_step_fields
   SET is_required = 1, is_active = 1, updated_at = datetime('now')
 WHERE field_key = 'document_customs_document';

UPDATE workflow_instance_fields
   SET is_required = 1, is_active = 1
 WHERE field_key = 'document_customs_document';
