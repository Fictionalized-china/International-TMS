import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.domestic-tracking";
import { requireSessionUser } from "../lib/auth.server";

type DomesticRow = {
  order_id: string;
  order_number: string;
  customer_name: string;
  business_type: string;
  order_status: string;
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
  const rows = await env.DB.prepare(
    `SELECT o.id order_id,o.order_number,c.name customer_name,o.business_type,o.status order_status,
            a.id assignment_id,COALESCE(ca.name,a.carrier_name) carrier_name,a.vehicle_count,
            a.origin_location,a.destination_location,w.name warehouse_name,
            a.planned_departure_at,a.planned_arrival_at,a.actual_departure_at,a.actual_arrival_at,a.status assignment_status,
            s.shipment_number,s.status shipment_status,s.actual_pickup_at shipment_pickup_at,
            (SELECT MAX(r.received_at) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed') inbound_at,
            COALESCE((SELECT MAX(r.cargo_complete) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed'),0) cargo_complete,
            COALESCE((SELECT MAX(r.has_exception) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed'),0) has_exception,
            COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed'),0) actual_pieces,
            COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed'),0) actual_weight_kg,
            COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments rs ON rs.id=r.shipment_id WHERE r.organization_id=o.organization_id AND rs.order_id=o.id AND r.status='completed'),0) actual_volume_cbm,
            mi.current_step_name transport_step_name,mi.status transport_module_status,
            (SELECT e.description FROM shipment_events e WHERE e.shipment_id=s.id ORDER BY e.event_at DESC,e.created_at DESC LIMIT 1) latest_event,
            (SELECT e.event_at FROM shipment_events e WHERE e.shipment_id=s.id ORDER BY e.event_at DESC,e.created_at DESC LIMIT 1) latest_event_at
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN order_transport_assignments a ON a.id=(
         SELECT ax.id FROM order_transport_assignments ax
         WHERE ax.organization_id=o.organization_id AND ax.order_id=o.id AND ax.leg_type='first_mile' AND ax.status!='cancelled'
         ORDER BY ax.updated_at DESC,ax.created_at DESC LIMIT 1
       )
       LEFT JOIN carriers ca ON ca.id=a.carrier_id
       LEFT JOIN warehouses w ON w.id=a.destination_warehouse_id
       LEFT JOIN shipments s ON s.id=(
         SELECT sx.id FROM shipments sx WHERE sx.organization_id=o.organization_id AND sx.order_id=o.id
         ORDER BY COALESCE(sx.updated_at,sx.created_at) DESC,sx.created_at DESC LIMIT 1
       )
       LEFT JOIN order_module_instances mi ON mi.organization_id=o.organization_id AND mi.order_id=o.id AND mi.module_code='transport' AND mi.enabled=1
      WHERE o.organization_id=? AND o.status NOT IN ('draft','submitted','cancelled')
      ORDER BY COALESCE(a.updated_at,o.updated_at) DESC`,
  ).bind(current.organizationId).all<DomesticRow>();
  const assignmentIds = rows.results.map((row) => row.assignment_id).filter((id): id is string => Boolean(id));
  const vehicles = assignmentIds.length
    ? await env.DB.prepare(
      `SELECT assignment_id,id,vehicle_sequence,vehicle_type,plate_number,driver_name,driver_phone,
              planned_pickup_at,actual_pickup_at,actual_arrival_at,status
       FROM domestic_waybill_vehicles
       WHERE organization_id=? AND assignment_id IN (${assignmentIds.map(() => "?").join(",")}) AND status!='cancelled'
       ORDER BY assignment_id,vehicle_sequence`,
    ).bind(current.organizationId, ...assignmentIds).all<VehicleRow>()
    : { results: [] as VehicleRow[] };
  const vehiclesByAssignment: Record<string, VehicleRow[]> = {};
  for (const vehicle of vehicles.results) (vehiclesByAssignment[vehicle.assignment_id] ??= []).push(vehicle);
  const mapped = rows.results.map((row) => ({
    ...row,
    domestic_status: domesticStatus(row, vehiclesByAssignment[row.assignment_id || ""] || []),
    vehicles: vehiclesByAssignment[row.assignment_id || ""] || [],
  })).filter((row) => {
    if (status && row.domestic_status.code !== status) return false;
    if (businessType && row.business_type !== businessType) return false;
    if (q && !`${row.order_number} ${row.customer_name} ${row.carrier_name || ""} ${row.warehouse_name || ""} ${row.vehicles.map((vehicle) => `${vehicle.plate_number} ${vehicle.driver_name || ""}`).join(" ")}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  return { current, rows: mapped, filters: { q, status, businessType } };
}

export default function DomesticTracking({ loaderData }: Route.ComponentProps) {
  return <>
    <header className="page-header"><div><p className="eyebrow">DOMESTIC ROAD TRACKING</p><h1>国内物流轨迹</h1><p>一张订单对应一张国内运单；多辆提货车在同一行展开查看，到仓货齐后保留完整历史。</p></div><span className="status-pill">{loaderData.rows.length} 票</span></header>
    <section className="panel domestic-tracking-ledger">
      <Form method="get" className="domestic-tracking-filters"><input name="q" defaultValue={loaderData.filters.q} placeholder="订单、客户、承运商、车牌或司机"/><select name="status" defaultValue={loaderData.filters.status}><option value="">全部国内状态</option><option value="waiting_arrangement">待安排</option><option value="planned">已安排待提货</option><option value="in_transit">国内运输中</option><option value="waiting_receipt">已到仓待收货</option><option value="warehouse_check">仓库清点中</option><option value="completed">国内运输完成</option><option value="exception">异常</option></select><select name="businessType" defaultValue={loaderData.filters.businessType}><option value="">全部订单类型</option><option value="ftl">整车</option><option value="ltl">拼车</option></select><button className="secondary">筛选</button><Link className="text-button" to="/admin/domestic-tracking">重置</Link></Form>
      <div className="table-wrap domestic-tracking-table"><table><thead><tr><th>国内状态</th><th>订单 / 客户</th><th>类型</th><th>承运商 / 国内运单</th><th>起点 → 国内仓</th><th>计划 / 实际</th><th>车辆</th><th>仓库实收</th><th>最近动态</th><th className="sticky-action">操作</th></tr></thead><tbody>{loaderData.rows.map(row=><tr key={row.order_id}>
        <td><span className={`status-pill ${row.domestic_status.tone}`}>{row.domestic_status.label}</span><small>{row.transport_step_name||"等待业务安排"}</small></td>
        <td><strong>{row.order_number}</strong><small>{row.customer_name}</small></td>
        <td>{row.business_type==="ftl"?"整车":"拼车"}</td>
        <td><strong>{row.carrier_name||"待安排"}</strong><small>{row.shipment_number||"运单待生成"}</small></td>
        <td><strong>{row.origin_location||"客户提货地待定"}</strong><small>→ {row.warehouse_name||row.destination_location||"国内仓待定"}</small></td>
        <td><strong>提货 {formatTime(row.actual_departure_at||row.shipment_pickup_at)||formatTime(row.planned_departure_at)||"待定"}</strong><small>到仓 {formatTime(row.actual_arrival_at)||formatTime(row.planned_arrival_at)||"待定"}</small></td>
        <td><VehicleDetails vehicles={row.vehicles}/></td>
        <td><strong>{row.inbound_at?`${row.actual_pieces} 件 · ${formatNumber(row.actual_weight_kg)} KG` : "尚未收货"}</strong><small>{row.inbound_at?`${formatNumber(row.actual_volume_cbm)} CBM · ${formatTime(row.inbound_at)}`:"等待到仓"}</small></td>
        <td><strong>{row.latest_event||"暂无轨迹"}</strong><small>{formatTime(row.latest_event_at)}</small></td>
        <td className="sticky-action"><div className="row-actions"><Link className="text-button" to={`/admin/orders/${row.order_id}/modules/transport#module-business-data`}>国内运输</Link>{row.inbound_at&&<Link className="text-button" to={`/admin/orders/${row.order_id}/modules/warehouse#module-business-data`}>仓库收货</Link>}</div></td>
      </tr>)}</tbody></table>{!loaderData.rows.length&&<p className="empty-state">没有符合筛选条件的国内运输订单。</p>}</div>
    </section>
  </>;
}

function VehicleDetails({ vehicles }: { vehicles: VehicleRow[] }) {
  if (!vehicles.length) return <span className="off">车辆待录入</span>;
  return <details className="domestic-vehicle-details"><summary>{vehicles.length} 辆车 · {vehicles.map((vehicle) => vehicle.plate_number).join("、")}</summary><div>{vehicles.map((vehicle) => <p key={vehicle.id}><strong>{vehicle.vehicle_sequence}. {vehicle.plate_number}</strong><span>{vehicle.vehicle_type||"车型待定"} · {vehicle.driver_name||"司机待定"} · {vehicle.driver_phone||"电话待定"}</span><small>{vehicleStatusLabel(vehicle.status)} · 提货 {formatTime(vehicle.actual_pickup_at)||formatTime(vehicle.planned_pickup_at)||"待定"}</small></p>)}</div></details>;
}

function domesticStatus(row: DomesticRow, vehicles: VehicleRow[]) {
  if (row.has_exception) return { code: "exception", label: "仓库异常", tone: "danger" };
  if (row.cargo_complete) return { code: "completed", label: "国内运输完成", tone: "success" };
  if (row.inbound_at) return { code: "warehouse_check", label: "仓库清点中", tone: "" };
  if (row.actual_arrival_at || vehicles.some((vehicle) => vehicle.status === "arrived")) return { code: "waiting_receipt", label: "已到仓待收货", tone: "" };
  if (row.actual_departure_at || row.shipment_pickup_at || vehicles.some((vehicle) => vehicle.status === "picked_up")) return { code: "in_transit", label: "国内运输中", tone: "" };
  if (row.assignment_id) return { code: "planned", label: "已安排待提货", tone: "" };
  return { code: "waiting_arrangement", label: "待安排", tone: "off" };
}

function vehicleStatusLabel(status: string) {
  return ({ planned: "待提货", picked_up: "运输中", arrived: "已到仓" } as Record<string,string>)[status] || status;
}
function formatTime(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : ""; }
function formatNumber(value: number) { return Number(value || 0).toFixed(2); }
export function meta() { return [{ title: "国内物流轨迹 | International TMS" }]; }
