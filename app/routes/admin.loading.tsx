import { env } from "cloudflare:workers";
import { useMemo, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.loading";
import { BatchNumberLink, OrderNumberLinkList } from "../components/EntityNumberLink";
import { ActionToast } from "../components/ActionToast";
import { requireSessionUser } from "../lib/auth.server";
import { batchVisibilitySql } from "../lib/order-access.server";
import { canAccessBatchWorkspace } from "../lib/order-access";
import {
  createOperationPlannedBatch,
  loadLoadingPlanningCandidates,
  loadLoadingPlanningOptions,
} from "../lib/loading-batch-planning.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";

type BatchRow = {
  id: string;
  batch_number: string;
  batch_name: string;
  origin_location: string;
  destination_location: string;
  planned_departure_at: string | null;
  status: string;
  road_status: string;
  approval_status: string;
  operation_supervisor_name: string | null;
  operation_assignee_name: string | null;
  carrier_name: string | null;
  warehouse_name: string | null;
  order_count: number;
  order_numbers: string | null;
  order_refs: string | null;
  total_weight: number;
  total_volume: number;
  vehicle_count: number;
};

const pageSize = 10;

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  if (!canAccessBatchWorkspace(current)) {
    throw new Response("当前岗位没有配载单工作台访问权限", { status: 403 });
  }
  const visibility = batchVisibilitySql(current, "b");
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "all";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const statusSql = status === "active"
    ? "AND b.road_status NOT IN ('pickup_completed','cancelled')"
    : status === "completed"
      ? "AND b.road_status='pickup_completed'"
      : status === "cancelled"
        ? "AND b.road_status='cancelled'"
        : "";
  const searchSql = q
    ? `AND (b.batch_number LIKE '%'||?||'%' OR b.batch_name LIKE '%'||?||'%' OR EXISTS(
         SELECT 1 FROM transport_batch_orders sx
         JOIN transport_orders ox ON ox.id=sx.order_id AND ox.organization_id=sx.organization_id
         WHERE sx.batch_id=b.id AND sx.organization_id=b.organization_id AND sx.status!='removed'
           AND ox.order_number LIKE '%'||?||'%'
       ))`
    : "";
  const searchBinds = q ? [q, q, q] : [];
  const count = await env.DB.prepare(
    `SELECT COUNT(*) total FROM transport_batches b
      WHERE b.organization_id=? AND b.batch_number LIKE 'PZ%' AND ${visibility.sql} ${statusSql} ${searchSql}`,
  ).bind(current.organizationId, ...visibility.values, ...searchBinds).first<{ total: number }>();
  const rows = await env.DB.prepare(
    `SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,
            b.planned_departure_at,b.status,b.road_status,b.approval_status,c.name carrier_name,w.name warehouse_name,
            supervisor.display_name operation_supervisor_name,operator.display_name operation_assignee_name,
            COUNT(DISTINCT bo.order_id) order_count,
            GROUP_CONCAT(DISTINCT o.order_number) order_numbers,
            GROUP_CONCAT(DISTINCT o.id||'|'||o.order_number) order_refs,
            COALESCE(SUM(COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg)),0) total_weight,
            COALESCE(SUM(COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm)),0) total_volume,
            (SELECT COUNT(*) FROM transport_batch_vehicles v WHERE v.batch_id=b.id AND v.status!='cancelled') vehicle_count
       FROM transport_batches b
       JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
       JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       LEFT JOIN carriers c ON c.id=b.carrier_id
       LEFT JOIN warehouses w ON w.id=b.warehouse_id
       LEFT JOIN users supervisor ON supervisor.id=b.operation_supervisor_user_id
       LEFT JOIN users operator ON operator.id=b.operation_assignee_user_id
      WHERE b.organization_id=? AND b.batch_number LIKE 'PZ%' AND ${visibility.sql} ${statusSql} ${searchSql}
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?`,
  ).bind(current.organizationId, ...visibility.values, ...searchBinds, pageSize, (page - 1) * pageSize).all<BatchRow>();

  const canPlan = current.permissions.includes("transport.batch.approve");
  const [planningCandidates, planningOptions] = canPlan
    ? await Promise.all([
        loadLoadingPlanningCandidates(current),
        loadLoadingPlanningOptions(current.organizationId),
      ])
    : [[], { carriers: [], vehicles: [], drivers: [], borderPorts: [], customsPlaces: [] }];

  return {
    canPlan,
    planningCandidates,
    planningOptions,
    batches: rows.results,
    total: count?.total ?? 0,
    q,
    status: ["all", "active", "completed", "cancelled"].includes(status) ? status : "all",
    page,
    pageCount: Math.max(1, Math.ceil((count?.total ?? 0) / pageSize)),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "transport.batch.approve");
  const form = await request.formData();
  if (valueOf(form, "intent") !== "create_batch") return { formError: "未知操作" };
  try {
    const created = await createOperationPlannedBatch({
      current,
      orderIds: form.getAll("orderIds").map(String),
      batchName: valueOf(form, "batchName").trim(),
      carrierId: valueOf(form, "carrierId"),
      vehicleId: valueOf(form, "vehicleId"),
      driverId: valueOf(form, "driverId"),
      borderPort: valueOf(form, "borderPort").trim(),
      customsLocation: valueOf(form, "customsLocation").trim(),
      plannedLoadingAt: valueOf(form, "plannedLoadingAt").trim(),
      plannedDepartureAt: valueOf(form, "plannedDepartureAt").trim(),
      plannedArrivalAt: valueOf(form, "plannedArrivalAt").trim(),
      routeNotes: valueOf(form, "routeNotes").trim(),
      notes: valueOf(form, "notes").trim(),
    });
    await writeAudit({
      request,
      action: "loading.batch.plan",
      resourceType: "transport_batch",
      resourceId: created.batchId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: created,
    });
    return {
      success: `配载单 ${created.batchNumber} 已建立，下一步请完成负责人分配`,
      batchId: created.batchId,
      batchNumber: created.batchNumber,
    };
  } catch (error) {
    return { formError: error instanceof Error ? error.message : "配载单创建失败，请刷新后重试" };
  }
}

