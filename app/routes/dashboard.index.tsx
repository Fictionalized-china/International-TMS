import { env } from "cloudflare:workers";
import { Link } from "react-router";
import type { Route } from "./+types/dashboard.index";
import { requireSessionUser } from "../lib/auth.server";
import { loadOrderGuidance } from "../lib/order-guidance.server";

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
  return <><header className="page-header"><div><p className="eyebrow">OPERATIONS CENTER</p><h1>你好，{loaderData.user.displayName}</h1><p>欧凌国际物流 · 国际零担运营后台</p></div><span className="status-pill">后台服务正常</span></header>
    <section className="stats stats-four"><article><span>有效客户</span><strong>{loaderData.stats.customers}</strong><small>客户主数据</small></article><article><span>开放线索</span><strong>{loaderData.stats.leads}</strong><small>待销售推进</small></article><article><span>开放商机</span><strong>{loaderData.stats.opportunities}</strong><small>销售漏斗</small></article><article><span>门户账号</span><strong>{loaderData.stats.portalAccounts}</strong><small>客户协作</small></article></section>
    <section className="panel"><div className="panel-header"><div><h2>订单闭环看板</h2><p>主管和老板只看三个状态：业务办理、业务完成待结算、已结清。</p></div><Link className="secondary" to="/admin/orders">进入订单工作台</Link></div><div className="completion-stats"><article><span>业务办理中</span><strong>{loaderData.completionStats.inProgress}</strong><small>继续按下一步动作处理</small></article><article><span>业务完成，结算未闭环</span><strong>{loaderData.completionStats.unsettled}</strong><small>财务继续收付款与核销</small></article><article><span>已完成并结清</span><strong>{loaderData.completionStats.settled}</strong><small>订单可进入经营复盘</small></article></div></section>
    <section className="panel"><div className="panel-header"><div><h2>我的订单待办</h2><p>与订单详情、订单列表使用同一套下一步动作和阻断规则。</p></div><Link className="secondary" to="/admin/orders">查看全部订单</Link></div><div className="table-wrap"><table><thead><tr><th>订单</th><th>当前阶段</th><th>下一步动作</th><th>负责人</th><th>阻断原因</th><th>入口</th></tr></thead><tbody>{loaderData.orderTodos.map(item=><tr key={item.order.id}><td><strong>{item.order.order_number}</strong></td><td>{item.stage.shortTitle}</td><td>{item.action}</td><td>{item.owner}</td><td className={item.blocker?"danger-text":""}>{item.blocker||"当前节点暂无阻断"}</td><td><Link className="text-button" to={item.href}>{item.blocker?"查看阻断并处理":"打开当前节点"}</Link></td></tr>)}</tbody></table></div>{!loaderData.orderTodos.length&&<p className="empty-state">当前没有待处理订单。</p>}</section>
    <section className="panel"><h2>第一阶段 MVP 能力</h2><div className="module-list"><div><span className="module-icon done">✓</span><div><strong>客户、销售与询价报价</strong><p>客户 360、销售漏斗、标准报价和客户在线确认。</p></div><span>已启用</span></div><div><span className="module-icon done">✓</span><div><strong>订单、运单与运输轨迹</strong><p>门户下单、后台确认、承运分段、轨迹和签收。</p></div><span>已启用</span></div><div><span className="module-icon done">✓</span><div><strong>账单、权限与安全</strong><p>应收账单、收款状态、角色权限和安全审计。</p></div><span>已启用</span></div></div></section>
  </>;
}
