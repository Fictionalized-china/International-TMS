import { Form, Link, useLocation, useNavigation } from "react-router";
import type { OrderTrackingReadView } from "../lib/order-tracking-read.server";
import { businessDateTimeLabel } from "../lib/business-time";
import { statusLabel } from "../lib/order-workflow";
import { QueryPagination } from "./QueryPagination";

export function ReadOnlyOrderTracking({ data, site }: { data: OrderTrackingReadView; site: "admin" | "warehouse" }) {
  const location = useLocation(), busy = useNavigation().state !== "idle";
  const href = (orderId: string) => { const params = new URLSearchParams(location.search); params.set("orderId", orderId); params.delete("eventsPage"); return `${location.pathname}?${params}`; };
  const preserved = new URLSearchParams(location.search);
  return <div className="module-business-stack readonly-order-tracking" aria-busy={busy}>
    <header className="page-header"><div><h1>订单运踪（只读）</h1><p>查看授权订单的运输事件，不改变订单、库存或运踪；各时间统一显示为北京时间。</p></div></header>
    <Form method="get" className="tracking-center-filter">
      {["itmsTab", "warehouseId"].map(key => preserved.get(key) && <input key={key} type="hidden" name={key} value={preserved.get(key)!}/>)}
      <label>查找订单<input name="q" defaultValue={data.q} placeholder="订单号、客户或货物"/></label><button className="primary" disabled={busy}>{busy ? "查询中…" : "查询"}</button>
    </Form>
    <div className="table-wrap" role="region" aria-label="授权订单列表，可左右滚动" tabIndex={0}><table><thead><tr><th>订单 / 客户</th><th>货物</th><th>线路</th><th>当前业务节点</th><th>查看</th></tr></thead>
      <tbody>{data.pagination.items.map(row => <tr key={row.id} aria-current={row.id === data.selected?.id ? "true" : undefined}><td><Link to={href(row.id)}>{row.order_number}</Link><small>{row.customer_name}</small></td><td>{row.cargo_description}</td><td>{row.origin_city} → {row.destination_city}</td><td>{row.current_step_name || statusLabel(row.status)}</td><td><Link className="text-button" to={href(row.id)}>查看运踪</Link></td></tr>)}
        {!data.pagination.items.length && <tr><td colSpan={5} className="empty-state">没有符合条件的授权订单；可调整搜索条件。</td></tr>}
      </tbody></table></div><QueryPagination {...data.pagination}/>
    {data.selected && <section className="panel" aria-label="本单运输轨迹"><header className="section-title"><h2>{data.selected.order_number} · 运输轨迹</h2>{site === "admin" && <Link className="secondary" to={`/admin/orders/${encodeURIComponent(data.selected.id)}${preserved.get("itmsTab") ? `?itmsTab=${encodeURIComponent(preserved.get("itmsTab")!)}` : ""}`}>返回本单办理</Link>}</header>
      <div className="readonly-tracking-events">{data.events.map(event => <article key={event.id}><header><strong>{event.description || "运输状态更新"}</strong><time dateTime={event.event_at}>{businessDateTimeLabel(event.event_at) || "时间待核对"}</time></header><p>{event.location || "地点未记录"}</p><small>{event.shipment_number} · {event.visible_to_customer ? "客户可见" : "内部运踪"}</small></article>)}
        {!data.events.length && <p className="empty-state">本单尚未登记运输事件；实际轨迹由有权限的运踪人员登记后同步显示。</p>}
      </div><QueryPagination {...data.eventPagination} pageParam="eventsPage" unit="条运踪"/>
    </section>}
  </div>;
}
