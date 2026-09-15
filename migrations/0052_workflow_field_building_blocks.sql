PRAGMA foreign_keys = ON;

ALTER TABLE workflow_step_fields ADD COLUMN module_code TEXT;

CREATE INDEX IF NOT EXISTS idx_workflow_step_fields_module
  ON workflow_step_fields(workflow_id,module_code,is_active,sort_order);

CREATE TABLE workflow_instance_fields (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  module_code TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  is_required INTEGER NOT NULL DEFAULT 0 CHECK(is_required IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 10,
  options_text TEXT,
  help_text TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(instance_id,step_key,module_code,field_key)
);

CREATE INDEX idx_workflow_instance_fields_instance
  ON workflow_instance_fields(instance_id,module_code,is_active,sort_order);

CREATE TABLE order_custom_workflow_field_values (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  field_instance_id TEXT NOT NULL REFERENCES workflow_instance_fields(id) ON DELETE CASCADE,
  value_text TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_id,field_instance_id)
);

CREATE INDEX idx_order_custom_workflow_values
  ON order_custom_workflow_field_values(organization_id,order_id,field_instance_id);

UPDATE workflow_step_fields
SET module_code=CASE
  WHEN field_key IN ('customer_reference','pickup_address','pickup_contact','pickup_time','overseas_warehouse') THEN 'consignment'
  WHEN field_key='operator' THEN 'assignment'
  WHEN field_key IN ('actual_pickup_at','vehicle_plate') THEN 'transport'
  WHEN field_key='loading_batch' THEN 'loading'
  WHEN field_key IN ('actual_exit_at','exit_port') THEN 'tracking'
  WHEN field_key='arrival_at' THEN 'overseas_warehouse'
  WHEN field_key='statement' THEN 'costs'
  WHEN field_key='review_result' THEN 'review'
  ELSE module_code
END
WHERE module_code IS NULL;

UPDATE workflow_step_fields
SET is_active=0,is_required=0,updated_at=datetime('now')
WHERE field_key='customer_reference';

INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT lower(hex(randomblob(16))),wi.id,wi.workflow_id,ws.step_key,
       COALESCE(f.module_code,'consignment'),f.field_key,f.label,f.field_type,
       f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,datetime('now')
FROM workflow_instances wi
JOIN workflow_steps ws ON ws.workflow_id=wi.workflow_id
JOIN workflow_step_fields f ON f.workflow_id=wi.workflow_id AND f.step_id=ws.id;

INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('workflow.field.manage','workflow','配置业务字段','配置工作流节点与模块的字段显示、选填和必填状态');

INSERT INTO positions(id,organization_id,code,name,department_code,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'DEVELOPER','开发者','ZJB','active',2,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM positions p WHERE p.organization_id=o.id AND p.code='DEVELOPER'
);

INSERT INTO roles(id,organization_id,code,name,description,is_system,created_at,updated_at)
SELECT lower(hex(randomblob(16))),o.id,'developer','开发者','维护业务工作流、字段积木与系统配置',1,datetime('now'),datetime('now')
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.organization_id=o.id AND r.code='developer'
);

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code
FROM roles r
JOIN permissions p
WHERE r.code IN ('boss','developer','owner')
  AND p.code IN ('workflow.view','workflow.manage','workflow.field.manage');
