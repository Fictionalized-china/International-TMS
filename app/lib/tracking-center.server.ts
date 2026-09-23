import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { orderVisibilitySql } from "./order-access.server";
import { paginateList, readListPage } from "./list-pagination";
import { deriveTrackingCenterState, summarizeTrackingCenter } from "./tracking-center";

type TrackingCenterDbRow = {
  order_id: string;
  order_number: string;
  customer_name: string;
  business_type: string;
  order_status: string;
  is_overdue: number;
  exception_status: string;
  origin_city: string | null;
  destination_city: string | null;
  current_step_name: string | null;
  owner_name: string | null;
  assignment_id: string | null;
  assignment_carrier: string | null;
  assignment_plate: string | null;
  batch_id: string | null;
  batch_number: string | null;
  batch_road_status: string | null;
  batch_plate: string | null;
  planned_arrival_at: string | null;
  actual_arrival_at: string | null;
  latest_event: string | null;
  latest_event_at: string | null;
  latest_location: string | null;
  client_visible_event_count: number;
  client_latest_event_at: string | null;
};

export type TrackingCenterRow = TrackingCenterDbRow & ReturnType<typeof deriveTrackingCenterState>;

export async function loadTrackingCenter(request: Request, current: SessionUser) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("zh-CN");
  const warning = (url.searchParams.get("warning") ?? "").trim();
  const dispatch = (url.searchParams.get("dispatch") ?? "").trim();
  const businessType = (url.searchParams.get("businessType") ?? "").trim();
  const visibility = orderVisibilitySql(current, "o");
  const result = await env.DB.prepare(
    `SELECT o.id order_id,o.order_number,c.name customer_name,o.business_type,o.status order_status,
            o.is_overdue,o.exception_status,o.origin_city,o.destination_city,o.current_step_name,
            owner.display_name owner_name,
            a.id assignment_id,COALESCE(carrier.name,a.carrier_name) assignment_carrier,a.plate_number assignment_plate,
            b.id batch_id,b.batch_number,b.road_status batch_road_status,b.overseas_vehicle_plate batch_plate,
            COALESCE(b.planned_arrival_at,a.planned_arrival_at,s.estimated_delivery_at,o.requested_delivery_date) planned_arrival_at,
            COALESCE(b.actual_arrival_at,a.actual_arrival_at,s.actual_delivery_at) actual_arrival_at,
            (SELECT e.description FROM shipment_events e WHERE e.shipment_id=s.id ORDER BY e.event_at DESC,e.created_at DESC LIMIT 1) latest_event,
            (SELECT e.event_at FROM shipment_events e WHERE e.shipment_id=s.id ORDER BY e.event_at DESC,e.created_at DESC LIMIT 1) latest_event_at,
            (SELECT e.location FROM shipment_events e WHERE e.shipment_id=s.id ORDER BY e.event_at DESC,e.created_at DESC LIMIT 1) latest_location,
            COALESCE((SELECT COUNT(*) FROM shipment_events e WHERE e.shipment_id=s.id AND e.visible_to_customer=1),0) client_visible_event_count,
            (SELECT MAX(e.event_at) FROM shipment_events e WHERE e.shipment_id=s.id AND e.visible_to_customer=1) client_latest_event_at
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN users owner ON owner.id=o.current_assignee_user_id
       LEFT JOIN order_transport_assignments a ON a.id=(
         SELECT candidate.id FROM order_transport_assignments candidate
         WHERE candidate.organization_id=o.organization_id AND candidate.order_id=o.id AND candidate.status!='cancelled'
         ORDER BY candidate.updated_at DESC,candidate.created_at DESC LIMIT 1
       )
       LEFT JOIN carriers carrier ON carrier.id=a.carrier_id
       LEFT JOIN shipments s ON s.id=(
         SELECT candidate.id FROM shipments candidate
         WHERE candidate.organization_id=o.organization_id AND candidate.order_id=o.id
         ORDER BY candidate.updated_at DESC,candidate.created_at DESC LIMIT 1
       )
       LEFT JOIN transport_batches b ON b.id=(
         SELECT candidate.id FROM transport_batches candidate
         WHERE candidate.organization_id=o.organization_id AND candidate.status!='cancelled'
           AND (candidate.order_id=o.id OR EXISTS(
             SELECT 1 FROM transport_batch_orders member
             WHERE member.organization_id=o.organization_id AND member.batch_id=candidate.id
               AND member.order_id=o.id AND member.status!='removed'
           ))
         ORDER BY candidate.updated_at DESC,candidate.created_at DESC LIMIT 1
       )
      WHERE o.organization_id=? AND ${visibility.sql}
        AND o.status NOT IN ('draft','submitted','cancelled')
      ORDER BY o.is_overdue DESC,COALESCE(s.updated_at,o.workflow_updated_at,o.updated_at) DESC
      LIMIT 600`,
  ).bind(current.organizationId, ...visibility.values).all<TrackingCenterDbRow>();

  const now = new Date();
  const rows: TrackingCenterRow[] = result.results.map((row) => ({
    ...row,
    ...deriveTrackingCenterState({
      orderStatus: row.order_status,
      isOverdue: Boolean(row.is_overdue),
      exceptionStatus: row.exception_status,
      assignmentId: row.assignment_id,
      batchId: row.batch_id,
      batchRoadStatus: row.batch_road_status,
      plannedArrivalAt: row.planned_arrival_at,
      actualArrivalAt: row.actual_arrival_at,
      latestEventAt: row.latest_event_at,
    }, now),
  }));
  const filtered = rows.filter((row) => {
    if (warning === "attention" && !["overdue", "stale", "exception"].includes(row.warning.code)) return false;
    if (warning && warning !== "attention" && row.warning.code !== warning) return false;
    if (dispatch && row.dispatch.code !== dispatch) return false;
    if (businessType && row.business_type !== businessType) return false;
    if (!q) return true;
    return [
      row.order_number,
      row.customer_name,
      row.origin_city,
      row.destination_city,
      row.assignment_carrier,
      row.assignment_plate,
      row.batch_number,
      row.batch_plate,
      row.owner_name,
      row.latest_location,
    ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(q));
  });
  const pagination = paginateList(filtered, readListPage(url.searchParams));
  return {
    rows: pagination.items,
    pagination,
    summary: summarizeTrackingCenter(rows.map((row) => ({
      orderId: row.order_id,
      dispatch: row.dispatch,
      warning: row.warning,
    }))),
    filters: { q: url.searchParams.get("q") ?? "", warning, dispatch, businessType },
  };
}
