import { env } from "cloudflare:workers";

type ManifestBatch = {
  batch_number: string;
  batch_name: string;
  origin_location: string;
  destination_location: string;
  planned_departure_at: string | null;
  planned_arrival_at: string | null;
  border_port: string | null;
  carrier_name: string | null;
  overseas_carrier_name: string | null;
  overseas_vehicle_type: string | null;
  overseas_vehicle_count: number;
  overseas_vehicle_plate: string | null;
  overseas_driver_name: string | null;
  overseas_driver_phone: string | null;
};

type ManifestOrder = {
  order_number: string;
  work_number: string;
  customer_name: string;
  cargo_names: string | null;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
};

type ManifestVehicle = {
  vehicle_no: string;
  vehicle_type: string | null;
  plate_number: string | null;
  driver_name: string | null;
  driver_phone: string | null;
};

const SYSTEM_BATCH_DOCUMENTS = [
  { code: "loading_manifest", name: "配载单", description: "仓库生成或调整 PZ 配载单后自动同步" },
  { code: "vehicle_manifest", name: "装车清单", description: "仓库根据 PZ 配载订单、车辆和司机自动生成" },
  { code: "batch_waybill", name: "批次运单", description: "仓库根据 PZ 配载单运输资源自动生成" },
] as const;

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] as string);
}

