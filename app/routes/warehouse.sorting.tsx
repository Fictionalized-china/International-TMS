import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.sorting";
import { Modal } from "../components/Modal";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { recordWarehouseProgress } from "../lib/warehouse-progress.server";
import { ensureOrderModules } from "../lib/order-modules.server";

type Shipment = {
  id: string;
  shipment_number: string;
  order_number: string;
  customer_name: string;
  customer_identity_code: string;
  origin_city: string;
  destination_city: string;
};
type Location = {
  id: string;
  name: string;
  code: string;
  zone_name: string;
  zone_type: string;
  warehouse_name: string;
  preferred: number;
};
type Batch = {
  id: string;
  batch_number: string;
  shipment_id: string;
  order_id: string;
  business_type: string;
  exit_port: string | null;
  customs_location: string | null;
  transit_locations: string | null;
  route_notes: string | null;
  shipment_number: string;
  order_number: string;
  customer_name: string;
  customer_identity_code: string;
  target_location_id: string;
  target_location: string;
  warehouse_name: string;
  status: string;
  item_count: number;
  verified_count: number;
  created_at: string;
  creator_name: string | null;
};
type Item = {
  id: string;
  batch_id: string;
  barcode: string;
  package_number: string;
  pieces: number;
  weight_kg: number | null;
  status: string;
  sorted_at: string;
};
type Movement = {
  id: string;
  barcode: string;
  operation_type: string;
  from_location: string | null;
  to_location: string | null;
  operator_name: string | null;
  occurred_at: string;
};
type SortingFilter = "all" | "open" | "staged" | "verified";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const url = new URL(request.url);
  const filter = parseSortingFilter(url.searchParams.get("filter"));
  const orderId = url.searchParams.get("orderId");
  if (orderId) await ensureSortingBatchForOrder(user.organizationId, user.userId, orderId);

  const [shipments, locations, batches, items, movements] = await Promise.all([
    env.DB.prepare(
      `SELECT s.id,s.shipment_number,o.order_number,c.name customer_name,c.identity_code customer_identity_code,o.origin_city,o.destination_city
       FROM shipments s
       JOIN transport_orders o ON o.id=s.order_id
       JOIN customers c ON c.id=s.customer_id
       WHERE s.organization_id=? AND s.status IN ('picked_up','in_transit')
       ORDER BY s.updated_at DESC`,
    ).bind(user.organizationId).all<Shipment>(),
    env.DB.prepare(
      `SELECT l.id,l.name,l.code,z.name zone_name,z.zone_type,w.name warehouse_name,
         CASE WHEN z.zone_type IN ('sorting','staging','storage') THEN 1 ELSE 0 END preferred
       FROM warehouse_locations l
       JOIN warehouse_zones z ON z.id=l.zone_id
       JOIN warehouses w ON w.id=l.warehouse_id
       WHERE l.organization_id=? AND l.status='active' AND z.status='active' AND w.status='active'
       ORDER BY preferred DESC,w.code,z.code,l.code`,
    ).bind(user.organizationId).all<Location>(),
    env.DB.prepare(
      `SELECT b.id,b.batch_number,b.shipment_id,o.id order_id,o.business_type,o.exit_port,o.customs_location,o.transit_locations,o.route_notes,
         s.shipment_number,o.order_number,c.name customer_name,c.identity_code customer_identity_code,
         b.target_location_id,l.name target_location,w.name warehouse_name,b.status,
         COUNT(i.id) item_count,
         SUM(CASE WHEN i.status='verified' THEN 1 ELSE 0 END) verified_count,
         b.created_at,u.display_name creator_name
       FROM warehouse_sorting_batches b
       JOIN shipments s ON s.id=b.shipment_id
       JOIN transport_orders o ON o.id=s.order_id
       JOIN customers c ON c.id=s.customer_id
       JOIN warehouse_locations l ON l.id=b.target_location_id
       JOIN warehouses w ON w.id=l.warehouse_id
       LEFT JOIN warehouse_sorting_items i ON i.batch_id=b.id
       LEFT JOIN users u ON u.id=b.created_by_user_id
       WHERE b.organization_id=?
       GROUP BY b.id
       ORDER BY CASE b.status WHEN 'open' THEN 1 WHEN 'staged' THEN 2 ELSE 3 END,b.updated_at DESC
       LIMIT 50`,
    ).bind(user.organizationId).all<Batch>(),
    env.DB.prepare(
      `SELECT i.id,i.batch_id,p.barcode,p.package_number,p.pieces,p.weight_kg,i.status,i.sorted_at
       FROM warehouse_sorting_items i
       JOIN warehouse_packages p ON p.id=i.package_id
       WHERE i.organization_id=?
       ORDER BY i.sorted_at DESC LIMIT 500`,
    ).bind(user.organizationId).all<Item>(),
    env.DB.prepare(
      `SELECT m.id,p.barcode,m.operation_type,lf.name from_location,lt.name to_location,u.display_name operator_name,m.occurred_at
       FROM warehouse_package_movements m
       JOIN warehouse_packages p ON p.id=m.package_id
       LEFT JOIN warehouse_locations lf ON lf.id=m.from_location_id
       LEFT JOIN warehouse_locations lt ON lt.id=m.to_location_id
       LEFT JOIN users u ON u.id=m.operator_user_id
       WHERE m.organization_id=?
       ORDER BY m.occurred_at DESC LIMIT 20`,
    ).bind(user.organizationId).all<Movement>(),
  ]);

  const allBatches = orderId
    ? batches.results.filter((batch) => batch.order_id === orderId)
    : batches.results;
  const stats = {
    open: allBatches.filter((x) => x.status === "open").length,
    staged: allBatches.filter((x) => x.status === "staged").length,
    verifiedToday: allBatches.filter((x) => x.status === "verified" && sameLocalDate(x.created_at, new Date())).length,
  };
  return {
    user,
    shipments: shipments.results,
    locations: locations.results,
    batches: filterBatches(allBatches, filter),
    items: items.results,
    movements: movements.results,
    stats,
    filter,
    orderId,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request, "warehouse.operate", "warehouse");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();

  if (intent === "create") {
    const shipmentId = valueOf(form, "shipmentId");
    const targetLocationId = valueOf(form, "targetLocationId");
    const notes = valueOf(form, "notes");
    const shipment = await env.DB.prepare(
      "SELECT id FROM shipments WHERE id=? AND organization_id=? AND status IN ('picked_up','in_transit')",
    ).bind(shipmentId, user.organizationId).first();
    const location = await env.DB.prepare(
      `SELECT l.id FROM warehouse_locations l
       JOIN warehouse_zones z ON z.id=l.zone_id
       JOIN warehouses w ON w.id=l.warehouse_id
       WHERE l.id=? AND l.organization_id=? AND l.status='active' AND z.status='active' AND w.status='active'`,
    ).bind(targetLocationId, user.organizationId).first();
    if (!shipment || !location) return { formError: "请选择有效运单和齐套复核库位；如果没有库位，请先到仓库与库位创建" };
    const id = crypto.randomUUID();
    const batchNumber = generateBatch();
    await env.DB.prepare(
      "INSERT INTO warehouse_sorting_batches(id,organization_id,batch_number,shipment_id,target_location_id,status,notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?,?,?)",
    ).bind(id, user.organizationId, batchNumber, shipmentId, targetLocationId, notes || null, user.userId, now, now).run();
    await writeAudit({
      request,
      action: "warehouse.sorting.create",
      resourceType: "sorting_batch",
      resourceId: id,
      organizationId: user.organizationId,
      actorUserId: user.userId,
      metadata: { batchNumber, shipmentId, targetLocationId },
    });
    return { success: `到货复核批次 ${batchNumber} 已创建` };
  }

  const batchId = valueOf(form, "batchId");
  const batch = await env.DB.prepare(
    `SELECT b.id,b.shipment_id,s.order_id,o.business_type,o.exit_port,o.customs_location,o.transit_locations,o.route_notes,b.target_location_id,b.status,b.batch_number
     FROM warehouse_sorting_batches b
     JOIN shipments s ON s.id=b.shipment_id
     JOIN transport_orders o ON o.id=s.order_id
     WHERE b.id=? AND b.organization_id=?`,
  ).bind(batchId, user.organizationId).first<{
    id: string;
    shipment_id: string;
    order_id: string;
    business_type: string;
    exit_port: string | null;
    customs_location: string | null;
    transit_locations: string | null;
    route_notes: string | null;
    target_location_id: string;
    status: string;
    batch_number: string;
  }>();
  if (!batch) return { formError: "到货复核批次不存在" };
  if (intent === "scan") {
    if (batch.status !== "open") return { formError: "该批次已结束清点，不能继续加入货物" };
    const barcode = valueOf(form, "barcode").toUpperCase();
    const pkg = await env.DB.prepare(
      "SELECT id,shipment_id,location_id,status FROM warehouse_packages WHERE organization_id=? AND barcode=?",
    ).bind(user.organizationId, barcode).first<{ id: string; shipment_id: string; location_id: string; status: string }>();
    if (!pkg) return { formError: `未找到货物标签 ${barcode}` };
    if (pkg.shipment_id !== batch.shipment_id) return { formError: "该货物不属于当前批次运单" };
    if (pkg.status !== "in_stock") return { formError: "该货物已被清点或出库，不能重复加入" };
    const existing = await env.DB.prepare(
      "SELECT id FROM warehouse_sorting_items WHERE batch_id=? AND package_id=?",
    ).bind(batch.id, pkg.id).first();
    if (existing) return { formError: "该货物已在当前分拣批次中" };
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO warehouse_sorting_items(id,organization_id,batch_id,package_id,status,sorted_by_user_id,sorted_at) VALUES(?,?,?,?,'sorted',?,?)",
      ).bind(crypto.randomUUID(), user.organizationId, batch.id, pkg.id, user.userId, now),
      env.DB.prepare(
        "INSERT INTO warehouse_package_movements(id,organization_id,package_id,operation_type,from_location_id,to_location_id,batch_id,operator_user_id,occurred_at,created_at) VALUES(?,?,?,'sort',?,?,?,?,?,?)",
      ).bind(crypto.randomUUID(), user.organizationId, pkg.id, pkg.location_id, batch.target_location_id, batch.id, user.userId, now, now),
      env.DB.prepare("UPDATE warehouse_packages SET location_id=?,status='allocated',updated_at=? WHERE id=? AND organization_id=?").bind(batch.target_location_id, now, pkg.id, user.organizationId),
      env.DB.prepare("UPDATE warehouse_sorting_batches SET updated_at=? WHERE id=?").bind(now, batch.id),
    ]);
    return { success: `${barcode} 已加入到货复核批次 ${batch.batch_number}` };
  }

  if (intent === "stage") {
    if (batch.status !== "open") return { formError: "只有进行中的批次可以完成清点" };
    const count = await env.DB.prepare("SELECT COUNT(*) total FROM warehouse_sorting_items WHERE batch_id=?").bind(batch.id).first<{ total: number }>();
    if (!count?.total) return { formError: "批次中没有货物，不能完成清点" };
    await env.DB.prepare("UPDATE warehouse_sorting_batches SET status='staged',updated_at=? WHERE id=? AND organization_id=?").bind(now, batch.id, user.organizationId).run();
    await writeAudit({ request, action: "warehouse.sorting.staged", resourceType: "sorting_batch", resourceId: batch.id, organizationId: user.organizationId, actorUserId: user.userId });
    return { success: `批次 ${batch.batch_number} 已清点，等待齐套复核` };
  }

  if (intent === "verify") {
    if (batch.status !== "staged") return { formError: "该批次尚未完成集货或已经复核" };
    const barcode = valueOf(form, "barcode").toUpperCase();
    const item = await env.DB.prepare(
      `SELECT i.id,i.package_id,i.status,p.location_id
       FROM warehouse_sorting_items i
       JOIN warehouse_packages p ON p.id=i.package_id
       WHERE i.batch_id=? AND i.organization_id=? AND p.barcode=?`,
    ).bind(batch.id, user.organizationId, barcode).first<{ id: string; package_id: string; status: string; location_id: string }>();
    if (!item) return { formError: "该标签不属于当前到货复核批次" };
    if (item.status === "verified") return { formError: "该标签已经复核，请勿重复扫描" };
    await env.DB.batch([
      env.DB.prepare("UPDATE warehouse_sorting_items SET status='verified',verified_by_user_id=?,verified_at=? WHERE id=?").bind(user.userId, now, item.id),
      env.DB.prepare(
        "INSERT INTO warehouse_package_movements(id,organization_id,package_id,operation_type,from_location_id,to_location_id,batch_id,operator_user_id,occurred_at,created_at) VALUES(?,?,?,'verify',?,?,?,?,?,?)",
      ).bind(crypto.randomUUID(), user.organizationId, item.package_id, item.location_id, item.location_id, batch.id, user.userId, now, now),
    ]);
    const remaining = await env.DB.prepare("SELECT COUNT(*) total FROM warehouse_sorting_items WHERE batch_id=? AND status!='verified'").bind(batch.id).first<{ total: number }>();
    if (!remaining?.total) {
      await env.DB.prepare("UPDATE warehouse_sorting_batches SET status='verified',verified_by_user_id=?,verified_at=?,updated_at=? WHERE id=?")
        .bind(user.userId, now, now, batch.id)
        .run();
      await ensureOrderModules(user.organizationId, batch.order_id);
      await recordWarehouseProgress({
        organizationId: user.organizationId,
        orderId: batch.order_id,
        actorUserId: user.userId,
        stepCode: "ready",
        stepName: "收货清点完成",
        actionCode: "inbound_ready",
        actionName: "到货齐套复核",
        notes: `到货复核批次 ${batch.batch_number} 已完成；后续整车/拼车由报价已确定，仓库仅提供实收数据。`,
      });
    }
    return { success: !remaining?.total ? `批次 ${batch.batch_number} 已确认到货齐套` : `${barcode} 复核通过` };
  }

  return { formError: "无效的作业类型" };
}

