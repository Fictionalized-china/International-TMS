PRAGMA foreign_keys = ON;

-- 报价在整车/拼车版本选定后即成为工作流第一步；委托资料补充顺延为第二步。
UPDATE workflow_steps
SET sort_order = sort_order + 10,
    updated_at = CURRENT_TIMESTAMP
WHERE is_active = 1
  AND step_key <> 'quotation'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions WHERE road_load_type IN ('ftl','ltl')
  );

INSERT OR IGNORE INTO workflow_steps(
  id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,
  is_required,is_active,actor_scope,created_at,updated_at
)
SELECT wd.id || ':wf:quotation',wd.id,'quotation','询价报价','quote','quote.created',10,
       1,1,'admin',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM workflow_definitions wd
WHERE wd.road_load_type IN ('ftl','ltl');

UPDATE workflow_steps
SET name='询价报价',entity_type='quote',trigger_event='quote.created',sort_order=10,
    is_required=1,is_active=1,actor_scope='admin',updated_at=CURRENT_TIMESTAMP
WHERE step_key='quotation'
  AND workflow_id IN (
    SELECT id FROM workflow_definitions WHERE road_load_type IN ('ftl','ltl')
  );

INSERT OR IGNORE INTO workflow_step_modules(
  id,workflow_id,step_id,module_code,display_name,sort_order,is_required,is_active,
  responsibility_position_code,completion_mode,created_at,updated_at
)
SELECT s.id || ':module:consignment',s.workflow_id,s.id,'consignment','询价与报价',10,1,1,
       'SALES','all_tasks',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM workflow_steps s
WHERE s.step_key='quotation' AND s.is_active=1;

INSERT OR IGNORE INTO workflow_module_tasks(
  id,workflow_id,step_module_id,task_key,name,task_type,sort_order,is_required,is_active,
  responsibility_position_code,instructions,created_at,updated_at
)
SELECT m.id || ':task:handle_quotation',m.workflow_id,m.id,'handle_quotation',
       '填写询价并完成报价','system',10,1,1,'SALES',
       '首次保存报价时锁定整车或拼车工作流版本；客户接受后完成本节点。',
       CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM workflow_step_modules m
JOIN workflow_steps s ON s.id=m.step_id AND s.workflow_id=m.workflow_id
WHERE s.step_key='quotation' AND m.module_code='consignment';

CREATE TABLE quotation_workflow_field_values (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  field_id TEXT NOT NULL REFERENCES workflow_step_fields(id) ON DELETE RESTRICT,
  field_key TEXT NOT NULL,
  module_code TEXT NOT NULL,
  value_text TEXT,
  file_name TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  data_url TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(quotation_id,field_id)
);

CREATE INDEX idx_quotation_workflow_values
  ON quotation_workflow_field_values(organization_id,quotation_id,workflow_id,field_id);

-- 给尚未建单的历史报价补上第一步实例；已建单报价沿用原实例。
INSERT OR IGNORE INTO workflow_instances(
  id,organization_id,workflow_id,customer_id,quotation_id,current_step_key,status,started_at,updated_at
)
SELECT lower(hex(randomblob(16))),q.organization_id,q.workflow_definition_id,q.customer_id,q.id,
       'quotation','active',q.created_at,CURRENT_TIMESTAMP
FROM quotations q
JOIN workflow_definitions wd
  ON wd.id=q.workflow_definition_id AND wd.organization_id=q.organization_id
WHERE q.lifecycle_status IN ('pending','withdrawn')
  AND wd.road_load_type=q.road_load_type
  AND NOT EXISTS(
    SELECT 1 FROM workflow_instances wi
    WHERE wi.organization_id=q.organization_id AND wi.quotation_id=q.id
  );

-- 所有既有订单都已经完成询价报价，新增历史节点只补审计，不回退当前节点。
INSERT OR IGNORE INTO workflow_instance_step_states(
  id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,
  started_at,completed_at,updated_at
)
SELECT lower(hex(randomblob(16))),wi.id,wi.workflow_id,s.id,'quotation','询价报价',10,
       CASE WHEN wi.order_id IS NOT NULL THEN 'completed' ELSE 'active' END,
       wi.started_at,CASE WHEN wi.order_id IS NOT NULL THEN wi.updated_at ELSE NULL END,CURRENT_TIMESTAMP
FROM workflow_instances wi
JOIN workflow_steps s ON s.workflow_id=wi.workflow_id AND s.step_key='quotation' AND s.is_active=1;

UPDATE workflow_instance_step_states
SET sort_order=(
      SELECT s.sort_order FROM workflow_steps s
      WHERE s.workflow_id=workflow_instance_step_states.workflow_id
        AND s.step_key=workflow_instance_step_states.step_key
    ),
    updated_at=CURRENT_TIMESTAMP
WHERE EXISTS(
  SELECT 1 FROM workflow_steps s
  WHERE s.workflow_id=workflow_instance_step_states.workflow_id
    AND s.step_key=workflow_instance_step_states.step_key
);

INSERT OR IGNORE INTO workflow_instance_module_states(
  id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,
  status,responsibility_position_code,completion_mode,updated_at
)
SELECT lower(hex(randomblob(16))),ss.id,m.id,m.module_code,m.display_name,m.sort_order,m.is_required,
       ss.status,m.responsibility_position_code,m.completion_mode,CURRENT_TIMESTAMP
FROM workflow_instance_step_states ss
JOIN workflow_step_modules m
  ON m.workflow_id=ss.workflow_id AND m.step_id=ss.step_id AND m.is_active=1
WHERE ss.step_key='quotation';

INSERT OR IGNORE INTO workflow_instance_task_states(
  id,instance_module_state_id,module_task_id,task_key,name,task_type,sort_order,is_required,
  status,responsibility_position_code,instructions,completed_at,updated_at
)
SELECT lower(hex(randomblob(16))),ms.id,t.id,t.task_key,t.name,t.task_type,t.sort_order,t.is_required,
       ms.status,COALESCE(t.responsibility_position_code,ms.responsibility_position_code),t.instructions,
       CASE WHEN ms.status='completed' THEN CURRENT_TIMESTAMP ELSE NULL END,CURRENT_TIMESTAMP
FROM workflow_instance_module_states ms
JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
JOIN workflow_module_tasks t
  ON t.workflow_id=ss.workflow_id AND t.step_module_id=ms.step_module_id AND t.is_active=1
WHERE ss.step_key='quotation';

INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT lower(hex(randomblob(16))),wi.id,f.workflow_id,'quotation',
       COALESCE(f.module_code,'consignment'),f.field_key,f.label,f.field_type,
       f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,CURRENT_TIMESTAMP
FROM workflow_instances wi
JOIN workflow_steps s ON s.workflow_id=wi.workflow_id AND s.step_key='quotation'
JOIN workflow_step_fields f ON f.workflow_id=s.workflow_id AND f.step_id=s.id;

INSERT INTO workflow_history(
  id,instance_id,step_key,step_name,actor_user_id,source,metadata,occurred_at
)
SELECT lower(hex(randomblob(16))),wi.id,'quotation','询价报价',NULL,'system',
       '{"migration":"0111","historicalNodeAdded":true}',
       COALESCE(q.created_at,wi.started_at)
FROM workflow_instances wi
LEFT JOIN quotations q ON q.id=wi.quotation_id
WHERE EXISTS(
  SELECT 1 FROM workflow_steps s
  WHERE s.workflow_id=wi.workflow_id AND s.step_key='quotation' AND s.is_active=1
)
AND NOT EXISTS(
  SELECT 1 FROM workflow_history h WHERE h.instance_id=wi.id AND h.step_key='quotation'
);
