PRAGMA foreign_keys = ON;

ALTER TABLE order_transport_assignments ADD COLUMN loading_mode TEXT
  CHECK(loading_mode IS NULL OR loading_mode IN ('ftl','ltl'));

INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
  sort_order,options_text,help_text,module_code,created_at,updated_at
)
SELECT w.id || ':catalog:transport:domestic_loading_mode',w.id,s.id,
       'domestic_loading_mode','装车方式','select',0,1,185,
       'ftl|整车' || char(10) || 'ltl|拼车',
       '国内运输安排采用整车或拼车装车。','transport',datetime('now'),datetime('now')
FROM workflow_definitions w
JOIN workflow_steps s ON s.workflow_id=w.id AND s.step_key='domestic_execution';

INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT wi.id || ':catalog:transport:domestic_loading_mode',wi.id,wi.workflow_id,
       'domestic_execution','transport','domestic_loading_mode','装车方式','select',
       0,1,185,'ftl|整车' || char(10) || 'ltl|拼车',
       '国内运输安排采用整车或拼车装车。',datetime('now')
FROM workflow_instances wi
JOIN workflow_steps s ON s.workflow_id=wi.workflow_id AND s.step_key='domestic_execution';
