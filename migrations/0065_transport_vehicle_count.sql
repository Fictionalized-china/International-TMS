PRAGMA foreign_keys = ON;

ALTER TABLE order_transport_assignments ADD COLUMN vehicle_count INTEGER NOT NULL DEFAULT 1
  CHECK(vehicle_count > 0);

INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
  sort_order,options_text,help_text,module_code,created_at,updated_at
)
SELECT w.id || ':catalog:transport:domestic_vehicle_count',w.id,s.id,
       'domestic_vehicle_count','车辆数目','number',0,1,175,NULL,
       '本次国内运输安排使用的车辆数量。','transport',datetime('now'),datetime('now')
FROM workflow_definitions w
JOIN workflow_steps s ON s.workflow_id=w.id AND s.step_key='domestic_execution';

INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT wi.id || ':catalog:transport:domestic_vehicle_count',wi.id,wi.workflow_id,
       'domestic_execution','transport','domestic_vehicle_count','车辆数目','number',
       0,1,175,NULL,'本次国内运输安排使用的车辆数量。',datetime('now')
FROM workflow_instances wi
JOIN workflow_steps s ON s.workflow_id=wi.workflow_id AND s.step_key='domestic_execution';
