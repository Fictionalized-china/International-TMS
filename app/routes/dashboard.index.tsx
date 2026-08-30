import { env } from "cloudflare:workers";
import { Link } from "react-router";
import type { Route } from "./+types/dashboard.index";
import { requireSessionUser } from "../lib/auth.server";
import { loadOrderGuidance } from "../lib/order-guidance.server";
import { AppIcon } from "../components/AppIcon";

const dashboardViewCodes = ["todo", "blocked", "in_progress", "unsettled"] as const;
type DashboardViewCode = (typeof dashboardViewCodes)[number];

type DashboardOrderRow = {
  id: string;
  order_number: string;
  status: string;
  completion_status: string;
  business_type: string;
  origin_city: string | null;
  destination_city: string | null;
  is_overdue: number;
  customer_name: string;
  updated_at: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "dashboard.view");
  const url = new URL(request.url);
  const requestedView = url.searchParams.get("view");
  const selectedView: DashboardViewCode = dashboardViewCodes.includes(requestedView as DashboardViewCode)
    ? requestedView as DashboardViewCode
    : "todo";
  const canViewAll = user.permissions.includes("order.manage") ? 1 : 0;
  const result = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.status,COALESCE(o.completion_status,'in_progress') completion_status,
            o.business_type,o.origin_city,o.destination_city,o.is_overdue,c.name customer_name,
            COALESCE(o.workflow_updated_at,o.updated_at,o.created_at) updated_at
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
      WHERE o.organization_id=? AND o.status!='cancelled'
        AND (?=1 OR o.current_assignee_user_id=? OR o.created_by_user_id=? OR EXISTS(
          SELECT 1 FROM order_module_instances m WHERE m.order_id=o.id AND m.assignee_user_id=?
        ))
      ORDER BY o.is_overdue DESC,COALESCE(o.workflow_updated_at,o.updated_at,o.created_at) DESC
      LIMIT 300`,
  ).bind(user.organizationId, canViewAll, user.userId, user.userId, user.userId).all<DashboardOrderRow>();
  const rows = result.results ?? [];
  const guidance = await loadOrderGuidance(env.DB, user.organizationId, rows.map(({ id, order_number, status }) => ({ id, order_number, status })));
  const allOrders = rows.map((order) => ({ order, ...guidance.get(order.id)! }));
  const currentTodos = allOrders.filter((item) => !["completed", "cancelled"].includes(item.order.status));
  const blockedOrders = currentTodos.filter((item) => Boolean(item.blocker));
  const inProgressOrders = allOrders.filter((item) => item.order.completion_status === "in_progress");
  const unsettledOrders = allOrders.filter((item) => item.order.completion_status === "business_complete_unsettled");
  const selectedOrders = selectedView === "blocked"
    ? blockedOrders
    : selectedView === "in_progress"
      ? inProgressOrders
      : selectedView === "unsettled"
        ? unsettledOrders
        : currentTodos;
  return {
    user,
    selectedView,
    counts: {
      todo: currentTodos.length,
      blocked: blockedOrders.length,
      in_progress: inProgressOrders.length,
      unsettled: unsettledOrders.length,
    },
    selectedOrders,
  };
}

export function meta() { return [{ title: "运营总览 | International TMS" }]; }

export default function DashboardIndex({ loaderData }: Route.ComponentProps) {
  const views: { code: DashboardViewCode; label: string; hint: string; icon: Parameters<typeof AppIcon>[0]["name"]; tone: string }[] = [
    { code: "todo", label: "当前待办", hint: "按优先级继续处理", icon: "clipboardCheck", tone: "orange" },
    { code: "blocked", label: "存在阻断", hint: "需先补齐资料或门禁", icon: "shield", tone: "red" },
    { code: "in_progress", label: "业务办理中", hint: "运输与仓库执行中", icon: "truck", tone: "blue" },
    { code: "unsettled", label: "业务完成待结算", hint: "等待收付款与核销", icon: "billing", tone: "green" },
  ];
  const activeView = views.find((view) => view.code === loaderData.selectedView)!;
  return <div className="ops-dashboard ops-dashboard-filtered">
    <header className="page-header ops-dashboard-header">
      <div><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>运营总览</h1><p>{loaderData.user.displayName} · 点击下方条件即可切换对应订单，不需要重新填写筛选表单。</p></div>
      <div className="page-actions"><Link className="secondary" to="/admin/portal"><AppIcon name="layout" size={15}/>岗位待办</Link><Link className="primary" to="/admin/orders"><AppIcon name="clipboard" size={15}/>全部订单</Link></div>
    </header>

    <nav className="ops-kpi-grid ops-filter-kpis" aria-label="运营订单筛选">
      {views.map((view) => <Link key={view.code} className={loaderData.selectedView === view.code ? "active" : ""} aria-current={loaderData.selectedView === view.code ? "page" : undefined} to={view.code === "todo" ? "/admin" : `/admin?view=${view.code}`}>
        <span className={`ops-kpi-icon ${view.tone}`}><AppIcon name={view.icon}/></span>
        <span><span>{view.label}</span><strong>{loaderData.counts[view.code]}</strong><small>{view.hint}</small></span>
      </Link>)}
    </nav>

    <section className="panel ops-filter-order-panel">
      <div className="panel-header"><div><h2>{activeView.label} <span className="count">{loaderData.selectedOrders.length}</span></h2><p>当前仅显示“{activeView.label}”订单；点击任意订单进入订单详情。</p></div><Link className="text-button" to="/admin/orders">打开订单台账</Link></div>
      <div className="ops-filter-order-head" aria-hidden="true"><span>订单 / 客户</span><span>线路 / 类型</span><span>当前节点</span><span>下一步 / 阻断</span><span>更新时间</span><span>操作</span></div>
      <div className="ops-filter-order-list">
        {loaderData.selectedOrders.map((item) => <Link className={item.blocker ? "blocked" : ""} key={item.order.id} to={`/admin/orders/${item.order.id}`}>
          <span><strong>{item.order.order_number}</strong><small>{item.order.customer_name}</small></span>
          <span><strong>{item.order.origin_city || "起运地待补"} → {item.order.destination_city || "目的地待补"}</strong><small>{item.order.business_type === "ftl" ? "整车" : item.order.business_type === "ltl" ? "拼车" : "类型待定"}</small></span>
          <span><strong>{item.stage.shortTitle}</strong><small>{orderStatusLabel(item.order.status)}</small></span>
          <span><strong>{item.action}</strong><small className={item.blocker ? "danger-text" : ""}>{item.blocker || "当前节点暂无阻断"}</small></span>
          <span><strong>{new Date(item.order.updated_at).toLocaleDateString("zh-CN")}</strong><small>{item.order.is_overdue ? "已超时" : "正常时效"}</small></span>
          <span className="ops-filter-order-open">查看订单</span>
        </Link>)}
        {!loaderData.selectedOrders.length && <p className="empty-state">当前筛选条件下没有订单。</p>}
      </div>
    </section>
  </div>;
}

function orderStatusLabel(status: string) {
  return ({ draft: "草稿", submitted: "待审批", confirmed: "待派单", in_execution: "执行中", completed: "已完成" } as Record<string, string>)[status] || status;
}
