PRAGMA foreign_keys = ON;

-- 强制：新建订单时委托书上传、预约提货时间、境外目的仓为必填。
-- 工作流字段字典默认即 required，但运行时配置曾被覆盖为 optional；本迁移恢复 required 状态。
UPDATE workflow_step_fields
   SET is_required = 1,
       updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
 WHERE module_code = 'consignment'
   AND is_active = 1
   AND field_key IN ('overseas_warehouse_id', 'requested_pickup_date', 'document_consignment_letter');