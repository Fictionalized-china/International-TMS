import type { SessionUser } from "./auth.server";
import { orderVisibilitySql } from "./order-access";
import { readListPage } from "./list-pagination";
import { warehouseRelatedOrderSql } from "./warehouse-related-order";

type TrackingOrder = { id: string; order_number: string; customer_name: string; cargo_description: string; origin_city: string; destination_city: string; current_step_name: string | null; status: string };
export type ReadOnlyTrackingEvent = { id: string; shipment_number: string; status: string; location: string | null; description: string; event_at: string; visible_to_customer: number };
export async function loadOrderTrackingReadView(db: D1Database, current: SessionUser, params: URLSearchParams, warehouse?: { id: string; warehouse_role: string }) {
  if (!current.permissions.includes(warehouse ? "warehouse.view" : "order.view")) throw new Response("没有运踪查看权限", { status: 403 });
  const scope = warehouse ? warehouseRelatedOrderSql(warehouse.id, warehouse.warehouse_role) : orderVisibilitySql(current, "o");
  const q = (params.get("q") ?? "").trim().slice(0, 200), pattern = `%${q}%`;
  const where = `o.organization_id=? AND ${scope.sql}`;
  const search = "(?='' OR o.order_number LIKE ? OR o.cargo_description LIKE ? OR c.name LIKE ?)";
  const binds = [current.organizationId, ...scope.values], searchBinds = [q, pattern, pattern, pattern];
  const total = Number((await db.prepare(`SELECT COUNT(*) n FROM transport_orders o JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id WHERE ${where} AND ${search}`).bind(...binds, ...searchBinds).first<{ n: number }>())?.n ?? 0);
  const pageSize = 20, pageCount = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(readListPage(params), pageCount);
  const columns = "o.id,o.order_number,c.name customer_name,o.cargo_description,o.origin_city,o.destination_city,o.current_step_name,o.status";
  const items = (await db.prepare(`SELECT ${columns} FROM transport_orders o JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id WHERE ${where} AND ${search} ORDER BY o.created_at DESC,o.id LIMIT ? OFFSET ?`).bind(...binds, ...searchBinds, pageSize, (page - 1) * pageSize).all<TrackingOrder>()).results;
  const requestedId = params.get("orderId");
  const selected = requestedId ? await db.prepare(`SELECT ${columns} FROM transport_orders o JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id WHERE ${where} AND o.id=?`).bind(...binds, requestedId).first<TrackingOrder>() : items[0] ?? null;
  if (requestedId && !selected) throw new Response("订单不存在或不在当前授权范围", { status: 404 });
  const eventTotal = selected ? Number((await db.prepare("SELECT COUNT(*) n FROM shipment_events e JOIN shipments s ON s.id=e.shipment_id WHERE s.organization_id=? AND s.order_id=?").bind(current.organizationId, selected.id).first<{ n: number }>())?.n ?? 0) : 0;
  const eventPageSize = 50, eventPageCount = Math.max(1, Math.ceil(eventTotal / eventPageSize)), eventPage = Math.min(readListPage(params, "eventsPage"), eventPageCount);
  const events = selected ? (await db.prepare(`SELECT e.id,s.shipment_number,e.status,e.location,e.description,e.event_at,e.visible_to_customer FROM shipment_events e JOIN shipments s ON s.id=e.shipment_id
    WHERE s.organization_id=? AND s.order_id=? ORDER BY REPLACE(e.event_at,'T',' ') DESC,e.created_at DESC,e.id LIMIT ? OFFSET ?`).bind(current.organizationId, selected.id, eventPageSize, (eventPage - 1) * eventPageSize).all<ReadOnlyTrackingEvent>()).results : [];
  return { q, selected, events, pagination: { items, total, page, pageSize, pageCount }, eventPagination: { total: eventTotal, page: eventPage, pageSize: eventPageSize, pageCount: eventPageCount } };
}
export type OrderTrackingReadView = Awaited<ReturnType<typeof loadOrderTrackingReadView>>;
