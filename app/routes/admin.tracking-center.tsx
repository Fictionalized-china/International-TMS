import { Form, Link, redirect } from "react-router";
import { env } from "cloudflare:workers";
import type { Route } from "./+types/admin.tracking-center";
import { AppIcon } from "../components/AppIcon";
import { OrderNumberLink } from "../components/EntityNumberLink";
import { QueryPagination } from "../components/QueryPagination";
import { requireSessionUser } from "../lib/auth.server";
import { TransportExecutionTabs } from "../components/TransportExecutionTabs";
import { loadTrackingCenter } from "../lib/tracking-center.server";
import { loadBusinessProcessPolicy } from "../lib/business-process-policy.server";
import { policyEnabled,policyPositions } from "../lib/business-process-policy";
import { dispatchTaskAccess } from "../lib/dispatch-tasks";
import { isBossBusinessActor } from "../lib/permission-blocks";
import { refreshAutomaticDispatchTasks,requestDispatchTask } from "../lib/dispatch-tasks.server";
import { recordDailyTracking } from "../lib/daily-tracking.server";
import { DailyTrackingForm,DispatchRequestForm } from "../components/TrackingActionForms";
import { canViewTrackingCenter } from "../lib/transport-workspace-access";
import { sessionSlotFromRequest, withSessionSlot } from "../lib/session-slot";

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request);
  if (current.permissions.includes("dispatch.view") && (!canViewTrackingCenter(current) || new URL(request.url).searchParams.has("dispatchTask"))) {
    return redirect(withSessionSlot("/admin/dispatch", sessionSlotFromRequest(request)));
  }
  if (!canViewTrackingCenter(current)) throw new Response("当前账号没有调度与运踪总览权限", { status: 403 });
  const policy=await loadBusinessProcessPolicy(current.organizationId);
  await refreshAutomaticDispatchTasks(env.DB,current.organizationId);
  const canRequest=!dispatchTaskAccess(policy,current.positionCode,current.permissions,"request",current.roleCodes);
  const borderPorts=canRequest?(await env.DB.prepare("SELECT code,name FROM reference_data WHERE organization_id=? AND category='border_port' AND status='active' ORDER BY sort_order,name").bind(current.organizationId).all<{code:string;name:string}>()).results:[];
  return { current,policy,canRequest,borderPorts,requestId:crypto.randomUUID(),canDaily:policyEnabled(policy,"tracking.daily_enabled")&&(isBossBusinessActor(current)||(policyPositions(policy,"tracking.positions").includes(current.positionCode??"")&&current.permissions.includes("tracking.daily.manage"))), ...(await loadTrackingCenter(request, current)) };
}

export async function action({request}:Route.ActionArgs) {
  const current=await requireSessionUser(request,"shipment.view");
  if (!canViewTrackingCenter(current)) throw new Response("当前账号没有调度与运踪总览权限", { status: 403 });
  const form=await request.formData(),value=(key:string)=>String(form.get(key)??"");
  // A datetime-local field here is explicitly labelled Beijing time, not server-local time.
  const beijingTime=(key:string)=>{const time=value(key);return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time)?`${time}:00+08:00`:time;};
  try {
    switch(value("intent")) {
      case "daily":await recordDailyTracking(env.DB,{current,orderId:value("orderId"),requestId:value("requestId"),eventKind:value("eventKind"),eventAt:beijingTime("eventAt"),location:value("location"),vehicleReference:value("vehicleReference"),notes:value("notes"),visibleToCustomer:value("visible")==="1"});break;
      case "dispatch_request":await requestDispatchTask(env.DB,{current,orderId:value("orderId"),plannedPortArrivalAt:beijingTime("plannedPortArrivalAt"),exitPort:value("exitPort"),planOnly:value("planOnly")==="1"});break;
      default:throw new Error("未知操作");
    }
    return {success:"已保存，相关岗位待办与客户端可见轨迹会同步更新。",savedAt:crypto.randomUUID()};
  }catch(error){return {formError:error instanceof Error?error.message:"登记失败，请稍后重试"};}
}

