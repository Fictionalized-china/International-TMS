import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/warehouse.index";
import { Modal } from "../components/Modal";
import { OrderRouteFilterFields } from "../components/OrderRouteFilterFields";
import { requireSessionUser } from "../lib/auth.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { matchesOrderRouteFilters, orderRouteFilterCount, readOrderRouteFilters } from "../lib/order-route-filters";
import {
  resolveWarehouseCargoIdentifiers,
  type WarehouseCargoPackageIdentifier,
} from "../lib/warehouse-cargo-identifiers";

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
  origin_country: string | null;
  origin_state: string | null;
  origin_city: string | null;
  origin_address: string | null;
  exit_port: string | null;
  exit_port_name: string | null;
  destination_country: string | null;
  destination_state: string | null;
  destination_city: string | null;
  destination_address: string | null;
  overseas_warehouse_name: string | null;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  received: number;
  cargo_complete: number;
  receipt_time: string | null;
  package_count: number;
  in_stock_count: number;
  overseas_operation_status: string | null;
  dispatch_status: string | null;
  active_exception_count: number;
  updated_at: string;
};

type CategorizedWarehouseRow = WarehouseQueueRow & { queue: WarehouseQueue };

type WarehouseCargoItem = {
  id: string;
  order_id: string;
  line_no: number;
  cargo_name_cn: string;
  cargo_name_en: string | null;
  hs_code: string | null;
  overseas_hs_code: string | null;
  package_type: string;
  package_count: number;
  pieces_per_package: number;
  gross_weight_per_package_kg: number;
  net_weight_per_package_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  volume_per_package_cbm: number;
  declared_value: number;
  currency: string;
  origin_country: string | null;
  brand_model: string | null;
  marks: string | null;
  special_attributes: string | null;
  notes: string | null;
};

const queueMeta: Record<WarehouseQueue, { label: string; hint: string }> = {
  inbound: { label: "待入库", hint: "等待扫码收货" },
  counting: { label: "收货清点", hint: "已收货，等待确认货齐或异常" },
  inventory: { label: "在库货物", hint: "已完成实收，等待配载或整车装车" },
  outbound: { label: "装车与出库", hint: "已有装车任务，等待扫码与交接" },
  exception: { label: "异常处理", hint: "货物被冻结，需先处理异常" },
};

