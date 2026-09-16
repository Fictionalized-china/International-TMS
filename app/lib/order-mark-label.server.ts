import { env } from "cloudflare:workers";
import { buildOrderMarkLabelSvg, type OrderMark, type OrderMarkLabel } from "./order-mark-label";
import { orderMarkLabelAvailable } from "./order-mark-label-policy";
import { resolveMarkContactSnapshots } from "./mark-contacts";
export { buildOrderMarkLabelSvg, orderMarkLabelFacts } from "./order-mark-label";
export type { OrderMark, OrderMarkLabel } from "./order-mark-label";
export { orderMarkLabelAvailable } from "./order-mark-label-policy";

export async function loadActiveOrderMarksByOrder(
  organizationId: string,
  orderIds: string[],
) {
  const result = new Map<string, OrderMark[]>();
  if (!orderIds.length) return result;

  const placeholders = orderIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT order_id,id,package_code code,package_sequence sequence,label_revision revision
       FROM order_cargo_packages
      WHERE organization_id=? AND order_id IN (${placeholders})
        AND is_active=1 AND status!='cancelled'
      ORDER BY order_id,package_sequence`,
  ).bind(organizationId, ...orderIds).all<OrderMark & { order_id: string }>();

  for (const row of rows.results) {
    const marks = result.get(row.order_id) ?? [];
    marks.push({ id: row.id, code: row.code, sequence: row.sequence, revision: row.revision });
    result.set(row.order_id, marks);
  }
  return result;
}

export async function loadOrderMarkLabel(input: {
  organizationId: string;
  orderId: string;
  customerId?: string;
}) {
  const customerScope = input.customerId ? " AND o.customer_id=?" : "";
  const values = input.customerId
    ? [input.orderId, input.organizationId, input.customerId]
    : [input.orderId, input.organizationId];
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,
      COALESCE(NULLIF(TRIM(q.customer_contact_phone),''),NULLIF(TRIM(o.shipper_phone),''),NULLIF(TRIM(o.consignee_phone),'')) contact_phone,
      o.mark_contacts_snapshot_json,
      c.name customer_name,o.cargo_description,o.pieces,o.declared_quantity_unit,
      o.planned_inbound_package_count,o.planned_inbound_package_type,
      o.gross_weight_kg,o.volume_cbm,o.origin_country,o.origin_state,o.origin_city,
      o.destination_country,o.destination_state,o.destination_city,
      w.name overseas_warehouse_name,o.status,
      CASE
        WHEN q.accepted_at IS NOT NULL THEN q.accepted_at
        WHEN o.quotation_id IS NULL AND o.status IN ('confirmed','in_execution','completed') THEN o.created_at
        ELSE NULL
      END label_generated_at,o.quote_withdrawn,o.inbound_package_locked_at
     FROM transport_orders o
     JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
     LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
     LEFT JOIN warehouses w ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
     WHERE o.id=? AND o.organization_id=?${customerScope}`,
  )
    .bind(...values)
    .first<Omit<OrderMarkLabel,"marks"|"mark_contacts"> & { quote_withdrawn: number;mark_contacts_snapshot_json:string|null }>();
  if (!order) throw new Response("订单不存在", { status: 404 });
  if (!orderMarkLabelAvailable({
    status: order.status,
    acceptedAt: order.label_generated_at,
    quoteWithdrawn: order.quote_withdrawn,
  })) {
    throw new Response("客户接受报价后才会自动生成入仓唛头标签", { status: 409 });
  }
  const markContacts=resolveMarkContactSnapshots(order.mark_contacts_snapshot_json,{
    name:"业务联系",
    phone:order.contact_phone,
  });
  const marks=await env.DB.prepare(
    `SELECT id,package_code code,package_sequence sequence,label_revision revision
       FROM order_cargo_packages
      WHERE organization_id=? AND order_id=? AND is_active=1 AND status!='cancelled'
      ORDER BY package_sequence`,
  ).bind(input.organizationId,input.orderId).all<{id:string;code:string;sequence:number;revision:number}>();
  const {mark_contacts_snapshot_json:_,...labelOrder}=order;
  return { ...labelOrder,mark_contacts:markContacts,marks:marks.results };
}

export function orderMarkLabelDownload(order: OrderMarkLabel) {
  const svg = buildOrderMarkLabelSvg(order);
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFileName(order.order_number)}-mark-label.svg"`,
      "Cache-Control": "private, no-store",
    },
  });
}

function safeFileName(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}
