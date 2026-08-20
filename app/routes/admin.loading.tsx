import { env } from "cloudflare:workers";
import { useMemo, useState } from "react";
import { Form, Link, redirect, useLocation, useNavigation } from "react-router";
import type { Route } from "./+types/admin.loading";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import { ensureOrderModules, syncOrderWorkflowSnapshot } from "../lib/order-modules.server";
import { loadOrderGuidance } from "../lib/order-guidance.server";
import { roadStatusLabels } from "../lib/warehouse-actual";
import { canManageOrderModule } from "../lib/position-portal";
import {
  buildLoadingFilter,
  loadingCompatibilityKey,
  type LoadingFilterCondition,
  type LoadingFilterField,
  type LoadingFilterOperator,
} from "../lib/loading-workbench";

const PAGE_SIZE = 20;

type CandidateOrder = {
  id: string;
  order_number: string;
  work_number: string;
  customer_name: string;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  origin_label: string;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  destination_label: string;
  exit_port: string | null;
  customs_location: string | null;
  route_notes: string | null;
  transit_locations: string | null;
  overseas_warehouse_id: string | null;
  domestic_warehouse_id: string | null;
  carrier_name: string | null;
  warehouse_name: string | null;
  operating_company: string;
  document_owner: string | null;
  customer_service: string | null;
  business_owner: string | null;
  order_date: string | null;
  planned_departure_at: string | null;
  actual_departure_at: string | null;
  planned_arrival_at: string | null;
  actual_arrival_at: string | null;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  attachment_count: number;
  status: string;
  business_type: string;
  next_stage: string;
  next_action: string;
  next_owner: string;
  next_blocker: string | null;
  next_href: string;
};

type BatchRow = {
  id: string;
  batch_number: string;
  batch_name: string;
  origin_location: string;
  destination_location: string;
  planned_departure_at: string | null;
  status: string;
  road_status: string;
  carrier_name: string | null;
  warehouse_name: string | null;
  order_count: number;
  order_numbers: string;
  total_weight: number;
  total_volume: number;
  vehicle_count: number;
};

const fieldOptions: [LoadingFilterField, string][] = [
  ["customer", "委托人"],
  ["origin", "起运地"],
  ["carrier", "承运商"],
  ["work_number", "工作号/订单号"],
  ["warehouse", "仓库"],
  ["destination", "目的地"],
  ["operating_company", "接单/操作公司"],
  ["document_owner", "单证"],
  ["customer_service", "客服/当前负责人"],
  ["business_owner", "商务/委托负责人"],
];

const operatorOptions: [LoadingFilterOperator, string][] = [
  ["equals", "等于"],
  ["contains", "包含"],
  ["exists", "存在"],
  ["not_equals", "不等于"],
  ["not_contains", "不包含"],
  ["not_exists", "不存在"],
  ["starts_with", "开头为"],
  ["ends_with", "结尾为"],
];

