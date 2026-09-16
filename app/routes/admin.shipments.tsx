import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.shipments";
import { OrderNumberLink } from "../components/EntityNumberLink";
import { OrderRouteFilterFields } from "../components/OrderRouteFilterFields";
import { ActionToast } from "../components/ActionToast";
import { TransportExecutionTabs } from "../components/TransportExecutionTabs";
import { requireSessionUser } from "../lib/auth.server";
import { nextDocumentNumber } from "../lib/documents.server";
import { canTransition, nextStates } from "../lib/workflow";
import { validateCode, validateEmail, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { recordWorkflowEvent } from "../lib/business-workflow.server";
import { statusLabel as orderStatusLabel } from "../lib/order-workflow";
import { loadOrderGuidance } from "../lib/order-guidance.server";
import { canOperateCurrentOrder, currentOrderActionSql, orderVisibilitySql, requireOrderAccess } from "../lib/order-access.server";
import { orderRouteFilterCount, readOrderRouteFilters, type OrderRouteFilters } from "../lib/order-route-filters";
import { duplicateOrDatabaseError } from "../lib/db-errors.server";

type Shipment = {
  id: string;
  shipment_number: string;
  master_tracking_number: string | null;
  order_id: string;
  order_number: string;
  customer_name: string;
  customer_code: string;
  status: string;
  current_location: string | null;
  estimated_delivery_at: string | null;
  actual_pickup_at: string | null;
  actual_delivery_at: string | null;
  signed_by: string | null;
  exception_reason: string | null;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  transport_mode: string;
  business_type: string;
  service_level: string | null;
  order_source: string;
  order_creator_name: string | null;
  order_created_at: string;
  order_status: string;
  current_assignee_user_id: string | null;
  order_current_step_name: string | null;
  order_workflow_updated_at: string | null;
  order_is_overdue: number;
  order_exception_status: string | null;
  workflow_module_count: number;
  workflow_completed_module_count: number;
  workflow_progress_percent: number;
  workflow_current_module: string | null;
  created_at: string;
  updated_at: string;
  latest_event_description: string | null;
  latest_event_at: string | null;
  carriers: string | null;
  domestic_transport_resources: string | null;
  overseas_transport_resources: string | null;
  next_stage: string;
  next_action: string;
  next_owner: string;
  next_blocker: string | null;
  next_href: string;
};

type ShipmentFilters = OrderRouteFilters & {
  q: string;
  handlingScope: string;
  status: string;
  workflowStatus: string;
  source: string;
  creator: string;
  dateFrom: string;
  dateTo: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "shipment.view");
  const url = new URL(request.url);
  const pageSize = 10;
  const requestedPage = Math.max(1, Number(url.searchParams.get("page") || 1));
  const filters: ShipmentFilters = {
    q: (url.searchParams.get("q") || "").trim(),
    handlingScope: url.searchParams.get("handlingScope") === "mine" ? "mine" : "",
    status: url.searchParams.get("status") || "",
    workflowStatus: url.searchParams.get("workflowStatus") || "",
    source: url.searchParams.get("source") || "",
    creator: url.searchParams.get("creator") || "",
    dateFrom: url.searchParams.get("dateFrom") || "",
    dateTo: url.searchParams.get("dateTo") || "",
    ...readOrderRouteFilters(url.searchParams),
  };
  const where = ["s.organization_id = ?"];
  const bindings: Array<string | number> = [current.organizationId];
  const visibility = orderVisibilitySql(current, "o");
  where.push(visibility.sql);
  bindings.push(...visibility.values);
  if (filters.handlingScope === "mine") {
    const actionable = currentOrderActionSql(current, "o");
    where.push(actionable.sql);
    bindings.push(...actionable.values);
  }
  if (filters.q) {
    where.push(`(s.shipment_number LIKE ? OR s.master_tracking_number LIKE ? OR o.order_number LIKE ? OR c.name LIKE ? OR c.identity_code LIKE ? OR o.cargo_description LIKE ? OR s.current_location LIKE ? OR o.current_step_name LIKE ?)`);
    const keyword = `%${filters.q}%`;
    bindings.push(keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword);
  }
  if (filters.status) {
    where.push("s.status = ?");
    bindings.push(filters.status);
  }
  if (filters.workflowStatus) {
    where.push("o.status = ?");
    bindings.push(filters.workflowStatus);
  }
  if (filters.source) {
    where.push("o.source = ?");
    bindings.push(filters.source);
  }
  if (filters.creator) {
    where.push("o.created_by_user_id = ?");
    bindings.push(filters.creator);
  }
  if (filters.dateFrom) {
    where.push("substr(o.created_at, 1, 10) >= ?");
    bindings.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push("substr(o.created_at, 1, 10) <= ?");
    bindings.push(filters.dateTo);
  }
  if (filters.origin) {
    const pattern = `%${filters.origin}%`;
    where.push("(o.origin_country LIKE ? OR o.origin_state LIKE ? OR o.origin_city LIKE ? OR o.origin_address LIKE ?)");
    bindings.push(pattern, pattern, pattern, pattern);
  }
  if (filters.exitPort) {
    const pattern = `%${filters.exitPort}%`;
    where.push("(o.exit_port LIKE ? OR EXISTS (SELECT 1 FROM reference_data route_port WHERE route_port.organization_id=o.organization_id AND route_port.category='border_port' AND route_port.code=o.exit_port AND route_port.name LIKE ?))");
    bindings.push(pattern, pattern);
  }
  if (filters.destination) {
    const pattern = `%${filters.destination}%`;
    where.push("(o.destination_country LIKE ? OR o.destination_state LIKE ? OR o.destination_city LIKE ? OR o.destination_address LIKE ? OR EXISTS (SELECT 1 FROM warehouses route_warehouse WHERE route_warehouse.organization_id=o.organization_id AND route_warehouse.id=o.overseas_warehouse_id AND route_warehouse.name LIKE ?))");
    bindings.push(pattern, pattern, pattern, pattern, pattern);
  }
  const whereSql = where.join(" AND ");
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) total FROM shipments s JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id WHERE ${whereSql}`).bind(...bindings).first<{total:number}>();
  const total = Number(totalRow?.total || 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pages);
  const offset = (page - 1) * pageSize;
  const [shipments, orders, carriers, creators] = await Promise.all([
    env.DB.prepare(`SELECT
      s.id,s.shipment_number,s.master_tracking_number,s.order_id,o.order_number,c.name customer_name,c.identity_code customer_code,
      s.status,s.current_location,s.estimated_delivery_at,s.actual_pickup_at,s.actual_delivery_at,s.signed_by,s.exception_reason,
      o.origin_country,o.origin_state,o.origin_city,o.destination_country,o.destination_state,o.destination_city,
      o.cargo_description,o.pieces,o.gross_weight_kg,o.volume_cbm,o.transport_mode,o.business_type,o.service_level,
      o.source order_source,creator.display_name order_creator_name,o.created_at order_created_at,
      o.status order_status,o.current_assignee_user_id,o.current_step_name order_current_step_name,o.workflow_updated_at order_workflow_updated_at,
      o.is_overdue order_is_overdue,o.exception_status order_exception_status,
      (SELECT COUNT(*) FROM order_module_instances m
        WHERE m.order_id=o.id AND m.organization_id=o.organization_id AND m.enabled=1
          AND (m.is_required=1 OR m.status NOT IN ('not_started','not_applicable'))) workflow_module_count,
      (SELECT COUNT(*) FROM order_module_instances m
        WHERE m.order_id=o.id AND m.organization_id=o.organization_id AND m.enabled=1 AND m.status='completed'
          AND (m.is_required=1 OR m.status NOT IN ('not_started','not_applicable'))) workflow_completed_module_count,
      COALESCE((SELECT CAST(ROUND(AVG(m.progress_percent)) AS INTEGER) FROM order_module_instances m
        WHERE m.order_id=o.id AND m.organization_id=o.organization_id AND m.enabled=1
          AND (m.is_required=1 OR m.status NOT IN ('not_started','not_applicable'))),0) workflow_progress_percent,
      (SELECT m.module_name || CASE WHEN m.current_step_name IS NOT NULL AND m.current_step_name!='' THEN ' · ' || m.current_step_name ELSE '' END
        FROM order_module_instances m
        WHERE m.order_id=o.id AND m.organization_id=o.organization_id AND m.enabled=1 AND m.status!='completed'
          AND (m.is_required=1 OR m.status NOT IN ('not_started','not_applicable'))
        ORDER BY CASE m.module_code
          WHEN 'consignment' THEN 1 WHEN 'cargo' THEN 2 WHEN 'assignment' THEN 3 WHEN 'transport' THEN 4
          WHEN 'warehouse' THEN 5 WHEN 'documents' THEN 6 WHEN 'customs' THEN 7 WHEN 'loading' THEN 8
          WHEN 'tracking' THEN 9 WHEN 'overseas_warehouse' THEN 10 WHEN 'costs' THEN 11
          WHEN 'exceptions' THEN 12 WHEN 'review' THEN 13 ELSE 99 END LIMIT 1) workflow_current_module,
      s.created_at,s.updated_at,
      (SELECT e.description FROM shipment_events e WHERE e.shipment_id=s.id ORDER BY e.event_at DESC LIMIT 1) latest_event_description,
      (SELECT e.event_at FROM shipment_events e WHERE e.shipment_id=s.id ORDER BY e.event_at DESC LIMIT 1) latest_event_at,
      (SELECT GROUP_CONCAT(DISTINCT carrier.name) FROM shipment_legs leg JOIN carriers carrier ON carrier.id=leg.carrier_id WHERE leg.shipment_id=s.id) carriers,
      COALESCE(
        (SELECT GROUP_CONCAT(DISTINCT
          COALESCE(NULLIF(TRIM(COALESCE(ac.name,a.carrier_name,'')),''),'承运方待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(a.vehicle_type,'')),''),'车型待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(a.plate_number,'')),''),'车牌待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(a.driver_name,'')),''),'司机待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(a.driver_phone,'')),''),'电话待定')
        ) FROM order_transport_assignments a LEFT JOIN carriers ac ON ac.id=a.carrier_id WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.leg_type='first_mile' AND a.status!='cancelled'),
        (SELECT GROUP_CONCAT(DISTINCT
          COALESCE(NULLIF(TRIM(COALESCE(vc.name,bc.name,'')),''),'承运方待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(v.vehicle_type,'')),''),'车型待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(v.plate_number,'')),''),'车牌待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(v.driver_name,'')),''),'司机待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(v.driver_phone,'')),''),'电话待定')
        )
         FROM transport_batch_orders bo
         JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id AND b.status!='cancelled'
         JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled'
         LEFT JOIN carriers vc ON vc.id=v.carrier_id
         LEFT JOIN carriers bc ON bc.id=b.carrier_id
         WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed'
           AND (
             EXISTS(
               SELECT 1 FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id
               WHERE l.batch_id=b.id AND l.vehicle_id=v.id AND p.order_id=o.id AND p.status!='cancelled'
             )
             OR NOT EXISTS(
               SELECT 1 FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id
               WHERE l.batch_id=b.id AND p.order_id=o.id AND p.status!='cancelled'
             )
           )
        )
      ) domestic_transport_resources,
      COALESCE(
        (SELECT GROUP_CONCAT(DISTINCT
          COALESCE(NULLIF(TRIM(COALESCE(ac.name,a.carrier_name,'')),''),'境外承运方待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(a.vehicle_type,'')),''),'车型待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(a.plate_number,'')),''),'车牌待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(a.driver_name,'')),''),'司机待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(a.driver_phone,'')),''),'电话待定')
        ) FROM order_transport_assignments a LEFT JOIN carriers ac ON ac.id=a.carrier_id WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.leg_type='main' AND a.status!='cancelled'),
        (SELECT GROUP_CONCAT(DISTINCT
          COALESCE(NULLIF(TRIM(COALESCE(x.overseas_carrier_name,bc.name,'')),''),'境外承运方待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(x.overseas_vehicle_type,'')),''),'车型待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(x.overseas_vehicle_plate,x.exit_vehicle_plate,'')),''),'车牌待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(x.overseas_driver_name,'')),''),'司机待定') || ' · ' ||
          COALESCE(NULLIF(TRIM(COALESCE(x.overseas_driver_phone,'')),''),'电话待定')
        )
         FROM transport_batch_orders bo
         JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id AND b.status!='cancelled'
         JOIN transport_exit_confirmations x ON x.batch_id=b.id AND x.organization_id=b.organization_id
         LEFT JOIN carriers bc ON bc.id=b.carrier_id
         WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed'
        )
      ) overseas_transport_resources
      FROM shipments s
      JOIN transport_orders o ON o.id=s.order_id
      JOIN customers c ON c.id=s.customer_id
      LEFT JOIN users creator ON creator.id=o.created_by_user_id
      WHERE ${whereSql}
      ORDER BY s.updated_at DESC,s.created_at DESC LIMIT ? OFFSET ?`).bind(...bindings,pageSize,offset).all<Shipment>(),
    env.DB.prepare(`SELECT o.id, o.order_number, c.name AS customer_name FROM transport_orders o JOIN customers c ON c.id = o.customer_id WHERE o.organization_id = ? AND ${visibility.sql} AND o.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id) ORDER BY o.confirmed_at DESC`).bind(current.organizationId,...visibility.values).all<{ id: string; order_number: string; customer_name: string }>(),
    env.DB.prepare("SELECT id, code, name, status FROM carriers WHERE organization_id = ? ORDER BY name").bind(current.organizationId).all<{ id: string; code: string; name: string; status: string }>(),
    env.DB.prepare(`SELECT DISTINCT u.id,u.display_name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=? AND m.status='active' ORDER BY u.display_name`).bind(current.organizationId).all<{id:string;display_name:string}>(),
  ]);
  const guidanceByOrder = await loadOrderGuidance(
    env.DB,
    current.organizationId,
    shipments.results.map((shipment) => ({
      id: shipment.order_id,
      status: shipment.order_status,
    })),
  );
  const shipmentRows = shipments.results.map((shipment) => {
    const guidance = guidanceByOrder.get(shipment.order_id)!;
    return {
      ...shipment,
      can_operate_current_node: canOperateCurrentOrder(current, shipment),
      next_stage: guidance.stage.shortTitle,
      next_action: guidance.action,
      next_owner: guidance.owner,
      next_blocker: guidance.blocker,
      next_href: guidance.href,
    };
  });
  return { current, shipments: shipmentRows, orders: orders.results, carriers: carriers.results, creators: creators.results, filters, total, page, pages, pageSize };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "shipment.manage");
  const form = await request.formData(), intent = valueOf(form, "intent"), now = new Date().toISOString();
  if (intent === "carrier") {
    const code = valueOf(form, "code").toLowerCase(), name = valueOf(form, "name"), scac = valueOf(form, "scac").toUpperCase(), contactName = valueOf(form, "contactName"), phone = valueOf(form, "phone"), email = valueOf(form, "email").toLowerCase();
    if (validateCode(code) || name.length < 2 || (email && validateEmail(email))) return { formError: "请填写有效承运商代码、名称和邮箱" };
    const id = crypto.randomUUID();
    try { await env.DB.prepare("INSERT INTO carriers (id, organization_id, code, name, scac, contact_name, contact_phone, contact_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, current.organizationId, code, name, scac || null, contactName || null, phone || null, email || null, now, now).run(); } catch (error) { return { formError: duplicateOrDatabaseError(error, "承运商代码不能重复") }; }
    await writeAudit({ request, action: "carrier.create", resourceType: "carrier", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { code } });
    return { success: "承运商已创建" };
  }
  if (intent === "create") {
    const orderId = valueOf(form, "orderId"), tracking = valueOf(form, "tracking"), eta = valueOf(form, "eta");
    await requireOrderAccess(current, orderId);
    const order = await env.DB.prepare("SELECT customer_id, origin_city FROM transport_orders WHERE id = ? AND organization_id = ? AND status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM shipments WHERE order_id = transport_orders.id)").bind(orderId, current.organizationId).first<{ customer_id: string; origin_city: string }>();
    if (!order) return { formError: "订单无效、未确认或已生成运单" };
    const id = crypto.randomUUID(), number = await nextDocumentNumber(current.organizationId, "shipment");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO shipments (id, organization_id, shipment_number, order_id, customer_id, master_tracking_number, current_location, estimated_delivery_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, current.organizationId, number, orderId, order.customer_id, tracking || null, order.origin_city, eta || null, now, now),
      env.DB.prepare("INSERT INTO shipment_events (id, shipment_id, status, location, description, event_at, created_by_user_id, created_at) VALUES (?, ?, 'booked', ?, '运单已创建，等待提货', ?, ?, ?)").bind(crypto.randomUUID(), id, order.origin_city, now, current.userId, now),
      env.DB.prepare("UPDATE transport_orders SET status = 'in_execution', updated_at = ? WHERE id = ? AND organization_id = ?").bind(now, orderId, current.organizationId),
    ]);
    await recordWorkflowEvent({organizationId:current.organizationId,event:"shipment.created",customerId:order.customer_id,orderId,shipmentId:id,actorUserId:current.userId,source:"admin",metadata:{number}});
    await writeAudit({ request, action: "shipment.create", resourceType: "shipment", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { number, orderId } });
    return { success: `运单 ${number} 已创建` };
  }
  if (intent === "leg") {
    const shipmentId = valueOf(form, "shipmentId"), carrierId = valueOf(form, "carrierId"), origin = valueOf(form, "origin"), destination = valueOf(form, "destination"), departure = valueOf(form, "departure"), arrival = valueOf(form, "arrival"), reference = valueOf(form, "reference");
    const owned = await ownedShipment(shipmentId, current.organizationId);
    if (!owned || !origin || !destination) return { formError: "运单或运输分段信息无效" };
    await requireOrderAccess(current, owned.order_id);
    if (carrierId && !(await env.DB.prepare("SELECT 1 FROM carriers WHERE id = ? AND organization_id = ? AND status = 'active'").bind(carrierId, current.organizationId).first())) return { formError: "承运商无效" };
    const row = await env.DB.prepare("SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence_no FROM shipment_legs WHERE shipment_id = ?").bind(shipmentId).first<{ sequence_no: number }>();
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO shipment_legs (id, shipment_id, sequence_no, carrier_id, carrier_reference, origin_location, destination_location, planned_departure_at, planned_arrival_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, shipmentId, row?.sequence_no ?? 1, carrierId || null, reference || null, origin, destination, departure || null, arrival || null, now, now).run();
    await writeAudit({ request, action: "shipment.leg.create", resourceType: "shipment_leg", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { shipmentId } });
    return { success: "运输分段已添加" };
  }
  const id = valueOf(form, "id"), status = valueOf(form, "status"), location = valueOf(form, "location"), description = valueOf(form, "description"), eventAt = valueOf(form, "eventAt") || now, signedBy = valueOf(form, "signedBy"), exceptionReason = valueOf(form, "exceptionReason");
  const shipment = await env.DB.prepare("SELECT status, order_id, customer_id FROM shipments WHERE id = ? AND organization_id = ?").bind(id, current.organizationId).first<{ status: string; order_id: string; customer_id:string }>();
  if (!shipment || !canTransition("shipment", shipment.status, status) || !description) return { formError: "运单状态流转或轨迹说明无效" };
  await requireOrderAccess(current, shipment.order_id);
  const statements = [
    env.DB.prepare(`UPDATE shipments SET status = ?, current_location = COALESCE(NULLIF(?, ''), current_location), actual_pickup_at = CASE WHEN ? = 'picked_up' THEN ? ELSE actual_pickup_at END, actual_delivery_at = CASE WHEN ? = 'delivered' THEN ? ELSE actual_delivery_at END, signed_by = CASE WHEN ? = 'delivered' THEN ? ELSE signed_by END, exception_reason = CASE WHEN ? = 'exception' THEN ? ELSE exception_reason END, updated_at = ? WHERE id = ? AND organization_id = ?`).bind(status, location, status, eventAt, status, eventAt, status, signedBy || null, status, exceptionReason || description, now, id, current.organizationId),
    env.DB.prepare("INSERT INTO shipment_events (id, shipment_id, status, location, description, event_at, visible_to_customer, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, status, location || null, description, eventAt, form.has("internal") ? 0 : 1, current.userId, now),
  ];
  await env.DB.batch(statements);
  if (["picked_up","in_transit","delivered"].includes(status)) await recordWorkflowEvent({organizationId:current.organizationId,event:`shipment.${status}` as "shipment.picked_up"|"shipment.in_transit"|"shipment.delivered",customerId:shipment.customer_id,orderId:shipment.order_id,shipmentId:id,actorUserId:current.userId,source:"admin",metadata:{location,description}});
  await writeAudit({ request, action: "shipment.status", resourceType: "shipment", resourceId: id, organizationId: current.organizationId, actorUserId: current.userId, metadata: { from: shipment.status, to: status } });
  return { success: "运单状态与轨迹已更新" };
}
async function ownedShipment(id: string, org: string) { return env.DB.prepare("SELECT order_id FROM shipments WHERE id = ? AND organization_id = ?").bind(id, org).first<{order_id:string}>(); }
export function meta() { return [{ title: "运输单据 | International TMS" }]; }
const labels: Record<string,string> = { booked:"已订舱", picked_up:"已提货", in_transit:"运输中", customs:"清关中", out_for_delivery:"运输中", delivered:"已签收", exception:"异常", cancelled:"已取消" };
const businessTypeLabels: Record<string,string> = { ltl:"零担/拼车", ftl:"整车", warehouse:"仓到仓" };
const orderWorkflowStatuses = ["draft","submitted","confirmed","in_execution","completed","cancelled"];

export default function Shipments({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const manage = loaderData.current.permissions.includes("shipment.manage");
  const advancedFilterCount = orderRouteFilterCount(loaderData.filters)
    + [loaderData.filters.workflowStatus, loaderData.filters.source, loaderData.filters.creator, loaderData.filters.dateFrom, loaderData.filters.dateTo].filter(Boolean).length;
  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">SHIPMENT REGISTER</p>
        <h1>运输单据</h1>
        <p>订单中心承载业务全流程；这里集中查看实际生成的运单、运输资源与轨迹。</p>
      </div>
      <span className="status-pill">共 {loaderData.total} 票</span>
    </header>
    <TransportExecutionTabs />
    <ActionToast data={actionData} />
    <section className="panel shipment-register">
      <div className="panel-header shipment-register-header">
        <div>
          <h2>运单台账</h2>
          <p>先筛选目标运单，再进入订单详情或展开运单操作。</p>
        </div>
      </div>
      <div className="shipment-filter-shell">
        <Form method="get" action="." className="shipment-filters">
          <input name="q" defaultValue={loaderData.filters.q} placeholder="运单号、订单号、客户、识别码、货物、位置"/>
          <select name="handlingScope" defaultValue={loaderData.filters.handlingScope}><option value="">全部可见</option><option value="mine">待我办理</option></select>
          <select name="status" defaultValue={loaderData.filters.status}><option value="">全部运单状态</option>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
          <select name="pageSize" defaultValue="10" aria-label="每页数量"><option value="10">10 条/页</option></select>
          <button className="secondary">筛选</button>
          <Link className="text-button" to="/admin/shipments">重置</Link>
          <details className="order-route-advanced-filter" open={advancedFilterCount > 0}>
            <summary><span>更多筛选条件</span><small>{advancedFilterCount ? `已启用 ${advancedFilterCount} 项` : "路线、工作流、来源、创建人和日期"}</small></summary>
            <div className="order-route-filter-grid shipment-advanced-filter-grid">
              <OrderRouteFilterFields filters={loaderData.filters}/>
              <label className="field"><span>工作流状态</span><select name="workflowStatus" defaultValue={loaderData.filters.workflowStatus}><option value="">全部</option>{orderWorkflowStatuses.map(value=><option key={value} value={value}>{orderStatusLabel(value)}</option>)}</select></label>
              <label className="field"><span>订单来源</span><select name="source" defaultValue={loaderData.filters.source}><option value="">全部</option><option value="admin">后台创建</option><option value="portal">客户门户</option></select></label>
              <label className="field"><span>订单创建人</span><select name="creator" defaultValue={loaderData.filters.creator}><option value="">全部</option>{loaderData.creators.map(item=><option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
              <label className="field"><span>创建日期（起）</span><input type="date" name="dateFrom" defaultValue={loaderData.filters.dateFrom}/></label>
              <label className="field"><span>创建日期（止）</span><input type="date" name="dateTo" defaultValue={loaderData.filters.dateTo}/></label>
            </div>
          </details>
        </Form>
        {manage && (
          <ShipmentOperations
            busy={busy}
            orders={loaderData.orders}
            carriers={loaderData.carriers}
            shipments={loaderData.shipments}
          />
        )}
      </div>
      <div className="table-wrap shipment-table">
        <table>
          <thead><tr><th>运单状态</th><th>订单工作流</th><th>运单 / 订单</th><th>客户</th><th>业务 / 线路</th><th>货物汇总</th><th>运输资源</th><th>计划 / 实际</th><th>订单创建信息</th><th>最近动态</th><th className="sticky-action">操作</th></tr></thead>
          <tbody>{loaderData.shipments.map(s=><tr key={s.id} className={s.can_operate_current_node ? "order-todo-row" : ""}>
            <td><div className="shipment-task-status"><span className={`status-pill shipment-status-${s.status}`}>{labels[s.status]||s.status}</span>{s.can_operate_current_node&&<span className="order-todo-badge">待办</span>}</div>{s.exception_reason&&<small className="danger-text">{s.exception_reason}</small>}</td>
            <td><ShipmentWorkflow shipment={s}/></td>
            <td><strong>{s.shipment_number}</strong><small>订单 <OrderNumberLink id={s.order_id} number={s.order_number}/></small>{s.master_tracking_number&&<small>追踪号 {s.master_tracking_number}</small>}</td>
            <td><strong>{s.customer_name}</strong><small>识别码 {s.customer_code}</small></td>
            <td><strong>{businessTypeLabels[s.business_type]||s.business_type} · {s.transport_mode}</strong><small>{routeText(s)}</small>{s.service_level&&<small>服务等级 {s.service_level}</small>}</td>
            <td><strong>{s.cargo_description}</strong><small>{s.pieces} 件 · {formatNumber(s.gross_weight_kg)} KG · {formatNumber(s.volume_cbm)} CBM</small></td>
            <td>
              <strong>国内：{s.domestic_transport_resources||s.carriers||"待安排"}</strong>
              <small>境外：{s.overseas_transport_resources||"待出境/待换装"}</small>
              <small>当前位置 {s.current_location||"待更新"}</small>
            </td>
            <td><strong>预计 {formatDate(s.estimated_delivery_at)}</strong><small>提货 {formatDate(s.actual_pickup_at)}</small><small>签收 {formatDate(s.actual_delivery_at)}</small></td>
            <td><strong>{s.order_creator_name||"系统/客户"}</strong><small>{s.order_source==="portal"?"客户门户":"后台创建"} · {formatDate(s.order_created_at)}</small><small>生成运单 {formatDate(s.created_at)}</small></td>
            <td><strong>{s.latest_event_description||"暂无轨迹"}</strong><small>{formatDate(s.latest_event_at)}</small><small>更新 {formatDate(s.updated_at)}</small></td>
            <td className="sticky-action"><div className="row-actions"><Link className="text-button" to={`/admin/orders/${s.order_id}`}>订单详情</Link>{manage&&nextStates("shipment",s.status).length>0&&<span className="muted">可更新轨迹</span>}</div></td>
          </tr>)}</tbody>
        </table>
        {!loaderData.shipments.length&&<p className="empty-state">没有符合当前筛选条件的运单。</p>}
      </div>
      <ShipmentPagination page={loaderData.page} pages={loaderData.pages} pageSize={loaderData.pageSize} filters={loaderData.filters}/>
    </section>
  </>;
}

function ShipmentOperations({
  busy,
  orders,
  carriers,
  shipments,
}: {
  busy: boolean;
  orders: Array<{ id: string; order_number: string; customer_name: string }>;
  carriers: Array<{ id: string; code: string; name: string; status: string }>;
  shipments: Shipment[];
}) {
  return (
    <details className="shipment-operations-menu">
      <summary>运单操作</summary>
      <div className="shipment-operations-panel">
        <details className="shipment-operation-item" open={shipments.length === 0}>
          <summary>从确认订单创建运单</summary>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="create" />
            <Sel
              name="orderId"
              label="确认订单"
              items={orders.map((o) => [o.id, `${o.order_number} · ${o.customer_name}`])}
            />
            <label className="field"><span>主追踪号</span><input name="tracking" /></label>
            <label className="field"><span>预计送达</span><input name="eta" type="datetime-local" /></label>
            <button className="primary" disabled={busy}>创建运单</button>
          </Form>
        </details>
        <details className="shipment-operation-item">
          <summary>承运商档案</summary>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="carrier" />
            <label className="field"><span>代码</span><input name="code" required /></label>
            <label className="field"><span>名称</span><input name="name" required /></label>
            <label className="field"><span>SCAC</span><input name="scac" /></label>
            <label className="field"><span>联系人</span><input name="contactName" /></label>
            <label className="field"><span>电话</span><input name="phone" /></label>
            <label className="field"><span>邮箱</span><input name="email" type="email" /></label>
            <button className="primary" disabled={busy}>新增承运商</button>
          </Form>
        </details>
        <details className="shipment-operation-item">
          <summary>添加运输分段</summary>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="leg" />
            <Sel name="shipmentId" label="运单" items={shipments.map((s) => [s.id, s.shipment_number])} />
            <Sel
              name="carrierId"
              label="承运商"
              optional
              items={carriers.filter((c) => c.status === "active").map((c) => [c.id, c.name])}
            />
            <label className="field"><span>承运商参考号</span><input name="reference" /></label>
            <label className="field"><span>起点</span><input name="origin" required /></label>
            <label className="field"><span>终点</span><input name="destination" required /></label>
            <label className="field"><span>计划发车</span><input name="departure" type="datetime-local" /></label>
            <label className="field"><span>计划到达</span><input name="arrival" type="datetime-local" /></label>
            <button className="primary" disabled={busy}>添加分段</button>
          </Form>
        </details>
        {shipments.length > 0 && (
          <details className="shipment-operation-item">
            <summary>更新运单状态与轨迹</summary>
            <Form method="post" className="form-grid compact">
              <input type="hidden" name="intent" value="status" />
              <Sel
                name="id"
                label="运单"
                items={shipments
                  .filter((s) => nextStates("shipment", s.status).length)
                  .map((s) => [s.id, `${s.shipment_number} · ${labels[s.status]}`])}
              />
              <label className="field">
                <span>下一状态</span>
                <select name="status" required>
                  <option value="">选择后续状态</option>
                  {Object.entries(labels).map(([value, text]) => (
                    <option key={value} value={value}>{text}</option>
                  ))}
                </select>
              </label>
              <label className="field"><span>当前位置</span><input name="location" /></label>
              <label className="field"><span>发生时间</span><input name="eventAt" type="datetime-local" /></label>
              <label className="field span-2"><span>轨迹说明</span><input name="description" required /></label>
              <label className="field"><span>签收人</span><input name="signedBy" /></label>
              <label className="field"><span>异常原因</span><input name="exceptionReason" /></label>
              <label className="check-field"><input name="internal" type="checkbox" />仅内部可见</label>
              <button className="primary" disabled={busy}>发布轨迹</button>
            </Form>
          </details>
        )}
      </div>
    </details>
  );
}

function Sel({label,name,items,optional}:{label:string;name:string;items:[string,string][];optional?:boolean}){return <label className="field"><span>{label}</span><select name={name} required={!optional}><option value="">{optional?'未指定':'请选择'}</option>{items.map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>}

function routeText(shipment: Shipment) {
  return `${shipment.origin_country} ${shipment.origin_state||""} ${shipment.origin_city} → ${shipment.destination_country} ${shipment.destination_state||""} ${shipment.destination_city}`.replace(/\s+/g," ");
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}) : "待定";
}
function formatNumber(value: number) {
  return Number(value||0).toLocaleString("zh-CN",{maximumFractionDigits:3});
}
function ShipmentWorkflow({shipment}:{shipment:Shipment}) {
  const progress=Math.max(0,Math.min(100,Number(shipment.workflow_progress_percent||0)));
  const hasModules=shipment.workflow_module_count>0;
  const currentStep=shipment.workflow_current_module||shipment.order_current_step_name||orderStatusLabel(shipment.order_status);
  const hasAlert=Boolean(shipment.order_is_overdue)||["warning","exception"].includes(shipment.order_exception_status||"");
  return <div className={`shipment-workflow${hasAlert?" has-alert":""}`}>
    <div className="shipment-workflow-heading">
      <span className={`status-pill order-workflow-status-${shipment.order_status}`}>{orderStatusLabel(shipment.order_status)}</span>
      <b>{hasModules?`${progress}%`:"—"}</b>
    </div>
    <strong className="shipment-workflow-step" title={`${shipment.next_stage} · ${currentStep}`}>{shipment.next_stage} · {currentStep}</strong>
    <span className="shipment-workflow-track" aria-label={`订单工作流进度 ${progress}%`}><i style={{width:`${progress}%`}}/></span>
    <Link className="shipment-workflow-next" to={shipment.next_href} title={`负责人：${shipment.next_owner}`}>下一步：{shipment.next_action} · {shipment.next_owner}</Link>
    {(hasAlert || shipment.next_blocker) && <small className="danger-text">{shipment.next_blocker || (shipment.order_is_overdue?"流程已逾期":shipment.order_exception_status||"")}</small>}
  </div>;
}
function ShipmentPagination({page,pages,pageSize,filters}:{page:number;pages:number;pageSize:number;filters:ShipmentFilters}) {
  if (pages<=1) return null;
  const link=(target:number)=>`?${new URLSearchParams({...filters,page:String(target),pageSize:String(pageSize)}).toString()}`;
  return <footer className="pagination"><span>第 {page} / {pages} 页</span><div>{page>1&&<Link className="secondary" to={link(page-1)}>上一页</Link>}{page<pages&&<Link className="secondary" to={link(page+1)}>下一页</Link>}</div></footer>;
}
