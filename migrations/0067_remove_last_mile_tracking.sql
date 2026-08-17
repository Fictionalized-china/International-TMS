-- 新业务在境外目的仓交付客户自提，不提供目的仓后的配送服务。
UPDATE order_tracking_milestones
SET milestone_code = 'station_arrived',
    milestone_name = '到达境外目的仓'
WHERE milestone_code = 'overseas_arrived';

UPDATE order_module_instances
SET current_step_code = 'arrived',
    current_step_name = '到达境外目的仓'
WHERE module_code = 'tracking'
  AND current_step_code = 'delivery';

UPDATE order_module_instances
SET current_step_code = 'waiting',
    current_step_name = '等待到达出境口岸'
WHERE module_code = 'tracking'
  AND current_step_code = 'departed';

DELETE FROM order_services
WHERE service_code = 'delivery';

UPDATE shipments
SET status = 'in_transit'
WHERE status = 'out_for_delivery';

UPDATE shipment_events
SET status = 'in_transit'
WHERE status = 'out_for_delivery';
