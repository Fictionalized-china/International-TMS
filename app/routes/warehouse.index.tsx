import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/warehouse.index";
import { requireSessionUser } from "../lib/auth.server";

type WarehouseQueue = "inbound" | "counting" | "inventory" | "outbound" | "exception";

type WarehouseQueueRow = {
  order_id: string;
  shipment_id: string;
  shipment_number: string;
  order_number: string;
  customer_name: string;
  customer_identity_code: string;
  business_type: string;
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  received: number;
  cargo_complete: number;
  receipt_time: string | null;
  package_count: number;
  in_stock_count: number;
  dispatch_status: string | null;
  active_exception_count: number;
  updated_at: string;
};

type CategorizedWarehouseRow = WarehouseQueueRow & { queue: WarehouseQueue };

const queueMeta: Record<WarehouseQueue, { label: string; hint: string }> = {
  inbound: { label: "待入库", hint: "等待扫码收货" },
  counting: { label: "收货清点", hint: "已收货，等待确认货齐或异常" },
  inventory: { label: "在库货物", hint: "已完成实收，等待配载或整车装车" },
  outbound: { label: "待装车出库", hint: "已有装车任务，等待扫码与交接" },
  exception: { label: "异常处理", hint: "货物被冻结，需先处理异常" },
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const url = new URL(request.url);
  const requestedView = url.searchParams.get("view") || "all";
  const view = requestedView === "all" || requestedView in queueMeta ? requestedView : "all";
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const rows = await env.DB.prepare(
    `SELECT s.order_id,s.id shipment_id,s.shipment_number,o.order_number,c.name customer_name,
            c.identity_code customer_identity_code,o.business_type,o.cargo_description,
            o.pieces,o.gross_weight_kg,o.volume_cbm,
            EXISTS(SELECT 1 FROM warehouse_receipts wr WHERE wr.organization_id=s.organization_id AND wr.shipment_id=s.id) received,
            EXISTS(SELECT 1 FROM warehouse_receipts wr WHERE wr.organization_id=s.organization_id AND wr.shipment_id=s.id AND wr.status='completed' AND wr.cargo_complete=1) cargo_complete,
            (SELECT MAX(wr.received_at) FROM warehouse_receipts wr WHERE wr.organization_id=s.organization_id AND wr.shipment_id=s.id) receipt_time,
            (SELECT COUNT(*) FROM warehouse_packages wp WHERE wp.organization_id=s.organization_id AND wp.shipment_id=s.id) package_count,
            (SELECT COUNT(*) FROM warehouse_packages wp WHERE wp.organization_id=s.organization_id AND wp.shipment_id=s.id AND wp.status IN ('in_stock','allocated')) in_stock_count,
            (SELECT wd.status FROM warehouse_dispatches wd WHERE wd.organization_id=s.organization_id AND wd.shipment_id=s.id ORDER BY wd.created_at DESC LIMIT 1) dispatch_status,
            (SELECT COUNT(*) FROM warehouse_exceptions we WHERE we.organization_id=s.organization_id AND we.shipment_id=s.id AND we.status IN ('open','processing')) active_exception_count,
            MAX(o.updated_at,s.updated_at) updated_at
       FROM shipments s
       JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
      WHERE s.organization_id=? AND o.status NOT IN ('cancelled','completed')
      ORDER BY o.updated_at DESC,s.updated_at DESC`,
  ).bind(user.organizationId).all<WarehouseQueueRow>();

  const categorized = rows.results.map((row) => ({ ...row, queue: warehouseQueue(row) }));
  const scoped = categorized.filter((row) => {
    if (view !== "all" && row.queue !== view) return false;
    if (!q) return true;
    return `${row.order_number} ${row.shipment_number} ${row.customer_name} ${row.customer_identity_code} ${row.cargo_description}`.toLowerCase().includes(q);
  });
  const counts = Object.fromEntries(
    Object.keys(queueMeta).map((key) => [key, categorized.filter((row) => row.queue === key).length]),
  ) as Record<WarehouseQueue, number>;
  return { user, rows: scoped, counts, view, q };
}

