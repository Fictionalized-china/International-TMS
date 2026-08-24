import { env } from "cloudflare:workers";
import { Link } from "react-router";
import type { Route } from "./+types/dashboard.index";
import { requireSessionUser } from "../lib/auth.server";
import { loadOrderGuidance } from "../lib/order-guidance.server";
import { AppIcon } from "../components/AppIcon";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "dashboard.view");
  const [customers, leads, opportunities, portalAccounts, openOrders, completion] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM customers WHERE organization_id = ? AND status = 'active'").bind(user.organizationId),
    env.DB.prepare("SELECT COUNT(*) AS count FROM sales_leads WHERE organization_id = ? AND status NOT IN ('converted', 'lost')").bind(user.organizationId),
    env.DB.prepare("SELECT COUNT(*) AS count FROM sales_opportunities WHERE organization_id = ? AND stage NOT IN ('won', 'lost')").bind(user.organizationId),
    env.DB.prepare("SELECT COUNT(*) AS count FROM customer_portal_accounts WHERE organization_id = ? AND status = 'active'").bind(user.organizationId),
    env.DB.prepare(`SELECT id,order_number,status FROM transport_orders
      WHERE organization_id=? AND status NOT IN ('completed','cancelled')
        AND (?=1 OR current_assignee_user_id=? OR created_by_user_id=? OR EXISTS(
          SELECT 1 FROM order_module_instances m WHERE m.order_id=transport_orders.id AND m.assignee_user_id=?
        ))
      ORDER BY is_overdue DESC,workflow_updated_at DESC,created_at DESC LIMIT 8`)
      .bind(user.organizationId,user.permissions.includes("order.manage")?1:0,user.userId,user.userId,user.userId),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN completion_status='in_progress' AND status!='cancelled' THEN 1 ELSE 0 END) in_progress,
      SUM(CASE WHEN completion_status='business_complete_unsettled' THEN 1 ELSE 0 END) unsettled,
      SUM(CASE WHEN completion_status='completed_settled' THEN 1 ELSE 0 END) settled
      FROM transport_orders WHERE organization_id=?`).bind(user.organizationId),
  ]);
  const count = (result: D1Result) => Number((result.results[0] as { count?: number } | undefined)?.count ?? 0);
  const orders=openOrders.results as {id:string;order_number:string;status:string}[];
  const guidance=await loadOrderGuidance(env.DB,user.organizationId,orders);
  const completionStats=(completion.results[0]??{}) as {in_progress?:number;unsettled?:number;settled?:number};
  return {
    user,
    stats: { customers: count(customers), leads: count(leads), opportunities: count(opportunities), portalAccounts: count(portalAccounts) },
    orderTodos: orders.map(order=>({order,...guidance.get(order.id)!})),
    completionStats: {inProgress:Number(completionStats.in_progress??0),unsettled:Number(completionStats.unsettled??0),settled:Number(completionStats.settled??0)},
  };
}

export function meta() { return [{ title: "工作台 | International TMS" }]; }

export default function DashboardIndex({ loaderData }: Route.ComponentProps) {
  const blocked = loaderData.orderTodos.filter((item) => Boolean(item.blocker)).length;
  return <div className="ops-dashboard">
    <header className="page-header ops-dashboard-header">
      <div><p className="eyebrow">TASK WORKBENCH / 任务工作台</p><h1>早上好，{loaderData.user.displayName}</h1><p>这里集中显示今天真正需要处理的订单与阻断。</p></div>
      <div className="page-actions"><Link className="secondary" to="/admin/portal"><AppIcon name="layout" size={15}/>岗位待办</Link><Link className="primary" to="/admin/orders"><AppIcon name="clipboard" size={15}/>运输订单</Link></div>
    </header>

    <section className="ops-kpi-grid" aria-label="运营概况">
      <article><span className="ops-kpi-icon orange"><AppIcon name="clipboardCheck" /></span><div><span>当前待办</span><strong>{loaderData.orderTodos.length}</strong><small>按优先级继续处理</small></div></article>
      <article><span className="ops-kpi-icon red"><AppIcon name="shield" /></span><div><span>存在阻断</span><strong>{blocked}</strong><small>需先补齐资料或门禁</small></div></article>
      <article><span className="ops-kpi-icon blue"><AppIcon name="truck" /></span><div><span>业务办理中</span><strong>{loaderData.completionStats.inProgress}</strong><small>运输与仓库执行中</small></div></article>
      <article><span className="ops-kpi-icon green"><AppIcon name="billing" /></span><div><span>业务完成待结算</span><strong>{loaderData.completionStats.unsettled}</strong><small>等待对账、收付款与核销</small></div></article>
    </section>

    <section className="panel ops-todo-panel">
      <div className="panel-header"><div><h2>待我处理</h2><p>下一步动作和阻断原因直接来自订单工作流。</p></div><Link className="secondary" to="/admin/portal">打开任务工作台</Link></div>
      <div className="ops-todo-list">
        {loaderData.orderTodos.slice(0, 5).map((item, index) => <Link className={item.blocker ? "blocked" : ""} key={item.order.id} to={item.href}>
          <span className="ops-todo-index">{String(index + 1).padStart(2, "0")}</span>
          <span><strong>{item.order.order_number}</strong><small>{item.stage.shortTitle} · {item.owner}</small></span>
          <span><strong>{item.action}</strong><small className={item.blocker ? "danger-text" : ""}>{item.blocker || "当前节点暂无阻断"}</small></span>
          <span className="ops-todo-open">打开</span>
        </Link>)}
        {!loaderData.orderTodos.length && <p className="empty-state">当前没有待处理订单。</p>}
      </div>
    </section>

    <section className="panel ops-closure-panel">
      <div className="panel-header"><div><h2>订单闭环</h2><p>按办理中、待结算、已结清三个结果查看。</p></div><Link className="text-button" to="/admin/billing">查看费用结算</Link></div>
      <div className="ops-closure-grid"><div><span>业务办理中</span><strong>{loaderData.completionStats.inProgress}</strong></div><div><span>业务完成待结算</span><strong>{loaderData.completionStats.unsettled}</strong></div><div><span>已完成并结清</span><strong>{loaderData.completionStats.settled}</strong></div><div><span>有效客户</span><strong>{loaderData.stats.customers}</strong></div></div>
    </section>
  </div>;
}
