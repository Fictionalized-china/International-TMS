import { env } from "cloudflare:workers";
import { PortalLink as Link } from "../components/PortalNavigation";
import { requirePortalCustomer } from "../lib/portal.server";
import type { Route } from "./+types/portal.tracking-event";
import { listOrderSitePhotos } from "../lib/order-site-photos.server";
import { SitePhotoGallery } from "../components/SitePhotos";
import { usePortalContextId } from "../components/PortalNavigation";

type EventDetail = {
  order_id:string; order_number: string; shipment_number: string; description: string;
  location: string | null; status: string; event_at: string;
};
const statuses: Record<string, string> = {
  booked: "待运踪更新", picked_up: "已提货", in_transit: "运输中", customs: "清关中",
  out_for_delivery: "派送中", delivered: "已签收", exception: "运输异常", cancelled: "已取消",
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, customer } = await requirePortalCustomer(request);
  const event = await env.DB.prepare(
    `SELECT o.id order_id,o.order_number,s.shipment_number,e.description,e.location,e.status,e.event_at
       FROM shipment_events e
       JOIN shipments s ON s.id=e.shipment_id
       JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
      WHERE e.id=? AND s.id=? AND s.organization_id=? AND s.customer_id=?
        AND o.customer_id=? AND e.visible_to_customer=1`,
  ).bind(params.eventId, params.shipmentId, user.organizationId, customer.id, customer.id).first<EventDetail>();
  if (!event) throw new Response("轨迹节点不存在", { status: 404 });
  return { event, shipmentId: params.shipmentId,sitePhotos:await listOrderSitePhotos(env.DB,user.organizationId,event.order_id,{eventId:params.eventId,page:Number(new URL(request.url).searchParams.get("photoPage"))||1}) };
}

export function meta() { return [{ title: "轨迹节点详情 | 客户门户" }]; }

export default function PortalTrackingEvent({ loaderData }: Route.ComponentProps) {
  const { event, shipmentId } = loaderData;
  const portalContext=usePortalContextId();
  return <>
    <nav className="portal-tracking-breadcrumb" aria-label="当前位置">
      <Link to="/portal/tracking">运输轨迹</Link><span aria-hidden="true">/</span>
      <Link to={`/portal/tracking/${shipmentId}`}>{event.order_number}</Link><span aria-hidden="true">/</span><span>节点详情</span>
    </nav>
    <header className="page-header"><div><p className="eyebrow">TRACKING EVENT</p><h1>轨迹节点详情</h1>
      <p>{event.order_number} · 运单 {event.shipment_number}</p></div></header>
    <section className="panel portal-tracking-event-detail">
      <h2>{event.description}</h2>
      <dl><div><dt>记录时间</dt><dd><time dateTime={event.event_at}>{new Date(event.event_at).toLocaleString("zh-CN")}</time></dd></div>
        <div><dt>登记地点</dt><dd>{event.location || "地点待更新"}</dd></div>
        <div><dt>运输状态</dt><dd>{statuses[event.status] || event.status}</dd></div></dl>
      <h3>本节点现场照片</h3><SitePhotoGallery photos={loaderData.sitePhotos.photos} basePath="/portal/site-photos" context={`portalContext=${encodeURIComponent(portalContext)}`}/>
      <Link className="secondary-button" to={`/portal/tracking/${shipmentId}`}>返回单票轨迹与全部现场照片</Link>
    </section>
  </>;
}
