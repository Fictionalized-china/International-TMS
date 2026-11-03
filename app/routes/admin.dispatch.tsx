import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.dispatch";
import { ActionToast } from "../components/ActionToast";
import { OrderNumberLink } from "../components/EntityNumberLink";
import { BatchDispatchFeedbackForm, DispatchFeedbackForm } from "../components/TrackingActionForms";
import { requireSessionUser } from "../lib/auth.server";
import { loadBusinessProcessPolicy } from "../lib/business-process-policy.server";
import { dispatchTaskAccess } from "../lib/dispatch-tasks";
import { fulfillDispatchTask, loadDispatchTaskRows, refreshAutomaticDispatchTasks } from "../lib/dispatch-tasks.server";
import { fulfillBatchFindVehicle, loadBatchFindVehicleTasks } from "../lib/batch-dispatch.server";
import { valueOf } from "../lib/validation";

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "dispatch.view");
  const policy = await loadBusinessProcessPolicy(current.organizationId);
  const unavailable = dispatchTaskAccess(policy, current.positionCode, current.permissions, "fulfill", current.roleCodes);
  await refreshAutomaticDispatchTasks(env.DB, current.organizationId);
  const [orderTasks, batchTasks, carriers, vehicles, drivers] = await Promise.all([
    loadDispatchTaskRows(env.DB, current), loadBatchFindVehicleTasks(current),
    !unavailable ? env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND status='active' AND carrier_scope='overseas' ORDER BY name").bind(current.organizationId).all<{id:string;name:string}>() : { results: [] },
    !unavailable ? env.DB.prepare("SELECT v.id,v.carrier_id,v.plate_number FROM carrier_vehicles v JOIN carriers c ON c.id=v.carrier_id AND c.organization_id=v.organization_id WHERE v.organization_id=? AND v.status='active' AND c.status='active' AND c.carrier_scope='overseas' ORDER BY v.plate_number").bind(current.organizationId).all<{id:string;carrier_id:string;plate_number:string}>() : { results: [] },
    !unavailable ? env.DB.prepare("SELECT d.id,d.carrier_id,d.name FROM carrier_drivers d JOIN carriers c ON c.id=d.carrier_id AND c.organization_id=d.organization_id WHERE d.organization_id=? AND d.status='active' AND c.status='active' AND c.carrier_scope='overseas' ORDER BY d.name").bind(current.organizationId).all<{id:string;carrier_id:string;name:string}>() : { results: [] },
  ]);
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") || "").trim().slice(0, 200);
  const orderId = params.get("orderId") || "";
  const status = ["all", "fulfilled"].includes(params.get("status") || "") ? params.get("status")! : "pending";
  const type = ["ftl", "ltl"].includes(params.get("type") || "") ? params.get("type")! : "all";
  const contains = (values: unknown[]) => values.join(" ").toLocaleLowerCase().includes(q.toLocaleLowerCase());
  return {
    current, canFulfill: !unavailable, unavailable,
    filters: { q, orderId, status, type },
    resources: { carriers: carriers.results, vehicles: vehicles.results, drivers: drivers.results },
    orderTasks: type === "ltl" ? [] : orderTasks.filter(task => (!orderId || task.order_id === orderId) && (status === "all" || task.status === status) && contains([task.order_number, task.customer_name, task.origin_city, task.destination_city, task.carrier_name, task.plate_number, task.driver_name])),
    batchTasks: type === "ftl" || orderId ? [] : batchTasks.filter(task => (status === "all" || (task.carrier_id ? "fulfilled" : "pending") === status) && contains([task.batch_number, task.batch_name, task.order_numbers, task.origin_location, task.destination_location, task.border_port, task.overseas_vehicle_plate, task.overseas_driver_name])),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "dispatch.view");
  if (!current.permissions.includes("dispatch.manage")) throw new Response("没有找车登记权限", { status: 403 });
  const form = await request.formData();
  const value = (key: string) => valueOf(form, key);
  const resources = { current, carrierId: value("carrierId"), vehicleId: value("vehicleId"), driverId: value("driverId"), freightAmount: Number(value("freightAmount")), currency: value("currency"), exchangeRate: Number(value("exchangeRate")), notes: value("notes") };
  try {
    if (value("intent") === "dispatch_fulfill") {
      await fulfillDispatchTask(env.DB, { ...resources, orderId: value("orderId") });
    } else if (value("intent") === "batch_dispatch_fulfill") {
      await fulfillBatchFindVehicle({ ...resources, batchId: value("batchId"), newCarrierName: value("newCarrierName"), newPlateNumber: value("newPlateNumber"), newVehicleType: value("newVehicleType"), newDriverName: value("newDriverName"), newDriverPhone: value("newDriverPhone"), allocationMethod: (value("allocationMethod") || "auto") as "auto" | "weight" | "volume" | "equal" });
    } else return { formError: "未知找车操作" };
    return { success: "资源已保存并反馈操作主管，配载单仍须主管确认后才能交仓库装车。", savedAt: crypto.randomUUID() };
  } catch (error) {
    return { formError: error instanceof Error ? error.message : "找车登记失败，请刷新后重试" };
  }
}

