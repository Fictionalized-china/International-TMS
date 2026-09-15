PRAGMA foreign_keys = ON;

ALTER TABLE transport_batch_vehicles ADD COLUMN vehicle_type TEXT;

ALTER TABLE transport_exit_confirmations ADD COLUMN overseas_carrier_name TEXT;
ALTER TABLE transport_exit_confirmations ADD COLUMN overseas_vehicle_type TEXT;
ALTER TABLE transport_exit_confirmations ADD COLUMN overseas_driver_name TEXT;
ALTER TABLE transport_exit_confirmations ADD COLUMN overseas_driver_phone TEXT;

UPDATE workflow_steps
SET name = '国内运输',
    updated_at = datetime('now')
WHERE step_key = 'domestic_execution';

INSERT OR IGNORE INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:domestic_execution:carrier_name', o.id || ':tms-default', o.id || ':wf:domestic_execution',
       'carrier_name', '国内承运方', 'supplier', 1, 20, '国内段实际承运方，整车在运输安排录入，拼车在配载车辆录入', datetime('now'), datetime('now')
FROM organizations o;

INSERT OR IGNORE INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:domestic_execution:vehicle_type', o.id || ':tms-default', o.id || ':wf:domestic_execution',
       'vehicle_type', '国内车型', 'text', 0, 30, NULL, datetime('now'), datetime('now')
FROM organizations o;

INSERT OR IGNORE INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:domestic_execution:driver_name', o.id || ':tms-default', o.id || ':wf:domestic_execution',
       'driver_name', '国内司机姓名', 'driver', 1, 40, NULL, datetime('now'), datetime('now')
FROM organizations o;

INSERT OR IGNORE INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:domestic_execution:driver_phone', o.id || ':tms-default', o.id || ':wf:domestic_execution',
       'driver_phone', '国内司机手机号', 'text', 0, 50, NULL, datetime('now'), datetime('now')
FROM organizations o;

INSERT OR IGNORE INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:outbound_transport:overseas_carrier_name', o.id || ':tms-default', o.id || ':wf:outbound_transport',
       'overseas_carrier_name', '境外承运方', 'supplier', 0, 30, '出境后或换装后的境外运输承运方', datetime('now'), datetime('now')
FROM organizations o;

INSERT OR IGNORE INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:outbound_transport:overseas_vehicle_type', o.id || ':tms-default', o.id || ':wf:outbound_transport',
       'overseas_vehicle_type', '境外车型', 'text', 0, 40, NULL, datetime('now'), datetime('now')
FROM organizations o;

INSERT OR IGNORE INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:outbound_transport:overseas_vehicle_plate', o.id || ':tms-default', o.id || ':wf:outbound_transport',
       'overseas_vehicle_plate', '境外车牌', 'vehicle', 0, 50, NULL, datetime('now'), datetime('now')
FROM organizations o;

INSERT OR IGNORE INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:outbound_transport:overseas_driver_name', o.id || ':tms-default', o.id || ':wf:outbound_transport',
       'overseas_driver_name', '境外司机姓名', 'driver', 0, 60, NULL, datetime('now'), datetime('now')
FROM organizations o;

INSERT OR IGNORE INTO workflow_step_fields(id, workflow_id, step_id, field_key, label, field_type, is_required, sort_order, help_text, created_at, updated_at)
SELECT o.id || ':wff:outbound_transport:overseas_driver_phone', o.id || ':tms-default', o.id || ':wf:outbound_transport',
       'overseas_driver_phone', '境外司机手机号', 'text', 0, 70, NULL, datetime('now'), datetime('now')
FROM organizations o;
