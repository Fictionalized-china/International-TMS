-- 运输安排只负责发运前的承运资源与计划，不再与实际运输执行混用。
UPDATE order_module_instances
SET current_step_name = '安排完成', updated_at = datetime('now')
WHERE module_code = 'transport'
  AND current_step_code = 'completed'
  AND current_step_name <> '安排完成';
