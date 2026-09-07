-- 收货凭证不再由仓库收货岗位录入；保留历史收货记录中的 evidence_note 供审计查看。
DELETE FROM workflow_step_fields
WHERE field_key = 'receipt_evidence';

UPDATE workflow_instance_fields
SET is_active = 0,
    is_required = 0
WHERE field_key = 'receipt_evidence';
