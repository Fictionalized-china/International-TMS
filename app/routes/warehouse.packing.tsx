import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.packing";
import { ActionToast } from "../components/ActionToast";
import { QueryPagination } from "../components/QueryPagination";
import { requireSessionUser } from "../lib/auth.server";
import { d1Placeholders } from "../lib/d1-bindings";
import { oulCode, randomOulSuffix } from "../lib/package-identity";
import { valueOf } from "../lib/validation";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { writeAudit } from "../lib/audit.server";

type PackingRow = {
  order_id: string;
  order_number: string;
  business_type: "ftl" | "ltl";
  customer_name: string;
  shipment_id: string;
  source_package_count: number;
  inbound_weight_kg: number;
  location_names: string | null;
  job_id: string | null;
  packing_mode: "preserve" | "merge" | "split" | null;
  outbound_package_count: number | null;
  total_weight_kg: number | null;
  total_volume_cbm: number | null;
  job_status: "generated" | "labelled" | "allocated" | "loading" | "dispatched" | "cancelled" | null;
  transport_batch_id: string | null;
  dispatch_id: string | null;
};

type PackageMeasure = { weightKg: number; lengthCm: number; widthCm: number; heightCm: number };
const PAGE_SIZE = 10;

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const context = await loadWarehouseContext(request, user);
  const warehouse = context.selected;
  if (warehouse.warehouse_role === "overseas_destination")
    throw new Response("境外目的仓不办理国内仓二次打包", { status: 404 });
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "";
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const values: unknown[] = [user.organizationId, warehouse.id, user.organizationId, warehouse.id];
  const filters: string[] = [];
  if (q) {
    filters.push("(o.order_number LIKE ? OR c.name LIKE ? OR COALESCE(o.cargo_description,'') LIKE ?)");
    values.push(...Array(3).fill(`%${q}%`));
  }
  if (status === "waiting") filters.push("job.id IS NULL");
  if (status === "labeling") filters.push("job.status='generated'");
  if (status === "ready") filters.push("job.status='labelled'");
  if (status === "forwarded") filters.push("job.status IN ('allocated','loading','dispatched')");
  const receivedCte = `WITH received AS (
      SELECT s.order_id,s.id shipment_id,COUNT(p.id) source_package_count,
             COALESCE(SUM(p.weight_kg),0) inbound_weight_kg,
             GROUP_CONCAT(DISTINCT COALESCE(NULLIF(TRIM(l.code),''),l.name)) location_names
      FROM warehouse_packages p
      JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
      LEFT JOIN warehouse_locations l ON l.id=p.location_id
      WHERE p.organization_id=? AND p.warehouse_id=? AND p.label_kind='inbound_mark'
        AND p.lifecycle_status='active' AND p.status IN ('in_stock','allocated')
        AND EXISTS(SELECT 1 FROM warehouse_receipts r WHERE r.organization_id=p.organization_id
          AND r.shipment_id=p.shipment_id AND r.warehouse_id=p.warehouse_id
          AND r.status='completed' AND r.cargo_complete=1)
      GROUP BY s.order_id,s.id
    )`;
  const receivedFrom = `FROM received
    JOIN transport_orders o ON o.id=received.order_id AND o.organization_id=?
    JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
    LEFT JOIN warehouse_packing_jobs job ON job.organization_id=o.organization_id
      AND job.warehouse_id=? AND job.order_id=o.id AND job.status!='cancelled'
    WHERE o.status IN ('confirmed','in_execution') ${filters.length ? `AND ${filters.join(" AND ")}` : ""}`;
  const totalRow = await env.DB.prepare(`${receivedCte} SELECT COUNT(*) total ${receivedFrom}`)
    .bind(...values).first<{ total: number }>();
  const total = Number(totalRow?.total || 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const rows = await env.DB.prepare(`${receivedCte}
    SELECT o.id order_id,o.order_number,o.business_type,c.name customer_name,received.shipment_id,
      received.source_package_count,received.inbound_weight_kg,received.location_names,
      job.id job_id,job.packing_mode,job.outbound_package_count,job.total_weight_kg,
      job.total_volume_cbm,job.status job_status,job.transport_batch_id,job.dispatch_id
    ${receivedFrom}
    ORDER BY CASE WHEN job.id IS NULL THEN 0 WHEN job.status='generated' THEN 1 ELSE 2 END,o.updated_at DESC
    LIMIT ? OFFSET ?`).bind(...values, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<PackingRow>();
  return {
    warehouse,
    rows: rows.results,
    filters: { q, status },
    pagination: { page, pageCount, pageSize: PAGE_SIZE, total },
    result: url.searchParams.get("packingResult"),
    error: url.searchParams.get("packingError"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request, "warehouse.operate", "warehouse");
  const context = await loadWarehouseContext(request, user);
  const warehouse = context.selected;
  await requireWarehouseAssignment(user, warehouse.id, "operator");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();

  if (intent === "create_packing") {
    const orderId = valueOf(form, "orderId");
    const requestedMode = valueOf(form, "packingMode");
    if (!(["preserve", "merge", "split"] as const).includes(requestedMode as "preserve" | "merge" | "split"))
      return { formError: "请选择保留原包装、合并包装或拆分包装" };
    const mode = requestedMode as "preserve" | "merge" | "split";
    const order = await env.DB.prepare(`SELECT o.id,o.order_number,o.business_type,s.id shipment_id
      FROM transport_orders o JOIN shipments s ON s.id=(SELECT sx.id FROM shipments sx
        WHERE sx.organization_id=o.organization_id AND sx.order_id=o.id ORDER BY sx.updated_at DESC LIMIT 1)
      WHERE o.organization_id=? AND o.id=? AND o.status IN ('confirmed','in_execution')
        AND EXISTS(SELECT 1 FROM warehouse_receipts r WHERE r.organization_id=o.organization_id
          AND r.shipment_id=s.id AND r.warehouse_id=? AND r.status='completed' AND r.cargo_complete=1)
        AND NOT EXISTS(SELECT 1 FROM warehouse_packing_jobs active_job WHERE active_job.organization_id=o.organization_id
          AND active_job.warehouse_id=? AND active_job.order_id=o.id AND active_job.status!='cancelled')`)
      .bind(user.organizationId, orderId, warehouse.id, warehouse.id)
      .first<{ id: string; order_number: string; business_type: "ftl" | "ltl"; shipment_id: string }>();
    if (!order) return { formError: "订单未完成货齐入库、已有包装方案，或状态已变化" };
    const sources = await env.DB.prepare(`SELECT p.id,p.receipt_id,p.shipment_id,p.location_id,p.source_order_package_id
      FROM warehouse_packages p WHERE p.organization_id=? AND p.warehouse_id=? AND p.shipment_id=?
        AND p.label_kind='inbound_mark' AND p.lifecycle_status='active' AND p.status='in_stock'
      ORDER BY p.created_at,p.id`).bind(user.organizationId, warehouse.id, order.shipment_id)
      .all<{ id: string; receipt_id: string; shipment_id: string; location_id: string; source_order_package_id: string | null }>();
    if (!sources.results.length) return { formError: "当前订单没有可用于二次打包的入仓包装" };
    const requestedCount = Number(valueOf(form, "outboundPackageCount"));
    const outboundCount = mode === "preserve" ? sources.results.length : requestedCount;
    if (!Number.isSafeInteger(outboundCount) || outboundCount < 1 || outboundCount > 500)
      return { formError: "最终出仓包装数必须是 1–500 之间的整数" };
    if (mode === "merge" && outboundCount >= sources.results.length)
      return { formError: "合并包装后的包裹数必须少于入仓包装数；数量不变请选择“保留原包装”" };
    if (mode === "split" && outboundCount <= sources.results.length)
      return { formError: "拆分包装后的包裹数必须多于入仓包装数；数量不变请选择“保留原包装”" };
    const measures: PackageMeasure[] = [];
    for (let index = 0; index < outboundCount; index += 1) {
      const measure = {
        weightKg: Number(valueOf(form, `weightKg_${index}`)),
        lengthCm: Number(valueOf(form, `lengthCm_${index}`)),
        widthCm: Number(valueOf(form, `widthCm_${index}`)),
        heightCm: Number(valueOf(form, `heightCm_${index}`)),
      };
      if (Object.values(measure).some((value) => !Number.isFinite(value) || value <= 0))
        return { formError: `请完整填写第 ${index + 1} 个最终包装的实重和长宽高，数值必须大于 0` };
      measures.push(measure);
    }
    const jobId = crypto.randomUUID();
    const totalWeight = measures.reduce((sum, item) => sum + item.weightKg, 0);
    const volumes = measures.map((item) => item.lengthCm * item.widthCm * item.heightCm / 1_000_000);
    const totalVolume = volumes.reduce((sum, value) => sum + value, 0);
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`INSERT INTO warehouse_packing_jobs(
        id,organization_id,warehouse_id,order_id,shipment_id,packing_mode,source_package_count,
        outbound_package_count,total_weight_kg,total_volume_cbm,notes,status,created_by_user_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'generated',?,?,?)`).bind(
        jobId, user.organizationId, warehouse.id, order.id, order.shipment_id, mode,
        sources.results.length, outboundCount, totalWeight, totalVolume,
        valueOf(form, "notes").trim() || null, user.userId, now, now,
      ),
    ];
    for (const source of sources.results) {
      statements.push(env.DB.prepare(`INSERT INTO warehouse_packing_job_sources(
        id,organization_id,packing_job_id,inbound_warehouse_package_id,created_at
      ) VALUES(?,?,?,?,?)`).bind(crypto.randomUUID(), user.organizationId, jobId, source.id, now));
    }
    const outputIds: string[] = [];
    for (let index = 0; index < outboundCount; index += 1) {
      const id = crypto.randomUUID();
      outputIds.push(id);
      const source = sources.results[index % sources.results.length];
      const code = oulCode(order.order_number, index + 1, outboundCount, randomOulSuffix());
      statements.push(env.DB.prepare(`INSERT INTO warehouse_packages(
        id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,
        pieces,weight_kg,volume_cbm,status,notes,created_at,updated_at,cargo_item_id,
        length_cm,width_cm,height_cm,label_kind,lifecycle_status,source_order_package_id,
        packing_revision,packing_job_id
      ) VALUES(?,?,?,?,?,?,?,?,1,?,?,'in_stock',?,?,?,NULL,?,?,?,'oul','active',?,1,?)`).bind(
        id, user.organizationId, source.receipt_id, source.shipment_id, warehouse.id, source.location_id,
        code, code, measures[index].weightKg, volumes[index], `最终出仓包装 · ${mode}`,
        now, now, measures[index].lengthCm, measures[index].widthCm, measures[index].heightCm,
        source.source_order_package_id, jobId,
      ));
    }
    const relationPairs = mode === "merge"
      ? sources.results.map((source, index) => ({ source, outputId: outputIds[index % outputIds.length] }))
      : outputIds.map((outputId, index) => ({ source: sources.results[index % sources.results.length], outputId }));
    for (const pair of relationPairs) {
      const { source, outputId } = pair;
      if (!source.source_order_package_id) continue;
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO warehouse_package_relations(
        id,organization_id,order_id,inbound_package_id,outbound_package_id,relation_type,created_by_user_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?)`).bind(
        crypto.randomUUID(), user.organizationId, order.id, source.source_order_package_id,
        outputId, mode === "preserve" ? "kept" : mode === "merge" ? "merged" : "split", user.userId, now,
      ));
    }
    statements.push(env.DB.prepare(`UPDATE warehouse_packages SET status='allocated',updated_at=?
      WHERE organization_id=? AND id IN (${d1Placeholders(sources.results.length)}) AND status='in_stock'`)
      .bind(now, user.organizationId, ...sources.results.map((source) => source.id)));
    try {
      await env.DB.batch(statements);
    } catch (error) {
      console.error("create pre-dispatch packing job failed", error);
      return { formError: "包装方案保存失败；订单可能已被其他仓库人员处理，请刷新后重试" };
    }
    await writeAudit({ request, action: "warehouse.packing.create", resourceType: "warehouse_packing_job", resourceId: jobId, organizationId: user.organizationId, actorUserId: user.userId, metadata: { orderId, orderNumber: order.order_number, mode, sourcePackageCount: sources.results.length, outboundPackageCount: outboundCount } });
    return { success: `${order.order_number} 已生成 ${outboundCount} 张 OUL，请打印贴标后在本页确认`, jobId };
  }

  const jobId = valueOf(form, "jobId");
  const job = await env.DB.prepare(`SELECT job.id,job.order_id,o.order_number,o.business_type,job.status
    FROM warehouse_packing_jobs job JOIN transport_orders o ON o.id=job.order_id AND o.organization_id=job.organization_id
    WHERE job.id=? AND job.organization_id=? AND job.warehouse_id=? AND job.status!='cancelled'`)
    .bind(jobId, user.organizationId, warehouse.id)
    .first<{ id: string; order_id: string; order_number: string; business_type: "ftl" | "ltl"; status: string }>();
  if (!job) return { formError: "包装任务不存在或已被取消" };
  if (intent === "confirm_labelled") {
    if (job.status !== "generated") return { formError: "该包装任务已确认贴标或已进入后续流程" };
    try {
      await env.DB.prepare(`UPDATE warehouse_packing_jobs SET status='labelled',labeling_confirmed_at=?,
        labeling_confirmed_by_user_id=?,updated_at=? WHERE id=? AND organization_id=? AND warehouse_id=? AND status='generated'`)
        .bind(now, user.userId, now, job.id, user.organizationId, warehouse.id).run();
    } catch (error) {
      console.error("confirm packing labels failed", error);
      return { formError: "贴标确认失败，请检查所有最终包装的实重和长宽高后重试" };
    }
    await writeAudit({ request, action: "warehouse.packing.labelled", resourceType: "warehouse_packing_job", resourceId: job.id, organizationId: user.organizationId, actorUserId: user.userId, metadata: { orderId: job.order_id, orderNumber: job.order_number } });
    return { success: job.business_type === "ltl" ? `${job.order_number} 已确认贴标，现已进入待配载池` : `${job.order_number} 已确认贴标，现在可以创建整车装车任务` };
  }
  if (intent === "cancel_packing") {
    if (!(["generated", "labelled"] as string[]).includes(job.status)) return { formError: "包装任务已进入配载或装车流程，不能作废" };
    const sourceIds = await env.DB.prepare(`SELECT inbound_warehouse_package_id id FROM warehouse_packing_job_sources
      WHERE organization_id=? AND packing_job_id=?`).bind(user.organizationId, job.id).all<{ id: string }>();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("UPDATE warehouse_packing_jobs SET status='cancelled',updated_at=? WHERE id=? AND organization_id=? AND status IN ('generated','labelled')").bind(now, job.id, user.organizationId),
      env.DB.prepare("UPDATE warehouse_packages SET lifecycle_status='voided',status='exception',voided_at=?,voided_by_user_id=?,void_reason='仓库重做包装方案',updated_at=? WHERE organization_id=? AND packing_job_id=? AND label_kind='oul' AND lifecycle_status='active'").bind(now, user.userId, now, user.organizationId, job.id),
    ];
    if (sourceIds.results.length) statements.push(env.DB.prepare(`UPDATE warehouse_packages SET status='in_stock',updated_at=? WHERE organization_id=? AND id IN (${d1Placeholders(sourceIds.results.length)}) AND label_kind='inbound_mark' AND status='allocated'`).bind(now, user.organizationId, ...sourceIds.results.map((row) => row.id)));
    await env.DB.batch(statements);
    return { success: `${job.order_number} 的包装方案已作废，可重新打包` };
  }
  return { formError: "未知操作" };
}

export default function WarehousePacking({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return <div className="warehouse-packing-page">
    <header className="warehouse-page-header"><div><p className="eyebrow">PACK · LABEL · RELEASE</p><h1>二次打包与贴标</h1><p>每张订单独立成包；登记最终包装实重和尺寸，生成并贴好 OUL 后才进入整车装车或拼车待配载。</p></div></header>
    <ActionToast data={actionData} message={loaderData.error || loaderData.result || undefined} tone={loaderData.error ? "error" : undefined}/>
    <section className="panel warehouse-packing-filter"><Form method="get"><input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/><input name="q" defaultValue={loaderData.filters.q} placeholder="订单号、客户或货物"/><select name="status" defaultValue={loaderData.filters.status}><option value="">全部状态</option><option value="waiting">待打包</option><option value="labeling">待贴标确认</option><option value="ready">已贴标待流转</option><option value="forwarded">已进入后续流程</option></select><button className="secondary">筛选</button><Link className="text-button" to={`/warehouse/packing?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}`}>重置</Link></Form></section>
    <section className="panel warehouse-packing-list">
      <div className="panel-header"><div><h2>在库订单包装队列</h2><p>保留原包装也必须登记最终出仓包装的实重和长宽高；不同订单不能合成同一 OUL。</p></div><span className="status-pill">{loaderData.rows.length} 票</span></div>
      <div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>类型</th><th>入仓包装</th><th>最终包装</th><th>状态</th><th>下一步</th><th>操作</th></tr></thead><tbody>
        {loaderData.rows.map((row) => <PackingRowView key={row.order_id} row={row} warehouseId={loaderData.warehouse.id} busy={busy}/>)}
        {!loaderData.rows.length && <tr><td className="empty" colSpan={7}>当前没有符合条件的在库订单。</td></tr>}
      </tbody></table></div>
      <QueryPagination {...loaderData.pagination} unit="票订单"/>
    </section>
  </div>;
}

function PackingRowView({ row, warehouseId, busy }: { row: PackingRow; warehouseId: string; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const next = row.job_status === "labelled"
    ? row.business_type === "ftl" ? "创建整车装车任务" : "进入待配载池"
    : row.job_status === "generated" ? "打印并贴好全部 OUL" : row.job_status ? "已进入后续业务" : "登记最终包装";
  return <>
    <tr className={row.job_status === "generated" ? "row-alert" : ""}>
      <td><strong>{row.order_number}</strong><small>{row.customer_name}</small></td>
      <td><span className={`pill ${row.business_type === "ltl" ? "ltl" : ""}`}>{row.business_type === "ltl" ? "拼车" : "整车"}</span></td>
      <td><strong>{row.source_package_count} 包</strong><small>{row.inbound_weight_kg.toFixed(2)} KG · {row.location_names || "库位待定"}</small></td>
      <td>{row.job_id ? <><strong>{row.outbound_package_count} 包</strong><small>{row.total_weight_kg?.toFixed(2)} KG · {row.total_volume_cbm?.toFixed(3)} CBM</small></> : "尚未登记"}</td>
      <td><span className={`status-pill ${row.job_status === "labelled" ? "success" : ""}`}>{packingStatus(row.job_status)}</span></td>
      <td><strong>{next}</strong></td>
      <td><div className="button-row">
        {!row.job_id && <button type="button" className="primary" onClick={() => setEditing(true)}>开始打包</button>}
        {row.job_status === "generated" && <><Link className="secondary" target="_blank" to={`/warehouse/packing-labels?warehouseId=${encodeURIComponent(warehouseId)}&jobId=${encodeURIComponent(row.job_id!)}`}>查看 / 打印 OUL</Link><Form method="post"><input type="hidden" name="intent" value="confirm_labelled"/><input type="hidden" name="jobId" value={row.job_id ?? ""}/><button className="primary" disabled={busy}>确认全部标签已贴完</button></Form></>}
        {row.job_status === "labelled" && row.business_type === "ftl" && <Link className="primary" to={`/warehouse/outbound?warehouseId=${encodeURIComponent(warehouseId)}&view=create&orderId=${encodeURIComponent(row.order_id)}`}>创建装车任务</Link>}
        {row.job_status === "labelled" && row.business_type === "ltl" && <Link className="primary" to={`/warehouse/consolidation?warehouseId=${encodeURIComponent(warehouseId)}&eligibility=eligible&q=${encodeURIComponent(row.order_number)}`}>查看待配载</Link>}
        {row.job_id && ["generated", "labelled"].includes(row.job_status || "") && <Form method="post"><input type="hidden" name="intent" value="cancel_packing"/><input type="hidden" name="jobId" value={row.job_id}/><button className="text-button" disabled={busy}>重做包装</button></Form>}
      </div></td>
    </tr>
    {editing && <tr className="warehouse-packing-editor-row"><td colSpan={7}><PackingForm row={row} busy={busy} onCancel={() => setEditing(false)}/></td></tr>}
  </>;
}

function PackingForm({ row, busy, onCancel }: { row: PackingRow; busy: boolean; onCancel: () => void }) {
  const [mode, setMode] = useState<"preserve" | "merge" | "split">("preserve");
  const [requestedCount, setRequestedCount] = useState(row.source_package_count);
  const count = mode === "preserve" ? row.source_package_count : Math.min(500, Math.max(1, requestedCount || 1));
  return <Form method="post" className="warehouse-packing-editor">
    <input type="hidden" name="intent" value="create_packing"/><input type="hidden" name="orderId" value={row.order_id}/><input type="hidden" name="outboundPackageCount" value={count}/>
    <div className="warehouse-packing-plan-head"><div><h3>{row.order_number} · 最终包装方案</h3><p>实测数据按每个最终出仓包裹登记，系统自动计算体积与整票合计。</p></div><div className="button-row"><button type="button" className="secondary" onClick={onCancel}>取消</button><button className="primary" disabled={busy}>{busy ? "正在生成…" : `生成 ${count} 张 OUL`}</button></div></div>
    <div className="form-grid compact warehouse-packing-mode-grid"><label className="field"><span>包装方式 *</span><select name="packingMode" value={mode} onChange={(event) => { const nextMode = event.target.value as typeof mode; setMode(nextMode); setRequestedCount(nextMode === "merge" ? Math.max(1, row.source_package_count - 1) : nextMode === "split" ? row.source_package_count + 1 : row.source_package_count); }}><option value="preserve">保留原包装</option>{row.source_package_count > 1 && <option value="merge">合并包装</option>}<option value="split">拆分包装</option></select></label><label className="field"><span>入仓包装数</span><input value={row.source_package_count} readOnly/></label><label className="field"><span>最终出仓包装数 *</span><input type="number" min={mode === "split" ? row.source_package_count + 1 : 1} max={mode === "merge" ? Math.max(1, row.source_package_count - 1) : 500} value={count} disabled={mode === "preserve"} onChange={(event) => setRequestedCount(Number(event.target.value))}/></label><label className="field"><span>包装备注</span><input name="notes" placeholder="选填，例如加固、换箱"/></label></div>
    <div className="warehouse-package-measure-list"><div className="warehouse-package-measure-head"><span>包裹</span><span>实重 KG</span><span>长 CM</span><span>宽 CM</span><span>高 CM</span><span>体积</span></div>{Array.from({ length: count }, (_, index) => <div className="warehouse-package-measure-row" key={index}><strong>#{String(index + 1).padStart(3, "0")}</strong><input name={`weightKg_${index}`} type="number" min="0.001" step="0.001" placeholder="必填" required/><input name={`lengthCm_${index}`} type="number" min="0.1" step="0.1" placeholder="必填" required/><input name={`widthCm_${index}`} type="number" min="0.1" step="0.1" placeholder="必填" required/><input name={`heightCm_${index}`} type="number" min="0.1" step="0.1" placeholder="必填" required/><span>自动计算</span></div>)}</div>
  </Form>;
}

function packingStatus(status: PackingRow["job_status"]) {
  return ({ generated: "待打印贴标", labelled: "标签已贴完", allocated: "已配载 / 已建任务", loading: "装车中", dispatched: "已出库" } as Record<string, string>)[status || ""] || "待打包";
}

export function meta() { return [{ title: "二次打包与贴标 | International TMS" }]; }