const candidateCte = `WITH candidate_orders AS (
  SELECT o.id,o.order_number,
    COALESCE((SELECT s.shipment_number FROM shipments s WHERE s.order_id=o.id ORDER BY s.created_at DESC LIMIT 1),o.order_number) work_number,
    c.name customer_name,
    o.origin_country,o.origin_state,o.origin_city,
    trim(o.origin_country||' '||COALESCE(o.origin_state||' ','')||o.origin_city) origin_label,
    o.destination_country,o.destination_state,o.destination_city,
    trim(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city) destination_label,
    o.exit_port,o.customs_location,o.route_notes,o.transit_locations,o.overseas_warehouse_id,
    (SELECT wr.warehouse_id FROM warehouse_receipts wr
      JOIN shipments rs ON rs.id=wr.shipment_id
      WHERE rs.order_id=o.id AND wr.status='completed' AND wr.cargo_complete=1
      ORDER BY wr.received_at DESC LIMIT 1) domestic_warehouse_id,
    COALESCE(
      (SELECT COALESCE(cr.name,a.carrier_name) FROM order_transport_assignments a LEFT JOIN carriers cr ON cr.id=a.carrier_id WHERE a.order_id=o.id AND a.status!='cancelled' ORDER BY CASE a.leg_type WHEN 'main' THEN 0 ELSE 1 END,a.created_at DESC LIMIT 1),
      (SELECT cr.name FROM booking_records br LEFT JOIN carriers cr ON cr.id=br.carrier_id WHERE br.order_id=o.id AND br.status!='cancelled' ORDER BY br.created_at DESC LIMIT 1)
    ) carrier_name,
    (SELECT w.name FROM warehouse_receipts wr JOIN shipments s ON s.id=wr.shipment_id JOIN warehouses w ON w.id=wr.warehouse_id WHERE s.order_id=o.id ORDER BY wr.received_at DESC LIMIT 1) warehouse_name,
    org.name operating_company,
    (SELECT u.display_name FROM order_module_instances mi LEFT JOIN users u ON u.id=mi.assignee_user_id WHERE mi.order_id=o.id AND mi.module_code='documents' LIMIT 1) document_owner,
    au.display_name customer_service,
    (SELECT u.display_name FROM order_module_instances mi LEFT JOIN users u ON u.id=mi.assignee_user_id WHERE mi.order_id=o.id AND mi.module_code='consignment' LIMIT 1) business_owner,
    o.order_date,
    COALESCE((SELECT MIN(a.planned_departure_at) FROM order_transport_assignments a WHERE a.order_id=o.id AND a.status!='cancelled'),(SELECT MIN(br.planned_departure_at) FROM booking_records br WHERE br.order_id=o.id AND br.status!='cancelled')) planned_departure_at,
    (SELECT MIN(a.actual_departure_at) FROM order_transport_assignments a WHERE a.order_id=o.id AND a.status!='cancelled') actual_departure_at,
    COALESCE((SELECT MAX(a.planned_arrival_at) FROM order_transport_assignments a WHERE a.order_id=o.id AND a.status!='cancelled'),(SELECT MAX(br.planned_arrival_at) FROM booking_records br WHERE br.order_id=o.id AND br.status!='cancelled')) planned_arrival_at,
    (SELECT MAX(a.actual_arrival_at) FROM order_transport_assignments a WHERE a.order_id=o.id AND a.status!='cancelled') actual_arrival_at,
    o.pieces,o.gross_weight_kg,o.volume_cbm,o.status,
    (SELECT COUNT(*) FROM order_attachments oa WHERE oa.order_id=o.id) attachment_count,
    CASE WHEN EXISTS(SELECT 1 FROM order_module_instances mi WHERE mi.order_id=o.id AND mi.module_code='warehouse' AND mi.enabled=1) THEN 1 ELSE 0 END warehouse_required,
    CASE WHEN EXISTS(SELECT 1 FROM warehouse_sorting_batches wb JOIN shipments ws ON ws.id=wb.shipment_id WHERE ws.order_id=o.id AND wb.status='verified') THEN 1 ELSE 0 END warehouse_ready,
    CASE WHEN EXISTS(SELECT 1 FROM order_cargo_packages p WHERE p.order_id=o.id AND p.organization_id=o.organization_id AND p.status!='cancelled') THEN 1 ELSE 0 END package_ready,
    (SELECT COUNT(*) FROM order_module_instances mi
      WHERE mi.order_id=o.id AND mi.enabled=1 AND mi.status IN ('blocked','exception')
        AND mi.module_code IN ('consignment','cargo','assignment','transport','warehouse','loading')) blocking_module_count,
    (SELECT bo.batch_id FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.order_id=o.id AND bo.status!='removed' AND b.status!='cancelled' LIMIT 1) active_batch_id
  FROM transport_orders o
  JOIN customers c ON c.id=o.customer_id
  JOIN organizations org ON org.id=o.organization_id
  LEFT JOIN users au ON au.id=o.current_assignee_user_id
  WHERE o.organization_id=? AND o.business_type='ltl' AND o.status IN ('confirmed','in_execution')
)`;

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  const url = new URL(request.url);
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const fields = url.searchParams.getAll("field");
  const operators = url.searchParams.getAll("operator");
  const values = url.searchParams.getAll("value");
  const conditions: LoadingFilterCondition[] = fields
    .map((field, index) => ({
      field: field as LoadingFilterField,
      operator: (operators[index] || "contains") as LoadingFilterOperator,
      value: values[index] || "",
    }))
    .filter((item) => fieldOptions.some(([value]) => value === item.field));
  while (conditions.length < 3)
    conditions.push({ field: "customer", operator: "contains", value: "" });

  const clauses = [
    "active_batch_id IS NULL",
    "(warehouse_required=0 OR warehouse_ready=1)",
    "package_ready=1",
    "blocking_module_count=0",
    "NULLIF(TRIM(exit_port),'') IS NOT NULL",
    "NULLIF(TRIM(customs_location),'') IS NOT NULL",
    "overseas_warehouse_id IS NOT NULL",
    "domestic_warehouse_id IS NOT NULL",
  ];
  const bindings: (string | number)[] = [current.organizationId];
  for (const condition of conditions) {
    const built = buildLoadingFilter(condition);
    if (!built) continue;
    clauses.push(built.clause);
    bindings.push(...built.bindings);
  }
  addDateRange(url, clauses, bindings, "order_date", "orderDateFrom", "orderDateTo");
  addDateRange(url, clauses, bindings, "planned_departure_at", "plannedDepartureFrom", "plannedDepartureTo");
  addDateRange(url, clauses, bindings, "actual_departure_at", "actualDepartureFrom", "actualDepartureTo");
  addDateRange(url, clauses, bindings, "planned_arrival_at", "plannedArrivalFrom", "plannedArrivalTo");
  addDateRange(url, clauses, bindings, "actual_arrival_at", "actualArrivalFrom", "actualArrivalTo");
  const where = `WHERE ${clauses.join(" AND ")}`;
  const count = await env.DB.prepare(`${candidateCte} SELECT COUNT(*) total FROM candidate_orders ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const total = count?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const candidates = await env.DB.prepare(
    `${candidateCte} SELECT * FROM candidate_orders ${where} ORDER BY COALESCE(planned_departure_at,'9999'),order_date,order_number LIMIT ? OFFSET ?`,
  )
    .bind(...bindings, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all<CandidateOrder>();
  const batches = await env.DB.prepare(
      `SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.planned_departure_at,b.status,b.road_status,c.name carrier_name,w.name warehouse_name,COUNT(DISTINCT bo.order_id) order_count,GROUP_CONCAT(DISTINCT o.order_number) order_numbers,COALESCE(SUM(COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg)),0) total_weight,COALESCE(SUM(COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm)),0) total_volume,(SELECT COUNT(*) FROM transport_batch_vehicles v WHERE v.batch_id=b.id) vehicle_count
       FROM transport_batches b
       LEFT JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.status!='removed'
       LEFT JOIN transport_orders o ON o.id=bo.order_id
       LEFT JOIN carriers c ON c.id=b.carrier_id
       LEFT JOIN warehouses w ON w.id=b.warehouse_id
       WHERE b.organization_id=? AND b.status!='cancelled'
       GROUP BY b.id ORDER BY b.created_at DESC LIMIT 50`,
    ).bind(current.organizationId).all<BatchRow>();
  const guidanceByOrder = await loadOrderGuidance(
    env.DB,
    current.organizationId,
    candidates.results.map((order) => ({ id: order.id, status: order.status })),
  );
  const candidateRows = candidates.results.map((order) => {
    const guidance = guidanceByOrder.get(order.id)!;
    return {
      ...order,
      next_stage: guidance.stage.shortTitle,
      next_action: guidance.action,
      next_owner: guidance.owner,
      next_blocker: guidance.blocker,
      next_href: guidance.href,
    };
  });
  return {
    current,
    candidates: candidateRows,
    batches: batches.results,
    conditions,
    dateFilters: Object.fromEntries([
      "orderDateFrom","orderDateTo","plannedDepartureFrom","plannedDepartureTo","actualDepartureFrom","actualDepartureTo","plannedArrivalFrom","plannedArrivalTo","actualArrivalFrom","actualArrivalTo",
    ].map((key) => [key, url.searchParams.get(key) || ""])),
    total,
    page,
    pages,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "order.view");
  if (!canManageOrderModule(current, "loading")) {
    throw new Response("无权办理拼车配载", { status: 403 });
  }
  const form = await request.formData();
  if (valueOf(form, "intent") !== "create_batch") return { formError: "操作无效" };
  const orderIds = [...new Set(form.getAll("orderIds").map(String).filter(Boolean))];
  if (orderIds.length < 2) return { formError: "请至少选择两个待配载订单" };
  const placeholders = orderIds.map(() => "?").join(",");
  const selected = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.origin_country,o.origin_state,o.origin_city,
            o.destination_country,o.destination_state,o.destination_city,o.status,o.business_type,
            o.exit_port,o.customs_location,o.route_notes,o.transit_locations,o.overseas_warehouse_id,
            (SELECT wr.warehouse_id FROM warehouse_receipts wr
             JOIN shipments s ON s.id=wr.shipment_id
             WHERE s.order_id=o.id AND wr.status='completed' AND wr.cargo_complete=1
             ORDER BY wr.received_at DESC LIMIT 1) domestic_warehouse_id
     FROM transport_orders o
     WHERE o.organization_id=? AND o.id IN (${placeholders})`,
  ).bind(current.organizationId, ...orderIds).all<CandidateOrder>();
  if (selected.results.length !== orderIds.length || selected.results.some((item) => item.business_type !== "ltl" || !["confirmed","in_execution"].includes(item.status)))
    return { formError: "所选订单包含无效、未审核或非零担订单" };
  const preparationMissing = selected.results.find((item) =>
    !item.exit_port ||
    !item.customs_location ||
    !item.domestic_warehouse_id ||
    !item.overseas_warehouse_id,
  );
  if (preparationMissing)
    return { formError: `订单 ${preparationMissing.order_number} 尚未完成配载准备，请先确定出境口岸、清关地和装车仓` };
  const compatibilityKeys = new Set(selected.results.map((item) => loadingCompatibilityKey({
    ...item,
  })));
  if (compatibilityKeys.size !== 1)
    return { formError: "所选订单的装车仓、线路、出境口岸、清关地或境外目的仓不一致，不能生成同一PZ配载单" };
  const occupied = await env.DB.prepare(
    `SELECT o.order_number FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id JOIN transport_orders o ON o.id=bo.order_id WHERE bo.organization_id=? AND bo.order_id IN (${placeholders}) AND bo.status!='removed' AND b.status!='cancelled' LIMIT 1`,
  ).bind(current.organizationId, ...orderIds).first<{order_number:string}>();
  if (occupied) return { formError: `订单 ${occupied.order_number} 已在其他有效配载批次中` };
  const unready = await env.DB.prepare(
    `SELECT o.order_number,
       CASE
         WHEN EXISTS(SELECT 1 FROM order_module_instances mi
           WHERE mi.order_id=o.id AND mi.enabled=1 AND mi.status IN ('blocked','exception')
             AND mi.module_code IN ('consignment','cargo','assignment','transport','warehouse','loading')) THEN '当前配载前置模块存在阻断或异常'
         WHEN EXISTS(SELECT 1 FROM order_module_instances mi WHERE mi.order_id=o.id AND mi.module_code='warehouse' AND mi.enabled=1)
           AND NOT EXISTS(SELECT 1 FROM warehouse_sorting_batches wb JOIN shipments ws ON ws.id=wb.shipment_id WHERE ws.order_id=o.id AND wb.status='verified') THEN '仓库尚未收货齐套并复核'
         WHEN NOT EXISTS(SELECT 1 FROM order_cargo_packages p WHERE p.order_id=o.id AND p.organization_id=o.organization_id AND p.status!='cancelled') THEN '订单尚未生成可装载包装编号'
         ELSE NULL
       END reason
     FROM transport_orders o
     WHERE o.organization_id=? AND o.id IN (${placeholders})
       AND (
         EXISTS(SELECT 1 FROM order_module_instances mi
           WHERE mi.order_id=o.id AND mi.enabled=1 AND mi.status IN ('blocked','exception')
             AND mi.module_code IN ('consignment','cargo','assignment','transport','warehouse','loading'))
         OR (EXISTS(SELECT 1 FROM order_module_instances mi WHERE mi.order_id=o.id AND mi.module_code='warehouse' AND mi.enabled=1)
           AND NOT EXISTS(SELECT 1 FROM warehouse_sorting_batches wb JOIN shipments ws ON ws.id=wb.shipment_id WHERE ws.order_id=o.id AND wb.status='verified'))
         OR NOT EXISTS(SELECT 1 FROM order_cargo_packages p WHERE p.order_id=o.id AND p.organization_id=o.organization_id AND p.status!='cancelled')
       )
     LIMIT 1`,
  ).bind(current.organizationId, ...orderIds).first<{order_number:string;reason:string}>();
  if (unready) return { formError: `订单 ${unready.order_number} 暂不可配载：${unready.reason}` };
  for (const orderId of orderIds) await ensureOrderModules(current.organizationId, orderId);
  const moduleRows = await env.DB.prepare(
    `SELECT id,order_id,current_step_code FROM order_module_instances WHERE organization_id=? AND module_code='loading' AND enabled=1 AND order_id IN (${placeholders})`,
  ).bind(current.organizationId,...orderIds).all<{id:string;order_id:string;current_step_code:string|null}>();
  if (moduleRows.results.length !== orderIds.length) return { formError:"所选订单中存在未启用拼车配载的订单" };
  const now = new Date().toISOString();
  const seq = await env.DB.prepare("SELECT COUNT(*)+1 next FROM transport_batches WHERE organization_id=? AND batch_number LIKE 'PZ-%'").bind(current.organizationId).first<{next:number}>();
  const batchId = crypto.randomUUID();
  const batchNumber = `PZ-${now.slice(0,10).replaceAll("-","")}-${String(seq?.next ?? 1).padStart(3,"0")}`;
  const first = selected.results[0];
  const origin = [first.origin_country,first.origin_state,first.origin_city].filter(Boolean).join(" ");
  const destination = [first.destination_country,first.destination_state,first.destination_city].filter(Boolean).join(" ");
  const statements = [
    env.DB.prepare(`INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,planned_departure_at,planned_arrival_at,status,notes,route_key,warehouse_id,carrier_id,created_by_user_id,created_at,updated_at,border_port,customs_location,transit_location,route_notes) VALUES(?,?,?,?,?,?,?,NULL,NULL,'planning',?,?,?,NULL,?,?,?,?,?,?,?)`).bind(batchId,current.organizationId,orderIds[0],batchNumber,valueOf(form,"batchName")||`${origin} → ${destination}`,origin,destination,valueOf(form,"notes")||null,loadingCompatibilityKey(first),first.domestic_warehouse_id,current.userId,now,now,first.exit_port,first.customs_location,first.transit_locations||null,first.route_notes),
    ...orderIds.map((orderId,index)=>env.DB.prepare("INSERT INTO transport_batch_orders(id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'planned',?,?,?)").bind(crypto.randomUUID(),current.organizationId,batchId,orderId,index+1,current.userId,now,now)),
    ...moduleRows.results.map((module)=>env.DB.prepare("UPDATE order_module_instances SET status='in_progress',current_step_code='planned',current_step_name='配载成单',progress_percent=75,started_at=COALESCE(started_at,?),completed_at=NULL,blocking_reason=NULL,updated_at=? WHERE id=?").bind(now,now,module.id)),
    ...moduleRows.results.map((module)=>env.DB.prepare("INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),current.organizationId,module.order_id,module.id,"batch_create","跨订单一键配载",module.current_step_code,"planned","配载成单",current.userId,`加入配载批次 ${batchNumber}；下一步安排承运商、车辆并按整票分配包装`,now)),
  ];
  try { await env.DB.batch(statements); }
  catch { return { formError:"配载批次编号冲突或数据保存失败，请重试" }; }
  await Promise.all(orderIds.map((orderId)=>syncOrderWorkflowSnapshot(current.organizationId,orderId)));
  await writeAudit({request,action:"transport.batch.cross_order.create",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchNumber,orderIds,routeKey:loadingCompatibilityKey(first)}});
  return redirect(`/admin/loading/${batchId}?fromOrderId=${orderIds[0]}`);
}

