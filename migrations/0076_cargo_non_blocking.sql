-- 货物信息（cargo）从工作流必经节点改为常驻查看模块，不再阻断工作流推进
-- 与文件中心（documents）一致：is_required=0，但仍 enabled=1 可随时访问
UPDATE order_module_instances
   SET is_required = 0, updated_at = datetime('now')
 WHERE module_code = 'cargo';

-- 工作流模板中对应字段也不再强制必填
UPDATE workflow_step_fields
   SET is_required = 0, updated_at = datetime('now')
 WHERE module_code = 'cargo' AND field_key NOT LIKE 'document_%';

UPDATE workflow_instance_fields
   SET is_required = 0
 WHERE module_code = 'cargo' AND field_key NOT LIKE 'document_%';