const statusLabels: Record<string, string> = {
  open: "清点中",
  staged: "待复核",
  verified: "已齐套",
  cancelled: "已取消",
};
const businessTypeLabels: Record<string, string> = {
  pending: "待操作员选择",
  ltl: "零担",
  ftl: "整车",
};

export default function WarehouseSorting({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const canOperate = loaderData.user.permissions.includes("warehouse.operate");
  const active = loaderData.batches.filter((x) => x.status !== "cancelled");
  const firstAction = active.find((x) => x.status === "open") ?? active.find((x) => x.status === "staged");
  const command = getCommand(firstAction, loaderData.filter);
  const filterHref = (filter: SortingFilter) => buildFilterHref(filter, loaderData.orderId);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">RECEIVE · COUNT · READY</p>
          <h1>到货齐套复核</h1>
          <p>这里确认货物全部到仓，并复核实收数量、重量和体积；完成后由订单报价决定整车或拼车，仓库不再判断。</p>
        </div>
        {canOperate && (
          <Modal title="新建到货复核批次" triggerLabel="新建复核批次" closeSignal={actionData?.success}>
            <Form method="post" className="stack">
              <input type="hidden" name="intent" value="create" />
              <label className="field">
                <span>目标订单 / 运单</span>
                <select name="shipmentId" required>
                  <option value="">请选择订单及运单</option>
                  {loaderData.shipments.map((x) => (
                    <option key={x.id} value={x.id}>
                      [{x.customer_identity_code}] {x.order_number} · {x.shipment_number} · {x.customer_name} · {x.origin_city} → {x.destination_city}
                    </option>
                  ))}
                </select>
                {!loaderData.shipments.length && <small className="field-error">当前没有已收货、可复核的运单，请先到“扫码收货”完成收货。</small>}
              </label>
              <label className="field">
                <span>齐套复核库位</span>
                <select name="targetLocationId" required>
                  <option value="">请选择清点或待配载库位</option>
                  {loaderData.locations.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.warehouse_name} / {x.zone_name} / {x.name}（{x.code}）{x.preferred ? "" : " · 原位复核"}
                    </option>
                  ))}
                </select>
              </label>
              {!loaderData.locations.length && <Link className="secondary" to="/warehouse/locations">前往仓库与库位</Link>}
              <label className="field">
                <span>复核备注</span>
                <textarea name="notes" rows={3} />
              </label>
              <button className="primary warehouse-primary" disabled={busy || !loaderData.shipments.length || !loaderData.locations.length}>创建并开始清点</button>
            </Form>
          </Modal>
        )}
      </header>

      {(actionData?.success || actionData?.formError) && (
        <div className={`alert sorting-alert ${actionData.formError ? "error" : "success"}`}>
          <div>
            <strong>{actionData.formError ? "操作没有完成" : "操作成功"}</strong>
            <span>{actionData.formError ?? actionData.success}</span>
          </div>
          {firstAction && <a className="secondary" href={`#batch-${firstAction.id}`}>查看当前批次</a>}
        </div>
      )}

      <section className="warehouse-command-panel">
        <div>
          <span>现在该做什么</span>
          <h2>{command.title}</h2>
          <p>{command.body}</p>
        </div>
        <div className="warehouse-command-actions">
          {firstAction && <a className="primary warehouse-primary" href={`#batch-${firstAction.id}`}>{command.cta}</a>}
          <Link className="secondary" to={filterHref("all")}>查看全部待处理</Link>
        </div>
      </section>

      <section className="stats warehouse-sort-stats" id="sorting-queue">
        <Link className={`warehouse-stat-card ${loaderData.filter === "open" ? "active" : ""}`} to={filterHref("open")}>
          <span>清点中</span>
          <strong>{loaderData.stats.open}</strong>
          <small>需要扫描货物标签</small>
        </Link>
        <Link className={`warehouse-stat-card ${loaderData.filter === "staged" ? "active" : ""}`} to={filterHref("staged")}>
          <span>待齐套复核</span>
          <strong>{loaderData.stats.staged}</strong>
          <small>已清点，待二次复核</small>
        </Link>
        <Link className={`warehouse-stat-card ${loaderData.filter === "verified" ? "active" : ""}`} to={filterHref("verified")}>
          <span>今日已齐套</span>
          <strong>{loaderData.stats.verifiedToday}</strong>
          <small>已进入下一步</small>
        </Link>
      </section>

      <div className="sorting-batches">
        {active.map((batch) => {
          const guide = getBatchGuide(batch);
          return (
            <article className={`panel sorting-batch status-${batch.status}`} id={`batch-${batch.id}`} key={batch.id}>
              <div className="panel-header">
                <div>
                  <h2><a href={`#batch-${batch.id}`}>{batch.batch_number}</a></h2>
                  <p>[{batch.customer_identity_code}] {batch.order_number} · {batch.shipment_number} · {batch.customer_name} · {businessTypeLabels[batch.business_type] ?? batch.business_type}</p>
                </div>
                <div className="page-actions">
                  <span className="status-pill">{statusLabels[batch.status]}</span>
                  <strong>
                    {batch.status === "open"
                      ? `已清点 ${batch.item_count} 个标签`
                      : `已复核 ${batch.verified_count} / 已清点 ${batch.item_count} 个标签`}
                  </strong>
                </div>
              </div>
              <div className={`sorting-card-guide ${batch.status === "verified" ? "done" : ""}`}>
                <b>{guide.badge}</b>
                <div>
                  <strong>{guide.title}</strong>
                  <span>{guide.body}</span>
                </div>
              </div>
              {batch.status === "open" ? (
                <div className="sorting-action">
                  <Form method="post" className="scan-inline">
                    <input type="hidden" name="intent" value="scan" />
                    <input type="hidden" name="batchId" value={batch.id} />
                    <label className="field">
                      <span>扫描本运单货物标签</span>
                      <input name="barcode" placeholder="把光标放这里，逐件扫码" autoComplete="off" required />
                    </label>
                    <button className="primary warehouse-primary" disabled={busy}>加入清点</button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="stage" />
                    <input type="hidden" name="batchId" value={batch.id} />
                    <button className="secondary" disabled={busy || !batch.item_count}>已扫完，完成清点</button>
                  </Form>
                </div>
              ) : batch.status === "staged" ? (
                <Form method="post" className="scan-inline verify-inline">
                  <input type="hidden" name="intent" value="verify" />
                  <input type="hidden" name="batchId" value={batch.id} />
                  <label className="field">
                    <span>扫描齐套复核标签</span>
                    <input name="barcode" placeholder="逐件扫码复核" autoComplete="off" required />
                  </label>
                  <button className="primary warehouse-primary" disabled={busy}>复核通过</button>
                </Form>
              ) : (
            <div className="sorting-done-banner">收货清点与齐套复核已完成。下一步按订单报价确定整车或拼车，仓库端继续执行清点与出库交接。</div>
              )}
              <div className="batch-items">
                {loaderData.items.filter((item) => item.batch_id === batch.id).map((item) => (
                  <div key={item.id}>
                    <code>{item.barcode}</code>
                    <span>{item.pieces} 件{item.weight_kg ? ` · ${item.weight_kg} KG` : ""}</span>
                    <span className={`status-pill ${item.status !== "verified" ? "off" : ""}`}>{item.status === "verified" ? "已复核" : "已分拣"}</span>
                  </div>
                ))}
              </div>
              {!batch.item_count && batch.status === "open" && <p className="empty-state">请扫描属于该运单的货物标签。</p>}
            </article>
          );
        })}
      </div>
      {!active.length && <p className="empty-state">暂无进行中的到货复核批次。</p>}

      <section className="panel">
        <h2>最近货物移动</h2>
        <div className="simple-list">
          {loaderData.movements.map((move) => (
            <div key={move.id}>
              <div>
                <strong>{move.barcode}</strong>
                <small>{move.operator_name || "系统"} · {new Date(move.occurred_at).toLocaleString("zh-CN")}</small>
              </div>
              <span>{move.operation_type.toUpperCase()} · {move.from_location || "入库"} → {move.to_location || "—"}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function generateBatch() {
  return `SORT-${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
}
function parseSortingFilter(value: string | null): SortingFilter {
  return value === "open" || value === "staged" || value === "verified" ? value : "all";
}
function sameLocalDate(value: string, date: Date) {
  return new Date(value).toDateString() === date.toDateString();
}
function filterBatches(batches: Batch[], filter: SortingFilter) {
  if (filter === "verified") return batches.filter((x) => x.status === "verified" && sameLocalDate(x.created_at, new Date()));
  if (filter === "open" || filter === "staged") return batches.filter((x) => x.status === filter);
  return batches.filter((x) => x.status !== "verified" && x.status !== "cancelled");
}
function buildFilterHref(filter: SortingFilter, orderId: string | null) {
  const params = new URLSearchParams();
  if (orderId) params.set("orderId", orderId);
  if (filter !== "all") params.set("filter", filter);
  const query = params.toString();
  return `${query ? `?${query}` : ""}#sorting-queue`;
}
function getCommand(batch: Batch | undefined, filter: SortingFilter) {
  if (filter === "verified") return { title: "这里是已齐套结果", body: "已齐套批次不用继续仓内操作，运输类型已由报价确定。", cta: "查看批次" };
  if (batch?.status === "open") return { title: "先扫码清点，再完成清点", body: "找到下方清点中的批次，逐件扫描本运单货物标签。扫完后点击完成清点。", cta: "去扫码清点" };
  if (batch?.status === "staged") return { title: "现在做收货清点与齐套复核", body: "逐件扫描并核对仓库实收数据；仓库在这里不判断整车或拼车。", cta: "去齐套复核" };
  return { title: "当前没有待处理复核批次", body: "如果订单已收货但这里没有批次，请新建复核批次；如果已齐套，请回订单详情查看下一步。", cta: "查看批次" };
}
function getBatchGuide(batch: Batch) {
  if (batch.status === "open") return { badge: "1", title: "扫码清点", body: "只扫本运单货物标签；扫错、重复扫、已出库都会被拦截。" };
  if (batch.status === "staged") return { badge: "2", title: "齐套复核", body: "复核完成后，订单进入装车与出库（整车）或配载（拼车）流程由业务系统自动分发。" };
  return { badge: "✓", title: "已齐套", body: "本批次已完成仓库复核。" };
}
async function ensureSortingBatchForOrder(organizationId: string, userId: string, orderId: string) {
  const existing = await env.DB.prepare(
    `SELECT b.id FROM warehouse_sorting_batches b
     JOIN shipments s ON s.id=b.shipment_id
     WHERE b.organization_id=? AND s.order_id=? AND b.status IN ('open','staged','verified') LIMIT 1`,
  ).bind(organizationId, orderId).first<{ id: string }>();
  if (existing) return;
  const shipment = await env.DB.prepare(
    `SELECT s.id FROM shipments s
     WHERE s.organization_id=? AND s.order_id=?
       AND EXISTS(SELECT 1 FROM warehouse_receipts r WHERE r.organization_id=s.organization_id AND r.shipment_id=s.id AND r.status='completed')
     ORDER BY s.updated_at DESC LIMIT 1`,
  ).bind(organizationId, orderId).first<{ id: string }>();
  if (!shipment) return;
  const location = await env.DB.prepare(
    `SELECT l.id FROM warehouse_locations l
     JOIN warehouse_zones z ON z.id=l.zone_id
     JOIN warehouses w ON w.id=l.warehouse_id
     WHERE l.organization_id=? AND l.status='active' AND z.status='active' AND w.status='active'
     ORDER BY CASE WHEN z.zone_type IN ('sorting','staging','storage') THEN 0 ELSE 1 END,w.code,z.code,l.code LIMIT 1`,
  ).bind(organizationId).first<{ id: string }>();
  if (!location) return;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO warehouse_sorting_batches(id,organization_id,batch_number,shipment_id,target_location_id,status,notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?,?,?)",
  ).bind(crypto.randomUUID(), organizationId, generateBatch(), shipment.id, location.id, "复核页为已收货订单自动补建齐套复核批次", userId, now, now).run();
}

export function meta() {
  return [{ title: "到货齐套复核 | International TMS" }];
}
