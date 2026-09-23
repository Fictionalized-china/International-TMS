export type ShipmentEventWrite = {
  id: string;
  shipmentId: string;
  status: string;
  location: string | null;
  description: string;
  eventAt: string;
  visibleToCustomer: number;
  actorUserId: string;
  createdAt: string;
};

/**
 * 将订单运踪写入客户门户共用的 shipment_events 数据源。
 * 自然键防重确保浏览器重试不会产生重复轨迹。
 */
export function insertShipmentEventIfMissing(
  db: D1Database,
  event: ShipmentEventWrite,
) {
  return db.prepare(
    `INSERT INTO shipment_events(
       id,shipment_id,status,location,description,event_at,
       visible_to_customer,created_by_user_id,created_at
     )
     SELECT ?,?,?,?,?,?,?,?,?
     WHERE NOT EXISTS(
       SELECT 1 FROM shipment_events
       WHERE shipment_id=? AND status=? AND description=? AND event_at=?
     )`,
  ).bind(
    event.id,
    event.shipmentId,
    event.status,
    event.location,
    event.description,
    event.eventAt,
    event.visibleToCustomer,
    event.actorUserId,
    event.createdAt,
    event.shipmentId,
    event.status,
    event.description,
    event.eventAt,
  );
}