export default function TrackingCenter({ loaderData,actionData }: Route.ComponentProps) {
  const { summary } = loaderData;
  const kpis = [
    { label: "运输任务", value: summary.total, hint: "当前权限范围", icon: "truck" as const, href: "/admin/tracking-center" },
    { label: "待调度", value: summary.pendingDispatch, hint: "尚未安排车辆或批次", icon: "clipboardCheck" as const, href: "/admin/tracking-center?dispatch=pending_dispatch" },
    { label: "运输执行中", value: summary.inTransit, hint: "车辆已经进入在途", icon: "map" as const, href: "/admin/tracking-center?dispatch=in_transit" },
    { label: "时效预警", value: summary.warnings, hint: "超时、异常或久未更新", icon: "bell" as const, href: "/admin/tracking-center?warning=attention" },
    { label: "已完成", value: summary.completed, hint: "到仓、签收或自提完成", icon: "packageCheck" as const, href: "/admin/tracking-center?dispatch=completed" },
  ];
  return <div className="tracking-control-center">
    <header className="page-header tracking-center-header">
      <div><p className="eyebrow">DISPATCH &amp; TRACKING CONTROL</p><h1>调度与运踪</h1><p>一个入口查看调度安排、在途状态、时效预警与客户端轨迹同步。</p></div>
      <div className="page-actions"><Link className="secondary" to="/admin/workbenches/tracking">我的运踪待办</Link><Link className="secondary" to="/admin/loading?view=tracking">配载单运踪</Link><Link className="primary" to="/admin/domestic-tracking">运输执行台账</Link></div>
    </header>
    <TransportExecutionTabs user={loaderData.current} />
    {actionData?.formError&&<p className="alert danger" role="alert">{actionData.formError}</p>}{actionData?.success&&<p className="alert success" role="status">{actionData.success}</p>}

    <nav className="tracking-center-kpis" aria-label="调度与运踪汇总">
      {kpis.map((item) => <Link key={item.label} to={item.href}><span><AppIcon name={item.icon}/></span><div><small>{item.label}</small><strong>{item.value}</strong><em>{item.hint}</em></div></Link>)}
    </nav>

    <section className="panel tracking-center-panel">
      <div className="panel-header"><div><h2>全程运输监控</h2><p>这里按订单展示预警；拼车订单请进入配载单整批登记，系统会同步挂载订单。</p></div><span className="status-pill">{loaderData.pagination.total} 票</span></div>
      <Form method="get" className="tracking-center-filter">
        <label><span>快速定位</span><input name="q" defaultValue={loaderData.filters.q} placeholder="订单、客户、线路、车辆、配载单或负责人" /></label>
        <label><span>调度状态</span><select name="dispatch" defaultValue={loaderData.filters.dispatch}><option value="">全部</option><option value="pending_dispatch">待调度</option><option value="scheduled">已调度待发运</option><option value="in_transit">运输执行中</option><option value="completed">已完成</option></select></label>
        <label><span>时效状态</span><select name="warning" defaultValue={loaderData.filters.warning}><option value="">全部</option><option value="attention">全部预警</option><option value="normal">时效正常</option><option value="upcoming">{loaderData.thresholds.dueWarningHours}小时内到期</option><option value="overdue">已超时</option><option value="stale">超过{loaderData.thresholds.staleWarningHours}小时未更新</option><option value="exception">运输异常</option></select></label>
        <label><span>订单类型</span><select name="businessType" defaultValue={loaderData.filters.businessType}><option value="">全部</option><option value="ftl">整车</option><option value="ltl">拼车</option></select></label>
        <div><button className="primary">筛选</button><Link className="secondary" to="/admin/tracking-center">重置</Link></div>
      </Form>

      <div className="table-wrap tracking-center-table"><table><thead><tr><th>调度 / 时效</th><th>订单 / 客户</th><th>线路 / 当前节点</th><th>车辆与批次</th><th>计划与动态</th><th>客户端运踪</th><th className="sticky-action">操作</th></tr></thead><tbody>
        {loaderData.rows.map((row) => <tr key={row.order_id}>
          <td><span className="status-pill">{row.dispatch.label}</span><small className={`tracking-warning ${row.warning.tone}`}>{row.warning.label}</small></td>
          <td><strong><OrderNumberLink id={row.order_id} number={row.order_number}/></strong><small>{row.customer_name} · {row.business_type === "ftl" ? "整车" : "拼车"}</small></td>
          <td><strong>{row.origin_city || "起运地待补"} → {row.destination_city || "目的地待补"}</strong><small>{row.current_step_name || "节点待更新"} · {row.owner_name || "负责人待指派"}</small></td>
          <td><strong>{row.batch_number || row.assignment_carrier || "尚未调度"}</strong><small>{row.batch_plate || row.assignment_plate || "车辆待安排"}</small></td>
          <td><strong>{row.latest_event || "暂无轨迹"}</strong><small>{row.latest_location || "地点待更新"} · {formatTime(row.latest_event_at)}</small></td>
          <td><strong>{row.client_visible_event_count} 条客户可见</strong><small>{row.client_latest_event_at ? `最近同步 ${formatTime(row.client_latest_event_at)}` : "尚未发布客户轨迹"}</small></td>
          <td className="sticky-action"><div className="row-actions">{loaderData.canDaily&&!row.batch_id&&row.order_status==="in_execution"&&!row.actual_arrival_at&&<DailyTrackingForm orderId={row.order_id} orderNumber={row.order_number} requestId={loaderData.requestId} closeSignal={actionData?.savedAt}/>} {loaderData.canRequest&&row.business_type==="ftl"&&row.order_status==="in_execution"&&<DispatchRequestForm orderId={row.order_id} orderNumber={row.order_number} currentExitPort={row.exit_port} borderPorts={loaderData.borderPorts} requireExitPort={loaderData.policy["dispatch.required_order_fields"].split(",").includes("exit_port")} closeSignal={actionData?.savedAt}/>} {row.batch_id ? <Link className="text-button" to={`/admin/loading/${row.batch_id}?tab=tracking`}>办理配载单运踪</Link> : <Link className="text-button" to={`/admin/orders/${row.order_id}/modules/tracking`}>办理订单运踪</Link>}</div></td>
        </tr>)}
      </tbody></table>{!loaderData.rows.length && <p className="empty-state">当前筛选条件下没有运输任务。</p>}</div>
      <QueryPagination {...loaderData.pagination} unit="票任务"/>
    </section>
  </div>;
}

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "待更新";
}

export function meta() { return [{ title: "调度与运踪 | International TMS" }]; }