function buildManifestHtml(batch: ManifestBatch, orders: ManifestOrder[], vehicles: ManifestVehicle[], generatedAt: string, documentName: string) {
  const totalPieces = orders.reduce((sum, order) => sum + Number(order.pieces || 0), 0);
  const totalWeight = orders.reduce((sum, order) => sum + Number(order.gross_weight_kg || 0), 0);
  const totalVolume = orders.reduce((sum, order) => sum + Number(order.volume_cbm || 0), 0);
  const orderRows = orders.map((order) => `<tr><td>${escapeHtml(order.order_number)}</td><td>${escapeHtml(order.work_number)}</td><td>${escapeHtml(order.customer_name)}</td><td>${escapeHtml(order.cargo_names || "未填写")}</td><td class="number">${order.pieces}</td><td class="number">${Number(order.gross_weight_kg).toFixed(2)}</td><td class="number">${Number(order.volume_cbm).toFixed(3)}</td></tr>`).join("");
  const vehicleRows = vehicles.map((vehicle) => `<tr><td>${escapeHtml(vehicle.vehicle_no)}</td><td>${escapeHtml(vehicle.vehicle_type || "-")}</td><td>${escapeHtml(vehicle.plate_number || "-")}</td><td>${escapeHtml(vehicle.driver_name || "-")}</td><td>${escapeHtml(vehicle.driver_phone || "-")}</td></tr>`).join("");

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(documentName)} ${escapeHtml(batch.batch_number)}</title><style>
body{font:12px "Microsoft YaHei",Arial,sans-serif;color:#111;margin:24px}h1{font-size:22px;margin:0 0 6px}h2{font-size:15px;margin:20px 0 8px}.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 20px;margin:12px 0}.meta span{border-bottom:1px solid #bbb;padding:5px 0}.meta b{color:#555;margin-right:6px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:6px;text-align:left}th{background:#eee}.number{text-align:right}.footer{margin-top:18px;color:#555}.signatures{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;margin-top:40px}.signatures span{border-top:1px solid #333;padding-top:6px}@media print{body{margin:8mm}}
</style></head><body><h1>${escapeHtml(documentName)} ${escapeHtml(batch.batch_number)}</h1><div>${escapeHtml(batch.batch_name)}</div>
<div class="meta"><span><b>线路</b>${escapeHtml(batch.origin_location)} → ${escapeHtml(batch.destination_location)}</span><span><b>出境口岸</b>${escapeHtml(batch.border_port || "待填写")}</span><span><b>计划发车</b>${escapeHtml(batch.planned_departure_at?.slice(0, 16).replace("T", " ") || "待填写")}</span><span><b>境外承运商</b>${escapeHtml(batch.overseas_carrier_name || batch.carrier_name || "待填写")}</span><span><b>车辆</b>${escapeHtml(batch.overseas_vehicle_type || "-")} · ${escapeHtml(batch.overseas_vehicle_plate || "待填写")}</span><span><b>司机</b>${escapeHtml(batch.overseas_driver_name || "待填写")} ${escapeHtml(batch.overseas_driver_phone || "")}</span></div>
<h2>车辆信息</h2><table><thead><tr><th>车辆序号</th><th>车型</th><th>车牌号</th><th>司机</th><th>电话</th></tr></thead><tbody>${vehicleRows}</tbody></table>
<h2>挂载订单（${orders.length} 票）</h2><table><thead><tr><th>订单号</th><th>工作号</th><th>客户</th><th>货物</th><th>件数</th><th>实收重量 KG</th><th>实收体积 CBM</th></tr></thead><tbody>${orderRows}</tbody><tfoot><tr><th colspan="4">合计</th><th class="number">${totalPieces}</th><th class="number">${totalWeight.toFixed(2)}</th><th class="number">${totalVolume.toFixed(3)}</th></tr></tfoot></table>
<div class="footer">系统生成时间：${escapeHtml(generatedAt.slice(0, 19).replace("T", " "))} · 来源：仓库货物配载与装车数据</div><div class="signatures"><span>仓库装车签字 / 日期</span><span>司机签字 / 日期</span><span>理货签字 / 日期</span></div></body></html>`;
}

export async function refreshLoadingManifest(organizationId: string, batchId: string, userId: string, now: string) {
  const [batch, orders, vehicles] = await Promise.all([
    env.DB.prepare(`SELECT b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.planned_departure_at,b.planned_arrival_at,b.border_port,
        c.name carrier_name,b.overseas_carrier_name,b.overseas_vehicle_type,b.overseas_vehicle_count,b.overseas_vehicle_plate,b.overseas_driver_name,b.overseas_driver_phone
      FROM transport_batches b LEFT JOIN carriers c ON c.id=b.carrier_id
      WHERE b.id=? AND b.organization_id=? AND b.status!='cancelled'`).bind(batchId, organizationId).first<ManifestBatch>(),
    env.DB.prepare(`SELECT o.order_number,COALESCE((SELECT s.shipment_number FROM shipments s WHERE s.order_id=o.id ORDER BY s.created_at DESC LIMIT 1),o.order_number) work_number,
        c.name customer_name,COALESCE((SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.order_id=o.id AND i.organization_id=o.organization_id),o.cargo_description) cargo_names,
        COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.pieces) pieces,
        COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg) gross_weight_kg,
        COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm) volume_cbm
      FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id JOIN customers c ON c.id=o.customer_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(batchId, organizationId).all<ManifestOrder>(),
    env.DB.prepare(`SELECT vehicle_no,vehicle_type,plate_number,driver_name,driver_phone FROM transport_batch_vehicles
      WHERE batch_id=? AND organization_id=? AND status!='cancelled' ORDER BY created_at`).bind(batchId, organizationId).all<ManifestVehicle>(),
  ]);
  if (!batch || !orders.results.length || !vehicles.results.length) return false;

  const statements: D1PreparedStatement[] = [];
  for (const document of SYSTEM_BATCH_DOCUMENTS) {
    const html = buildManifestHtml(batch, orders.results, vehicles.results, now, document.name);
    statements.push(
      env.DB.prepare("UPDATE transport_batch_documents SET review_status='archived',updated_at=? WHERE batch_id=? AND organization_id=? AND document_category=? AND review_status!='archived'").bind(now, batchId, organizationId, document.code),
      env.DB.prepare(`INSERT INTO transport_batch_documents(id,organization_id,batch_id,document_category,file_name,content_type,size_bytes,data_url,description,review_status,uploaded_by_user_id,reviewed_by_user_id,reviewed_at,review_notes,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'approved',?,?,?,?,?,?)`).bind(crypto.randomUUID(), organizationId, batchId, document.code, `${document.name}-${batch.batch_number}.html`, "text/html", new TextEncoder().encode(html).length, `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, document.description, userId, userId, now, "仓库系统单据自动生成，无需人工审核", now, now),
    );
  }
  await env.DB.batch(statements);
  return true;
}

export async function ensureBatchSystemDocuments(organizationId: string, batchId: string, userId: string, now: string) {
  const existing = await env.DB.prepare(`SELECT COUNT(DISTINCT document_category) total
    FROM transport_batch_documents
    WHERE organization_id=? AND batch_id=?
      AND document_category IN ('loading_manifest','vehicle_manifest','batch_waybill')
      AND review_status!='archived'`).bind(organizationId, batchId).first<{ total: number }>();
  if ((existing?.total ?? 0) === SYSTEM_BATCH_DOCUMENTS.length) return true;
  return refreshLoadingManifest(organizationId, batchId, userId, now);
}
