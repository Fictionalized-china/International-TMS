import { env } from "cloudflare:workers";
import { nextDocumentNumber } from "./documents.server";
import { recordWorkflowEvent } from "./business-workflow.server";

type ShipmentSourceOrder = {
  id: string;
  customer_id: string;
  origin_city: string;
};

export async function ensureShipmentForOrder(input: {
  organizationId: string;
  orderId: string;
  actorUserId?: string | null;
  request?: Request;
}) {
  const existing = await env.DB.prepare(
    "SELECT id,shipment_number FROM shipments WHERE organization_id=? AND order_id=? LIMIT 1",
  )
    .bind(input.organizationId, input.orderId)
    .first<{ id: string; shipment_number: string }>();
  if (existing) return existing;

  const order = await env.DB.prepare(
    "SELECT id,customer_id,origin_city FROM transport_orders WHERE id=? AND organization_id=?",
  )
    .bind(input.orderId, input.organizationId)
    .first<ShipmentSourceOrder>();
  if (!order) throw new Error("订单不存在，无法生成运单");

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const number = await nextDocumentNumber(input.organizationId, "shipment");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO shipments
       (id,organization_id,shipment_number,order_id,customer_id,current_location,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).bind(id, input.organizationId, number, order.id, order.customer_id, order.origin_city, now, now),
    env.DB.prepare(
      `INSERT INTO shipment_events
       (id,shipment_id,status,location,description,event_at,created_by_user_id,created_at)
       VALUES(?,?,'booked',?,'订单已创建，系统自动生成运单，等待后续执行',?,?,?)`,
    ).bind(crypto.randomUUID(), id, order.origin_city, now, input.actorUserId || null, now),
  ]);
  await recordWorkflowEvent({
    organizationId: input.organizationId,
    event: "shipment.created",
    customerId: order.customer_id,
    orderId: order.id,
    shipmentId: id,
    actorUserId: input.actorUserId || undefined,
    source: "admin",
    metadata: { number, autoCreated: true },
  });
  return { id, shipment_number: number };
}
