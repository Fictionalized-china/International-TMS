PRAGMA foreign_keys = ON;

ALTER TABLE workflow_definitions ADD COLUMN template_family_id TEXT;
ALTER TABLE workflow_definitions ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workflow_definitions ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE workflow_definitions ADD COLUMN based_on_workflow_id TEXT;
ALTER TABLE workflow_definitions ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'valid';
ALTER TABLE workflow_definitions ADD COLUMN validation_message TEXT;
ALTER TABLE workflow_definitions ADD COLUMN published_at TEXT;
ALTER TABLE workflow_definitions ADD COLUMN published_by_user_id TEXT;

UPDATE workflow_definitions
SET template_family_id=id,
    lifecycle_status='published',
    validation_status='valid',
    published_at=COALESCE(published_at,created_at)
WHERE template_family_id IS NULL;

CREATE INDEX idx_workflow_definition_family_version
  ON workflow_definitions(organization_id,template_family_id,version_number DESC);
CREATE INDEX idx_workflow_definition_publication
  ON workflow_definitions(organization_id,lifecycle_status,status,updated_at DESC);

CREATE TABLE workflow_step_modules (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 10,
  is_required INTEGER NOT NULL DEFAULT 1 CHECK(is_required IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  responsibility_position_code TEXT,
  activation_condition TEXT,
  completion_mode TEXT NOT NULL DEFAULT 'all_tasks' CHECK(completion_mode IN ('all_tasks','manual_confirm','automatic')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(step_id,module_code)
);

CREATE INDEX idx_workflow_step_modules_step
  ON workflow_step_modules(workflow_id,step_id,is_active,sort_order);

CREATE TABLE workflow_module_tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  step_module_id TEXT NOT NULL REFERENCES workflow_step_modules(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'form' CHECK(task_type IN ('form','review','decision','system')),
  sort_order INTEGER NOT NULL DEFAULT 10,
  is_required INTEGER NOT NULL DEFAULT 1 CHECK(is_required IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  responsibility_position_code TEXT,
  instructions TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(step_module_id,task_key)
);

CREATE INDEX idx_workflow_module_tasks_module
  ON workflow_module_tasks(workflow_id,step_module_id,is_active,sort_order);

-- Build module blocks from existing field ownership first.
INSERT OR IGNORE INTO workflow_step_modules(
  id,workflow_id,step_id,module_code,display_name,sort_order,is_required,is_active,
  responsibility_position_code,completion_mode,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),f.workflow_id,f.step_id,f.module_code,
       CASE f.module_code
         WHEN 'consignment' THEN '委托信息' WHEN 'cargo' THEN '货物信息'
         WHEN 'assignment' THEN '任务分配' WHEN 'transport' THEN '国内运输'
         WHEN 'warehouse' THEN '仓库入库' WHEN 'loading' THEN '装车与出库'
         WHEN 'documents' THEN '文件记录' WHEN 'customs' THEN '报关作业'
         WHEN 'tracking' THEN '运输执行与跟踪' WHEN 'overseas_warehouse' THEN '境外仓自提'
         WHEN 'costs' THEN '费用结算' WHEN 'exceptions' THEN '异常处理'
         WHEN 'review' THEN '订单复盘' ELSE f.module_code END,
       MIN(f.sort_order),MAX(f.is_required),MAX(f.is_active),
       CASE f.module_code
         WHEN 'assignment' THEN 'OPERATION_SUPERVISOR'
         WHEN 'transport' THEN 'SALES' WHEN 'warehouse' THEN 'WAREHOUSE'
         WHEN 'loading' THEN 'LOADING' WHEN 'customs' THEN 'DOC'
         WHEN 'tracking' THEN 'TRACKING' WHEN 'overseas_warehouse' THEN 'OVERSEAS_WAREHOUSE'
         WHEN 'costs' THEN 'FINANCE_ACCOUNTING' WHEN 'review' THEN 'FINANCE_ACCOUNTING'
         ELSE 'OPERATION' END,
       'all_tasks',datetime('now'),datetime('now')
FROM workflow_step_fields f
WHERE f.module_code IS NOT NULL
GROUP BY f.workflow_id,f.step_id,f.module_code;

-- Ensure every standard node has an explicit block even when it has no fields.
INSERT OR IGNORE INTO workflow_step_modules(
  id,workflow_id,step_id,module_code,display_name,sort_order,is_required,is_active,
  responsibility_position_code,completion_mode,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),s.workflow_id,s.id,
       CASE s.step_key
         WHEN 'order_creation' THEN 'consignment' WHEN 'consignment_approval' THEN 'consignment'
         WHEN 'task_assignment' THEN 'assignment' WHEN 'domestic_execution' THEN 'transport'
         WHEN 'warehouse_receiving' THEN 'warehouse' WHEN 'port_loading' THEN 'loading'
         WHEN 'outbound_transport' THEN 'tracking' WHEN 'overseas_pickup' THEN 'overseas_warehouse'
         WHEN 'reconciliation' THEN 'costs' WHEN 'completion_review' THEN 'review' END,
       CASE s.step_key
         WHEN 'order_creation' THEN '委托信息' WHEN 'consignment_approval' THEN '委托审核'
         WHEN 'task_assignment' THEN '任务分配' WHEN 'domestic_execution' THEN '国内运输'
         WHEN 'warehouse_receiving' THEN '仓库入库' WHEN 'port_loading' THEN '装车与出库'
         WHEN 'outbound_transport' THEN '运输执行与跟踪' WHEN 'overseas_pickup' THEN '境外仓自提'
         WHEN 'reconciliation' THEN '费用结算' WHEN 'completion_review' THEN '订单复盘' END,
       10,1,1,
       CASE s.step_key
         WHEN 'consignment_approval' THEN 'BUSINESS_SUPERVISOR'
         WHEN 'task_assignment' THEN 'OPERATION_SUPERVISOR'
         WHEN 'domestic_execution' THEN 'SALES' WHEN 'warehouse_receiving' THEN 'WAREHOUSE'
         WHEN 'port_loading' THEN 'LOADING' WHEN 'outbound_transport' THEN 'TRACKING'
         WHEN 'overseas_pickup' THEN 'OVERSEAS_WAREHOUSE'
         WHEN 'reconciliation' THEN 'FINANCE_ACCOUNTING'
         WHEN 'completion_review' THEN 'FINANCE_ACCOUNTING' ELSE 'SALES' END,
       CASE s.step_key WHEN 'consignment_approval' THEN 'manual_confirm' ELSE 'all_tasks' END,
       datetime('now'),datetime('now')
FROM workflow_steps s
WHERE s.is_active=1
  AND s.step_key IN (
    'order_creation','consignment_approval','task_assignment','domestic_execution',
    'warehouse_receiving','port_loading','outbound_transport','overseas_pickup',
    'reconciliation','completion_review'
  );

INSERT OR IGNORE INTO workflow_module_tasks(
  id,workflow_id,step_module_id,task_key,name,task_type,sort_order,is_required,is_active,
  responsibility_position_code,instructions,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),m.workflow_id,m.id,'handle_'||m.module_code,
       CASE m.completion_mode WHEN 'manual_confirm' THEN '确认无误并继续' ELSE '办理'||m.display_name END,
       CASE m.completion_mode WHEN 'manual_confirm' THEN 'review' ELSE 'form' END,
       10,1,1,m.responsibility_position_code,
       CASE m.completion_mode WHEN 'manual_confirm' THEN '核对当前节点全部继承信息，确认无误后继续。' ELSE NULL END,
       datetime('now'),datetime('now')
FROM workflow_step_modules m;
