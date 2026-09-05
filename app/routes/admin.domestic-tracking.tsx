import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.domestic-tracking";
import { BatchNumberLink, OrderNumberLink } from "../components/EntityNumberLink";
import { OrderRouteFilterFields } from "../components/OrderRouteFilterFields";
import { QueryPagination } from "../components/QueryPagination";
import { requireSessionUser } from "../lib/auth.server";
import { chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import { paginateList, readListPage } from "../lib/list-pagination";
import { matchesOrderRouteFilters, orderRouteFilterCount, readOrderRouteFilters } from "../lib/order-route-filters";

type DomesticRow = {
  order_id: string;
  order_number: string;
  customer_name: string;
  business_type: string;
  order_status: string;
  origin_country: string | null;
  origin_state: string | null;
  origin_city: string | null;
  origin_address: string | null;
  exit_port: string | null;
  exit_port_name: string | null;
  destination_country: string | null;
  destination_state: string | null;
  destination_city: string | null;
  destination_address: string | null;
  overseas_warehouse_name: string | null;
  assignment_id: string | null;
  carrier_name: string | null;
  vehicle_count: number | null;
  origin_location: string | null;
  destination_location: string | null;
  warehouse_name: string | null;
  planned_departure_at: string | null;
  planned_arrival_at: string | null;
  actual_departure_at: string | null;
  actual_arrival_at: string | null;
  assignment_status: string | null;
  shipment_number: string | null;
  shipment_status: string | null;
  shipment_pickup_at: string | null;
  inbound_at: string | null;
  cargo_complete: number;
  has_exception: number;
  actual_pieces: number;
  actual_weight_kg: number;
  actual_volume_cbm: number;
  transport_step_name: string | null;
  transport_module_status: string | null;
  latest_event: string | null;
  latest_event_at: string | null;
  outbound_batch_id: string | null;
  outbound_batch_number: string | null;
  outbound_road_status: string | null;
  outbound_carrier_name: string | null;
  outbound_vehicle_plate: string | null;
  outbound_driver_name: string | null;
  outbound_driver_phone: string | null;
  outbound_departure_at: string | null;
  outbound_arrival_at: string | null;
};

type VehicleRow = {
  assignment_id: string;
  id: string;
  vehicle_sequence: number;
  vehicle_type: string | null;
  plate_number: string;
  driver_name: string | null;
  driver_phone: string | null;
  planned_pickup_at: string | null;
  actual_pickup_at: string | null;
  actual_arrival_at: string | null;
  status: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "shipment.view");
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "";
  const businessType = url.searchParams.get("businessType") || "";
  const requestedPage = readListPage(url.searchParams);
  const routeFilters = readOrderRouteFilters(url.searchParams);
  const rows = await env.DB.prepare(
    `SELECT o.id order_id,o.order_number,c.name customer_name,o.business_type,o.status order_status,
            o.origin_country,o.origin_state,o.origin_city,o.origin_address,
            o.exit_port,route_port.name exit_port_name,
            o.destination_country,o.destination_state,o.destination_city,o.destination_address,
            ow.name overseas_warehouse_name,
            a.id assignment_id,COALESCE(ca.name,a.carrier_name) carrier_name,a.vehicle_count,
            a.origin_location,a.destination_location,w.name warehouse_name,
            a.planned_departure_at,a.planned_arrival_at,a.actual_departure_at,a.actual_arrival_at,a.status assignment_status,
            s.shipment_number,s.status shipment_status,s.actual_pickup_at shipment_pickup_at,
            (SELECT MAX(r.received_at) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed') inbound_at,
            COALESCE((SELECT MAX(r.cargo_complete) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed'),0) cargo_complete,
            CASE WHEN o.exception_status IN ('warning','exception') THEN 1 ELSE 0 END has_exception,
            COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed'),0) actual_pieces,
            COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed'),0) actual_weight_kg,
            COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed'),0) actual_volume_cbm,
            mi.current_step_name transport_step_name,mi.status transport_module_status,
            (SELECT e.description FROM shipment_events e WHERE e.shipment_id=s.id ORDER BY e.event_at DESC,e.created_at DESC LIMIT 1) latest_event,
            (SELECT e.event_at FROM shipment_events e WHERE e.shipment_id=s.id ORDER BY e.event_at DESC,e.created_at DESC LIMIT 1) latest_event_at
            ,b.id outbound_batch_id,b.batch_number outbound_batch_number,b.road_status outbound_road_status,
            b.overseas_carrier_name outbound_carrier_name,b.overseas_vehicle_plate outbound_vehicle_plate,
            b.overseas_driver_name outbound_driver_name,b.overseas_driver_phone outbound_driver_phone,
            b.actual_departure_at outbound_departure_at,b.actual_arrival_at outbound_arrival_at
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN order_transport_assignments a ON a.id=(
         SELECT ax.id FROM order_transport_assignments ax
         WHERE ax.organization_id=o.organization_id AND ax.order_id=o.id AND ax.leg_type='first_mile' AND ax.status!='cancelled'
         ORDER BY ax.updated_at DESC,ax.created_at DESC LIMIT 1
       )
       LEFT JOIN carriers ca ON ca.id=a.carrier_id
       LEFT JOIN warehouses w ON w.id=a.destination_warehouse_id
       LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
       LEFT JOIN reference_data route_port ON route_port.organization_id=o.organization_id AND route_port.category='border_port' AND route_port.code=o.exit_port
       LEFT JOIN shipments s ON s.id=(
         SELECT sx.id FROM shipments sx WHERE sx.organization_id=o.organization_id AND sx.order_id=o.id
         ORDER BY COALESCE(sx.updated_at,sx.created_at) DESC,sx.created_at DESC LIMIT 1
       )
       LEFT JOIN order_module_instances mi ON mi.organization_id=o.organization_id AND mi.order_id=o.id AND mi.module_code='transport' AND mi.enabled=1
       LEFT JOIN transport_batches b ON b.id=(
         SELECT bx.id FROM transport_batches bx
         WHERE bx.organization_id=o.organization_id AND bx.status!='cancelled'
           AND (bx.order_id=o.id OR EXISTS(
             SELECT 1 FROM transport_batch_orders bo
             WHERE bo.organization_id=o.organization_id AND bo.batch_id=bx.id AND bo.order_id=o.id AND bo.status!='removed'
           ))
         ORDER BY bx.updated_at DESC,bx.created_at DESC LIMIT 1
       )
      WHERE o.organization_id=? AND o.status NOT IN ('draft','submitted','cancelled')
      ORDER BY COALESCE(a.updated_at,o.updated_at) DESC`,
  ).bind(current.organizationId).all<DomesticRow>();
  const assignmentIds = rows.results.map((row) => row.assignment_id).filter((id): id is string => Boolean(id));
  const vehicles: VehicleRow[] = [];
  for (const assignmentChunk of chunkD1Values(assignmentIds, 1)) {
    const result = await env.DB.prepare(
      `SELECT assignment_id,id,vehicle_sequence,vehicle_type,plate_number,driver_name,driver_phone,
              planned_pickup_at,actual_pickup_at,actual_arrival_at,status
       FROM domestic_waybill_vehicles
       WHERE organization_id=? AND assignment_id IN (${d1Placeholders(assignmentChunk.length)}) AND status!='cancelled'
       ORDER BY assignment_id,vehicle_sequence`,
    ).bind(current.organizationId, ...assignmentChunk).all<VehicleRow>();
    vehicles.push(...result.results);
  }
  const vehiclesByAssignment: Record<string, VehicleRow[]> = {};
  for (const vehicle of vehicles) (vehiclesByAssignment[vehicle.assignment_id] ??= []).push(vehicle);
  const mapped = rows.results.map((row) => ({
    ...row,
    transit_status: transitStatus(row, vehiclesByAssignment[row.assignment_id || ""] || []),
    vehicles: vehiclesByAssignment[row.assignment_id || ""] || [],
  })).filter((row) => {
    if (status && row.transit_status.code !== status) return false;
    if (businessType && row.business_type !== businessType) return false;
    if (!matchesOrderRouteFilters(row, routeFilters)) return false;
    if (q && !`${row.order_number} ${row.customer_name} ${row.carrier_name || ""} ${row.warehouse_name || ""} ${row.outbound_batch_number || ""} ${row.outbound_carrier_name || ""} ${row.outbound_vehicle_plate || ""} ${row.outbound_driver_name || ""} ${row.vehicles.map((vehicle) => `${vehicle.plate_number} ${vehicle.driver_name || ""}`).join(" ")}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const pagination = paginateList(mapped, requestedPage);
  return {
    current,
    rows: pagination.items,
    pagination: {
      page: pagination.page,
      pageCount: pagination.pageCount,
      pageSize: pagination.pageSize,
      total: pagination.total,
    },
    filters: { q, status, businessType, ...routeFilters },
  };
}

export default function DomesticTracking({ loaderData }: Route.ComponentProps) {
  const advancedFilterCount = orderRouteFilterCount(loaderData.filters);
  return <>
    <header className="page-header"><div><p className="eyebrow">IN-TRANSIT VEHICLES</p><h1>在途车辆</h1><p>统一查看国内提货车辆、出境配载车辆和国内外轨迹；订单全程保持一行，历史不丢失。</p></div><span className="status-pill">{loaderData.pagination.total} 票</span></header>
    <section className="panel domestic-tracking-ledger">
      <Form method="get" action="." className="domestic-tracking-filters"><input name="q" defaultValue={loaderData.filters.q} placeholder="订单、客户、承运商、配载单、车牌或司机"/><select name="status" defaultValue={loaderData.filters.status}><option value="">全部在途状态</option><option value="waiting_arrangement">国内待安排</option><option value="planned">国内待提货</option><option value="domestic_in_transit">国内运输中</option><option value="waiting_receipt">国内仓待收货</option><option value="warehouse_check">国内仓清点中</option><option value="domestic_completed">国内运输完成</option><option value="waiting_outbound">等待出境</option><option value="outbound_in_transit">出境运输中</option><option value="overseas_arrived">已到境外仓</option><option value="completed">客户已自提</option><option value="exception">异常</option></select><select name="businessType" defaultValue={loaderData.filters.businessType}><option value="">全部订单类型</option><option value="ftl">整车</option><option value="ltl">拼车</option></select><button className="secondary">筛选</button><Link className="text-button" to="/admin/domestic-tracking">重置</Link><details className="order-route-advanced-filter" open={advancedFilterCount > 0}><summary><span>更多筛选条件</span><small>{advancedFilterCount ? `已启用 ${advancedFilterCount} 项` : "出发地、出境口岸、目的地"}</small></summary><div className="order-route-filter-grid"><OrderRouteFilterFields filters={loaderData.filters}/></div></details></Form>
      <div className="table-wrap domestic-tracking-table"><table><thead><tr><th>当前状态</th><th>订单 / 客户</th><th>类型</th><th>国内承运商 / 运单</th><th>国内车辆</th><th>国内仓实收</th><th>出境批次 / 承运商</th><th>出境车辆 / 司机</th><th>最近动态</th><th className="sticky-action">操作</th></tr></thead><tbody>{loaderData.rows.map(row=><tr key={row.order_id}>
        <td><span className={`status-pill ${row.transit_status.tone}`}>{row.transit_status.label}</span><small>{row.transport_step_name||"等待业务安排"}</small></td>
        <td><strong><OrderNumberLink id={row.order_id} number={row.order_number}/></strong><small>{row.customer_name}</small></td>
        <td>{row.business_type==="ftl"?"整车":"拼车"}</td>
        <td><strong>{row.carrier_name||"待安排"}</strong><small>{row.shipment_number||"运单待生成"} · {row.origin_location||"提货地待定"} → {row.warehouse_name||row.destination_location||"国内仓待定"}</small></td>
        <td><VehicleDetails vehicles={row.vehicles}/></td>
        <td><strong>{row.inbound_at?`${row.actual_pieces} 件 · ${formatNumber(row.actual_weight_kg)} KG` : "尚未收货"}</strong><small>{row.inbound_at?`${formatNumber(row.actual_volume_cbm)} CBM · ${formatTime(row.inbound_at)}`:"等待到仓"}</small></td>
        <td><strong>{row.outbound_batch_id&&row.outbound_batch_number?<BatchNumberLink id={row.outbound_batch_id} number={row.outbound_batch_number}/>:"尚未生成"}</strong><small>{row.outbound_carrier_name||"出境承运商待定"}</small></td>
        <td><strong>{row.outbound_vehicle_plate||"车辆待定"}</strong><small>{row.outbound_driver_name||"司机待定"} · {row.outbound_driver_phone||"电话待定"}</small></td>
        <td><strong>{row.latest_event||"暂无轨迹"}</strong><small>{formatTime(row.latest_event_at)}</small></td>
        <td className="sticky-action"><div className="row-actions">{row.outbound_batch_id?<Link className="text-button" to={`/admin/loading/${row.outbound_batch_id}`}>查看出境轨迹</Link>:<Link className="text-button" to={`/admin/orders/${row.order_id}/modules/transport#module-business-data`}>查看国内运输</Link>}</div></td>
      </tr>)}</tbody></table>{!loaderData.rows.length&&<p className="empty-state">没有符合筛选条件的在途订单。</p>}</div>
      <QueryPagination {...loaderData.pagination}/>
    </section>
  </>;
}

function VehicleDetails({ vehicles }: { vehicles: VehicleRow[] }) {
  if (!vehicles.length) return <span className="off">车辆待录入</span>;
  return <details className="domestic-vehicle-details"><summary>{vehicles.length} 辆车 · {vehicles.map((vehicle) => vehicle.plate_number).join("、")}</summary><div>{vehicles.map((vehicle) => <p key={vehicle.id}><strong>{vehicle.vehicle_sequence}. {vehicle.plate_number}</strong><span>{vehicle.vehicle_type||"车型待定"} · {vehicle.driver_name||"司机待定"} · {vehicle.driver_phone||"电话待定"}</span><small>{vehicleStatusLabel(vehicle.status)} · 提货 {formatTime(vehicle.actual_pickup_at)||formatTime(vehicle.planned_pickup_at)||"待定"}</small></p>)}</div></details>;
}

function transitStatus(row: DomesticRow, vehicles: VehicleRow[]) {
  if (row.order_status === "completed" || row.outbound_road_status === "pickup_completed") return { code: "completed", label: "客户已自提", tone: "success" };
  if (["overseas_arrived","waiting_pickup"].includes(row.outbound_road_status||"")) return { code: "overseas_arrived", label: "已到境外仓", tone: "success" };
  if (row.outbound_road_status === "outbound_in_transit") return { code: "outbound_in_transit", label: "出境运输中", tone: "" };
  if (["preplanned","loaded_waiting_exit"].includes(row.outbound_road_status||"")) return { code: "waiting_outbound", label: "等待出境", tone: "" };
  if (row.has_exception) return { code: "exception", label: "仓库异常", tone: "danger" };
  if (row.cargo_complete) return { code: "domestic_completed", label: "国内运输完成", tone: "success" };
  if (row.inbound_at) return { code: "warehouse_check", label: "仓库清点中", tone: "" };
  if (row.actual_arrival_at || vehicles.some((vehicle) => vehicle.status === "arrived")) return { code: "waiting_receipt", label: "已到仓待收货", tone: "" };
  if (row.actual_departure_at || row.shipment_pickup_at || vehicles.some((vehicle) => vehicle.status === "picked_up")) return { code: "domestic_in_transit", label: "国内运输中", tone: "" };
  if (row.assignment_id) return { code: "planned", label: "已安排待提货", tone: "" };
  return { code: "waiting_arrangement", label: "待安排", tone: "off" };
}

function vehicleStatusLabel(status: string) {
  return ({ planned: "待提货", picked_up: "运输中", arrived: "已到仓" } as Record<string,string>)[status] || status;
}
function formatTime(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : ""; }
function formatNumber(value: number) { return Number(value || 0).toFixed(2); }
export function meta() { return [{ title: "在途车辆 | International TMS" }]; }