export default function DispatchWorkbench({ loaderData: data, actionData }: Route.ComponentProps) {
  return <div className="tracking-control-center dispatch-workbench">
    <header className="page-header"><div><h1>找车</h1><p>商务按整车订单或拼车配载单落实承运商、车辆、司机与运价，完成后反馈操作主管。</p></div>
      {data.current.permissions.includes("carrier.view") && <Link className="secondary" to="/admin/carriers">承运商与车辆台账</Link>}
    </header>
    <ActionToast data={actionData}/>
    {data.unavailable && <p className="alert info">{data.unavailable}；已登记资源可继续查看。</p>}
    <Form method="get" className="tracking-center-filter dispatch-workbench-filter" role="search">
      {data.filters.orderId && <input type="hidden" name="orderId" value={data.filters.orderId}/>}
      <label><span>查找需求</span><input name="q" defaultValue={data.filters.q} placeholder="订单号、配载单号、线路、车辆或司机"/></label>
      <label><span>找车状态</span><select name="status" defaultValue={data.filters.status}><option value="pending">待找车</option><option value="fulfilled">已落实资源</option><option value="all">全部记录</option></select></label>
      <label><span>需求类型</span><select name="type" defaultValue={data.filters.type}><option value="all">全部需求</option><option value="ltl">拼车配载单</option><option value="ftl">整车订单</option></select></label>
      <div><button className="primary">筛选</button><Link className="secondary" to="/admin/dispatch">重置</Link></div>
    </Form>
    <section className="panel"><div className="panel-header"><div><h2>拼车配载单找车</h2><p>先由操作主管生成并发送配载需求，商务在此登记整批运输资源；不需要逐票重复登记。</p></div><span>{data.batchTasks.length} 张</span></div>
      <div className="table-wrap"><table><thead><tr><th>配载单 / 挂载订单</th><th>线路与口岸</th><th>货物汇总</th><th>计划发车</th><th>运输资源</th><th>办理</th></tr></thead><tbody>
        {data.batchTasks.map(task => <tr key={task.id}><td><strong>{task.batch_number}</strong><small>{task.order_count} 票：{task.order_numbers || "—"}</small></td><td>{task.origin_location} → {task.destination_location}<small>装车仓：{task.warehouse_name || "待补"} · 出境口岸：{task.border_port || "待补"}</small></td><td>{task.package_count} 包 · {Number(task.weight_kg || 0).toFixed(2)} KG<small>{Number(task.volume_cbm || 0).toFixed(3)} CBM</small></td><td>{formatTime(task.planned_departure_at)}</td><td>{task.carrier_id ? <>{task.carrier_name}<small>{task.overseas_vehicle_plate} · {task.overseas_driver_name}</small></> : "待商务落实"}</td><td>{!task.carrier_id && data.canFulfill ? <BatchDispatchFeedbackForm batchId={task.id} batchNumber={task.batch_number} resources={data.resources} closeSignal={actionData?.savedAt} allowNewResources={data.current.permissions.includes("carrier.manage")}/> : task.carrier_id ? "已反馈主管" : "仅查看"}</td></tr>)}
      </tbody></table></div>{!data.batchTasks.length && <p className="empty-state">当前筛选条件下没有配载单找车需求。</p>}
    </section>
    <section className="panel"><div className="panel-header"><h2>整车订单找车</h2><span>{data.orderTasks.length} 单</span></div>
      <div className="table-wrap"><table><thead><tr><th>订单</th><th>计划到口岸</th><th>运输资源</th><th>运价</th><th>状态</th><th>办理</th></tr></thead><tbody>
        {data.orderTasks.map(task => <tr key={task.id}><td>{data.current.permissions.includes("order.view") ? <OrderNumberLink id={task.order_id} number={task.order_number}/> : <strong>{task.order_number}</strong>}<small>{task.customer_name} · {task.origin_city || "待补"} → {task.destination_city || "待补"}</small></td><td>{formatTime(task.planned_port_arrival_at)}</td><td>{[task.carrier_name, task.plate_number, task.driver_name].filter(Boolean).join(" · ") || "待商务落实"}</td><td>{task.freight_amount !== null ? `${task.freight_amount} ${task.freight_currency}` : "—"}</td><td>{task.status === "fulfilled" ? "已落实资源" : "待找车"}</td><td>{data.canFulfill && task.status === "pending" ? <DispatchFeedbackForm orderId={task.order_id} orderNumber={task.order_number} resources={data.resources} closeSignal={actionData?.savedAt}/> : "仅查看"}</td></tr>)}
      </tbody></table></div>{!data.orderTasks.length && <p className="empty-state">当前筛选条件下没有整车找车需求。</p>}
    </section>
  </div>;
}

function formatTime(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "待安排"; }
export function meta() { return [{ title: "找车 | International TMS" }]; }