export default function LoadingTracking({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">CONSOLIDATION TRACKING</p>
        <h1>配载单跟踪</h1>
        <p>操作主管按商务已录入的境外运输资源选择可配载订单；仓库只负责后续装车、扫描和出库执行。</p>
      </div>
      <span className="status-pill">{loaderData.total} 张配载单</span>
    </header>
    <ActionToast message={actionData?.formError || actionData?.success} tone={actionData?.formError ? "error" : "success"} data={actionData}/>
    {actionData && "batchId" in actionData && actionData.batchId && <div className="alert success"><strong>配载规划已保存</strong><Link className="text-button" to={`/admin/loading/${actionData.batchId}`}>进入配载单完成负责人分配 →</Link></div>}
    {loaderData.canPlan && <BatchPlanningPanel data={loaderData} busy={busy}/>}
    <section className="panel loading-tracking-filter-panel">
      <Form method="get" action="." className="filter-bar compact loading-tracking-filter">
        <label className="field loading-tracking-filter__query"><span>配载单号或订单号</span><input name="q" defaultValue={loaderData.q} placeholder="输入配载单号或子订单号" /></label>
        <label className="field loading-tracking-filter__status"><span>状态</span><select name="status" defaultValue={loaderData.status}><option value="all">全部</option><option value="active">执行中</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></label>
        <div className="loading-tracking-filter__actions"><button className="primary">查询</button><Link className="secondary" to="/admin/loading">重置</Link></div>
        <details className="inline-details advanced-filter loading-tracking-filter__advanced"><summary>高级筛选</summary><div className="filter-help">仓库、目的地、客户和时间等高级条件后续统一接入筛选积木；当前可通过配载单内订单号准确定位。</div></details>
      </Form>
    </section>
    <section className="panel">
      <div className="table-wrap"><table><thead><tr><th>配载单</th><th>线路</th><th>挂载订单</th><th>实收重量/体积</th><th>负责人</th><th>车辆</th><th>计划发车</th><th>审核 / 状态</th><th>操作</th></tr></thead><tbody>{loaderData.batches.map((batch) => <tr key={batch.id}>
        <td><strong><BatchNumberLink id={batch.id} number={batch.batch_number}/></strong><small>{batch.batch_name}</small></td>
        <td>{batch.origin_location}<small>→ {batch.destination_location}</small></td>
        <td><strong>{batch.order_count} 票</strong><small className="entity-number-list"><OrderNumberLinkList orders={orderReferences(batch.order_refs)}/></small></td>
        <td>{Number(batch.total_weight || 0).toFixed(2)} KG<small>{Number(batch.total_volume || 0).toFixed(3)} CBM</small></td>
        <td>{batch.operation_assignee_name || batch.operation_supervisor_name || "待指派"}<small>{batch.operation_assignee_name?"整单操作负责人":batch.operation_supervisor_name?"待操作主管审核":"尚未绑定主管"}</small></td>
        <td>{batch.vehicle_count} 辆</td>
        <td>{formatDate(batch.planned_departure_at)}</td>
        <td><span className={`status-pill ${batch.approval_status==="approved"?"success":batch.approval_status==="rejected"?"danger":""}`}>{batchApprovalLabel(batch.approval_status)}</span><small>{roadStatusLabel(batch.road_status)}</small></td>
        <td><Link className={batch.approval_status==="submitted"?"primary":"text-button"} to={`/admin/loading/${batch.id}`}>{batch.approval_status==="submitted"?"审核并指派":"查看配载单"}</Link></td>
      </tr>)}</tbody></table></div>
      {!loaderData.batches.length && <p className="empty-state">没有找到符合条件的已生成配载单。</p>}
      {loaderData.pageCount > 1 && <div className="pagination">
        {loaderData.page > 1 && <Link className="secondary" to={pageHref(loaderData, loaderData.page - 1)}>上一页</Link>}
        <span>第 {loaderData.page} / {loaderData.pageCount} 页</span>
        {loaderData.page < loaderData.pageCount && <Link className="secondary" to={pageHref(loaderData, loaderData.page + 1)}>下一页</Link>}
      </div>}
    </section>
  </>;
}

function BatchPlanningPanel({ data, busy }: {
  data: Route.ComponentProps["loaderData"];
  busy: boolean;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [carrierId, setCarrierId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [driverId, setDriverId] = useState("");
  const selected = data.planningCandidates.filter((item) => selectedIds.includes(item.order_id));
  const first = selected[0];
  const routeKey = (item: (typeof data.planningCandidates)[number]) => [
    item.warehouse_id,item.overseas_warehouse_id,item.destination_country,item.destination_state || "",
    item.destination_city,item.operation_supervisor_user_id,
  ].join("|");
  const compatible = (item: (typeof data.planningCandidates)[number]) => !first || routeKey(item) === routeKey(first);
  const totals = useMemo(() => selected.reduce((sum, item) => ({
    weight: sum.weight + Number(item.weight_kg || 0),
    volume: sum.volume + Number(item.volume_cbm || 0),
    packages: sum.packages + Number(item.package_count || 0),
  }), { weight: 0, volume: 0, packages: 0 }), [selected]);
  const vehicles = data.planningOptions.vehicles.filter((item) => item.carrier_id === carrierId);
  const drivers = data.planningOptions.drivers.filter((item) => item.carrier_id === carrierId);
  const toggle = (id: string, checked: boolean) => setSelectedIds((current) => checked
    ? [...new Set([...current, id])]
    : current.filter((item) => item !== id));
  return <section className="panel inline-loading-workbench">
    <div className="panel-header"><div><h2>配载规划</h2><p>先由商务在“承运商管理”录入境外承运商、车辆和司机；再由操作主管按同仓、同目的仓和同线路勾选订单。</p></div><span className="status-pill">{data.planningCandidates.length} 票可配载</span></div>
    <Form method="post">
      <input type="hidden" name="intent" value="create_batch"/>
      <div className="form-grid compact loading-batch-fields">
        <label className="field"><span>配载单名称</span><input name="batchName" placeholder="留空自动生成"/></label>
        <label className="field"><span>境外承运商 *</span><select name="carrierId" value={carrierId} required onChange={(event) => { setCarrierId(event.currentTarget.value); setVehicleId(""); setDriverId(""); }}><option value="">请选择商务已录入资源</option>{data.planningOptions.carriers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field"><span>境外车辆 *</span><select name="vehicleId" value={vehicleId} required disabled={!carrierId} onChange={(event) => setVehicleId(event.currentTarget.value)}><option value="">{carrierId ? "请选择车辆" : "请先选择承运商"}</option>{vehicles.map((item) => <option key={item.id} value={item.id}>{item.plate_number}{item.vehicle_type ? ` · ${item.vehicle_type}` : ""}</option>)}</select></label>
        <label className="field"><span>境外司机 *</span><select name="driverId" value={driverId} required disabled={!carrierId} onChange={(event) => setDriverId(event.currentTarget.value)}><option value="">{carrierId ? "请选择司机" : "请先选择承运商"}</option>{drivers.map((item) => <option key={item.id} value={item.id}>{item.name}{item.phone ? ` · ${item.phone}` : ""}</option>)}</select></label>
        <label className="field"><span>出境口岸</span><select name="borderPort" defaultValue=""><option value="">按工作流选填</option>{data.planningOptions.borderPorts.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <label className="field"><span>清关地</span><select name="customsLocation" defaultValue=""><option value="">按工作流选填</option>{data.planningOptions.customsPlaces.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <label className="field"><span>计划装车</span><input name="plannedLoadingAt" type="datetime-local"/></label>
        <label className="field"><span>计划出境</span><input name="plannedDepartureAt" type="datetime-local"/></label>
        <label className="field"><span>计划到仓</span><input name="plannedArrivalAt" type="datetime-local"/></label>
        <label className="field"><span>线路说明</span><input name="routeNotes" placeholder="按工作流选填"/></label>
        <label className="field span-2"><span>配载说明</span><input name="notes" placeholder="特殊装载、交接或调度说明"/></label>
      </div>
      <div className="loading-selection-summary inline-loading-summary"><span>已选 <strong>{selected.length}</strong> 票</span><span>{totals.packages} 包</span><span>{totals.weight.toFixed(2)} KG</span><span>{totals.volume.toFixed(3)} CBM</span></div>
      <div className="table-wrap module-record-table inline-loading-table"><table><thead><tr><th>选择</th><th>订单 / 客户</th><th>装车仓</th><th>境外目的地</th><th>实收汇总</th><th>状态</th></tr></thead><tbody>{data.planningCandidates.map((item) => {
        const disabled = !compatible(item) && !selectedIds.includes(item.order_id);
        return <tr key={item.order_id} className={selectedIds.includes(item.order_id) ? "selected-row" : ""}><td><input type="checkbox" name="orderIds" value={item.order_id} checked={selectedIds.includes(item.order_id)} disabled={disabled} onChange={(event) => toggle(item.order_id,event.currentTarget.checked)}/></td><td><strong>{item.order_number}</strong><small>{item.customer_name}</small></td><td>{item.warehouse_name}</td><td>{item.overseas_warehouse_name || "未设置"}<small>{[item.destination_country,item.destination_state,item.destination_city].filter(Boolean).join(" ")}</small></td><td>{Number(item.weight_kg).toFixed(2)} KG<small>{Number(item.volume_cbm).toFixed(3)} CBM · {item.package_count} 包</small></td><td>{disabled ? "与当前选择不兼容" : "可配载"}</td></tr>;
      })}</tbody></table></div>
      {!data.planningCandidates.length && <p className="empty-state">当前没有同时满足“已货齐、无异常、未占用、工作流已到配载节点”的订单。</p>}
      <div className="inline-loading-actions"><small>提交时服务端会重新校验全部订单和资源，避免并发占用或跨线路混配。</small><button className="primary" disabled={busy || selected.length < 2 || !carrierId || !vehicleId || !driverId}>{busy ? "正在校验并生成…" : "生成配载单并进入负责人分配"}</button></div>
    </Form>
  </section>;
}

function pageHref(data: { q: string; status: string }, page: number) {
  const params = new URLSearchParams({ q: data.q, status: data.status, page: String(page) });
  return `/admin/loading?${params}`;
}

function orderReferences(value: string | null) {
  return (value || "").split(",").flatMap((reference) => {
    const separator = reference.indexOf("|");
    return separator > 0 ? [{ id: reference.slice(0, separator), number: reference.slice(separator + 1) }] : [];
  });
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "待安排";
}

function roadStatusLabel(value: string) {
  return ({
    planning: "计划中",
    loaded_waiting_exit: "已装车待出境",
    outbound_in_transit: "出境运输中",
    overseas_arrived: "已到境外仓",
    waiting_pickup: "等待客户自提",
    pickup_completed: "已完成自提",
    cancelled: "已取消",
  } as Record<string, string>)[value] || value;
}

function batchApprovalLabel(value: string) {
  return ({ draft: "草稿", submitted: "待操作主管审核", approved: "已审核", rejected: "已退回" } as Record<string, string>)[value] || value;
}

export function meta() { return [{ title: "配载单跟踪 | International TMS" }]; }