export default function WarehouseIndex({ loaderData }: Route.ComponentProps) {
  return <>
    <header className="page-header warehouse-queue-header">
      <div><p className="eyebrow">WAREHOUSE WORK QUEUE</p><h1>仓库作业总表</h1><p>一行一票货；系统根据收货、实收、库存、装车和异常记录自动归类。</p></div>
      <Link className="secondary" to="/warehouse/inventory?status=dispatched">查看已出库记录</Link>
    </header>
    <nav className="warehouse-queue-tabs" aria-label="仓库作业分类">
      <Link className={loaderData.view === "all" ? "active" : ""} to="/warehouse">全部 <strong>{Object.values(loaderData.counts).reduce((sum, count) => sum + count, 0)}</strong></Link>
      {(Object.keys(queueMeta) as WarehouseQueue[]).map((key) => <Link key={key} className={loaderData.view === key ? "active" : ""} to={`/warehouse?view=${key}`}>{queueMeta[key].label} <strong>{loaderData.counts[key]}</strong></Link>)}
    </nav>
    <section className="panel warehouse-queue-panel">
      <Form method="get" className="warehouse-queue-filter">
        {loaderData.view !== "all" && <input type="hidden" name="view" value={loaderData.view} />}
        <input name="q" defaultValue={loaderData.q} placeholder="订单、运单、客户、识别码或货物名称" />
        <button className="secondary">筛选</button>
        <Link className="text-button" to={loaderData.view === "all" ? "/warehouse" : `/warehouse?view=${loaderData.view}`}>重置</Link>
      </Form>
      <div className="table-wrap warehouse-queue-table"><table><thead><tr><th>作业状态</th><th>订单 / 运单</th><th>客户</th><th>货物与实收</th><th>入库时间</th><th>当前处理</th><th className="sticky-action">操作</th></tr></thead><tbody>{loaderData.rows.map((row) => <tr key={row.shipment_id} className={row.queue === "exception" ? "row-blocked" : ""}>
        <td><span className={`status-pill warehouse-queue-${row.queue}`}>{queueMeta[row.queue].label}</span><small>{row.business_type === "ftl" ? "整车" : "拼车"}</small></td>
        <td><strong>{row.order_number}</strong><small>{row.shipment_number}</small></td>
        <td><strong>{row.customer_name}</strong><small>识别码 {row.customer_identity_code}</small></td>
        <td><strong>{row.cargo_description || "货物名称待补"}</strong><small>{row.pieces || 0} 件 · {Number(row.gross_weight_kg || 0).toFixed(2)} KG · {Number(row.volume_cbm || 0).toFixed(3)} CBM · {row.package_count} 个标签</small></td>
        <td>{row.receipt_time ? new Date(row.receipt_time).toLocaleString("zh-CN") : "尚未入库"}</td>
        <td><strong>{queueMeta[row.queue].hint}</strong><small>{warehouseQueueDetail(row)}</small></td>
        <td className="sticky-action"><Link className="text-button" to={warehouseQueueHref(row)}>进入办理</Link></td>
      </tr>)}</tbody></table></div>
      {!loaderData.rows.length && <p className="empty-state">当前筛选条件下没有仓库作业。</p>}
    </section>
  </>;
}

function warehouseQueue(row: WarehouseQueueRow): WarehouseQueue {
  if (row.active_exception_count > 0) return "exception";
  if (row.dispatch_status === "loading") return "outbound";
  if (!row.received) return "inbound";
  if (!row.cargo_complete) return "counting";
  return "inventory";
}

function warehouseQueueDetail(row: CategorizedWarehouseRow) {
  if (row.active_exception_count) return `${row.active_exception_count} 条未结案异常`;
  if (row.dispatch_status === "loading") return "装车任务进行中";
  if (!row.received) return "尚无仓库收货记录";
  if (!row.cargo_complete) return "已收货，尚未确认货齐";
  return `${row.in_stock_count}/${row.package_count} 个标签在库或已集货`;
}

function warehouseQueueHref(row: CategorizedWarehouseRow) {
  const returnTo = encodeURIComponent(`/admin/orders/${row.order_id}/modules/warehouse`);
  if (row.queue === "exception") return "/warehouse/exceptions?status=active";
  if (row.queue === "outbound") return `/warehouse/outbound?orderId=${row.order_id}&returnTo=${returnTo}`;
  if (row.queue === "inventory") return `/warehouse/inventory?q=${encodeURIComponent(row.order_number)}`;
  return `/warehouse/inbound?orderId=${row.order_id}&returnTo=${returnTo}`;
}

export function meta() { return [{ title: "仓库作业总表 | International TMS" }]; }
