import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.loading";
import { BatchNumberLink, OrderNumberLinkList } from "../components/EntityNumberLink";
import { requireSessionUser } from "../lib/auth.server";
import { batchVisibilitySql } from "../lib/order-access.server";

type BatchRow = {
  id: string;
  batch_number: string;
  batch_name: string;
  origin_location: string;
  destination_location: string;
  planned_departure_at: string | null;
  status: string;
  road_status: string;
  carrier_name: string | null;
  warehouse_name: string | null;
  order_count: number;
  order_numbers: string | null;
  order_refs: string | null;
  total_weight: number;
  total_volume: number;
  vehicle_count: number;
};

const pageSize = 30;

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.module.loading.manage");
  const visibility = batchVisibilitySql(current, "b");
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "all";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const statusSql = status === "active"
    ? "AND b.road_status NOT IN ('pickup_completed','cancelled')"
    : status === "completed"
      ? "AND b.road_status='pickup_completed'"
      : status === "cancelled"
        ? "AND b.road_status='cancelled'"
        : "";
  const searchSql = q
    ? `AND (b.batch_number LIKE '%'||?||'%' OR b.batch_name LIKE '%'||?||'%' OR EXISTS(
         SELECT 1 FROM transport_batch_orders sx
         JOIN transport_orders ox ON ox.id=sx.order_id AND ox.organization_id=sx.organization_id
         WHERE sx.batch_id=b.id AND sx.organization_id=b.organization_id AND sx.status!='removed'
           AND ox.order_number LIKE '%'||?||'%'
       ))`
    : "";
  const searchBinds = q ? [q, q, q] : [];
  const count = await env.DB.prepare(
    `SELECT COUNT(*) total FROM transport_batches b
      WHERE b.organization_id=? AND b.batch_number LIKE 'PZ%' AND ${visibility.sql} ${statusSql} ${searchSql}`,
  ).bind(current.organizationId, ...visibility.values, ...searchBinds).first<{ total: number }>();
  const rows = await env.DB.prepare(
    `SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,
            b.planned_departure_at,b.status,b.road_status,c.name carrier_name,w.name warehouse_name,
            COUNT(DISTINCT bo.order_id) order_count,
            GROUP_CONCAT(DISTINCT o.order_number) order_numbers,
            GROUP_CONCAT(DISTINCT o.id||'|'||o.order_number) order_refs,
            COALESCE(SUM(COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg)),0) total_weight,
            COALESCE(SUM(COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm)),0) total_volume,
            (SELECT COUNT(*) FROM transport_batch_vehicles v WHERE v.batch_id=b.id AND v.status!='cancelled') vehicle_count
       FROM transport_batches b
       JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
       JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       LEFT JOIN carriers c ON c.id=b.carrier_id
       LEFT JOIN warehouses w ON w.id=b.warehouse_id
      WHERE b.organization_id=? AND b.batch_number LIKE 'PZ%' AND ${visibility.sql} ${statusSql} ${searchSql}
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?`,
  ).bind(current.organizationId, ...visibility.values, ...searchBinds, pageSize, (page - 1) * pageSize).all<BatchRow>();

  return {
    batches: rows.results,
    total: count?.total ?? 0,
    q,
    status: ["all", "active", "completed", "cancelled"].includes(status) ? status : "all",
    page,
    pageCount: Math.max(1, Math.ceil((count?.total ?? 0) / pageSize)),
  };
}

export default function LoadingTracking({ loaderData }: Route.ComponentProps) {
  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">CONSOLIDATION TRACKING</p>
        <h1>配载单跟踪</h1>
        <p>配载单由仓库端生成并自动同步；这里只读查看仓库准备结果，整批出库后再进入运输执行与跟踪。</p>
      </div>
      <span className="status-pill">{loaderData.total} 张配载单</span>
    </header>
    <section className="panel">
      <Form method="get" action="." className="filter-bar compact loading-tracking-filter">
        <label className="field"><span>配载单号或订单号</span><input name="q" defaultValue={loaderData.q} placeholder="输入子订单号可定位所属配载单" /></label>
        <label className="field"><span>状态</span><select name="status" defaultValue={loaderData.status}><option value="all">全部</option><option value="active">执行中</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></label>
        <button className="secondary">查询</button>
        <Link className="text-button" to="/admin/loading">重置</Link>
        <details className="inline-details advanced-filter"><summary>高级筛选</summary><div className="filter-help">仓库、目的地、客户和时间等高级条件后续统一接入筛选积木；当前可通过配载单内订单号准确定位。</div></details>
      </Form>
    </section>
    <section className="panel">
      <div className="table-wrap"><table><thead><tr><th>配载单</th><th>线路</th><th>挂载订单</th><th>实收重量/体积</th><th>承运商/仓库</th><th>车辆</th><th>计划发车</th><th>状态</th><th>操作</th></tr></thead><tbody>{loaderData.batches.map((batch) => <tr key={batch.id}>
        <td><strong><BatchNumberLink id={batch.id} number={batch.batch_number}/></strong><small>{batch.batch_name}</small></td>
        <td>{batch.origin_location}<small>→ {batch.destination_location}</small></td>
        <td><strong>{batch.order_count} 票</strong><small className="entity-number-list"><OrderNumberLinkList orders={orderReferences(batch.order_refs)}/></small></td>
        <td>{Number(batch.total_weight || 0).toFixed(2)} KG<small>{Number(batch.total_volume || 0).toFixed(3)} CBM</small></td>
        <td>{batch.carrier_name || "待仓库补齐"}<small>{batch.warehouse_name || "仓库未记录"}</small></td>
        <td>{batch.vehicle_count} 辆</td>
        <td>{formatDate(batch.planned_departure_at)}</td>
        <td><span className="status-pill">{roadStatusLabel(batch.road_status)}</span></td>
        <td><Link className="text-button" to={`/admin/loading/${batch.id}`}>查看配载单</Link></td>
      </tr>)}</tbody></table></div>
      {!loaderData.batches.length && <p className="empty-state">没有找到符合条件的已生成配载单。</p>}
      {loaderData.pageCount > 1 && <div className="pagination">
        {loaderData.page > 1 && <Link className="secondary" to={pageHref(loaderData, loaderData.page - 1)}>上一页</Link>}
        <span>第 {loaderData.page} / {loaderData.pageCount} 页</span>
        {loaderData.page < loaderData.pageCount && <Link className="secondary" to={pageHref(loaderData, loaderData.page + 1)}>下一页</Link>}
      </div>}
    </section>
  </>;
}

function pageHref(data: { q: string; status: string }, page: number) {
  const params = new URLSearchParams({ q: data.q, status: data.status, page: String(page) });
  return `/admin/loading?${params}`;
}

function orderReferences(value: string | null) {
  return (value || "").split(",").flatMap((reference) => {
    const separator = reference.indexOf("|");
    return separator > 0 ? [{ id: reference.slice(0, separator), number: reference.slice(separator + 1) }] : [];
  });
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "待安排";
}

function roadStatusLabel(value: string) {
  return ({
    planning: "计划中",
    loaded_waiting_exit: "已装车待出境",
    outbound_in_transit: "出境运输中",
    overseas_arrived: "已到境外仓",
    waiting_pickup: "等待客户自提",
    pickup_completed: "已完成自提",
    cancelled: "已取消",
  } as Record<string, string>)[value] || value;
}

export function meta() { return [{ title: "配载单跟踪 | International TMS" }]; }
