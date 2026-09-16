import { env } from "cloudflare:workers";
import { Link } from "react-router";
import type { Route } from "./+types/admin.cargo";
import { requireSessionUser } from "../lib/auth.server";
import { orderVisibilitySql } from "../lib/order-access.server";
import { statusLabel } from "../lib/order-workflow";

const PAGE_SIZE = 10;

type CargoRow = {
  id: string;
  line_no: number;
  cargo_name_cn: string;
  cargo_name_en: string | null;
  hs_code: string | null;
  package_type: string;
  package_count: number;
  pieces_per_package: number;
  gross_weight_per_package_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  volume_per_package_cbm: number;
  created_at: string;
  order_id: string;
  order_number: string;
  order_status: string;
  customer_name: string;
  customer_identity_code: string | null;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
};

type CargoImage = {
  id: string;
  cargo_item_id: string;
  file_name: string;
};

const packageLabels: Record<string, string> = {
  carton: "纸箱",
  pallet: "托盘",
  wooden_case: "木箱",
  bag: "袋",
  drum: "桶",
  bundle: "捆",
  other: "其他",
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request);
  if (!current.permissions.some((permission) => [
    "order.module.cargo.view",
    "order.module.cargo.manage",
  ].includes(permission))) {
    throw new Response("无权查看货物信息", { status: 403 });
  }
  const visibility = orderVisibilitySql(current, "o");
  const requestedPage = Math.max(
    1,
    Number(new URL(request.url).searchParams.get("page")) || 1,
  );
  const count = await env.DB.prepare(
    `SELECT COUNT(*) total
       FROM order_cargo_items i
       JOIN transport_orders o ON o.id=i.order_id AND o.organization_id=i.organization_id
      WHERE i.organization_id=? AND ${visibility.sql}`,
  )
    .bind(current.organizationId, ...visibility.values)
    .first<{ total: number }>();
  const total = count?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const cargo = await env.DB.prepare(
    `SELECT i.id,i.line_no,i.cargo_name_cn,i.cargo_name_en,i.hs_code,i.package_type,i.package_count,i.pieces_per_package,i.gross_weight_per_package_kg,i.length_cm,i.width_cm,i.height_cm,i.volume_per_package_cbm,i.created_at,o.id order_id,o.order_number,o.status order_status,c.name customer_name,c.identity_code customer_identity_code,o.origin_country,o.origin_state,o.origin_city,o.destination_country,o.destination_state,o.destination_city
     FROM order_cargo_items i
     JOIN transport_orders o ON o.id=i.order_id AND o.organization_id=i.organization_id
     JOIN customers c ON c.id=o.customer_id AND c.organization_id=i.organization_id
     WHERE i.organization_id=? AND ${visibility.sql}
     ORDER BY i.created_at DESC,i.id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(current.organizationId, ...visibility.values, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all<CargoRow>();
  const ids = cargo.results.map((item) => item.id);
  const images = ids.length
    ? await env.DB.prepare(
        `SELECT id,cargo_item_id,file_name FROM order_cargo_images WHERE organization_id=? AND cargo_item_id IN (${ids.map(() => "?").join(",")}) ORDER BY cargo_item_id,sort_order,created_at`,
      )
        .bind(current.organizationId, ...ids)
        .all<CargoImage>()
    : { results: [] as CargoImage[] };
  return {
    cargo: cargo.results,
    images: images.results,
    total,
    page,
    pages,
  };
}

export function meta() {
  return [{ title: "货物信息 | International TMS" }];
}

export default function CargoInformation({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">ROAD FREIGHT CARGO</p>
          <h1>货物信息</h1>
          <p>按订单货物明细的最小记录单位，集中查看全部汽运货物。</p>
        </div>
        <span className="status-pill">共 {loaderData.total} 条</span>
      </header>
      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>客户</th>
                <th>关联订单</th>
                <th>货物名称</th>
                <th>HS Code</th>
                <th>包装/件数</th>
                <th>重量</th>
                <th>体积/尺寸</th>
                <th>图片</th>
                <th>运输线路</th>
                <th>订单状态</th>
                <th>录入时间</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.cargo.map((item) => {
                const itemImages = loaderData.images.filter(
                  (image) => image.cargo_item_id === item.id,
                );
                const pieces = item.package_count * item.pieces_per_package;
                const totalWeight =
                  item.package_count * item.gross_weight_per_package_kg;
                const totalVolume =
                  item.package_count * item.volume_per_package_cbm;
                return (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.customer_name}</strong>
                      <small>{item.customer_identity_code || "—"}</small>
                    </td>
                    <td>
                      <Link to={`/admin/orders/${item.order_id}`}>
                        <strong>{item.order_number}</strong>
                      </Link>
                      <small>货物明细 {item.line_no}</small>
                    </td>
                    <td>
                      <strong>{item.cargo_name_cn}</strong>
                      <small>{item.cargo_name_en || "—"}</small>
                    </td>
                    <td>{item.hs_code || "—"}</td>
                    <td>
                      <strong>
                        {packageLabels[item.package_type] || item.package_type}{" "}
                        × {item.package_count}
                      </strong>
                      <small>
                        每包装 {item.pieces_per_package} 件 · 共 {pieces} 件
                      </small>
                    </td>
                    <td>
                      <strong>{totalWeight.toLocaleString()} KG</strong>
                      <small>
                        单包装 {item.gross_weight_per_package_kg} KG
                      </small>
                    </td>
                    <td>
                      <strong>{totalVolume.toFixed(4)} CBM</strong>
                      <small>
                        {item.length_cm}×{item.width_cm}×{item.height_cm} cm
                      </small>
                    </td>
                    <td>
                      {itemImages.length ? (
                        <div className="cargo-table-images">
                          {itemImages.slice(0, 3).map((image) => {
                            const imageHref = `/admin/cargo-images/${image.id}`;
                            return (
                              <a
                                key={image.id}
                                href={imageHref}
                                target="_blank"
                                rel="noreferrer"
                                title={image.file_name}
                              >
                                <img src={imageHref} alt={image.file_name} loading="lazy" />
                              </a>
                            );
                          })}
                          {itemImages.length > 3 && (
                            <span>+{itemImages.length - 3}</span>
                          )}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <strong>
                        {place(
                          item.origin_country,
                          item.origin_state,
                          item.origin_city,
                        )}
                      </strong>
                      <small>
                        →{" "}
                        {place(
                          item.destination_country,
                          item.destination_state,
                          item.destination_city,
                        )}
                      </small>
                    </td>
                    <td>
                      <span
                        className={`status-pill ${item.order_status === "cancelled" ? "off" : ""}`}
                      >
                        {statusLabel(item.order_status)}
                      </span>
                    </td>
                    <td>{new Date(item.created_at).toLocaleString("zh-CN")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loaderData.cargo.length && (
          <p className="empty-state">当前没有订单货物明细。</p>
        )}
        <CargoPagination page={loaderData.page} pages={loaderData.pages} />
      </section>
    </>
  );
}

function place(country: string, state: string | null, city: string) {
  return [country, state, city].filter(Boolean).join(" ");
}

function CargoPagination({ page, pages }: { page: number; pages: number }) {
  if (pages <= 1) return null;
  return (
    <footer className="pagination" aria-label="货物信息分页">
      <span>
        第 {page} / {pages} 页
      </span>
      <div>
        {page > 1 && (
          <Link className="secondary" to={`?page=${page - 1}`}>
            上一页
          </Link>
        )}
        {page < pages && (
          <Link className="secondary" to={`?page=${page + 1}`}>
            下一页
          </Link>
        )}
      </div>
    </footer>
  );
}
