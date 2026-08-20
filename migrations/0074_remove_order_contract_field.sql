PRAGMA foreign_keys = ON;

-- 合同不再作为订单工作流的必传文件。
-- 业务约定：合同在创建/维护客户资料时归档，订单工作流不再强制上传。
-- 已上传的合同附件与审核记录不删除，仅解除工作流的必填/启用约束。

UPDATE workflow_step_fields
SET is_required=0, is_active=0, updated_at=datetime('now')
WHERE field_key='document_contract';

UPDATE workflow_instance_fields
SET is_required=0, is_active=0
WHERE field_key='document_contract';
