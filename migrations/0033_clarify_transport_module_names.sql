-- “运输安排”发生在发运前；实际“运输执行与跟踪”必须位于配载/直装和装车出库之后。
UPDATE order_module_instances
SET module_name = '运输安排', updated_at = datetime('now')
WHERE module_code = 'transport' AND module_name <> '运输安排';

UPDATE order_module_instances
SET module_name = '运输执行与跟踪', updated_at = datetime('now')
WHERE module_code = 'tracking' AND module_name <> '运输执行与跟踪';
