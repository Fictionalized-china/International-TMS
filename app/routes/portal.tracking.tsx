import { env } from "cloudflare:workers";
import { PortalForm as Form, PortalLink as Link } from "../components/PortalNavigation";
import type { Route } from "./+types/portal.tracking";
import { requirePortalCustomer } from "../lib/portal.server";

type Shipment = {
  id: string;
  shipment_number: string;
  order_number: string;
  status: string;
  current_location: string | null;
  estimated_delivery_at: string | null;
  actual_delivery_at: string | null;
  signed_by: string | null;
  origin_city: string;
  destination_city: string;
  cargo_description: string;
};

type Event = {
  id: string;
  shipment_id: string;
  status: string;
  location: string | null;
  description: string;
  event_at: string;
};

const PAGE_SIZE = 10;

const labels: Record<string, string> = {
  booked: "待运踪更新",
  picked_up: "已提货",
  in_transit: "运输中",
  customs: "清关中",
  out_for_delivery: "派送中",
  delivered: "已签收",
  exception: "运输异常",
  cancelled: "已取消",
};

const statusOptions = [
  { value: "", label: "全部状态" },
  { value: "booked", label: "待运踪更新" },
  { value: "picked_up", label: "已提货" },
  { value: "in_transit", label: "运输中" },
  { value: "customs", label: "清关中" },
  { value: "out_for_delivery", label: "派送中" },
  { value: "delivered", label: "已签收" },
  { value: "exception", label: "运输异常" },
];

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "待定";
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const status = (url.searchParams.get("status") ?? "").trim();
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const [shipmentsResult, eventsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT s.id,s.shipment_number,o.order_number,s.status,s.current_location,
              s.estimated_delivery_at,s.actual_delivery_at,s.signed_by,
              o.origin_city,o.destination_city,o.cargo_description
         FROM shipments s
         JOIN transport_orders o ON o.id=s.order_id
        WHERE s.organization_id=? AND s.customer_id=?
        ORDER BY CASE WHEN s.status IN ('delivered','cancelled') THEN 1 ELSE 0 END,
                 s.updated_at DESC`,
    )
      .bind(user.organizationId, customer.id)
      .all<Shipment>(),
    env.DB.prepare(
      `SELECT e.id,e.shipment_id,e.status,e.location,e.description,e.event_at
         FROM shipment_events e
         JOIN shipments s ON s.id=e.shipment_id
        WHERE s.organization_id=? AND s.customer_id=? AND e.visible_to_customer=1
        ORDER BY e.event_at DESC`,
    )
      .bind(user.organizationId, customer.id)
      .all<Event>(),
  ]);

  const normalizedQuery = q.toLocaleLowerCase("zh-CN");
  const filteredShipments = shipmentsResult.results.filter((shipment) => {
    if (status && shipment.status !== status) return false;
    if (!normalizedQuery) return true;
    return [
      shipment.order_number,
      shipment.shipment_number,
      shipment.cargo_description,
      shipment.origin_city,
      shipment.destination_city,
      shipment.current_location,
    ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  });

  const pageCount = Math.max(1, Math.ceil(filteredShipments.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const shipments = filteredShipments.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const visibleShipmentIds = new Set(shipments.map((shipment) => shipment.id));

  return {
    shipments,
    events: eventsResult.results.filter((event) => visibleShipmentIds.has(event.shipment_id)),
    total: filteredShipments.length,
    allTotal: shipmentsResult.results.length,
    page,
    pageCount,
    filters: { q, status },
  };
}

export function meta() {
  return [{ title: "运输轨迹 | 欧凌客户门户" }];
}

export default function PortalTracking({ loaderData }: Route.ComponentProps) {
  const eventsByShipment = new Map<string, Event[]>();
  for (const event of loaderData.events) {
    const events = eventsByShipment.get(event.shipment_id) ?? [];
    events.push(event);
    eventsByShipment.set(event.shipment_id, events);
  }

  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (loaderData.filters.q) params.set("q", loaderData.filters.q);
    if (loaderData.filters.status) params.set("status", loaderData.filters.status);
    params.set("page", String(page));
    return `/portal/tracking?${params.toString()}`;
  };

  return (
    <>
      <header className="page-header portal-tracking-page-header">
        <div>
          <p className="eyebrow">TRACK &amp; TRACE</p>
          <h1>运输轨迹</h1>
          <p>按订单查看当前运输状态、预计送达和客户可见节点。</p>
        </div>
      </header>

      <section className="panel portal-tracking-workbench">
        <Form method="get" className="portal-tracking-filters">
          <label className="portal-tracking-search-field">
            <span>查找订单</span>
            <input
              type="search"
              name="q"
              defaultValue={loaderData.filters.q}
              placeholder="订单号、运单号、货物、城市或当前位置"
            />
          </label>
          <label>
            <span>运输状态</span>
            <select name="status" defaultValue={loaderData.filters.status}>
              {statusOptions.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary-button">筛选</button>
          {(loaderData.filters.q || loaderData.filters.status) && (
            <Link to="/portal/tracking" className="secondary-button">清除</Link>
          )}
        </Form>

        <div className="portal-tracking-result-bar">
          <div>
            <strong>订单轨迹</strong>
            <span>当前显示 {loaderData.total} / {loaderData.allTotal} 单</span>
          </div>
          <span>点击订单查看完整轨迹，每页最多 10 单</span>
        </div>

        {loaderData.shipments.length ? (
          <div className="portal-tracking-order-list">
            {loaderData.shipments.map((shipment, index) => {
              const events = eventsByShipment.get(shipment.id) ?? [];
              const latestEvent = events[0];
              return (
                <article className={`portal-tracking-order-card ${shipment.status === "exception" ? "is-exception" : ""}`} key={shipment.id}>
                  <header className="portal-tracking-order-heading">
                    <div className="portal-tracking-order-title">
                      <span className="portal-tracking-order-index">{(loaderData.page - 1) * PAGE_SIZE + index + 1}</span>
                      <div>
                        <strong><Link to={`/portal/tracking/${shipment.id}`}>{shipment.order_number}</Link></strong>
                        <small>运单 {shipment.shipment_number} · {shipment.origin_city} → {shipment.destination_city}</small>
                      </div>
                    </div>
                    <span className={`status-pill ${shipment.status === "exception" ? "danger" : ""}`}>
                      {labels[shipment.status] || shipment.status}
                    </span>
                  </header>

                  <div className="portal-tracking-order-summary">
                    <div><span>当前位置</span><strong>{latestEvent?.location || shipment.current_location || "待更新"}</strong></div>
                    <div><span>最新动态</span><strong>{latestEvent?.description || "暂无客户可见节点"}</strong></div>
                    <div><span>更新时间</span><strong>{formatDateTime(latestEvent?.event_at || null)}</strong></div>
                    <Link className="secondary-button" to={`/portal/tracking/${shipment.id}`}>查看轨迹 →</Link>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="portal-tracking-empty">
            <strong>{loaderData.allTotal ? "没有符合筛选条件的订单" : "当前没有运输订单"}</strong>
            <p>{loaderData.allTotal ? "请调整订单关键词或运输状态后重试。" : "订单开始运输后，轨迹会在这里按订单显示。"}</p>
            {loaderData.allTotal > 0 && <Link to="/portal/tracking" className="secondary-button">清除筛选</Link>}
          </div>
        )}

        {loaderData.pageCount > 1 && (
          <nav className="portal-tracking-pagination" aria-label="运输轨迹分页">
            <span>第 {loaderData.page} / {loaderData.pageCount} 页</span>
            <div>
              {loaderData.page > 1 ? <Link to={pageHref(loaderData.page - 1)}>上一页</Link> : <span aria-disabled="true">上一页</span>}
              {Array.from({ length: loaderData.pageCount }, (_, index) => index + 1).map((page) => (
                <Link key={page} to={pageHref(page)} aria-current={page === loaderData.page ? "page" : undefined}>
                  {page}
                </Link>
              ))}
              {loaderData.page < loaderData.pageCount ? <Link to={pageHref(loaderData.page + 1)}>下一页</Link> : <span aria-disabled="true">下一页</span>}
            </div>
          </nav>
        )}
      </section>
    </>
  );
}
