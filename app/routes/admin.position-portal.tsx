import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.position-portal";
import { OrderNumberLink } from "../components/EntityNumberLink";
import { requireSessionUser } from "../lib/auth.server";
import { canSeeScopedOrder, canViewAllOrders } from "../lib/order-access.server";
import {
  orderNextGuidance,
  type GuidanceModule,
} from "../lib/order-guidance";
import { orderResponsiblePosition } from "../lib/order-responsibility";
import type { OrderModuleCode } from "../lib/order-modules";

type PortalModuleRow = GuidanceModule & {
  order_id: string;
  order_number: string;
  order_status: string;
  business_type: string;
  customer_name: string;
  origin_city: string;
  destination_city: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  is_overdue: number;
  updated_at: string;
  salesperson_user_id: string | null;
  created_by_user_id: string | null;
  customer_sales_owner_user_id: string | null;
};

type WorkflowTaskRow = {
  order_id: string;
  step_key: string;
  step_name: string;
  module_code: string;
  module_name: string;
  task_name: string;
  task_status: string;
  position_code: string | null;
  position_name: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
};

type FilterOption = { id: string; name: string };

type PortalSettings = {
  order_scope: "current_position" | "all_orders";
  default_filter: "open" | "all" | "blocked" | "overdue";
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request);
  const url = new URL(request.url);
  if (!current.permissions.includes("order.view")) {
    return {
      current,
      orders: [] as never[],
      canViewAll: false,
      accessLimited: true,
      summary: { open: 0, blocked: 0, overdue: 0 },
      positions: [] as FilterOption[],
      assignees: [] as FilterOption[],
      filters: {
        state: "open",
        stage: "",
        businessType: "",
        position: "",
        assignee: "",
        q: "",
      },
    };
  }
  const settings = current.positionCode
    ? await env.DB.prepare(
      `SELECT pps.order_scope,pps.default_filter
       FROM positions p LEFT JOIN position_portal_settings pps
         ON pps.position_id=p.id AND pps.organization_id=p.organization_id
       WHERE p.organization_id=? AND p.code=?`,
    ).bind(current.organizationId, current.positionCode).first<PortalSettings>()
    : null;
  const canViewAll = canViewAllOrders(current);
  const requestedFilter = url.searchParams.get("state");
  const stateFilter = ["open", "all", "blocked", "overdue"].includes(requestedFilter || "")
    ? requestedFilter!
    : settings?.default_filter || "open";
  const stageFilter = url.searchParams.get("stage") || "";
  const businessTypeFilter = url.searchParams.get("businessType") || "";
  const positionFilter = url.searchParams.get("position") || "";
  const assigneeFilter = url.searchParams.get("assignee") || "";
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();

  const [rows, workflowTasks, positions, assignees] = await env.DB.batch([
    env.DB.prepare(
    `SELECT o.id order_id,o.order_number,o.status order_status,o.business_type,
            o.origin_city,o.destination_city,o.pieces,o.gross_weight_kg,o.volume_cbm,
            o.is_overdue,o.salesperson_user_id,o.created_by_user_id,
            c.sales_owner_user_id customer_sales_owner_user_id,c.name customer_name,
            m.module_code,m.module_name,m.enabled,m.is_required,m.status,
            m.current_step_code,m.current_step_name,m.blocking_reason,
            m.progress_percent,u.display_name assignee_name,
            MAX(o.updated_at,m.updated_at) updated_at
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       JOIN order_module_instances m ON m.order_id=o.id AND m.organization_id=o.organization_id
       LEFT JOIN users u ON u.id=m.assignee_user_id
      WHERE o.organization_id=? AND m.enabled=1
      ORDER BY o.is_overdue DESC,o.updated_at DESC,m.updated_at DESC`,
    ).bind(current.organizationId),
    env.DB.prepare(
      `SELECT wi.order_id,ss.step_key,ss.step_name,ms.module_code,ms.display_name module_name,
              ts.name task_name,ts.status task_status,
              COALESCE(ts.responsibility_position_code,ms.responsibility_position_code) position_code,
              p.name position_name,COALESCE(ts.assignee_user_id,omi.assignee_user_id) assignee_user_id,
              u.display_name assignee_name
         FROM workflow_instances wi
         JOIN workflow_instance_step_states ss
           ON ss.instance_id=wi.id AND ss.step_key=wi.current_step_key
         JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
         JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
         LEFT JOIN positions p ON p.organization_id=wi.organization_id
           AND p.code=COALESCE(ts.responsibility_position_code,ms.responsibility_position_code)
         LEFT JOIN order_module_instances omi ON omi.organization_id=wi.organization_id
           AND omi.order_id=wi.order_id AND omi.module_code=ms.module_code
         LEFT JOIN users u ON u.id=COALESCE(ts.assignee_user_id,omi.assignee_user_id)
        WHERE wi.organization_id=? AND ts.status!='completed'
        ORDER BY ss.sort_order,ms.sort_order,ts.sort_order`,
    ).bind(current.organizationId),
    env.DB.prepare(
      "SELECT code id,name FROM positions WHERE organization_id=? AND status='active' ORDER BY name",
    ).bind(current.organizationId),
    env.DB.prepare(
      `SELECT u.id,u.display_name name FROM memberships m
       JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=? AND m.status='active' ORDER BY u.display_name`,
    ).bind(current.organizationId),
  ]);

  const portalRows = rows as D1Result<PortalModuleRow>;
  const portalWorkflowTasks = workflowTasks as D1Result<WorkflowTaskRow>;
  const portalPositions = positions as D1Result<FilterOption>;
  const portalAssignees = assignees as D1Result<FilterOption>;

  const currentTaskByOrder = new Map<string, WorkflowTaskRow>();
  for (const task of portalWorkflowTasks.results) {
    if (!currentTaskByOrder.has(task.order_id)) currentTaskByOrder.set(task.order_id, task);
  }

  const modulesByOrder = new Map<string, PortalModuleRow[]>();
  for (const row of portalRows.results) {
    const modules = modulesByOrder.get(row.order_id) ?? [];
    modules.push(row);
    modulesByOrder.set(row.order_id, modules);
  }

  const allOrders = [...modulesByOrder.values()].map((modules) => {
    const order = modules[0];
    const guidance = orderNextGuidance({
      orderId: order.order_id,
      orderStatus: order.order_status,
      modules,
    });
    const moduleCode = guidance.moduleCode as OrderModuleCode | null;
    const workflowTask = currentTaskByOrder.get(order.order_id);
    const effectiveModuleCode = (workflowTask?.module_code || moduleCode) as OrderModuleCode | null;
    const responsible = workflowTask?.position_code
      ? { code: workflowTask.position_code, name: workflowTask.position_name || workflowTask.position_code }
      : orderResponsiblePosition(effectiveModuleCode, order.order_status);
    const target = effectiveModuleCode
      ? modules.find((module) => module.module_code === effectiveModuleCode)
      : null;
    return {
      order_id: order.order_id,
      order_number: order.order_number,
      customer_name: order.customer_name,
      order_status: order.order_status,
      business_type: order.business_type,
      is_overdue: order.is_overdue,
      origin_city: order.origin_city,
      destination_city: order.destination_city,
      pieces: order.pieces,
      gross_weight_kg: order.gross_weight_kg,
      volume_cbm: order.volume_cbm,
      current_stage_code: workflowTask?.step_key || guidance.stage.code,
      current_stage_name: workflowTask?.step_name || guidance.stage.shortTitle,
      current_module_name: workflowTask?.module_name || target?.module_name || "业务主流程",
      current_step_name: workflowTask?.task_name || target?.current_step_name || guidance.action,
      module_status: target?.status || (order.order_status === "completed" ? "completed" : "not_started"),
      assignee_user_id: workflowTask?.assignee_user_id || null,
      assignee_name: workflowTask?.assignee_name || target?.assignee_name || null,
      next_action: guidance.action,
      blocker: guidance.blocker,
      responsible_position_code: responsible.code,
      responsible_position_name: responsible.name,
      salesperson_user_id: order.salesperson_user_id,
      created_by_user_id: order.created_by_user_id,
      customer_sales_owner_user_id: order.customer_sales_owner_user_id,
      href: effectiveModuleCode
        ? `/admin/orders/${order.order_id}/modules/${effectiveModuleCode}#module-business-data`
        : guidance.href,
      updated_at: order.updated_at,
    };
  });

  const scopedOrders = allOrders.filter((order) => canSeeScopedOrder(current, order));
  const visible = scopedOrders.filter((order) => {
    if (stateFilter === "open" && ["completed", "cancelled"].includes(order.order_status)) return false;
    if (stateFilter === "blocked" && !order.blocker) return false;
    if (stateFilter === "overdue" && !order.is_overdue) return false;
    if (stageFilter && order.current_stage_code !== stageFilter) return false;
    if (businessTypeFilter && order.business_type !== businessTypeFilter) return false;
    if (positionFilter && order.responsible_position_code !== positionFilter) return false;
    if (assigneeFilter && order.assignee_user_id !== assigneeFilter) return false;
    if (query && !`${order.order_number} ${order.customer_name} ${order.origin_city} ${order.destination_city} ${order.current_stage_name} ${order.current_module_name} ${order.current_step_name} ${order.responsible_position_name} ${order.assignee_name || ""}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((left, right) => {
    if (left.is_overdue !== right.is_overdue) return right.is_overdue - left.is_overdue;
    if (Boolean(left.blocker) !== Boolean(right.blocker)) return left.blocker ? -1 : 1;
    return right.updated_at.localeCompare(left.updated_at);
  });

  return {
    current,
    orders: visible,
    canViewAll,
    accessLimited: false,
    summary: {
      open: scopedOrders.filter((order) => !["completed", "cancelled"].includes(order.order_status)).length,
      blocked: scopedOrders.filter((order) => Boolean(order.blocker)).length,
      overdue: scopedOrders.filter((order) => Boolean(order.is_overdue)).length,
    },
    positions: portalPositions.results,
    assignees: portalAssignees.results,
    filters: {
      state: stateFilter,
      stage: stageFilter,
      businessType: businessTypeFilter,
      position: positionFilter,
      assignee: assigneeFilter,
      q: url.searchParams.get("q") || "",
    },
  };
}

export function meta() {
  return [{ title: "任务工作台 | International TMS" }];
}

export default function PositionPortal({ loaderData }: Route.ComponentProps) {
  const { current, orders, canViewAll, filters, summary, accessLimited } = loaderData;
  const advancedFilterCount = [filters.stage, filters.businessType, filters.position, filters.assignee].filter(Boolean).length;
  return <>
    <header className="page-header position-portal-header">
      <div><p className="eyebrow">TASK WORKBENCH</p><h1>任务工作台</h1><p>{current.displayName} · {canViewAll ? "可查看全部订单" : "只显示当前由本岗位负责推进的订单"} · 点击订单直接进入对应办理模组</p></div>
      <div className="page-actions"><span className="status-pill">当前显示 {orders.length} 条</span></div>
    </header>

    {accessLimited ? <section className="panel"><div className="empty-state"><strong>当前岗位仅用于组织与薪资归类</strong><p>尚未配置订单或业务数据权限；如需承担业务，请由人事行政岗或老板增加对应权限积木。</p></div></section> : <section className="panel position-order-ledger">
      <div className="position-ledger-summary" aria-label="待办概况"><span>未完成 <strong>{summary.open}</strong></span><span>有阻断 <strong>{summary.blocked}</strong></span><span>已超时 <strong>{summary.overdue}</strong></span><span>当前视图 <strong>{orders.length}</strong></span></div>
      <Form method="get" action="." className="position-ledger-filters">
        <div className="position-primary-filters">
          <input name="q" defaultValue={filters.q} placeholder="订单、客户、线路、节点、岗位或人员" />
          <select name="state" defaultValue={filters.state}><option value="open">未完成</option><option value="blocked">有阻断</option><option value="overdue">即将/已经超时</option>{canViewAll&&<option value="all">全部订单</option>}</select>
          <button className="primary">查询任务</button><Link className="text-button" to="/admin/portal">重置</Link>
        </div>
        <details className="position-advanced-filters" open={advancedFilterCount > 0}>
          <summary><span>更多筛选条件</span><small>{advancedFilterCount ? `已启用 ${advancedFilterCount} 项` : "阶段、类型、岗位和负责人"}</small></summary>
          <div className="position-advanced-filter-grid">
            <label><span>业务阶段</span><select name="stage" defaultValue={filters.stage}><option value="">全部阶段</option><option value="order_creation">订单创建</option><option value="consignment_approval">委托审核</option><option value="task_assignment">任务分配</option><option value="domestic_execution">国内运输</option><option value="warehouse_receiving">仓库入库</option><option value="port_loading">出口准备</option><option value="outbound_transport">出境运输</option><option value="overseas_pickup">境外仓自提</option><option value="reconciliation">对账结算</option><option value="completion_review">完成复盘</option></select></label>
            <label><span>订单类型</span><select name="businessType" defaultValue={filters.businessType}><option value="">全部类型</option><option value="ftl">整车</option><option value="ltl">拼车</option></select></label>
            <label><span>负责岗位</span><select name="position" defaultValue={filters.position}><option value="">全部负责岗位</option>{loaderData.positions.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label><span>具体负责人</span><select name="assignee" defaultValue={filters.assignee}><option value="">全部负责人</option>{loaderData.assignees.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          </div>
        </details>
      </Form>
      <div className="table-wrap position-ledger-table"><table><thead><tr><th>状态</th><th>订单 / 客户</th><th>线路 / 货量</th><th>当前节点 / 模组</th><th>负责岗位 / 人员</th><th>下一步与阻断</th><th className="sticky-action">操作</th></tr></thead><tbody>{orders.map(order=><tr key={order.order_id} className={order.blocker?"row-blocked":""}>
        <td><span className={`status-pill ${order.is_overdue?"danger":""}`}>{order.is_overdue?"超时":orderStatusLabel(order.order_status)}</span></td>
        <td><strong><OrderNumberLink id={order.order_id} number={order.order_number}/></strong><small>{order.customer_name}</small></td>
        <td><strong>{order.origin_city || "起运地待补"} → {order.destination_city || "目的地待补"}</strong><small>{order.business_type==="ftl"?"整车":order.business_type==="ltl"?"拼车":"待确定"} · {order.pieces || 0} 件 · {Number(order.gross_weight_kg || 0).toFixed(2)} KG · {Number(order.volume_cbm || 0).toFixed(3)} CBM</small></td>
        <td><strong>{order.current_stage_name}</strong><small>{order.current_module_name} · {order.current_step_name}</small></td>
        <td><strong>{order.responsible_position_name}</strong><small>{order.assignee_name||"待分配"}</small></td>
        <td><strong>{order.next_action}</strong><small className={order.blocker?"danger-text":""}>{order.blocker||"当前节点暂无阻断"}</small></td>
        <td className="sticky-action"><Link className="text-button" to={order.href}>{order.blocker?"查看阻断并处理":"打开当前节点"}</Link></td>
      </tr>)}</tbody></table>{!orders.length&&<p className="empty-state">当前筛选条件下没有订单。</p>}</div>
    </section>}
  </>;
}

function orderStatusLabel(status: string) {
  return ({draft:"草稿",submitted:"待审批",confirmed:"待派单",in_execution:"执行中",completed:"已完成",cancelled:"已取消"} as Record<string,string>)[status] || status;
}