function addDateRange(url:URL,clauses:string[],bindings:(string|number)[],column:string,fromKey:string,toKey:string){
  const from=url.searchParams.get(fromKey),to=url.searchParams.get(toKey);
  if(from){clauses.push(`${column}>=?`);bindings.push(from)}
  if(to){clauses.push(`${column}<=?`);bindings.push(to.length===10?`${to}T23:59:59`:to)}
}

export default function LoadingWorkbench({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle";
  const location=useLocation();
  const [selected,setSelected]=useState<string[]>([]);
  const chosen=useMemo(()=>loaderData.candidates.filter(item=>selected.includes(item.id)),[loaderData.candidates,selected]);
  const totals=chosen.reduce((sum,item)=>({pieces:sum.pieces+item.pieces,weight:sum.weight+item.gross_weight_kg,volume:sum.volume+item.volume_cbm}),{pieces:0,weight:0,volume:0});
  const allSelected=loaderData.candidates.length>0&&loaderData.candidates.every(item=>selected.includes(item.id));
  const toggle=(id:string,checked:boolean)=>setSelected(current=>checked?[...new Set([...current,id])]:current.filter(item=>item!==id));
  return <>
    <header className="page-header"><div><p className="eyebrow">CONSOLIDATION WORKBENCH</p><h1>拼车配载工作台</h1><p>从同线路待配载池筛选多个完整订单，勾选后生成统一配载批次。</p></div><span className="status-pill">{loaderData.total} 票待配载</span></header>
    {actionData?.formError&&<div className="alert error">{actionData.formError}</div>}
    <section className="panel loading-filter-panel"><div className="panel-header"><div><h2>线路与业务条件</h2><p>文本条件支持等于、包含、存在、排除、开头和结尾判断；时间条件支持区间筛选。</p></div><Link className="secondary" to="/admin/loading">重置条件</Link></div>
      <Form method="get" className="loading-advanced-filter">
        <div className="loading-condition-list">{loaderData.conditions.slice(0,3).map((condition,index)=><div className="loading-condition-row" key={index}><select name="field" defaultValue={condition.field}>{fieldOptions.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select><select name="operator" defaultValue={condition.operator}>{operatorOptions.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select><input name="value" defaultValue={condition.value} placeholder="筛选值；存在/不存在可留空"/></div>)}</div>
        <div className="loading-date-grid"><DateRange label="接单日期" from="orderDateFrom" to="orderDateTo" values={loaderData.dateFilters}/><DateRange label="计划发车" from="plannedDepartureFrom" to="plannedDepartureTo" values={loaderData.dateFilters}/><DateRange label="已登记发车" from="actualDepartureFrom" to="actualDepartureTo" values={loaderData.dateFilters}/><DateRange label="计划到达" from="plannedArrivalFrom" to="plannedArrivalTo" values={loaderData.dateFilters}/><DateRange label="已登记到达" from="actualArrivalFrom" to="actualArrivalTo" values={loaderData.dateFilters}/></div>
        <button className="primary">查询待配载订单</button>
      </Form>
    </section>
    <Form method="post" id="create-load-batch">
      <input type="hidden" name="intent" value="create_batch"/>
      <section className="panel loading-candidate-panel"><div className="panel-header"><div><h2>待配载订单</h2><p>以完整订单为最小选择单位；一票订单不会在这里被拆分。</p></div><div className="loading-selection-summary"><span>已选 <strong>{selected.length}</strong> 票</span><span>{totals.pieces} 件</span><span>{totals.weight.toFixed(2)} KG</span><span>{totals.volume.toFixed(3)} CBM</span><button className="primary" disabled={busy||selected.length<2}>一键配载</button></div></div>
        <div className="loading-batch-fields"><label className="field"><span>批次名称（可选）</span><input name="batchName" placeholder="默认继承所选订单线路"/></label><label className="field span-2"><span>组批说明</span><input name="notes" placeholder="这里只确定共同运输的订单；承运商、车辆和时间在组批后安排"/></label></div>
        <div className="table-wrap loading-table"><table><thead><tr><th><input type="checkbox" checked={allSelected} onChange={event=>setSelected(event.target.checked?loaderData.candidates.map(item=>item.id):[])}/></th><th>状态</th><th>订单/工作号</th><th>委托人</th><th>线路</th><th>承运商/仓库</th><th>接单/计划时间</th><th>货物汇总</th><th>下一步/负责人</th><th>资料</th></tr></thead><tbody>{loaderData.candidates.map(item=><tr key={item.id} className={selected.includes(item.id)?"selected-row":""}><td><input type="checkbox" name="orderIds" value={item.id} checked={selected.includes(item.id)} onChange={event=>toggle(item.id,event.target.checked)}/></td><td><span className="status-pill">{item.status==="confirmed"?"待派单":"执行中"}</span></td><td><Link to={`/admin/orders/${item.id}`}><strong>{item.order_number}</strong></Link><small>{item.work_number}</small></td><td><strong>{item.customer_name}</strong><small>{item.operating_company}</small></td><td><strong>{item.origin_label}</strong><small>→ {item.destination_label}</small></td><td>{item.carrier_name||"承运商待定"}<small>{item.warehouse_name||"仓库待定"}</small></td><td>{item.order_date||"—"}<small>发车 {formatDate(item.planned_departure_at)}</small></td><td><strong>{item.pieces} 件 · {item.gross_weight_kg} KG</strong><small>{item.volume_cbm} CBM</small></td><td><Link className="order-next-link" to={item.next_href}><strong>{item.next_action}</strong><small>{item.next_stage} · {item.next_owner}</small></Link>{item.next_blocker&&<small className="danger-text">阻断：{item.next_blocker}</small>}</td><td>{item.attachment_count} 份</td></tr>)}</tbody></table></div>
        {!loaderData.candidates.length&&<p className="empty-state">当前筛选条件下没有可配载的零担订单。</p>}
        <Pagination page={loaderData.page} pages={loaderData.pages} search={location.search}/>
      </section>
    </Form>
    <section className="panel"><div className="panel-header"><div><h2>最近配载结果</h2><p>一个批次可以包含多票订单，结果会同步显示在每票订单的拼车配载模块。</p></div></div><div className="table-wrap"><table><thead><tr><th>配载批次</th><th>线路</th><th>订单</th><th>实收重量/体积</th><th>承运商/仓库</th><th>车辆</th><th>计划发车</th><th>状态</th><th>操作</th></tr></thead><tbody>{loaderData.batches.map(batch=><tr key={batch.id}><td><strong>{batch.batch_number}</strong><small>{batch.batch_name}</small></td><td>{batch.origin_location}<small>→ {batch.destination_location}</small></td><td><strong>{batch.order_count} 票</strong><small>{batch.order_numbers||"—"}</small></td><td>{batch.total_weight.toFixed(2)} KG<small>{batch.total_volume.toFixed(3)} CBM</small></td><td>{batch.carrier_name||"待确定"}<small>{batch.warehouse_name||"仓库待确定"}</small></td><td>{batch.vehicle_count} 辆</td><td>{formatDate(batch.planned_departure_at)}</td><td><span className="status-pill">{roadStatusLabels[batch.road_status]||batch.road_status}</span></td><td><Link className="text-button" to={`/admin/loading/${batch.id}`}>管理配载</Link></td></tr>)}</tbody></table></div></section>
  </>;
}

function DateRange({label,from,to,values}:{label:string;from:string;to:string;values:Record<string,string>}){return <div className="loading-date-range"><span>{label}</span><input type="date" name={from} defaultValue={values[from]}/><b>至</b><input type="date" name={to} defaultValue={values[to]}/></div>}
function Pagination({page,pages,search}:{page:number;pages:number;search:string}){if(pages<=1)return null;return <footer className="pagination"><span>第 {page} / {pages} 页</span><div>{page>1&&<Link className="secondary" to={pageUrl(search,page-1)}>上一页</Link>}{page<pages&&<Link className="secondary" to={pageUrl(search,page+1)}>下一页</Link>}</div></footer>}
function pageUrl(search:string,page:number){const params=new URLSearchParams(search);params.set("page",String(page));return `?${params.toString()}`}
function formatDate(value:string|null){return value?value.replace("T"," ").slice(0,16):"—"}
export function meta(){return[{title:"拼车配载工作台 | International TMS"}]}
