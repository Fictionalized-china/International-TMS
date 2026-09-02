import { env } from "cloudflare:workers";
import { Link } from "react-router";
import type { Route } from "./+types/admin.package-labels";
import { requireSessionUser } from "../lib/auth.server";
import { requireOrderAccess } from "../lib/order-access.server";

type Label = {
  package_code: string;
  cargo_name_cn: string;
  cargo_name_en: string | null;
  hs_code: string | null;
  package_type: string;
  gross_weight_per_package_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  volume_per_package_cbm: number;
  marks: string | null;
  order_number: string;
  customer_name: string;
  origin_city: string;
  destination_city: string;
};
export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view"),
    orderId = params.orderId;
  await requireOrderAccess(current, orderId);
  const rows = await env.DB.prepare(
    `SELECT p.package_code,i.cargo_name_cn,i.cargo_name_en,i.hs_code,i.package_type,i.gross_weight_per_package_kg,i.length_cm,i.width_cm,i.height_cm,i.volume_per_package_cbm,i.marks,o.order_number,c.name customer_name,o.origin_city,o.destination_city FROM order_cargo_packages p JOIN order_cargo_items i ON i.id=p.cargo_item_id JOIN transport_orders o ON o.id=p.order_id JOIN customers c ON c.id=o.customer_id WHERE p.order_id=? AND p.organization_id=? AND p.status!='cancelled' ORDER BY p.package_code`,
  )
    .bind(orderId, current.organizationId)
    .all<Label>();
  if (!rows.results.length)
    throw new Response("没有可打印的包装标签", { status: 404 });
  return { orderId, labels: rows.results };
}
export default function PackageLabels({ loaderData }: Route.ComponentProps) {
  return (
    <main className="label-page">
      <header className="label-toolbar">
        <div>
          <h1>包装标签</h1>
          <p>
            {loaderData.labels[0].order_number} · 共 {loaderData.labels.length}{" "}
            张
          </p>
        </div>
        <div>
          <Link
            className="secondary"
            to={`/admin/orders/${loaderData.orderId}/operations`}
          >
            返回
          </Link>
          <button className="primary" onClick={() => window.print()}>
            打印标签
          </button>
        </div>
      </header>
      <section className="package-label-grid">
        {loaderData.labels.map((x) => (
          <article className="package-label" key={x.package_code}>
            <header>
              <strong>OULING INTERNATIONAL LOGISTICS</strong>
              <span>{x.package_code}</span>
            </header>
            <div className="package-code">{x.package_code}</div>
            <dl>
              <dt>订单</dt>
              <dd>{x.order_number}</dd>
              <dt>客户</dt>
              <dd>{x.customer_name}</dd>
              <dt>线路</dt>
              <dd>
                {x.origin_city} → {x.destination_city}
              </dd>
              <dt>品名</dt>
              <dd>
                {x.cargo_name_cn}
                {x.cargo_name_en ? ` / ${x.cargo_name_en}` : ""}
              </dd>
              <dt>HS Code</dt>
              <dd>{x.hs_code || "—"}</dd>
              <dt>包装</dt>
              <dd>{x.package_type}</dd>
              <dt>重量</dt>
              <dd>{x.gross_weight_per_package_kg} KG</dd>
              <dt>尺寸</dt>
              <dd>
                {x.length_cm} × {x.width_cm} × {x.height_cm} CM
              </dd>
              <dt>体积</dt>
              <dd>{x.volume_per_package_cbm.toFixed(4)} CBM</dd>
              <dt>唛头</dt>
              <dd>{x.marks || "—"}</dd>
            </dl>
          </article>
        ))}
      </section>
    </main>
  );
}
export function meta() {
  return [{ title: "包装标签打印 | International TMS" }];
}
