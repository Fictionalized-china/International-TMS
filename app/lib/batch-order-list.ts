export function ordinaryOrderBatchExclusionSql(orderAlias="o") {
  return `NOT EXISTS(
    SELECT 1 FROM transport_batch_orders ordinary_batch_order
    JOIN transport_batches ordinary_batch
      ON ordinary_batch.id=ordinary_batch_order.batch_id
     AND ordinary_batch.organization_id=ordinary_batch_order.organization_id
    WHERE ordinary_batch_order.organization_id=${orderAlias}.organization_id
      AND ordinary_batch_order.order_id=${orderAlias}.id
      AND ordinary_batch_order.status!='removed'
      AND ordinary_batch.batch_number LIKE 'PZ-%'
      AND ordinary_batch.status!='cancelled'
      AND ordinary_batch.road_status NOT IN ('cancelled','overseas_arrived','waiting_pickup','pickup_completed')
  )`;
}