function queueHint(queue: WarehouseQueue, overseas: boolean) {
  if (!overseas) return queueMeta[queue].hint;
  if (queue === "inbound") return "等待目的仓扫码入库";
  if (queue === "counting") return "已入库，等待清点确认";
  if (queue === "inventory") return "已清点，等待运输单齐套同步";
  if (queue === "outbound") return "境外仓无需再次装车出库";
  return queueMeta[queue].hint;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const warehouseContext = await loadWarehouseContext(request, user);
  const warehouse = warehouseContext.selected;
  const url = new URL(request.url);
  const requestedView = url.searchParams.get("view") || "all";
  const view = requestedView === "all" || requestedView in queueMeta ? requestedView : "all";
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const routeFilters = readOrderRouteFilters(url.searchParams);
  const rows = await env.DB.prepare(
    `SELECT s.order_id,s.id shipment_id,s.shipment_number,o.order_number,c.name customer_name,
            c.identity_code customer_identity_code,o.business_type,o.cargo_description,
            o.origin_country,o.origin_state,o.origin_city,o.origin_address,
            o.exit_port,route_port.name exit_port_name,
            o.destination_country,o.destination_state,o.destination_city,o.destination_address,
            ow.name overseas_warehouse_name,
            o.pieces,o.gross_weight_kg,o.volume_cbm,
            EXISTS(SELECT 1 FROM warehouse_receipts wr WHERE wr.organization_id=s.organization_id AND wr.shipment_id=s.id AND wr.warehouse_id=?) received,
            EXISTS(SELECT 1 FROM warehouse_receipts wr WHERE wr.organization_id=s.organization_id AND wr.shipment_id=s.id AND wr.warehouse_id=? AND wr.status='completed' AND wr.cargo_complete=1) cargo_complete,
            (SELECT MAX(wr.received_at) FROM warehouse_receipts wr WHERE wr.organization_id=s.organization_id AND wr.shipment_id=s.id AND wr.warehouse_id=?) receipt_time,
            (SELECT COUNT(*) FROM warehouse_packages wp WHERE wp.organization_id=s.organization_id AND wp.shipment_id=s.id AND wp.warehouse_id=?) package_count,
            (SELECT COUNT(*) FROM warehouse_packages wp WHERE wp.organization_id=s.organization_id AND wp.shipment_id=s.id AND wp.warehouse_id=? AND wp.status IN ('in_stock','allocated')) in_stock_count,
            (SELECT op.status
               FROM overseas_warehouse_operations op
              WHERE op.organization_id=s.organization_id AND op.order_id=s.order_id AND op.warehouse_id=? AND op.status!='cancelled'
              ORDER BY op.created_at DESC LIMIT 1) overseas_operation_status,
            (SELECT wd.status
               FROM warehouse_dispatches wd
               JOIN warehouse_dispatch_items wdi ON wdi.dispatch_id=wd.id
               JOIN warehouse_packages dwp ON dwp.id=wdi.package_id AND dwp.shipment_id=s.id
               JOIN warehouse_sorting_items dsi ON dsi.package_id=dwp.id
               JOIN warehouse_sorting_batches dsb ON dsb.id=dsi.batch_id
               JOIN warehouse_locations dl ON dl.id=dsb.target_location_id
              WHERE wd.organization_id=s.organization_id AND dl.warehouse_id=?
              ORDER BY wd.created_at DESC LIMIT 1) dispatch_status,
            (SELECT COUNT(*) FROM warehouse_exceptions we JOIN warehouse_packages wp ON wp.id=we.package_id WHERE we.organization_id=s.organization_id AND we.shipment_id=s.id AND wp.warehouse_id=? AND we.status IN ('open','processing')) active_exception_count,
            MAX(o.updated_at,s.updated_at) updated_at
       FROM shipments s
       JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
       LEFT JOIN reference_data route_port ON route_port.organization_id=o.organization_id AND route_port.category='border_port' AND route_port.code=o.exit_port
      WHERE s.organization_id=? AND o.status NOT IN ('cancelled','completed')
        AND ${warehouse.warehouse_role === "overseas_destination"
          ? `o.overseas_warehouse_id=? AND (
               EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.road_status IN ('outbound_in_transit','overseas_arrived','waiting_pickup','pickup_completed'))
               OR EXISTS(SELECT 1 FROM warehouse_receipts wr WHERE wr.organization_id=o.organization_id AND wr.shipment_id=s.id AND wr.warehouse_id=?)
             )`
          : `(EXISTS(SELECT 1 FROM order_transport_assignments a WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.leg_type='first_mile' AND a.status!='cancelled' AND a.destination_warehouse_id=?)
               OR EXISTS(SELECT 1 FROM warehouse_receipts wr WHERE wr.organization_id=o.organization_id AND wr.shipment_id=s.id AND wr.warehouse_id=?))`}
      ORDER BY o.updated_at DESC,s.updated_at DESC`,
  ).bind(
    warehouse.id,
    warehouse.id,
    warehouse.id,
    warehouse.id,
    warehouse.id,
    warehouse.id,
    warehouse.id,
    warehouse.id,
    user.organizationId,
    warehouse.id,
    warehouse.id,
  ).all<WarehouseQueueRow>();

  const activeRows = warehouse.warehouse_role === "overseas_destination"
    ? rows.results.filter((row) => row.overseas_operation_status !== "picked_up")
    : rows.results.filter((row) => row.dispatch_status !== "dispatched");
  const categorized = activeRows.map((row) => ({ ...row, queue: warehouseQueue(row) }));
  const scoped = categorized.filter((row) => {
    if (view !== "all" && row.queue !== view) return false;
    if (!matchesOrderRouteFilters(row, routeFilters)) return false;
    if (q && !`${row.order_number} ${row.shipment_number} ${row.customer_name} ${row.customer_identity_code} ${row.cargo_description}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const counts = Object.fromEntries(
    Object.keys(queueMeta).map((key) => [key, categorized.filter((row) => row.queue === key).length]),
  ) as Record<WarehouseQueue, number>;
  const orderIds = [...new Set(scoped.map((row) => row.order_id))];
  const cargoItems: WarehouseCargoItem[] = [];
  const cargoPackages: WarehouseCargoPackageIdentifier[] = [];
  for (const ids of chunk(orderIds, 80)) {
    const [cargoResult, packageResult] = await Promise.all([
      env.DB.prepare(
        `SELECT id,order_id,line_no,cargo_name_cn,cargo_name_en,hs_code,overseas_hs_code,
              package_type,package_count,pieces_per_package,gross_weight_per_package_kg,
              net_weight_per_package_kg,length_cm,width_cm,height_cm,volume_per_package_cbm,
              declared_value,currency,origin_country,brand_model,marks,special_attributes,notes
         FROM order_cargo_items
        WHERE organization_id=? AND order_id IN (${ids.map(() => "?").join(",")})
        ORDER BY order_id,line_no,id`,
      ).bind(user.organizationId, ...ids).all<WarehouseCargoItem>(),
      env.DB.prepare(
        `SELECT p.id,s.order_id,p.cargo_item_id,p.package_number,p.barcode,p.status
           FROM warehouse_packages p
           JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
          WHERE p.organization_id=? AND s.order_id IN (${ids.map(() => "?").join(",")})
            AND p.status!='cancelled'
          ORDER BY s.order_id,p.package_number,p.created_at`,
      ).bind(user.organizationId, ...ids).all<WarehouseCargoPackageIdentifier>(),
    ]);
    cargoItems.push(...cargoResult.results);
    cargoPackages.push(...packageResult.results);
  }
  return {
    user,
    warehouse,
    rows: scoped,
    cargoItems,
    cargoPackages,
    counts,
    view,
    q,
    routeFilters,
  };
}

export default function WarehouseIndex({ loaderData }: Route.ComponentProps) {
  const advancedFilterCount = orderRouteFilterCount(loaderData.routeFilters);
  return <div className="page prototype-page warehouse-queue-page">
    <div className="breadcrumb">仓库作业 / 作业总览 / {loaderData.warehouse.name}</div>
    <header className="page-head">
      <div><p className="prototype-kicker">WAREHOUSE WORK QUEUE</p><h1>仓库作业总表</h1><p>一行一票货；系统根据收货、实收、库存、装车和异常记录自动归类。</p></div>
      <Link className="btn" to={warehousePath("/warehouse/inventory", loaderData.warehouse.id, { status: "dispatched" })}>查看已出库记录</Link>
    </header>
    <nav className="warehouse-queue-tabs" aria-label="仓库作业分类">
      <Link className={loaderData.view === "all" ? "active" : ""} to={warehousePath("/warehouse", loaderData.warehouse.id)}>全部 <strong>{Object.values(loaderData.counts).reduce((sum, count) => sum + count, 0)}</strong></Link>
      {(Object.keys(queueMeta) as WarehouseQueue[]).map((key) => <Link key={key} className={loaderData.view === key ? "active" : ""} to={warehousePath("/warehouse", loaderData.warehouse.id, { view: key })}>{queueMeta[key].label} <strong>{loaderData.counts[key]}</strong></Link>)}
    </nav>
    <section className="table-panel warehouse-queue-panel">
      <Form method="get" action="." className="warehouse-queue-filter">
        {loaderData.view !== "all" && <input type="hidden" name="view" value={loaderData.view} />}
        <input type="hidden" name="warehouseId" value={loaderData.warehouse.id} />
        <input name="q" defaultValue={loaderData.q} placeholder="订单、运单、客户、识别码或货物名称" />
        <button className="secondary">筛选</button>
        <Link className="text-button" to={warehousePath("/warehouse", loaderData.warehouse.id, loaderData.view === "all" ? undefined : { view: loaderData.view })}>重置</Link>
        <details className="order-route-advanced-filter" open={advancedFilterCount > 0}>
          <summary><span>更多筛选条件</span><small>{advancedFilterCount ? `已启用 ${advancedFilterCount} 项` : "出发地、出境口岸、目的地"}</small></summary>
          <div className="order-route-filter-grid"><OrderRouteFilterFields filters={loaderData.routeFilters}/></div>
        </details>
      </Form>
      <div className="table-wrap warehouse-queue-table"><table><thead><tr><th>作业状态</th><th>订单 / 运单</th><th>客户</th><th>货物与实收</th><th>入库时间</th><th>当前处理</th><th className="sticky-action">操作</th></tr></thead><tbody>{loaderData.rows.map((row) => <tr key={row.shipment_id} className={row.queue === "exception" ? "row-blocked" : ""}>
        <td><span className={`status-pill warehouse-queue-${row.queue}`}>{queueMeta[row.queue].label}</span><small>{row.business_type === "ftl" ? "整车" : "拼车"}</small></td>
        <td><strong>{row.order_number}</strong><small>{row.shipment_number}</small></td>
        <td><strong>{row.customer_name}</strong><small>识别码 {row.customer_identity_code}</small></td>
        <td><strong>{row.cargo_description || "货物名称待补"}</strong><small>{row.pieces || 0} 件 · {Number(row.gross_weight_kg || 0).toFixed(2)} KG · {Number(row.volume_cbm || 0).toFixed(3)} CBM · {row.package_count} 个标签</small></td>
        <td>{row.receipt_time ? new Date(row.receipt_time).toLocaleString("zh-CN") : "尚未入库"}</td>
        <td><strong>{queueHint(row.queue, loaderData.warehouse.warehouse_role === "overseas_destination")}</strong><small>{warehouseQueueDetail(row)}</small></td>
        <td className="sticky-action"><div className="warehouse-queue-actions">
          <Link className="warehouse-queue-action primary-action" to={warehouseQueueHref(row, loaderData.warehouse.id, loaderData.warehouse.warehouse_role === "overseas_destination")}>进入办理</Link>
          <Modal title={`货物详情 · ${row.order_number}`} triggerLabel="查看货物" triggerClassName="warehouse-queue-action" size="xwide">
            <WarehouseCargoDetails row={row} items={loaderData.cargoItems.filter((item) => item.order_id === row.order_id)} packages={loaderData.cargoPackages.filter((item) => item.order_id === row.order_id)} />
          </Modal>
        </div></td>
      </tr>)}</tbody></table></div>
      {!loaderData.rows.length && <p className="empty-state">当前筛选条件下没有仓库作业。</p>}
    </section>
  </div>;
}

function WarehouseCargoDetails({ row, items, packages }: { row: CategorizedWarehouseRow; items: WarehouseCargoItem[]; packages: WarehouseCargoPackageIdentifier[] }) {
  const totals = items.reduce((sum, item) => ({
    packages: sum.packages + item.package_count,
    pieces: sum.pieces + item.package_count * item.pieces_per_package,
    grossWeight: sum.grossWeight + item.package_count * item.gross_weight_per_package_kg,
    volume: sum.volume + item.package_count * item.volume_per_package_cbm,
  }), { packages: 0, pieces: 0, grossWeight: 0, volume: 0 });

  return <div className="warehouse-cargo-dialog">
    <div className="warehouse-cargo-summary">
      <span><small>客户</small><strong>{row.customer_name}</strong></span>
      <span><small>运单号</small><strong>{row.shipment_number}</strong></span>
      <span><small>货物品类</small><strong>{items.length || 1}</strong></span>
      <span><small>包装 / 件数</small><strong>{items.length ? `${totals.packages} 包装 / ${totals.pieces} 件` : `${row.pieces || 0} 件`}</strong></span>
      <span><small>总毛重</small><strong>{(items.length ? totals.grossWeight : Number(row.gross_weight_kg || 0)).toFixed(2)} KG</strong></span>
      <span><small>总体积</small><strong>{(items.length ? totals.volume : Number(row.volume_cbm || 0)).toFixed(3)} CBM</strong></span>
    </div>
    {items.length ? <div className="table-wrap warehouse-cargo-detail-table"><table>
      <thead><tr><th>序号 / 品名</th><th>HS Code</th><th>包装</th><th>重量</th><th>尺寸 / 体积</th><th>申报信息</th><th>唛头号 / 货物条码</th><th>属性与备注</th></tr></thead>
      <tbody>{items.map((item) => {
        const identifiers = resolveWarehouseCargoIdentifiers({
          orderNumber: row.order_number,
          cargoItemId: item.id,
          customMarks: item.marks,
          packages,
          singleCargoItem: items.length === 1,
        });
        return <tr key={item.id}>
        <td><strong>{item.line_no}. {item.cargo_name_cn}</strong><small>{item.cargo_name_en || "英文品名未填"}</small></td>
        <td><strong>{item.hs_code || "—"}</strong><small>境外：{item.overseas_hs_code || "—"}</small></td>
        <td><strong>{packageTypeLabel(item.package_type)} · {item.package_count} 包装</strong><small>{item.pieces_per_package} 件/包装，共 {item.package_count * item.pieces_per_package} 件</small></td>
        <td><strong>毛重 {item.gross_weight_per_package_kg.toFixed(2)} KG/包装</strong><small>净重 {item.net_weight_per_package_kg.toFixed(2)} KG/包装</small></td>
        <td><strong>{item.length_cm} × {item.width_cm} × {item.height_cm} cm</strong><small>{item.volume_per_package_cbm.toFixed(4)} CBM/包装</small></td>
        <td><strong>{item.currency} {item.declared_value.toLocaleString("zh-CN")}</strong><small>{item.origin_country || "原产国未填"}{item.brand_model ? ` · ${item.brand_model}` : ""}</small></td>
        <td className="warehouse-cargo-identifiers"><small>唛头号（订单号）</small><code>{identifiers.markNumber}</code><small>货物条码</small>{identifiers.packages.length ? <div>{identifiers.packages.map((pkg) => <code key={pkg.id} title={`包装号 ${pkg.package_number}`}>{pkg.barcode}</code>)}</div> : <em>尚未生成（国内仓收货时生成）</em>}</td>
        <td><strong>{identifiers.customMarks ? `货物标记：${identifiers.customMarks}` : "无额外货物标记"}</strong><small>{[item.special_attributes, item.notes].filter(Boolean).join(" · ") || "无备注"}</small></td>
      </tr>;
      })}</tbody>
    </table></div> : <div className="warehouse-cargo-empty">
      <strong>{row.cargo_description || "货物名称待补"}</strong>
      <span>唛头号（订单号）：<code>{row.order_number}</code></span>
      <span>货物条码：{packages.length ? packages.map((item) => item.barcode).join("、") : "尚未生成（国内仓收货时生成）"}</span>
      <span>该订单尚无逐项货物明细，当前仅有订单汇总：{row.pieces || 0} 件 · {Number(row.gross_weight_kg || 0).toFixed(2)} KG · {Number(row.volume_cbm || 0).toFixed(3)} CBM。</span>
    </div>}
  </div>;
}

function packageTypeLabel(value: string) {
  return ({ carton: "纸箱", wooden_case: "木箱", pallet: "托盘", bag: "袋装", drum: "桶装", bundle: "捆装", other: "其他" } as Record<string, string>)[value] || value;
}

function chunk<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
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

function warehouseQueueHref(row: CategorizedWarehouseRow, warehouseId: string, overseas: boolean) {
  const returnTo = `/admin/orders/${row.order_id}/modules/${overseas ? "overseas_warehouse" : "warehouse"}`;
  if (row.queue === "exception") return warehousePath("/warehouse/exceptions", warehouseId, { status: "active" });
  if (row.queue === "outbound") return warehousePath("/warehouse/outbound", warehouseId, { orderId: row.order_id, returnTo });
  if (row.queue === "inventory") return warehousePath("/warehouse/inventory", warehouseId, { q: row.order_number });
  return warehousePath(overseas ? "/warehouse/inbound" : "/warehouse/acceptance", warehouseId, { orderId: row.order_id, returnTo });
}

function warehousePath(path: string, warehouseId: string, values?: Record<string, string>) {
  const params = new URLSearchParams({ warehouseId, ...(values ?? {}) });
  return `${path}?${params}`;
}

export function meta() { return [{ title: "仓库作业总表 | International TMS" }]; }
