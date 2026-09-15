import { env } from "cloudflare:workers";
import { Link } from "react-router";
import type { Route } from "./+types/warehouse.packing-labels";
import { Code39 } from "../components/OrderMarkLabelPage";
import { requireSessionUser } from "../lib/auth.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";

type LabelRow = {
  barcode: string;
  package_number: string;
  weight_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  volume_cbm: number;
  order_number: string;
  cargo_description: string;
  customer_name: string;
  package_sequence: number;
  package_total: number;
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const context = await loadWarehouseContext(request, user);
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") || "";
  const rows = await env.DB.prepare(`SELECT p.barcode,p.package_number,p.weight_kg,p.length_cm,p.width_cm,p.height_cm,p.volume_cbm,
      o.order_number,o.cargo_description,c.name customer_name,
      ROW_NUMBER() OVER(ORDER BY p.created_at,p.id) package_sequence,
      COUNT(*) OVER() package_total
    FROM warehouse_packages p
    JOIN warehouse_packing_jobs job ON job.id=p.packing_job_id AND job.organization_id=p.organization_id
    JOIN transport_orders o ON o.id=job.order_id AND o.organization_id=job.organization_id
    JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
    WHERE p.organization_id=? AND p.warehouse_id=? AND p.packing_job_id=?
      AND p.label_kind='oul' AND p.lifecycle_status='active' AND job.status!='cancelled'
    ORDER BY p.created_at,p.id`).bind(user.organizationId, context.selected.id, jobId).all<LabelRow>();
  if (!rows.results.length) throw new Response("没有可打印的 OUL", { status: 404 });
  return { warehouse: context.selected, jobId, labels: rows.results };
}

export default function WarehousePackingLabels({ loaderData }: Route.ComponentProps) {
  return <main className="label-page warehouse-oul-label-page">
    <header className="label-toolbar"><div><h1>最终出仓包装标签（OUL）</h1><p>{loaderData.labels[0].order_number} · 共 {loaderData.labels.length} 张</p></div><div><Link className="secondary" to={`/warehouse/packing?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}`}>返回包装队列</Link><button className="primary" onClick={() => window.print()}>打印全部 OUL</button></div></header>
    <section className="package-label-grid">{loaderData.labels.map((label) => <article className="package-label" key={label.barcode}><header><strong>OULING 国际物流</strong><span>最终出仓包装标签</span></header><Code39 value={label.barcode}/><div className="package-code">{label.barcode}</div><dl><dt>订单号</dt><dd>{label.order_number}</dd><dt>客户</dt><dd>{label.customer_name}</dd><dt>包裹序号</dt><dd>{label.package_sequence} / {label.package_total}</dd><dt>货物</dt><dd>{label.cargo_description || "—"}</dd><dt>实重</dt><dd>{label.weight_kg.toFixed(3)} KG</dd><dt>尺寸</dt><dd>{label.length_cm} × {label.width_cm} × {label.height_cm} CM</dd><dt>体积</dt><dd>{label.volume_cbm.toFixed(4)} CBM</dd></dl><small>全程身份：国内仓出库 → 境外仓收货 → 客户自提签收</small></article>)}</section>
  </main>;
}

export function meta() { return [{ title: "OUL 打印 | International TMS" }]; }
