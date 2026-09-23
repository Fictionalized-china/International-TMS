import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.analytics";
import { AppIcon } from "../components/AppIcon";
import { requireSessionUser } from "../lib/auth.server";
import { loadAnalyticsSnapshot } from "../lib/analytics.server";

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "analytics.business.view");
  return { current, ...(await loadAnalyticsSnapshot(request, current)) };
}

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const filterParams = new URLSearchParams(Object.entries(loaderData.filters).filter(([, value]) => value));
  const cards = [
    { label: "订单总量", value: loaderData.metrics.total, hint: "当前筛选范围", icon: "clipboard" as const, href: "/admin/orders" },
    { label: "执行中", value: loaderData.metrics.executing, hint: "正在办理或运输", icon: "truck" as const, href: "/admin/orders?status=in_execution" },
    { label: "时效预警", value: loaderData.metrics.overdue, hint: "订单已标记超时", icon: "bell" as const, href: "/admin/orders" },
    { label: "业务异常", value: loaderData.metrics.exceptions, hint: "警告或异常状态", icon: "shield" as const, href: "/admin/orders?exception=yes" },
    { label: "仓库已实收", value: loaderData.metrics.warehouseReceived, hint: "已有完成收货记录", icon: "warehouse" as const, href: "/admin/shipments" },
    { label: "已完成", value: loaderData.metrics.completed, hint: "流程完成订单", icon: "packageCheck" as const, href: "/admin/orders?status=completed" },
  ];
  return <div className="analytics-center">
    <header className="page-header analytics-header">
      <div><p className="eyebrow">BUSINESS ANALYTICS</p><h1>汇总分析</h1><p>汇总现有订单、运踪、仓库和获授权的财务数据，所有数字均可回到原始业务明细核对。</p></div>
      <div className="page-actions">{loaderData.access.canExport && <a className="secondary" href={`/admin/analytics/export?${filterParams.toString()}`}>导出当前汇总</a>}<Link className="primary" to="/admin/orders">查看订单明细</Link></div>
    </header>

    <section className="panel analytics-filter-panel">
      <Form method="get" className="analytics-filter-bar">
        <label><span>开始日期</span><input type="date" name="from" defaultValue={loaderData.filters.from}/></label>
        <label><span>结束日期</span><input type="date" name="to" defaultValue={loaderData.filters.to}/></label>
        <label><span>客户</span><select name="customerId" defaultValue={loaderData.filters.customerId}><option value="">全部客户</option>{loaderData.options.customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>负责人</span><select name="ownerId" defaultValue={loaderData.filters.ownerId}><option value="">全部负责人</option>{loaderData.options.owners.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>线路</span><input name="route" defaultValue={loaderData.filters.route} placeholder="起运地或目的地"/></label>
        <div><button className="primary">应用筛选</button><Link className="secondary" to="/admin/analytics">重置</Link></div>
      </Form>
    </section>

    <section className="analytics-kpi-grid" aria-label="业务汇总指标">
      {cards.map((card) => <Link key={card.label} to={card.href}><span><AppIcon name={card.icon}/></span><div><small>{card.label}</small><strong>{card.value}</strong><em>{card.hint}</em></div></Link>)}
    </section>

    {(loaderData.finance.receivable !== null || loaderData.finance.payable !== null || loaderData.finance.profit !== null) && <section className="panel analytics-finance-panel">
      <div className="panel-header"><div><h2>财务金额</h2><p>仅显示当前岗位被授权的指标；未授权字段不会进入页面数据。</p></div><span className="status-pill">本位币口径</span></div>
      <div className="analytics-finance-grid">
        {loaderData.finance.receivable !== null && <Metric label="应收金额" value={money(loaderData.finance.receivable)}/>}
        {loaderData.finance.payable !== null && <Metric label="应付及成本" value={money(loaderData.finance.payable)}/>}
        {loaderData.finance.profit !== null && <Metric
          label="毛利"
          value={money(loaderData.finance.profit)}
          hint={loaderData.finance.margin === null ? "毛利率待计算" : `毛利率 ${(loaderData.finance.margin * 100).toFixed(1)}%`}
        />}
      </div>
    </section>}

    <section className="analytics-breakdown-grid">
      <Breakdown title="客户订单量" items={loaderData.breakdowns.customers} kind="customer"/>
      <Breakdown title="线路分布" items={loaderData.breakdowns.routes} kind="route"/>
      <Breakdown title="负责人工作量" items={loaderData.breakdowns.owners} kind="owner"/>
    </section>
  </div>;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <Link to="/admin/billing"><small>{label}</small><strong>{value}</strong><span>{hint || "当前筛选范围"}</span></Link>;
}

function Breakdown({ title, items, kind }: { title: string; items: Array<[string, number]>; kind: "customer" | "route" | "owner" }) {
  const max = Math.max(1, ...items.map(([, value]) => value));
  return <section className="panel analytics-breakdown"><div className="panel-header"><div><h2>{title}</h2><p>按订单数从高到低排列，点击可查看业务明细</p></div></div>{items.length ? <ol>{items.map(([label, value]) => <li key={label}><Link to={breakdownHref(kind, label)}><span><strong>{label}</strong><small>{value} 票</small></span><i><b style={{ width: `${Math.max(6, value / max * 100)}%` }}/></i></Link></li>)}</ol> : <p className="empty-state">当前范围暂无数据。</p>}</section>;
}

function breakdownHref(kind: "customer" | "route" | "owner", label: string) {
  if (kind === "customer") return `/admin/orders?keyword=${encodeURIComponent(label)}`;
  if (kind === "route") {
    const [origin = "", destination = ""] = label.split("→").map((part) => part.trim());
    return `/admin/orders?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
  }
  return "/admin/orders";
}

function money(value: number) { return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); }
export function meta() { return [{ title: "汇总分析 | International TMS" }]; }
