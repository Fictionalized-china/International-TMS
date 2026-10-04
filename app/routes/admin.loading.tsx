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
  resumeOperationPlannedBatch,
} from "../lib/loading-batch-planning.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { loadingTrackingFilters } from "../lib/loading-tracking-filters";

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
  sync_pending: number;
  created_by_user_id: string;
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
  const advanced = loadingTrackingFilters(url.searchParams);
  const count = await env.DB.prepare(
    `SELECT COUNT(*) total FROM transport_batches b
      WHERE b.organization_id=? AND b.batch_number LIKE 'PZ%' AND ${visibility.sql} ${statusSql} ${searchSql} ${advanced.sql}`,
  ).bind(current.organizationId, ...visibility.values, ...searchBinds,...advanced.values).first<{ total: number }>();
  const rows = await env.DB.prepare(
    `SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,
            b.planned_departure_at,b.status,b.road_status,b.approval_status,c.name carrier_name,w.name warehouse_name,b.created_by_user_id,
            EXISTS(SELECT 1 FROM loading_planning_submissions ps WHERE ps.organization_id=b.organization_id AND ps.batch_id=b.id AND ps.sync_status='pending') sync_pending,
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
      WHERE b.organization_id=? AND b.batch_number LIKE 'PZ%' AND ${visibility.sql} ${statusSql} ${searchSql} ${advanced.sql}
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?`,
  ).bind(current.organizationId, ...visibility.values, ...searchBinds,...advanced.values, pageSize, (page - 1) * pageSize).all<BatchRow>();

  const canPlan = current.permissions.includes("transport.batch.plan");
  const [planningCandidates, planningOptions] = canPlan
    ? await Promise.all([
        loadLoadingPlanningCandidates(current),
        loadLoadingPlanningOptions(current.organizationId),
      ])
    : [[], { carriers: [], vehicles: [], drivers: [], borderPorts: [], customsPlaces: [], operationMembers: [], documentMembers: [] }];

  return {
    canPlan,
    currentUserId:current.userId,
    requestId:crypto.randomUUID(),
    ...advanced.fields,
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
  const current = await requireSessionUser(request, "transport.batch.plan");
  const form = await request.formData();
  try {
    if (valueOf(form,"intent") === "retry_batch_sync") {
      const saved = await resumeOperationPlannedBatch(current,valueOf(form,"batchId"));
      return {...saved,success:saved.syncPending ? `配载单 ${saved.batchNumber} 已保存，同步仍待完成，请稍后重试` : `配载单 ${saved.batchNumber} 已同步完成，可以继续办理`};
    }
    if (valueOf(form, "intent") !== "create_batch") return { formError: "未知操作" };
    const allocationMethod = valueOf(form, "costAllocationMethod");
    if (!["auto", "weight", "volume", "equal"].includes(allocationMethod)) {
      return { formError: "成本分摊方式无效，请刷新后重试" };
    }
    const created = await createOperationPlannedBatch({
      current,
      requestId:valueOf(form,"requestId"),
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
      operationAssigneeUserId: valueOf(form, "operationAssigneeUserId"),
      documentAssigneeUserId: valueOf(form, "documentAssigneeUserId"),
      costAmount: Number(valueOf(form, "costAmount")),
      costCurrency: valueOf(form, "costCurrency") || "CNY",
      costExchangeRate: Number(valueOf(form, "costExchangeRate")),
      costAllocationMethod: allocationMethod as "auto" | "weight" | "volume" | "equal",
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
      success: created.syncPending ? `配载单 ${created.batchNumber} 已保存，后续同步待完成，无需再次生成` : `配载单 ${created.batchNumber} 已建立，负责人和成本分摊草稿已同步保存`,
      syncPending:created.syncPending,
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
    {actionData && "batchId" in actionData && actionData.batchId && <div className={`alert ${actionData.syncPending ? "warning" : "success"}`}><strong>{actionData.syncPending ? "配载规划已保存，待同步后开放执行" : "配载规划已保存"}</strong>{actionData.syncPending ? <Form method="post"><input type="hidden" name="intent" value="retry_batch_sync"/><input type="hidden" name="batchId" value={actionData.batchId}/><button className="secondary" disabled={busy}>重试同步</button></Form> : <Link className="text-button" to={`/admin/loading/${actionData.batchId}`}>进入配载单办理 →</Link>}</div>}
    {loaderData.canPlan && <BatchPlanningPanel data={loaderData} busy={busy}/>}
    <section className="panel loading-tracking-filter-panel">
      <Form method="get" action="." className="filter-bar compact loading-tracking-filter">
        <label className="field loading-tracking-filter__query"><span>配载单号或订单号</span><input name="q" defaultValue={loaderData.q} placeholder="输入配载单号或子订单号" /></label>
        <label className="field loading-tracking-filter__status"><span>状态</span><select name="status" defaultValue={loaderData.status}><option value="all">全部</option><option value="active">执行中</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></label>
        <div className="loading-tracking-filter__actions"><button className="primary">查询</button><Link className="secondary" to="/admin/loading">重置</Link></div>
        <details className="inline-details advanced-filter loading-tracking-filter__advanced" open={Boolean(loaderData.warehouse||loaderData.destination||loaderData.customer||loaderData.departureFrom||loaderData.departureTo)}><summary>高级筛选</summary><div className="filter-help form-grid compact">
          <label className="field"><span>装车仓</span><input name="warehouse" defaultValue={loaderData.warehouse} placeholder="仓库名称"/></label>
          <label className="field"><span>目的地</span><input name="destination" defaultValue={loaderData.destination} placeholder="目的仓或地区"/></label>
          <label className="field span-2"><span>客户</span><input name="customer" defaultValue={loaderData.customer} placeholder="客户名称"/></label>
          <label className="field"><span>计划发车从</span><input type="date" name="departureFrom" defaultValue={loaderData.departureFrom}/></label>
          <label className="field"><span>计划发车至</span><input type="date" name="departureTo" defaultValue={loaderData.departureTo}/></label>
          <button className="primary span-2">应用高级筛选</button>
        </div></details>
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
        <td><span className={`status-pill ${batch.approval_status==="approved"?"success":batch.approval_status==="rejected"?"danger":""}`}>{batch.sync_pending ? "已保存 · 待同步" : batchApprovalLabel(batch.approval_status)}</span><small>{roadStatusLabel(batch.road_status)}</small></td>
        <td>{Boolean(batch.sync_pending)&&loaderData.canPlan&&batch.created_by_user_id===loaderData.currentUserId ? <Form method="post"><input type="hidden" name="intent" value="retry_batch_sync"/><input type="hidden" name="batchId" value={batch.id}/><button className="secondary" disabled={busy}>重试同步</button></Form> : <Link className={batch.approval_status==="submitted"?"primary":"text-button"} to={`/admin/loading/${batch.id}`}>{batch.approval_status==="submitted"?"审核并指派":"查看配载单"}</Link>}</td>
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
  const [costAmount, setCostAmount] = useState("");
  const [costCurrency,setCostCurrency] = useState("CNY");
  const [costExchangeRate, setCostExchangeRate] = useState("1");
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
    receivable: sum.receivable + Number(item.receivable_base_amount || 0),
  }), { weight: 0, volume: 0, packages: 0, receivable: 0 }), [selected]);
  const costBaseAmount = Number(costAmount || 0) * Number(costExchangeRate || 0);
  const estimatedProfit = totals.receivable - costBaseAmount;
  const vehicles = data.planningOptions.vehicles.filter((item) => item.carrier_id === carrierId);
  const drivers = data.planningOptions.drivers.filter((item) => item.carrier_id === carrierId);
  const toggle = (id: string, checked: boolean) => setSelectedIds((current) => checked
    ? [...new Set([...current, id])]
    : current.filter((item) => item !== id));
  return <section className="panel inline-loading-workbench">
    <div className="panel-header"><div><h2>配载规划</h2><p>先由商务在“承运商管理”录入境外承运商、车辆和司机；再由操作主管按同仓、同目的仓和同线路勾选订单。</p></div><span className="status-pill">{data.planningCandidates.length} 票可配载</span></div>
    <Form method="post">
      <input type="hidden" name="intent" value="create_batch"/>
      <input type="hidden" name="requestId" value={data.requestId}/>
      <div className="form-grid compact loading-batch-fields">
        <label className="field"><span>配载单名称</span><input name="batchName" placeholder="留空自动生成"/></label>
        <label className="field"><span>境外承运商 *</span><select name="carrierId" value={carrierId} required onChange={(event) => { setCarrierId(event.currentTarget.value); setVehicleId(""); setDriverId(""); }}><option value="">请选择商务已录入资源</option>{data.planningOptions.carriers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field"><span>境外车辆 *</span><select name="vehicleId" value={vehicleId} required disabled={!carrierId} onChange={(event) => setVehicleId(event.currentTarget.value)}><option value="">{carrierId ? "请选择车辆" : "请先选择承运商"}</option>{vehicles.map((item) => <option key={item.id} value={item.id}>{item.plate_number}{item.vehicle_type ? ` · ${item.vehicle_type}` : ""}</option>)}</select></label>
        <label className="field"><span>境外司机 *</span><select name="driverId" value={driverId} required disabled={!carrierId} onChange={(event) => setDriverId(event.currentTarget.value)}><option value="">{carrierId ? "请选择司机" : "请先选择承运商"}</option>{drivers.map((item) => <option key={item.id} value={item.id}>{item.name}{item.phone ? ` · ${item.phone}` : ""}</option>)}</select></label>
        <label className="field"><span>整批操作负责人 *</span><select name="operationAssigneeUserId" required defaultValue=""><option value="">请选择操作岗账号</option>{data.planningOptions.operationMembers.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
        <label className="field"><span>整批单证负责人 *</span><select name="documentAssigneeUserId" required defaultValue=""><option value="">请选择单证岗账号</option>{data.planningOptions.documentMembers.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
        <label className="field"><span>境外运输成本 *</span><input name="costAmount" type="number" min="0.01" step="0.01" required value={costAmount} onChange={(event) => setCostAmount(event.currentTarget.value)} placeholder="输入承运资源报价"/></label>
        <label className="field"><span>成本币种 *</span><select name="costCurrency" value={costCurrency} onChange={(event) => {setCostCurrency(event.currentTarget.value);setCostExchangeRate(event.currentTarget.value === "CNY" ? "1" : "");}}><option value="CNY">CNY</option><option value="USD">USD</option><option value="RUB">RUB</option><option value="KZT">KZT</option><option value="UZS">UZS</option></select></label>
        <label className="field"><span>折算汇率 *</span><input name="costExchangeRate" type="number" min="0.000001" step="0.000001" required readOnly={costCurrency === "CNY"} placeholder="录入实际汇率" value={costExchangeRate} onChange={(event) => setCostExchangeRate(event.currentTarget.value)}/></label>
        <label className="field"><span>成本分摊方式 *</span><select name="costAllocationMethod" defaultValue="auto"><option value="auto">按 1:300 抛重比自动建议</option><option value="weight">按实收重量</option><option value="volume">按实收体积</option><option value="equal">按订单均分</option></select></label>
      </div>
      <details className="inline-details"><summary>口岸、时间与补充说明</summary><div className="form-grid compact loading-batch-fields">
        <label className="field"><span>出境口岸</span><select name="borderPort" defaultValue=""><option value="">按工作流选填</option>{data.planningOptions.borderPorts.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <label className="field"><span>清关地</span><select name="customsLocation" defaultValue=""><option value="">按工作流选填</option>{data.planningOptions.customsPlaces.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <label className="field"><span>计划装车</span><input name="plannedLoadingAt" type="datetime-local"/></label>
        <label className="field"><span>计划出境</span><input name="plannedDepartureAt" type="datetime-local"/></label>
        <label className="field"><span>计划到仓</span><input name="plannedArrivalAt" type="datetime-local"/></label>
        <label className="field"><span>线路说明</span><input name="routeNotes" placeholder="按工作流选填"/></label>
        <label className="field span-2"><span>配载说明</span><input name="notes" placeholder="特殊装载、交接或调度说明"/></label>
      </div></details>
      <div className="loading-selection-summary inline-loading-summary"><span>已选 <strong>{selected.length}</strong> 票</span><span>{totals.packages} 包</span><span>{totals.weight.toFixed(2)} KG</span><span>{totals.volume.toFixed(3)} CBM</span><span>应收折算 {totals.receivable.toFixed(2)}</span><span>成本折算 {Number(costExchangeRate)>0 ? costBaseAmount.toFixed(2) : "待填写汇率"}</span><span>预计毛利 <strong>{Number(costExchangeRate)>0 ? estimatedProfit.toFixed(2) : "待填写汇率"}</strong></span></div>
      <div className="table-wrap module-record-table inline-loading-table"><table><thead><tr><th>选择</th><th>订单 / 客户</th><th>装车仓</th><th>境外目的地</th><th>实收汇总</th><th>状态</th></tr></thead><tbody>{data.planningCandidates.map((item) => {
        const disabled = !compatible(item) && !selectedIds.includes(item.order_id);
        return <tr key={item.order_id} className={selectedIds.includes(item.order_id) ? "selected-row" : ""}><td><input type="checkbox" name="orderIds" aria-label={`选择订单 ${item.order_number}`} value={item.order_id} checked={selectedIds.includes(item.order_id)} disabled={disabled} onChange={(event) => toggle(item.order_id,event.currentTarget.checked)}/></td><td><strong>{item.order_number}</strong><small>{item.customer_name}</small></td><td>{item.warehouse_name}</td><td>{item.overseas_warehouse_name || "未设置"}<small>{[item.destination_country,item.destination_state,item.destination_city].filter(Boolean).join(" ")}</small></td><td>{Number(item.weight_kg).toFixed(2)} KG<small>{Number(item.volume_cbm).toFixed(3)} CBM · {item.package_count} 包</small></td><td>{disabled ? "与当前选择不兼容" : "可配载"}</td></tr>;
      })}</tbody></table></div>
      {!data.planningCandidates.length && <p className="empty-state">当前没有同时满足“已货齐、无异常、未占用、工作流已到配载节点”的订单。</p>}
      <div className="inline-loading-actions"><small>提交时会重新校验订单、运输资源、负责人和成本；一次生成配载单并保存成本分摊草稿。</small><button className="primary" disabled={busy || selected.length < 2 || !carrierId || !vehicleId || !driverId || Number(costAmount) <= 0 || Number(costExchangeRate)<=0}>{busy ? "正在校验并生成…" : "确认资源、负责人和成本并生成配载单"}</button></div>
    </Form>
  </section>;
}

function pageHref(data: { q: string; status: string } & Record<"warehouse"|"destination"|"customer"|"departureFrom"|"departureTo",string>, page: number) {
  const params = new URLSearchParams({ q:data.q,status:data.status,warehouse:data.warehouse,destination:data.destination,
    customer:data.customer,departureFrom:data.departureFrom,departureTo:data.departureTo,page:String(page) });
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
