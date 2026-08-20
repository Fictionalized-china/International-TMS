import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.position-portal";
import { requireSessionUser } from "../lib/auth.server";
import { positionPortalForUser, visiblePortalLinks } from "../lib/position-portal";
import {
  buildStageSnapshots,
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
  is_overdue: number;
  updated_at: string;
};

type PortalSettings = {
  order_scope: "current_position" | "all_orders";
  default_filter: "open" | "all" | "blocked" | "overdue";
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  const config = positionPortalForUser(current);
  const url = new URL(request.url);
  const settings = current.positionCode
    ? await env.DB.prepare(
      `SELECT pps.order_scope,pps.default_filter
       FROM positions p LEFT JOIN position_portal_settings pps
         ON pps.position_id=p.id AND pps.organization_id=p.organization_id
       WHERE p.organization_id=? AND p.code=?`,
    ).bind(current.organizationId, current.positionCode).first<PortalSettings>()
    : null;
  const privileged = current.roleCodes.some((code) => ["owner", "boss", "developer"].includes(code));
  const canViewAll = settings?.order_scope === "all_orders" || (privileged && !settings);
  const requestedFilter = url.searchParams.get("state");
  const stateFilter = ["open", "all", "blocked", "overdue"].includes(requestedFilter || "")
    ? requestedFilter!
    : settings?.default_filter || "open";
  const stageFilter = url.searchParams.get("stage") || "";
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();

  const rows = await env.DB.prepare(
    `SELECT o.id order_id,o.order_number,o.status order_status,o.business_type,
            o.is_overdue,c.name customer_name,
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
  ).bind(current.organizationId).all<PortalModuleRow>();

  const modulesByOrder = new Map<string, PortalModuleRow[]>();
  for (const row of rows.results) {
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
    const responsible = orderResponsiblePosition(moduleCode, order.order_status);
    const target = moduleCode ? modules.find((module) => module.module_code === moduleCode) : null;
    return {
      order_id: order.order_id,
      order_number: order.order_number,
      customer_name: order.customer_name,
      order_status: order.order_status,
      business_type: order.business_type,
      is_overdue: order.is_overdue,
      current_stage_code: guidance.stage.code,
      current_stage_name: guidance.stage.shortTitle,
      current_step_name: target?.current_step_name || target?.module_name || guidance.action,
      module_status: target?.status || (order.order_status === "completed" ? "completed" : "not_started"),
      assignee_name: target?.assignee_name || guidance.owner,
      next_action: guidance.action,
      blocker: guidance.blocker,
      responsible_position_code: responsible.code,
      responsible_position_name: responsible.name,
      href: guidance.href,
      updated_at: order.updated_at,
      stages: buildStageSnapshots(order.order_status, modules).map((snapshot) => ({
        code: snapshot.stage.code,
        name: snapshot.stage.shortTitle,
        status: snapshot.status,
      })),
    };
  });

  const visible = allOrders.filter((order) => {
    if (!canViewAll && order.responsible_position_code !== current.positionCode) return false;
    if (stateFilter === "open" && ["completed", "cancelled"].includes(order.order_status)) return false;
    if (stateFilter === "blocked" && !order.blocker) return false;
    if (stateFilter === "overdue" && !order.is_overdue) return false;
    if (stageFilter && order.current_stage_code !== stageFilter) return false;
    if (query && !`${order.order_number} ${order.customer_name} ${order.current_step_name} ${order.responsible_position_name}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((left, right) => {
    if (left.is_overdue !== right.is_overdue) return right.is_overdue - left.is_overdue;
    if (Boolean(left.blocker) !== Boolean(right.blocker)) return left.blocker ? -1 : 1;
    return right.updated_at.localeCompare(left.updated_at);
  });

  return {
    current,
    config,
    links: visiblePortalLinks(config, current.permissions),
    orders: visible,
    canViewAll,
    filters: { state: stateFilter, stage: stageFilter, q: url.searchParams.get("q") || "" },
  };
}

export function meta() {
  return [{ title: "岗位门户 | International TMS" }];
}

export default function PositionPortal({ loaderData }: Route.ComponentProps) {
  const { current, config, links, orders, canViewAll, filters } = loaderData;
  return <>
    <header className="page-header position-portal-header">
      <div><p className="eyebrow">POSITION WORK QUEUE</p><h1>{config.title}</h1><p>{current.displayName} · {canViewAll ? "可查看全部订单" : "只显示当前由本岗位负责推进的订单"}</p></div>
      <div className="page-actions"><span className="status-pill">{orders.length} 条</span>{links.slice(0,4).map(link=><Link className="secondary" key={link.href} to={link.href}>{link.label}</Link>)}</div>
    </header>

    <section className="panel position-order-ledger">
      <div className="panel-header position-ledger-header"><div><h2>岗位订单工作表</h2><p>一行一张订单；当前节点、负责人、阻断与下一步动作均由订单工作流实时计算。</p></div></div>
      <Form method="get" className="position-ledger-filters">
        <input name="q" defaultValue={filters.q} placeholder="订单号、客户、节点或岗位" />
        <select name="state" defaultValue={filters.state}><option value="open">未完成</option><option value="blocked">有阻断</option><option value="overdue">即将/已经超时</option>{canViewAll&&<option value="all">全部订单</option>}</select>
        <select name="stage" defaultValue={filters.stage}><option value="">全部阶段</option><option value="order_creation">订单创建</option><option value="review_assignment">审核分配</option><option value="domestic_execution">国内运输</option><option value="port_loading">装车出库</option><option value="outbound_transport">出境运输</option><option value="overseas_pickup">境外仓自提</option><option value="reconciliation">对账结算</option><option value="completion_review">完成复盘</option></select>
        <button className="secondary">筛选</button><Link className="text-button" to="/admin/portal">重置</Link>
      </Form>
      <div className="table-wrap position-ledger-table"><table><thead><tr><th>状态</th><th>订单 / 客户</th><th>类型</th><th>八阶段进度</th><th>当前节点</th><th>负责岗位 / 人员</th><th>下一步与阻断</th><th className="sticky-action">操作</th></tr></thead><tbody>{orders.map(order=><tr key={order.order_id} className={order.blocker?"row-blocked":""}>
        <td><span className={`status-pill ${order.is_overdue?"danger":""}`}>{order.is_overdue?"超时":orderStatusLabel(order.order_status)}</span></td>
        <td><strong>{order.order_number}</strong><small>{order.customer_name}</small></td>
        <td>{order.business_type==="ftl"?"整车":order.business_type==="ltl"?"拼车":"待确定"}</td>
        <td><div className="position-stage-line">{order.stages.map(stage=><span key={stage.code} className={stage.status} title={stage.name}>{stage.name}</span>)}</div></td>
        <td><strong>{order.current_stage_name}</strong><small>{order.current_step_name}</small></td>
        <td><strong>{order.responsible_position_name}</strong><small>{order.assignee_name||"待分配"}</small></td>
        <td><strong>{order.next_action}</strong><small className={order.blocker?"danger-text":""}>{order.blocker||"当前节点暂无阻断"}</small></td>
        <td className="sticky-action"><Link className="text-button" to={order.href}>{order.blocker?"查看阻断并处理":"打开当前节点"}</Link></td>
      </tr>)}</tbody></table>{!orders.length&&<p className="empty-state">当前筛选条件下没有订单。</p>}</div>
    </section>
  </>;
}

function orderStatusLabel(status: string) {
  return ({draft:"草稿",submitted:"待审批",confirmed:"待派单",in_execution:"执行中",completed:"已完成",cancelled:"已取消"} as Record<string,string>)[status] || status;
}
