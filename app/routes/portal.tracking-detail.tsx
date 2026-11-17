import { env } from "cloudflare:workers";
import { PortalLink as Link } from "../components/PortalNavigation";
import { requirePortalCustomer } from "../lib/portal.server";
import type { Route } from "./+types/portal.tracking-detail";
import { listOrderSitePhotos } from "../lib/order-site-photos.server";
import { SitePhotoGallery } from "../components/SitePhotos";
import { usePortalContextId } from "../components/PortalNavigation";

type Shipment = {
  id: string; order_id:string; shipment_number: string; order_number: string; status: string;
  current_location: string | null; estimated_delivery_at: string | null;
  actual_delivery_at: string | null; signed_by: string | null;
  origin_city: string; destination_city: string; cargo_description: string;
};
type Event = { id: string; status: string; location: string | null; description: string; event_at: string };
const statuses: Record<string, string> = {
  booked: "待运踪更新", picked_up: "已提货", in_transit: "运输中", customs: "清关中",
  out_for_delivery: "派送中", delivered: "已签收", exception: "运输异常", cancelled: "已取消",
};
const displayTime = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "待更新";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const shipment = await env.DB.prepare(
    `SELECT s.id,o.id order_id,s.shipment_number,o.order_number,s.status,s.current_location,
            s.estimated_delivery_at,s.actual_delivery_at,s.signed_by,
            o.origin_city,o.destination_city,o.cargo_description
       FROM shipments s JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
      WHERE s.id=? AND s.organization_id=? AND s.customer_id=? AND o.customer_id=?`,
  ).bind(params.shipmentId, user.organizationId, customer.id, customer.id).first<Shipment>();
  if (!shipment) throw new Response("运单不存在", { status: 404 });
  const events = await env.DB.prepare(
    `SELECT id,status,location,description,event_at FROM shipment_events
      WHERE shipment_id=? AND visible_to_customer=1 ORDER BY event_at DESC,created_at DESC`,
  ).bind(shipment.id).all<Event>();
  return { shipment, events: events.results,sitePhotos:await listOrderSitePhotos(env.DB,user.organizationId,shipment.order_id,{page:Number(new URL(request.url).searchParams.get("photoPage"))||1}) };
}

export function meta() { return [{ title: "单票运输轨迹 | 客户门户" }]; }

export default function PortalTrackingDetail({ loaderData }: Route.ComponentProps) {
  const { shipment, events } = loaderData;
  const portalContext=usePortalContextId();
  return <>
    <nav className="portal-tracking-breadcrumb" aria-label="当前位置">
      <Link to="/portal/tracking">运输轨迹</Link><span aria-hidden="true">/</span><span>{shipment.order_number}</span>
    </nav>
    <header className="page-header portal-tracking-page-header">
      <div><p className="eyebrow">TRACK &amp; TRACE</p><h1>{shipment.order_number}</h1>
        <p>运单 {shipment.shipment_number} · {shipment.origin_city} → {shipment.destination_city}</p></div>
      <span className="status-pill">{statuses[shipment.status] || shipment.status}</span>
    </header>
    <section className="panel portal-tracking-detail-overview" aria-label="运输概况">
      <div><span>当前位置</span><strong>{events[0]?.location || shipment.current_location || "待更新"}</strong></div>
      <div><span>最新动态</span><strong>{events[0]?.description || "暂无客户可见节点"}</strong></div>
      <div><span>{shipment.actual_delivery_at ? "实际送达" : "预计送达"}</span><strong>{displayTime(shipment.actual_delivery_at || shipment.estimated_delivery_at)}</strong></div>
    </section>
    <section className="panel portal-tracking-detail-events" aria-label="客户可见运输节点">
      <header><div><h2>运输时间轴</h2><p>运踪岗登记并设为客户可见的节点会显示在这里。</p></div><strong>{events.length} 条记录</strong></header>
      {events.length ? <ol>{events.map((event) => <li key={event.id}>
        <div><strong>{event.description}</strong><span>{event.location || "地点待更新"} · {statuses[event.status] || event.status}</span></div>
        <div><time dateTime={event.event_at}>{displayTime(event.event_at)}</time>
          <Link to={`/portal/tracking/${shipment.id}/events/${event.id}`}>查看节点详情 →</Link></div>
      </li>)}</ol> : <p className="portal-tracking-no-events">暂无客户可见运输节点；请等待运踪岗更新。</p>}
    </section>
    <section className="panel" aria-label="现场照片"><h2>现场照片</h2><p>提货、收货和换装照片按所属作业自动同步；点击查看原图。</p><SitePhotoGallery photos={loaderData.sitePhotos.photos} basePath="/portal/site-photos" context={`portalContext=${encodeURIComponent(portalContext)}`}/><div className="site-photo-pagination">{loaderData.sitePhotos.page>1&&<Link to={`?photoPage=${loaderData.sitePhotos.page-1}`}>上一页</Link>}<span>第 {loaderData.sitePhotos.page} 页</span>{loaderData.sitePhotos.hasMore&&<Link to={`?photoPage=${loaderData.sitePhotos.page+1}`}>下一页</Link>}</div></section>
    <section className="panel portal-tracking-detail-secondary" aria-label="运单资料">
      <h2>运单资料</h2><dl><div><dt>货物</dt><dd>{shipment.cargo_description || "—"}</dd></div>
        <div><dt>路线</dt><dd>{shipment.origin_city} → {shipment.destination_city}</dd></div>
        <div><dt>签收人</dt><dd>{shipment.signed_by || "待签收"}</dd></div></dl>
    </section>
  </>;
}
