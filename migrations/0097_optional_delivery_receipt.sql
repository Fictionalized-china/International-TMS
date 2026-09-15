-- 境外仓扫码核对并确认客户自提出库即完成签收和运输。
-- 签收单保留为可选归档资料，不再成为历史模板或订单快照的隐藏门禁。
UPDATE workflow_step_fields
SET is_required = 0,
    help_text = '境外仓扫码核对并完成客户自提出库后，可选上传签收文件作为补充归档。',
    updated_at = CURRENT_TIMESTAMP
WHERE field_key = 'document_delivery_receipt';

UPDATE workflow_instance_fields
SET is_required = 0,
    help_text = '境外仓扫码核对并完成客户自提出库后，可选上传签收文件作为补充归档。'
WHERE field_key = 'document_delivery_receipt';
