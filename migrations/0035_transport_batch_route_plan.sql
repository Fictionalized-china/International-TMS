-- 配载批次生成后才确定实际口岸、中转路径和路线说明；订单起讫地继续作为只读主数据继承。
ALTER TABLE transport_batches ADD COLUMN border_port TEXT;
ALTER TABLE transport_batches ADD COLUMN transit_location TEXT;
ALTER TABLE transport_batches ADD COLUMN route_notes TEXT;

UPDATE transport_batches
SET border_port = (
      SELECT o.exit_port FROM transport_orders o WHERE o.id = transport_batches.order_id
    ),
    transit_location = (
      SELECT o.transit_locations FROM transport_orders o WHERE o.id = transport_batches.order_id
    )
WHERE border_port IS NULL AND transit_location IS NULL;
