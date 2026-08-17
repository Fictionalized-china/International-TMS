PRAGMA foreign_keys = ON;

-- 文件中心只负责汇总、审核和归档，不再作为订单主流程中的独立必经模块。
UPDATE order_module_instances
SET is_required=0, updated_at=datetime('now')
WHERE module_code='documents';

UPDATE workflow_step_fields
SET is_required=0, updated_at=datetime('now')
WHERE module_code='documents';

UPDATE workflow_instance_fields
SET is_required=0
WHERE module_code='documents';

UPDATE permissions
SET name='办理文件中心',
    description='汇总、审核和归档各业务节点上传的订单文件'
WHERE code='order.module.documents.manage';

-- 文件在实际取得它的业务节点上传。所有工作流模板均获得同一套可配置积木，
-- 用户仍可在业务工作流中调整必填、选填或隐藏状态。
WITH document_fields(
  step_key,module_code,field_key,label,is_required,sort_order,help_text
) AS (
  VALUES
    ('order_creation','consignment','document_consignment_letter','委托书',1,900,'客户确认委托后，在委托信息节点上传。'),
    ('order_creation','consignment','document_contract','合同',1,910,'业务合同或运输代理合同在委托信息节点上传。'),
    ('domestic_execution','transport','document_waybill','运单',0,900,'国内承运方提供运单后，在国内运输节点上传。'),
    ('outbound_transport','customs','document_commercial_invoice','商业发票',1,900,'办理报关申报时使用的商业发票。'),
    ('outbound_transport','customs','document_packing_list','装箱单',1,910,'办理报关申报时使用的装箱明细。'),
    ('outbound_transport','customs','document_customs_document','报关资料',1,920,'起运地、过境地或目的地申报所需资料。'),
    ('outbound_transport','customs','document_border_document','口岸文件',0,930,'口岸交接、过境或查验文件。'),
    ('outbound_transport','tracking','document_transshipment_order','换装单',0,900,'换装、转关或车辆交接后上传。'),
    ('overseas_pickup','overseas_warehouse','document_pod','POD',0,900,'境外仓交付或客户提货完成后上传交付证明。'),
    ('overseas_pickup','overseas_warehouse','document_delivery_receipt','签收单',1,910,'国外运输结束并完成签收后上传；未上传不能完成境外仓交付。'),
    ('overseas_pickup','overseas_warehouse','document_return_receipt','回单',0,920,'客户签收回单或业务回执。'),
    ('reconciliation','costs','document_billing_statement','账单',0,900,'对账完成后上传客户或供应商账单。'),
    ('reconciliation','costs','document_payment_receipt','收付款凭证',0,910,'收付款或核销完成后上传银行回单等凭证。')
)
INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
  sort_order,options_text,help_text,module_code,created_at,updated_at
)
SELECT
  w.id || ':catalog:' || f.module_code || ':' || f.field_key,
  w.id,
  s.id,
  f.field_key,
  f.label,
  'attachment',
  f.is_required,
  1,
  f.sort_order,
  NULL,
  f.help_text,
  f.module_code,
  datetime('now'),
  datetime('now')
FROM workflow_definitions w
JOIN workflow_steps s ON s.workflow_id=w.id
JOIN document_fields f ON f.step_key=s.step_key;

UPDATE workflow_step_fields
SET is_required=1, is_active=1, updated_at=datetime('now')
WHERE field_key IN (
  'document_consignment_letter',
  'document_contract',
  'document_commercial_invoice',
  'document_packing_list',
  'document_customs_document',
  'document_delivery_receipt'
);

-- 已有订单使用字段快照，必须把新文件字段补入快照才能立即生效。
INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT
  lower(hex(randomblob(16))),
  wi.id,
  wi.workflow_id,
  ws.step_key,
  f.module_code,
  f.field_key,
  f.label,
  f.field_type,
  f.is_required,
  f.is_active,
  f.sort_order,
  f.options_text,
  f.help_text,
  datetime('now')
FROM workflow_instances wi
JOIN workflow_step_fields f ON f.workflow_id=wi.workflow_id
JOIN workflow_steps ws ON ws.id=f.step_id AND ws.workflow_id=f.workflow_id
WHERE f.field_key IN (
  'document_consignment_letter',
  'document_contract',
  'document_waybill',
  'document_commercial_invoice',
  'document_packing_list',
  'document_customs_document',
  'document_border_document',
  'document_transshipment_order',
  'document_pod',
  'document_delivery_receipt',
  'document_return_receipt',
  'document_billing_statement',
  'document_payment_receipt'
);

UPDATE workflow_instance_fields
SET is_required=1, is_active=1
WHERE field_key IN (
  'document_consignment_letter',
  'document_contract',
  'document_commercial_invoice',
  'document_packing_list',
  'document_customs_document',
  'document_delivery_receipt'
);
