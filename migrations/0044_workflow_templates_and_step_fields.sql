PRAGMA foreign_keys = ON;

CREATE TABLE workflow_step_fields (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text','textarea','number','date','datetime','amount','select','multiselect','attachment','customer','supplier','vehicle','driver','warehouse','border_port')),
  is_required INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 10,
  options_text TEXT,
  help_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (step_id, field_key)
);

CREATE INDEX idx_workflow_step_fields_step ON workflow_step_fields(step_id, sort_order);

INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:order_creation:customer_reference', o.id || ':tms-default', o.id || ':wf:order_creation',
       'customer_reference', '客户单号', 'text', 0, 10, '客户和业务员敲定的外部参考号', datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:order_creation:pickup_address', o.id || ':tms-default', o.id || ':wf:order_creation',
       'pickup_address', '提货地址', 'text', 1, 20, '创建订单时必须明确客户仓库或提货地址', datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:order_creation:pickup_contact', o.id || ':tms-default', o.id || ':wf:order_creation',
       'pickup_contact', '提货联系人', 'text', 1, 30, NULL, datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:order_creation:pickup_time', o.id || ':tms-default', o.id || ':wf:order_creation',
       'pickup_time', '预约提货时间', 'datetime', 1, 40, NULL, datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:order_creation:overseas_warehouse', o.id || ':tms-default', o.id || ':wf:order_creation',
       'overseas_warehouse', '境外目的仓', 'warehouse', 1, 50, '只能选择角色为境外目的仓的启用仓库', datetime('now'), datetime('now')
FROM organizations o;

INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:review_assignment:operator', o.id || ':tms-default', o.id || ':wf:review_assignment',
       'operator', '主操作员', 'driver', 1, 10, '第一版复用人员下拉，后续可改为用户字段类型', datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:domestic_execution:actual_pickup_at', o.id || ':tms-default', o.id || ':wf:domestic_execution',
       'actual_pickup_at', '实际提货时间', 'datetime', 1, 10, NULL, datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:domestic_execution:vehicle_plate', o.id || ':tms-default', o.id || ':wf:domestic_execution',
       'vehicle_plate', '国内车牌', 'vehicle', 1, 20, NULL, datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:port_loading:loading_batch', o.id || ':tms-default', o.id || ':wf:port_loading',
       'loading_batch', '配载批次', 'text', 1, 10, '拼车订单必须整票进入一个配载批次', datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:outbound_transport:actual_exit_at', o.id || ':tms-default', o.id || ':wf:outbound_transport',
       'actual_exit_at', '实际出境时间', 'datetime', 1, 10, '录入后进入出境运输中', datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:outbound_transport:exit_port', o.id || ':tms-default', o.id || ':wf:outbound_transport',
       'exit_port', '实际出境口岸', 'border_port', 1, 20, NULL, datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:overseas_pickup:arrival_at', o.id || ':tms-default', o.id || ':wf:overseas_pickup',
       'arrival_at', '境外仓到仓时间', 'datetime', 1, 10, NULL, datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:reconciliation:statement', o.id || ':tms-default', o.id || ':wf:reconciliation',
       'statement', '对账单附件', 'attachment', 0, 10, NULL, datetime('now'), datetime('now')
FROM organizations o;
INSERT INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:completion_review:review_result', o.id || ':tms-default', o.id || ':wf:completion_review',
       'review_result', '复盘结论', 'textarea', 1, 10, NULL, datetime('now'), datetime('now')
FROM organizations o;
