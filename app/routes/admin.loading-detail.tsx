import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.loading-detail";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import { checkOrderDeparture, checkOrderLoadPlan, checkOrderPreDepartureDocuments } from "../lib/order-readiness.server";
import { recordWorkflowEvent } from "../lib/business-workflow.server";
import { roadStatusLabels } from "../lib/warehouse-actual";
import { recordWarehouseProgress } from "../lib/warehouse-progress.server";
import { allocationMethodLabel, type AllocationMethod } from "../lib/cost-allocation";
import { confirmCostAllocation, createCostAllocation, loadCostAllocations, updateCostAllocation } from "../lib/cost-allocation.server";
import { canManageOrderModule } from "../lib/position-portal";
import { maxInlineOrderDocumentBytes, orderDocumentTypeCodes, orderDocumentTypeLabel } from "../lib/order-documents";
import { syncCustomsModuleFromRecords } from "../lib/customs-status.server";
import {
  BATCH_TRACKING_MILESTONES,
  BATCH_TRACKING_OPTIONAL_CODES,
  BATCH_TRACKING_REQUIRED_PREVIOUS,
} from "../lib/batch-tracking.shared";
import {
  getBatchOrderIds,
  getBatchMainVehiclePlate,
  validateBatchTrackingRequiredPrevious,
  insertTrackingMilestoneForBatchOrders,
  syncTrackingModuleStatusForOrder,
  syncBatchRoadStatusFromTracking,
  recordShipmentEventForBatchOrders,
  syncBatchTrackingMilestonesFromBatch,
} from "../lib/batch-tracking.server";
import { Modal } from "../components/Modal";

const CHUNK_SIZE = 800;

let orderModulesImportPromise:
  | Promise<typeof import("../lib/order-modules.server")>
  | null = null;

async function ensureOrderModulesModule() {
  if (!orderModulesImportPromise) {
    orderModulesImportPromise = import("../lib/order-modules.server");
  }
  return orderModulesImportPromise;
}

function chunkArray<T>(values: T[], size = CHUNK_SIZE): T[][] {
  if (!values.length) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function syncOrderWorkflowSnapshotSafe(organizationId: string, orderId: string) {
  const modules = await ensureOrderModulesModule();
  await modules.syncOrderWorkflowSnapshot(organizationId, orderId);
}

async function syncCostModuleStatusSafe(organizationId: string, orderId: string, now: string) {
  const modules = await ensureOrderModulesModule();
  await modules.syncCostsModuleStatus(organizationId, orderId, now);
}

type Batch={id:string;batch_number:string;batch_name:string;origin_location:string;destination_location:string;planned_departure_at:string|null;planned_arrival_at:string|null;status:string;road_status:string;carrier_id:string|null;warehouse_id:string|null;carrier_name:string|null;warehouse_name:string|null;border_port:string|null;customs_location:string|null;transit_location:string|null;route_notes:string|null;notes:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null};
type BatchOrder={order_id:string;order_number:string;business_type:string|null;work_number:string;customer_name:string;cargo_description:string|null;cargo_names:string|null;pieces:number;gross_weight_kg:number;volume_cbm:number;declared_weight_kg:number;declared_volume_cbm:number;inbound_at:string|null;dispatched_packages:number;in_stock_packages:number;package_count:number;assigned_count:number;vehicle_names:string|null;overseas_warehouse_id:string|null;overseas_warehouse_name:string|null;overseas_status:string|null;overseas_arrival_at:string|null};
type Vehicle={id:string;vehicle_no:string;vehicle_type:string|null;plate_number:string|null;driver_name:string|null;driver_phone:string|null;capacity_weight_kg:number;capacity_volume_cbm:number;used_weight:number;used_volume:number;loaded_orders:number;status:string};
type Option={id:string;name:string};
type ReferenceOption={code:string;name:string};
type BatchDocument={id:string;document_category:string;file_name:string;content_type:string;size_bytes:number;data_url:string;description:string|null;review_status:string;created_at:string};
type OrderDocument={id:string;order_id:string;document_category:string;file_name:string;content_type:string;size_bytes:number;data_url:string;description:string|null;review_status:string;created_at:string};
type CustomsSummary={order_id:string;total:number;released:number};
type BatchCustomsDeclaration={id:string;order_id:string;customs_record_id:string;clearance_stage:string;declaration_number:string;declaration_type:string;declaration_title:string;declaring_company:string;declared_at:string;declared_amount:number;currency:string;gross_weight_kg:number;released_at:string|null;status:string;is_deleted:number;is_redeclared:number;is_amended:number;is_inspected:number;change_reason:string|null;updated_at:string};
type BatchOutboundStatus={order_id:string;dispatched:number};
type DepartureGateStatus={order_id:string;ready:boolean;reasons:string[]};
type BatchTrackingMilestone={id:string;order_id:string;milestone_code:string;milestone_name:string;event_at:string;location:string|null;vehicle_reference:string|null;notes:string|null;visible_to_customer:number;created_at:string};
type BatchTrackingFlag={order_id:string;requires_transloading:number;requires_transit_customs:number};
type CarrierVehicleOption={id:string;carrier_id:string;plate_number:string;vehicle_type:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null;carrier_name:string};
type CarrierDriverOption={id:string;carrier_id:string;name:string;phone:string|null;carrier_name:string};
type ManifestOrderRow={order_id:string;order_number:string;work_number:string;customer_name:string;cargo_names:string|null;pieces:number;gross_weight_kg:number;volume_cbm:number;vehicle_names:string|null};
type ManifestVehicleRow={vehicle_no:string;vehicle_type:string|null;plate_number:string|null;driver_name:string|null;driver_phone:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null};
type ManifestBatchRow={batch_number:string;batch_name:string;origin_location:string;destination_location:string;planned_departure_at:string|null;planned_arrival_at:string|null;border_port:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null;carrier_name:string|null};

function escapeHtml(value: string | null | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
}

function buildLoadingManifestHtml(batch: ManifestBatchRow, orders: ManifestOrderRow[], vehicles: ManifestVehicleRow[], generatedAt: string) {
  const totalPieces = orders.reduce((sum, item) => sum + item.pieces, 0);
  const totalWeight = orders.reduce((sum, item) => sum + item.gross_weight_kg, 0);
  const totalVolume = orders.reduce((sum, item) => sum + item.volume_cbm, 0);
  const rows = orders.map((item) => `<tr><td>${escapeHtml(item.order_number)}</td><td>${escapeHtml(item.work_number)}</td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.cargo_names || "未填写")}</td><td class="num">${item.pieces}</td><td class="num">${item.gross_weight_kg.toFixed(2)}</td><td class="num">${item.volume_cbm.toFixed(3)}</td><td>${escapeHtml(item.vehicle_names || "待分配")}</td></tr>`).join("");
  const vehicleRows = vehicles.map((item) => `<tr><td>${escapeHtml(item.vehicle_no)}</td><td>${escapeHtml(item.vehicle_type || "—")}</td><td>${escapeHtml(item.plate_number || "—")}</td><td>${escapeHtml(item.driver_name || "—")}</td><td>${escapeHtml(item.driver_phone || "—")}</td><td class="num">${item.capacity_weight_kg ? `${item.capacity_weight_kg} KG` : "不限"}</td><td class="num">${item.capacity_volume_cbm ? `${item.capacity_volume_cbm} CBM` : "不限"}</td></tr>`).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>配载单 ${escapeHtml(batch.batch_number)}</title><style>
  body{font-family:"Microsoft YaHei",system-ui,sans-serif;color:#111;margin:24px;font-size:12px}
  h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px}
  .meta{display:flex;flex-wrap:wrap;gap:4px 24px;margin:8px 0;color:#333}
  .meta b{margin-right:4px;color:#555}
  table{width:100%;border-collapse:collapse;margin:6px 0}
  th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}
  th{background:#eee}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  tfoot td{font-weight:bold;background:#f7f7f7}
  .footer{margin-top:18px;display:flex;justify-content:space-between;color:#555}
  .sign{margin-top:26px;display:flex;gap:48px}.sign div{flex:1;border-top:1px solid #333;padding-top:6px}
  @media print{body{margin:8mm}}
</style></head><body>
<h1>配载单 ${escapeHtml(batch.batch_number)}</h1>
<div class="meta"><span>${escapeHtml(batch.batch_name)}</span></div>
<div class="meta"><span><b>线路</b>${escapeHtml(batch.origin_location)} → ${escapeHtml(batch.destination_location)}</span><span><b>承运商</b>${escapeHtml(batch.carrier_name || "待定")}</span><span><b>出境口岸</b>${escapeHtml(batch.border_port || "待定")}</span><span><b>计划发车</b>${escapeHtml(batch.planned_departure_at?.slice(0, 16).replace("T", " ") || "待定")}</span><span><b>计划到达</b>${escapeHtml(batch.planned_arrival_at?.slice(0, 16).replace("T", " ") || "待定")}</span></div>
<h2>境外运输资源</h2>
<div class="meta"><span><b>境外承运方</b>${escapeHtml(batch.overseas_carrier_name || "待定")}</span><span><b>车型/数量</b>${escapeHtml(batch.overseas_vehicle_type || "待定")} × ${batch.overseas_vehicle_count || 1}</span><span><b>车牌</b>${escapeHtml(batch.overseas_vehicle_plate || "待定")}</span><span><b>司机</b>${escapeHtml(batch.overseas_driver_name || "待定")} ${escapeHtml(batch.overseas_driver_phone || "")}</span></div>
<h2>装载车辆（${vehicles.length} 车）</h2>
<table><thead><tr><th>序号</th><th>车型</th><th>车牌号</th><th>司机</th><th>电话</th><th>载重上限</th><th>体积上限</th></tr></thead><tbody>${vehicleRows}</tbody></table>
<h2>挂载订单（${orders.length} 票）</h2>
<table><thead><tr><th>订单号</th><th>工作号</th><th>委托人</th><th>货物名称</th><th>件数</th><th>实收重量 KG</th><th>实收体积 CBM</th><th>装载车辆</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="4">合计</td><td class="num">${totalPieces}</td><td class="num">${totalWeight.toFixed(2)}</td><td class="num">${totalVolume.toFixed(3)}</td><td>—</td></tr></tfoot></table>
<div class="footer"><span>系统生成时间：${escapeHtml(generatedAt.slice(0, 19).replace("T", " "))}</span><span>生成来源：配载工作台（自动审核通过）</span></div>
<div class="sign"><div>仓库装车签字 / 日期</div><div>司机签字 / 日期</div><div>理货签字 / 日期</div></div>
</body></html>`;
}

const BATCH_DOCUMENT_TYPES=[
  {code:"loading_manifest",name:"配载清单",hint:"配载工作台一键自动生成，仓库按此配载单装车出库，无需人工上传",required:true},
  {code:"vehicle_manifest",name:"装车清单",hint:"按车辆形成的装载与包装清单",required:false},
  {code:"batch_waybill",name:"批次运单",hint:"本批次共用的国际运输运单",required:false},
  {code:"border_handover",name:"口岸交接文件",hint:"口岸换装、过境或交接凭证",required:false},
  {code:"transshipment_order",name:"换装单",hint:"发生换装时上传的批次共用凭证",required:false},
] as const;
const ORDER_BATCH_DOCUMENT_CODES=["consignment_letter","commercial_invoice","packing_list","customs_document"] as const;

const VEHICLE_TYPE_OPTIONS=[
  "卡车",
  "尖程拼车",
  "13米平板",
  "13.5米高栏",
  "13.7米平板",
  "17.5米平板",
  "17.5米厢式车",
  "13米高栏",
  "16米厢式车",
  "13米厢式车",
  "冷藏车",
];

export async function loader({request,params}:Route.LoaderArgs){
  const current=await requireSessionUser(request,"order.view"),batchId=params.batchId;
  const fromOrderId = new URL(request.url).searchParams.get("fromOrderId");
  const batch=await env.DB.prepare(`SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.planned_departure_at,b.planned_arrival_at,b.status,b.road_status,b.carrier_id,b.warehouse_id,b.border_port,b.customs_location,b.transit_location,b.route_notes,b.notes,b.overseas_carrier_name,b.overseas_vehicle_type,b.overseas_vehicle_count,b.overseas_vehicle_plate,b.overseas_driver_name,b.overseas_driver_phone,c.name carrier_name,w.name warehouse_name FROM transport_batches b LEFT JOIN carriers c ON c.id=b.carrier_id LEFT JOIN warehouses w ON w.id=b.warehouse_id WHERE b.id=? AND b.organization_id=?`).bind(batchId,current.organizationId).first<Batch>();
  if(!batch)throw new Response("配载批次不存在",{status:404});
  await synchronizeBatchTransport(current.organizationId,batchId,new Date().toISOString());
  const [orders,vehicles,carriers,warehouses,borderPorts,costAllocations,batchDocuments,orderDocuments,customsSummaries,customsDeclarations]=await Promise.all([
    env.DB.prepare(`SELECT bo.order_id,o.order_number,o.business_type,COALESCE((SELECT s.shipment_number FROM shipments s WHERE s.order_id=o.id ORDER BY s.created_at DESC LIMIT 1),o.order_number) work_number,c.name customer_name,o.cargo_description,
        COALESCE((SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.order_id=o.id AND i.organization_id=o.organization_id),o.cargo_description) cargo_names,
        COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.pieces) pieces,
        COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg) gross_weight_kg,
        COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm) volume_cbm,
        o.gross_weight_kg declared_weight_kg,o.volume_cbm declared_volume_cbm,
        (SELECT MIN(r.received_at) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed') inbound_at,
        (SELECT COUNT(*) FROM warehouse_packages wp JOIN shipments s2 ON s2.id=wp.shipment_id WHERE s2.order_id=o.id AND wp.status='dispatched') dispatched_packages,
        (SELECT COUNT(*) FROM warehouse_packages wp JOIN shipments s2 ON s2.id=wp.shipment_id WHERE s2.order_id=o.id AND wp.status IN ('in_stock','allocated')) in_stock_packages,
        COUNT(DISTINCT p.id) package_count,COUNT(DISTINCT l.package_id) assigned_count,GROUP_CONCAT(DISTINCT v.vehicle_no) vehicle_names,
        o.overseas_warehouse_id,ow.name overseas_warehouse_name,
        CASE WHEN EXISTS(
          SELECT 1 FROM warehouse_receipts owr
          JOIN shipments os ON os.id=owr.shipment_id AND os.organization_id=owr.organization_id
          WHERE owr.organization_id=o.organization_id AND os.order_id=o.id
            AND owr.warehouse_id=o.overseas_warehouse_id AND owr.status='completed' AND owr.cargo_complete=1
        ) THEN 'received' ELSE op.status END overseas_status,
        COALESCE(op.actual_arrival_at,(
          SELECT MAX(owr.received_at) FROM warehouse_receipts owr
          JOIN shipments os ON os.id=owr.shipment_id AND os.organization_id=owr.organization_id
          WHERE owr.organization_id=o.organization_id AND os.order_id=o.id
            AND owr.warehouse_id=o.overseas_warehouse_id AND owr.status='completed' AND owr.cargo_complete=1
        )) overseas_arrival_at
      FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id JOIN customers c ON c.id=o.customer_id LEFT JOIN order_cargo_packages p ON p.order_id=o.id AND p.status!='cancelled' LEFT JOIN transport_vehicle_loads l ON l.batch_id=bo.batch_id AND l.package_id=p.id LEFT JOIN transport_batch_vehicles v ON v.id=l.vehicle_id LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id LEFT JOIN overseas_warehouse_operations op ON op.batch_id=bo.batch_id AND op.order_id=bo.order_id AND op.organization_id=bo.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' GROUP BY bo.order_id ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<BatchOrder>(),
    env.DB.prepare(`WITH vehicle_order_actual AS (
        SELECT l.vehicle_id,p.order_id,
          COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=p.order_id AND r.status='completed'),SUM(i.gross_weight_per_package_kg)) weight,
          COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=p.order_id AND r.status='completed'),SUM(i.volume_per_package_cbm)) volume
        FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id JOIN order_cargo_items i ON i.id=p.cargo_item_id
        GROUP BY l.vehicle_id,p.order_id
      ) SELECT v.id,v.vehicle_no,v.vehicle_type,v.plate_number,v.driver_name,v.driver_phone,v.capacity_weight_kg,v.capacity_volume_cbm,v.status,COALESCE(SUM(a.weight),0) used_weight,COALESCE(SUM(a.volume),0) used_volume,COUNT(DISTINCT a.order_id) loaded_orders
      FROM transport_batch_vehicles v LEFT JOIN vehicle_order_actual a ON a.vehicle_id=v.id
      WHERE v.batch_id=? AND v.organization_id=? GROUP BY v.id ORDER BY v.created_at`).bind(batchId,current.organizationId).all<Vehicle>(),
    env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND status='active' ORDER BY name").bind(current.organizationId).all<Option>(),
    env.DB.prepare("SELECT id,name FROM warehouses WHERE organization_id=? AND status='active' AND warehouse_role IN ('domestic_collection','port') ORDER BY CASE warehouse_role WHEN 'domestic_collection' THEN 10 ELSE 20 END,code,name").bind(current.organizationId).all<Option>(),
    env.DB.prepare("SELECT code,name FROM reference_data WHERE organization_id=? AND category='border_port' AND status='active' ORDER BY sort_order,code").bind(current.organizationId).all<ReferenceOption>(),
    loadCostAllocations(env.DB,current.organizationId,batchId),
    env.DB.prepare("SELECT id,document_category,file_name,content_type,size_bytes,data_url,description,review_status,created_at FROM transport_batch_documents WHERE organization_id=? AND batch_id=? ORDER BY created_at DESC").bind(current.organizationId,batchId).all<BatchDocument>(),
    env.DB.prepare(`SELECT a.id,a.order_id,m.document_category,a.file_name,a.content_type,a.size_bytes,a.data_url,m.description,m.review_status,a.created_at
      FROM transport_batch_orders bo JOIN order_attachments a ON a.order_id=bo.order_id AND a.organization_id=bo.organization_id
      JOIN order_document_metadata m ON m.attachment_id=a.id AND m.order_id=bo.order_id AND m.organization_id=bo.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
      ORDER BY a.created_at DESC`).bind(batchId,current.organizationId).all<OrderDocument>(),
    env.DB.prepare(`SELECT bo.order_id,COUNT(d.id) total,COALESCE(SUM(CASE WHEN d.status='released' THEN 1 ELSE 0 END),0) released
      FROM transport_batch_orders bo LEFT JOIN order_customs_declarations d ON d.order_id=bo.order_id AND d.organization_id=bo.organization_id AND d.is_deleted=0 AND d.status!='cancelled'
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' GROUP BY bo.order_id`).bind(batchId,current.organizationId).all<CustomsSummary>(),
    env.DB.prepare(`SELECT d.id,d.order_id,d.customs_record_id,r.clearance_stage,d.declaration_number,d.declaration_type,d.declaration_title,d.declaring_company,d.declared_at,d.declared_amount,d.currency,d.gross_weight_kg,d.released_at,d.status,d.is_deleted,d.is_redeclared,d.is_amended,d.is_inspected,d.change_reason,d.updated_at
      FROM transport_batch_orders bo
      JOIN order_customs_declarations d ON d.order_id=bo.order_id AND d.organization_id=bo.organization_id
      JOIN order_customs_records r ON r.id=d.customs_record_id AND r.organization_id=d.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
      ORDER BY bo.sequence_no,r.clearance_stage,d.created_at DESC`).bind(batchId,current.organizationId).all<BatchCustomsDeclaration>(),
  ]);
  const returnOrderId =
    fromOrderId && orders.results.some((item) => item.order_id === fromOrderId)
      ? fromOrderId
      : (orders.results[0]?.order_id ?? null);
  const outboundStatuses=await env.DB.prepare(`SELECT bo.order_id,
      CASE WHEN EXISTS(
        SELECT 1 FROM warehouse_dispatches d
        JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
        JOIN warehouse_packages p ON p.id=di.package_id
        JOIN shipments s ON s.id=p.shipment_id
        WHERE d.organization_id=bo.organization_id AND s.order_id=bo.order_id AND d.status='dispatched'
      ) THEN 1 ELSE 0 END dispatched
    FROM transport_batch_orders bo
    WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
    ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<BatchOutboundStatus>();
  const departureGateStatuses:DepartureGateStatus[]=await Promise.all(orders.results.map(async item=>({
    order_id:item.order_id,
    ...await checkOrderDeparture(current.organizationId,item.order_id,undefined,{warehouseDispatchConfirmed:true}),
  })));
  // 配载页运输跟踪：先做反向同步（与订单页打开 tracking 模块一致），保证子订单里程碑齐整
  const batchOrderIds=orders.results.map((item)=>item.order_id);
  if(batchOrderIds.length>1)await syncBatchTrackingMilestonesFromBatch(current.organizationId,batchOrderIds,current.userId);
  const trackingMilestones: BatchTrackingMilestone[] = [];
  if(batchOrderIds.length){
    for (const chunk of chunkArray(batchOrderIds, CHUNK_SIZE)) {
      const trackingPlaceholders = chunk.map(() => "?").join(",");
      const rows = await env.DB.prepare(`SELECT id,order_id,milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer,created_at
        FROM order_tracking_milestones
        WHERE organization_id=? AND order_id IN (${trackingPlaceholders})
        ORDER BY event_at DESC, created_at DESC`).bind(current.organizationId,...chunk).all<BatchTrackingMilestone>();
      trackingMilestones.push(...rows.results);
    }
  }
  const [trackingFlags,batchVehiclePlate,carrierVehicles,carrierDrivers]=await Promise.all([
    env.DB.prepare(`SELECT bo.order_id, COALESCE(o.requires_transloading,0) requires_transloading, COALESCE(o.requires_transit_customs,0) requires_transit_customs
      FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<BatchTrackingFlag>(),
    getBatchMainVehiclePlate(current.organizationId,batchId),
    env.DB.prepare(`SELECT v.id,v.carrier_id,v.plate_number,v.vehicle_type,v.capacity_weight_kg,v.capacity_volume_cbm,c.name carrier_name
      FROM carrier_vehicles v JOIN carriers c ON c.id=v.carrier_id
      WHERE v.organization_id=? AND v.status='active' AND c.status='active'
      ORDER BY c.name,v.plate_number`).bind(current.organizationId).all<CarrierVehicleOption>(),
    env.DB.prepare(`SELECT d.id,d.carrier_id,d.name,d.phone,c.name carrier_name
      FROM carrier_drivers d JOIN carriers c ON c.id=d.carrier_id
      WHERE d.organization_id=? AND d.status='active' AND c.status='active'
      ORDER BY c.name,d.name`).bind(current.organizationId).all<CarrierDriverOption>(),
  ]);
  return{current,batch,orders:orders.results,vehicles:vehicles.results,carriers:carriers.results,warehouses:warehouses.results,borderPorts:borderPorts.results,costAllocations,batchDocuments:batchDocuments.results,orderDocuments:orderDocuments.results,customsSummaries:customsSummaries.results,customsDeclarations:customsDeclarations.results,outboundStatuses:outboundStatuses.results,departureGateStatuses,returnOrderId,trackingMilestones,trackingFlags:trackingFlags.results,batchVehiclePlate,carrierVehicles:carrierVehicles.results,carrierDrivers:carrierDrivers.results};
}

export async function action({request,params}:Route.ActionArgs){
  const current=await requireSessionUser(request,"order.view"),batchId=params.batchId,form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  if(!canManageOrderModule(current,"loading"))throw new Response("无权办理拼车配载",{status:403});
  const batch=await env.DB.prepare("SELECT id,batch_number,status,road_status,border_port,customs_location,route_notes,warehouse_id,overseas_carrier_name,overseas_vehicle_type,overseas_vehicle_count,overseas_vehicle_plate,overseas_driver_name,overseas_driver_phone FROM transport_batches WHERE id=? AND organization_id=? AND status!='cancelled'").bind(batchId,current.organizationId).first<{id:string;batch_number:string;status:string;road_status:string;border_port:string|null;customs_location:string|null;route_notes:string|null;warehouse_id:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null}>();
  if(!batch)return{formError:"配载批次无效"};
  if(intent==="batch_document_upload"){
    const documentCategory=valueOf(form,"documentCategory"),file=form.get("attachment");
    if(!BATCH_DOCUMENT_TYPES.some(item=>item.code===documentCategory))return{formError:"请选择有效的批次文件类型"};
    if(!(file instanceof File)||file.size<=0)return{formError:"请选择要上传的批次文件"};
    const fileError=validateDocumentFile(file);if(fileError)return{formError:fileError};
    const id=crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO transport_batch_documents(id,organization_id,batch_id,document_category,file_name,content_type,size_bytes,data_url,description,review_status,uploaded_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)`).bind(id,current.organizationId,batchId,documentCategory,file.name,file.type,file.size,await toDataUrl(file),valueOf(form,"documentDescription")||null,current.userId,now,now).run();
    await writeAudit({request,action:"transport.batch.document.upload",resourceType:"transport_batch_document",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,documentCategory}});
    return{success:`${batchDocumentTypeLabel(documentCategory)}已上传，等待审核`};
  }
  if(intent==="batch_document_review"){
    const attachmentId=valueOf(form,"attachmentId"),reviewStatus=valueOf(form,"reviewStatus");
    if(!["approved","rejected"].includes(reviewStatus))return{formError:"请选择有效的审核结果"};
    const result=await env.DB.prepare("UPDATE transport_batch_documents SET review_status=?,reviewed_by_user_id=?,reviewed_at=?,review_notes=?,updated_at=? WHERE id=? AND batch_id=? AND organization_id=?").bind(reviewStatus,current.userId,now,valueOf(form,"reviewNotes")||null,now,attachmentId,batchId,current.organizationId).run();
    if(!result.meta.changes)return{formError:"批次文件不存在或已失效"};
    await writeAudit({request,action:"transport.batch.document.review",resourceType:"transport_batch_document",resourceId:attachmentId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,reviewStatus}});
    return{success:reviewStatus==="approved"?"批次文件已审核通过":"批次文件已退回"};
  }
  if(intent==="batch_order_document_upload"){
    const orderId=valueOf(form,"orderId"),documentCategory=valueOf(form,"documentCategory"),file=form.get("attachment");
    if(!ORDER_BATCH_DOCUMENT_CODES.includes(documentCategory as typeof ORDER_BATCH_DOCUMENT_CODES[number])||!orderDocumentTypeCodes.has(documentCategory))return{formError:"请选择有效的订单文件类型"};
    if(!(file instanceof File)||file.size<=0)return{formError:"请选择要上传的订单文件"};
    const fileError=validateDocumentFile(file);if(fileError)return{formError:fileError};
    const order=await env.DB.prepare(`SELECT o.customer_id FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id WHERE bo.batch_id=? AND bo.order_id=? AND bo.organization_id=? AND bo.status!='removed'`).bind(batchId,orderId,current.organizationId).first<{customer_id:string}>();
    if(!order)return{formError:"该订单不属于当前配载单"};
    const attachmentId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)").bind(attachmentId,current.organizationId,orderId,order.customer_id,file.name,file.type,file.size,await toDataUrl(file),current.userId,now),
      env.DB.prepare("INSERT INTO order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,updated_at) VALUES(?,?,?,?,?,0,'pending',?)").bind(attachmentId,current.organizationId,orderId,documentCategory,valueOf(form,"documentDescription")||orderDocumentTypeLabel(documentCategory),now),
    ]);
    await syncBatchOrderDocumentsStatus(current.organizationId,orderId,current.userId,now);
    await writeAudit({request,action:"transport.batch.order_document.upload",resourceType:"order_attachment",resourceId:attachmentId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,orderId,documentCategory}});
    return{success:`${orderDocumentTypeLabel(documentCategory)}已上传到对应订单，等待审核`};
  }
  if(intent==="generate_manifest"){
    // 配载单由工作台自动生成：仓库按生成的配载单装车出库，不再要求人工上传。
    const [ordersList,vehiclesList]=await Promise.all([
      env.DB.prepare(`SELECT bo.order_id,o.order_number,COALESCE((SELECT s.shipment_number FROM shipments s WHERE s.order_id=o.id ORDER BY s.created_at DESC LIMIT 1),o.order_number) work_number,c.name customer_name,
          COALESCE((SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.order_id=o.id AND i.organization_id=o.organization_id),o.cargo_description) cargo_names,
          COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.pieces) pieces,
          COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg) gross_weight_kg,
          COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm) volume_cbm,
          (SELECT GROUP_CONCAT(DISTINCT v.vehicle_no||' '||COALESCE(v.plate_number,'')) FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id JOIN transport_batch_vehicles v ON v.id=l.vehicle_id WHERE l.batch_id=bo.batch_id AND p.order_id=o.id) vehicle_names
        FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id JOIN customers c ON c.id=o.customer_id
        WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<ManifestOrderRow>(),
      env.DB.prepare("SELECT vehicle_no,vehicle_type,plate_number,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm FROM transport_batch_vehicles WHERE batch_id=? AND organization_id=? AND status!='cancelled' ORDER BY vehicle_no").bind(batchId,current.organizationId).all<ManifestVehicleRow>(),
    ]);
    if(!vehiclesList.results.length)return{formError:"配载单还没有车辆；请先在配载单信息中添加车辆，再生成配载单"};
    const batchDetail=await env.DB.prepare("SELECT b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.planned_departure_at,b.planned_arrival_at,b.border_port,b.overseas_carrier_name,b.overseas_vehicle_type,b.overseas_vehicle_count,b.overseas_vehicle_plate,b.overseas_driver_name,b.overseas_driver_phone,c.name carrier_name FROM transport_batches b LEFT JOIN carriers c ON c.id=b.carrier_id WHERE b.id=? AND b.organization_id=?").bind(batchId,current.organizationId).first<ManifestBatchRow>();
    if(!batchDetail)return{formError:"配载批次无效"};
    const html=buildLoadingManifestHtml(batchDetail,ordersList.results,vehiclesList.results,now);
    const documentId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE transport_batch_documents SET review_status='archived',updated_at=? WHERE batch_id=? AND organization_id=? AND document_category='loading_manifest'").bind(now,batchId,current.organizationId),
      env.DB.prepare(`INSERT INTO transport_batch_documents(id,organization_id,batch_id,document_category,file_name,content_type,size_bytes,data_url,description,review_status,uploaded_by_user_id,reviewed_by_user_id,reviewed_at,review_notes,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'系统自动生成；仓库按此配载单装车出库','approved',?,?,?,?,?,?)`).bind(documentId,current.organizationId,batchId,"loading_manifest",`配载单-${batchDetail.batch_number}.html`,"text/html",new TextEncoder().encode(html).length,`data:text/html;charset=utf-8,${encodeURIComponent(html)}`,current.userId,current.userId,now,"配载工作台自动生成",now,now),
    ]);
    await writeAudit({request,action:"transport.batch.manifest.generate",resourceType:"transport_batch_document",resourceId:documentId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,orders:ordersList.results.length,vehicles:vehiclesList.results.length}});
    return{success:`配载单已生成并自动审核通过（${ordersList.results.length} 票 · ${vehiclesList.results.length} 车）；仓库可按此配载单装车出库`};
  }
  if(intent==="batch_order_document_review"){
    const orderId=valueOf(form,"orderId"),attachmentId=valueOf(form,"attachmentId"),reviewStatus=valueOf(form,"reviewStatus");
    if(!["approved","rejected"].includes(reviewStatus))return{formError:"请选择有效的审核结果"};
    const result=await env.DB.prepare(`UPDATE order_document_metadata SET review_status=?,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE attachment_id=? AND order_id=? AND organization_id=? AND EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=? AND bo.order_id=? AND bo.organization_id=? AND bo.status!='removed')`).bind(reviewStatus,current.userId,now,now,attachmentId,orderId,current.organizationId,batchId,orderId,current.organizationId).run();
    if(!result.meta.changes)return{formError:"订单文件不存在或不属于当前配载单"};
    await syncBatchOrderDocumentsStatus(current.organizationId,orderId,current.userId,now);
    await writeAudit({request,action:"transport.batch.order_document.review",resourceType:"order_attachment",resourceId:attachmentId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,orderId,reviewStatus}});
    return{success:reviewStatus==="approved"?"订单文件已审核通过":"订单文件已退回"};
  }
  if(intent==="batch_order_customs_declaration_save"){
    const orderId=valueOf(form,"orderId"),declarationId=valueOf(form,"declarationId")||null;
    const batchOrder=await env.DB.prepare("SELECT 1 FROM transport_batch_orders WHERE batch_id=? AND order_id=? AND organization_id=? AND status!='removed'").bind(batchId,orderId,current.organizationId).first();
    if(!batchOrder)return{formError:"该订单不属于当前配载单"};
    const clearanceStage=valueOf(form,"clearanceStage")||"origin";
    if(!["origin","transit","destination"].includes(clearanceStage))return{formError:"报关作业阶段无效"};
    const declarationNumber=valueOf(form,"declarationNumber"),declarationType=valueOf(form,"declarationType"),declarationTitle=valueOf(form,"declarationTitle"),declaringCompany=valueOf(form,"declaringCompany"),declaredAt=valueOf(form,"declaredAt"),currency=valueOf(form,"currency").toUpperCase();
    const declaredAmount=Number(valueOf(form,"declaredAmount")),grossWeightKg=Number(valueOf(form,"grossWeightKg"));
    const isDeleted=form.has("isDeleted"),changeReason=valueOf(form,"changeReason"),requestedStatus=valueOf(form,"status")||"declared",declarationStatus=isDeleted?"cancelled":requestedStatus;
    if(!declarationNumber||!declarationType||!declarationTitle||!declaringCompany||!declaredAt||!currency)return{formError:"请完整填写报关单号、类型、申报抬头、申报公司、申报时间和币种"};
    if(!["declared","released","cancelled"].includes(declarationStatus))return{formError:"申报单状态无效"};
    if(!Number.isFinite(declaredAmount)||declaredAmount<0||!Number.isFinite(grossWeightKg)||grossWeightKg<0)return{formError:"申报金额和毛重必须是大于等于 0 的数字"};
    if(isDeleted&&!changeReason)return{formError:"删单时请填写变更原因"};
    let releasedAt=valueOf(form,"releasedAt")||null;
    if(declarationStatus==="released"){
      const documentGate=await checkOrderPreDepartureDocuments(current.organizationId,orderId);
      if(!documentGate.ready)return{formError:`确认放行前请先处理文件：${documentGate.reasons.join("；")}`};
      releasedAt||=now;
    }
    let customsRecordId=valueOf(form,"customsRecordId")||null;
    if(customsRecordId){
      const record=await env.DB.prepare("SELECT id FROM order_customs_records WHERE id=? AND organization_id=? AND order_id=? AND clearance_stage=?").bind(customsRecordId,current.organizationId,orderId,clearanceStage).first();
      if(!record)return{formError:"所选报关任务不存在或阶段不一致"};
    }else{
      const record=await env.DB.prepare("SELECT id FROM order_customs_records WHERE organization_id=? AND order_id=? AND clearance_stage=? AND status!='cancelled' ORDER BY created_at LIMIT 1").bind(current.organizationId,orderId,clearanceStage).first<{id:string}>();
      customsRecordId=record?.id??crypto.randomUUID();
      if(!record)await env.DB.prepare("INSERT INTO order_customs_records(id,organization_id,order_id,clearance_stage,status,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,'draft',?,?,?)").bind(customsRecordId,current.organizationId,orderId,clearanceStage,current.userId,now,now).run();
    }
    try{
      if(declarationId){
        const existing=await env.DB.prepare("SELECT id FROM order_customs_declarations WHERE id=? AND organization_id=? AND order_id=?").bind(declarationId,current.organizationId,orderId).first();
        if(!existing)return{formError:"要更新的申报单不存在"};
        await env.DB.prepare(`UPDATE order_customs_declarations SET customs_record_id=?,declaration_number=?,declaration_type=?,declaration_title=?,declaring_company=?,declared_at=?,declared_amount=?,currency=?,gross_weight_kg=?,released_at=?,status=?,is_deleted=?,is_redeclared=?,is_amended=?,is_inspected=?,change_reason=?,updated_at=? WHERE id=? AND organization_id=? AND order_id=?`).bind(customsRecordId,declarationNumber,declarationType,declarationTitle,declaringCompany,declaredAt,declaredAmount,currency,grossWeightKg,declarationStatus==="released"?releasedAt:null,declarationStatus,isDeleted?1:0,form.has("isRedeclared")?1:0,form.has("isAmended")?1:0,form.has("isInspected")?1:0,changeReason||null,now,declarationId,current.organizationId,orderId).run();
      }else{
        const id=crypto.randomUUID();
        await env.DB.prepare(`INSERT INTO order_customs_declarations(id,organization_id,order_id,customs_record_id,declaration_number,declaration_type,declaration_title,declaring_company,declared_at,declared_amount,currency,gross_weight_kg,released_at,status,is_deleted,is_redeclared,is_amended,is_inspected,change_reason,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,current.organizationId,orderId,customsRecordId,declarationNumber,declarationType,declarationTitle,declaringCompany,declaredAt,declaredAmount,currency,grossWeightKg,declarationStatus==="released"?releasedAt:null,declarationStatus,isDeleted?1:0,form.has("isRedeclared")?1:0,form.has("isAmended")?1:0,form.has("isInspected")?1:0,changeReason||null,current.userId,now,now).run();
      }
    }catch(error){if(String(error).includes("UNIQUE"))return{formError:"同一订单的报关单号不能重复"};throw error}
    await syncCustomsModuleFromRecords(current.organizationId,orderId,current.userId);
    await writeAudit({request,action:declarationId?"transport.batch.order_customs_declaration.update":"transport.batch.order_customs_declaration.create",resourceType:"transport_order",resourceId:orderId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,declarationId,declarationNumber,clearanceStage,declarationStatus}});
    return{success:isDeleted?"本票报关单已标记删单，门禁与订单工作流已同步":"本票报关单已保存，门禁与订单工作流已同步"};
  }
  if(intent==="create_cost_allocation"){
    const chargeCode=valueOf(form,"chargeCode"),charge=COST_CHARGES.find(item=>item.code===chargeCode),method=valueOf(form,"method");
    if(!charge)return{formError:"请选择有效的分摊费用项目"};
    if(!["auto","weight","volume","equal"].includes(method))return{formError:"请选择有效的分摊方式"};
    try{
      const allocationId=await createCostAllocation(env.DB,{organizationId:current.organizationId,batchId,chargeCode:charge.code,chargeName:charge.name,counterpartyName:valueOf(form,"counterpartyName"),currency:valueOf(form,"currency")||"CNY",exchangeRate:positiveNumberOf(form,"exchangeRate",1),totalAmount:positiveNumberOf(form,"totalAmount"),method:method as "auto"|AllocationMethod,notes:valueOf(form,"allocationNotes"),userId:current.userId,now});
      await writeAudit({request,action:"transport.batch.cost_allocation.create",resourceType:"transport_cost_allocation",resourceId:allocationId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,chargeCode}});
      return{success:"分摊草稿已生成；请逐票检查后再确认入账"};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="update_cost_allocation"){
    const allocationId=valueOf(form,"allocationId"),method=valueOf(form,"method");
    if(!["weight","volume","equal"].includes(method))return{formError:"分摊方式无效"};
    const lineIds=form.getAll("lineId").map(String),amounts=form.getAll("lineAmount").map(value=>Number(value)),reasons=form.getAll("lineReason").map(String);
    try{
      await updateCostAllocation(env.DB,{organizationId:current.organizationId,allocationId,method:method as AllocationMethod,adjustments:lineIds.map((lineId,index)=>({lineId,amount:amounts[index],reason:reasons[index]||""})),now});
      await writeAudit({request,action:"transport.batch.cost_allocation.update",resourceType:"transport_cost_allocation",resourceId:allocationId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,method}});
      return{success:"分摊草稿已保存，尚未生成正式费用"};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="confirm_cost_allocation"){
    const allocationId=valueOf(form,"allocationId");
    try{
      await confirmCostAllocation(env.DB,{organizationId:current.organizationId,allocationId,userId:current.userId,now});
      const affectedOrders=await env.DB.prepare("SELECT DISTINCT order_id FROM transport_cost_allocation_lines WHERE organization_id=? AND allocation_id=?").bind(current.organizationId,allocationId).all<{order_id:string}>();
      await Promise.all(affectedOrders.results.map(async(item)=>{
      await syncCostModuleStatusSafe(current.organizationId,item.order_id,now);
        await syncOrderWorkflowSnapshotSafe(current.organizationId,item.order_id);
      }));
      await writeAudit({request,action:"transport.batch.cost_allocation.confirm",resourceType:"transport_cost_allocation",resourceId:allocationId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId}});
      return{success:"成本分摊已人工确认，并为各订单生成正式应付费用；该结果只影响内部应付和毛利，不会改客户应收。下一步请到订单费用模块确认、审核并锁定应付"};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="arrangement"){
    const carrierId=valueOf(form,"carrierId"),warehouseId=valueOf(form,"warehouseId"),borderPort=valueOf(form,"borderPort"),plannedDeparture=valueOf(form,"plannedDeparture"),plannedArrival=valueOf(form,"plannedArrival");
    const overseasVehicleMasterId=valueOf(form,"overseasVehicleMasterId"),overseasDriverMasterId=valueOf(form,"overseasDriverMasterId");
    let overseasCarrierName=valueOf(form,"overseasCarrierName"),overseasVehicleType=valueOf(form,"overseasVehicleType"),overseasVehiclePlate=valueOf(form,"overseasVehiclePlate"),overseasDriverName=valueOf(form,"overseasDriverName"),overseasDriverPhone=valueOf(form,"overseasDriverPhone");
    let capacityWeight=numberOf(form,"capacityWeight"),capacityVolume=numberOf(form,"capacityVolume");
    const carrier=await env.DB.prepare("SELECT id,name FROM carriers WHERE id=? AND organization_id=? AND status='active'").bind(carrierId,current.organizationId).first<{id:string;name:string}>();
    if(!carrier)return{formError:"承运商无效"};
    overseasCarrierName=carrier.name;
    if(overseasVehicleMasterId){
      const master=await env.DB.prepare("SELECT carrier_id,plate_number,vehicle_type,capacity_weight_kg,capacity_volume_cbm FROM carrier_vehicles WHERE id=? AND organization_id=? AND status='active'").bind(overseasVehicleMasterId,current.organizationId).first<{carrier_id:string;plate_number:string;vehicle_type:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null}>();
      if(!master||master.carrier_id!==carrierId)return{formError:"所选车辆不属于当前承运商或已停用"};
      overseasVehicleType=overseasVehicleType||master.vehicle_type||"";
      overseasVehiclePlate=overseasVehiclePlate||master.plate_number;
      capacityWeight=capacityWeight||master.capacity_weight_kg||0;
      capacityVolume=capacityVolume||master.capacity_volume_cbm||0;
    }
    if(overseasDriverMasterId){
      const master=await env.DB.prepare("SELECT carrier_id,name,phone FROM carrier_drivers WHERE id=? AND organization_id=? AND status='active'").bind(overseasDriverMasterId,current.organizationId).first<{carrier_id:string;name:string;phone:string|null}>();
      if(!master||master.carrier_id!==carrierId)return{formError:"所选司机不属于当前承运商或已停用"};
      overseasDriverName=overseasDriverName||master.name;
      overseasDriverPhone=overseasDriverPhone||master.phone||"";
    }
    const overseasVehicleCount=1;
    overseasVehiclePlate=overseasVehiclePlate.toUpperCase();
    if(!batch.border_port||!batch.customs_location||!batch.warehouse_id)return{formError:"配载准备不完整，请返回订单补齐装车仓、出境口岸和清关地"};
    if(!carrierId||!borderPort||!plannedDeparture||!plannedArrival)return{formError:"请先确定承运商、出境口岸、计划发车和计划到达时间"};
    if(!overseasCarrierName||!overseasVehicleType||!overseasVehiclePlate||!overseasDriverName||!overseasDriverPhone)return{formError:"请完整填写境外承运方、车型、车辆数、车牌号、司机姓名和电话（可从承运商车辆库 / 司机库下拉选择自动带出）"};
    if(warehouseId&&!(await env.DB.prepare("SELECT 1 FROM warehouses WHERE id=? AND organization_id=? AND status='active' AND warehouse_role IN ('domestic_collection','port')").bind(warehouseId,current.organizationId).first()))return{formError:"集货仓库无效，只能选择国内集货仓或口岸仓"};
    if(!(await env.DB.prepare("SELECT 1 FROM reference_data WHERE organization_id=? AND category='border_port' AND code=? AND status='active'").bind(current.organizationId,borderPort).first()))return{formError:"出境口岸无效"};
    const existingVehicle=await env.DB.prepare("SELECT id FROM transport_batch_vehicles WHERE batch_id=? AND organization_id=? AND status!='cancelled' ORDER BY created_at LIMIT 1").bind(batchId,current.organizationId).first<{id:string}>();
    await env.DB.batch([
      env.DB.prepare("UPDATE transport_batches SET carrier_id=?,warehouse_id=COALESCE(?,warehouse_id),planned_departure_at=?,planned_arrival_at=?,notes=?,overseas_carrier_name=?,overseas_vehicle_type=?,overseas_vehicle_count=?,overseas_vehicle_plate=?,overseas_driver_name=?,overseas_driver_phone=?,updated_at=? WHERE id=? AND organization_id=?").bind(carrierId,warehouseId||null,plannedDeparture,plannedArrival,valueOf(form,"notes")||null,overseasCarrierName,overseasVehicleType,overseasVehicleCount,overseasVehiclePlate,overseasDriverName,overseasDriverPhone,now,batchId,current.organizationId),
      existingVehicle
        ? env.DB.prepare("UPDATE transport_batch_vehicles SET carrier_id=?,vehicle_type=?,plate_number=?,driver_name=?,driver_phone=?,capacity_weight_kg=?,capacity_volume_cbm=?,status='planned',updated_at=? WHERE id=? AND organization_id=?").bind(carrierId,overseasVehicleType,overseasVehiclePlate,overseasDriverName,overseasDriverPhone,capacityWeight,capacityVolume,now,existingVehicle.id,current.organizationId)
        : env.DB.prepare("INSERT INTO transport_batch_vehicles(id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,carrier_id,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at) VALUES(?,?,?,'MAIN-1',?,?,?,?,?,?,?,'planned',?,?)").bind(crypto.randomUUID(),current.organizationId,batchId,overseasVehicleType,overseasVehiclePlate,carrierId,overseasDriverName,overseasDriverPhone,capacityWeight,capacityVolume,now,now),
    ]);
    await synchronizeBatchTransport(current.organizationId,batchId,now);
    await synchronizeBatchWarehouseProgress(current.organizationId,batchId,current.userId);
    await writeAudit({request,action:"transport.batch.arrangement.update",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{carrierId:carrierId||null,warehouseId:warehouseId||null}});
    return{success:"批次运输安排已保存；订单线路和货物数据已自动继承"};
  }
  if(intent==="vehicle"){
    const vehicleNo=valueOf(form,"vehicleNo");if(!vehicleNo)return{formError:"请填写车辆序号"};
    const vehicleMasterId=valueOf(form,"vehicleMasterId"),driverMasterId=valueOf(form,"driverMasterId");
    let vehicleType=valueOf(form,"vehicleType")||null,plateNumber=valueOf(form,"plateNumber"),driverName=valueOf(form,"driverName"),driverPhone=valueOf(form,"driverPhone")||null,capacityWeight=numberOf(form,"capacityWeight"),capacityVolume=numberOf(form,"capacityVolume");
    if(vehicleMasterId){
      const master=await env.DB.prepare("SELECT plate_number,vehicle_type,capacity_weight_kg,capacity_volume_cbm FROM carrier_vehicles WHERE id=? AND organization_id=? AND status='active'").bind(vehicleMasterId,current.organizationId).first<{plate_number:string;vehicle_type:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null}>();
      if(!master)return{formError:"所选承运商车辆不存在或已停用，请到承运商管理维护车辆台账"};
      vehicleType=vehicleType||master.vehicle_type;
      plateNumber=plateNumber||master.plate_number;
      capacityWeight=capacityWeight||master.capacity_weight_kg||0;
      capacityVolume=capacityVolume||master.capacity_volume_cbm||0;
    }
    if(driverMasterId){
      const master=await env.DB.prepare("SELECT name,phone FROM carrier_drivers WHERE id=? AND organization_id=? AND status='active'").bind(driverMasterId,current.organizationId).first<{name:string;phone:string|null}>();
      if(!master)return{formError:"所选司机不存在或已停用，请到承运商管理维护司机台账"};
      driverName=driverName||master.name;
      driverPhone=driverPhone||master.phone||null;
    }
    plateNumber=plateNumber.toUpperCase();
    if(!plateNumber||!driverName)return{formError:"请填写车牌号和司机（可从承运商车辆库 / 司机库下拉选择自动带出）"};
    const id=crypto.randomUUID();
    try{await env.DB.prepare("INSERT INTO transport_batch_vehicles(id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,current.organizationId,batchId,vehicleNo,vehicleType,plateNumber,driverName,driverPhone,capacityWeight,capacityVolume,now,now).run()}catch{return{formError:"车辆序号重复或车辆信息无效"}}
    await synchronizeBatchTransport(current.organizationId,batchId,now);
    await synchronizeBatchWarehouseProgress(current.organizationId,batchId,current.userId);
    await writeAudit({request,action:"transport.batch.vehicle.create",resourceType:"transport_batch_vehicle",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,vehicleNo}});
    return{success:"车辆已加入配载批次"};
  }
  if(intent==="assign_order"){
    const orderId=valueOf(form,"orderId"),vehicleId=valueOf(form,"vehicleId");
    const [relation,vehicle,packages]=await Promise.all([
      env.DB.prepare("SELECT 1 FROM transport_batch_orders WHERE batch_id=? AND order_id=? AND organization_id=? AND status!='removed'").bind(batchId,orderId,current.organizationId).first(),
      env.DB.prepare("SELECT id,capacity_weight_kg,capacity_volume_cbm FROM transport_batch_vehicles WHERE id=? AND batch_id=? AND organization_id=? AND status!='cancelled'").bind(vehicleId,batchId,current.organizationId).first<{id:string;capacity_weight_kg:number;capacity_volume_cbm:number}>(),
      env.DB.prepare(`SELECT p.id,i.gross_weight_per_package_kg weight,i.volume_per_package_cbm volume FROM order_cargo_packages p JOIN order_cargo_items i ON i.id=p.cargo_item_id WHERE p.order_id=? AND p.organization_id=? AND p.status!='cancelled' ORDER BY p.package_sequence`).bind(orderId,current.organizationId).all<{id:string;weight:number;volume:number}>(),
    ]);
    if(!relation||!vehicle)return{formError:"订单或车辆不属于当前配载批次"};
    if(!packages.results.length)return{formError:"该订单没有可配载的包装记录"};
    const packageIds=packages.results.map(item=>item.id);
    const [used,actual]=await Promise.all([
      env.DB.prepare(`SELECT COALESCE(SUM(x.weight),0) weight,COALESCE(SUM(x.volume),0) volume FROM (SELECT p.order_id,COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=p.order_id AND r.status='completed'),SUM(i.gross_weight_per_package_kg)) weight,COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=p.order_id AND r.status='completed'),SUM(i.volume_per_package_cbm)) volume FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id JOIN order_cargo_items i ON i.id=p.cargo_item_id WHERE l.vehicle_id=? AND p.order_id!=? GROUP BY p.order_id) x`).bind(vehicleId,orderId).first<{weight:number;volume:number}>(),
      env.DB.prepare("SELECT SUM(r.total_weight_kg) weight,SUM(r.total_volume_cbm) volume FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=? AND s.order_id=? AND r.status='completed'").bind(current.organizationId,orderId).first<{weight:number|null;volume:number|null}>(),
    ]);
    const orderWeight=actual?.weight??packages.results.reduce((sum,item)=>sum+item.weight,0),orderVolume=actual?.volume??packages.results.reduce((sum,item)=>sum+item.volume,0);
    if(vehicle.capacity_weight_kg>0&&(used?.weight??0)+orderWeight>vehicle.capacity_weight_kg)return{formError:"整票订单装入后将超过车辆重量上限"};
    if(vehicle.capacity_volume_cbm>0&&(used?.volume??0)+orderVolume>vehicle.capacity_volume_cbm)return{formError:"整票订单装入后将超过车辆体积上限"};
    const statements=[
      env.DB.prepare("DELETE FROM transport_vehicle_loads WHERE batch_id=? AND package_id IN (SELECT id FROM order_cargo_packages WHERE order_id=?)").bind(batchId,orderId),
      ...packageIds.map(packageId=>env.DB.prepare("INSERT INTO transport_vehicle_loads(id,organization_id,batch_id,vehicle_id,package_id,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?)").bind(crypto.randomUUID(),current.organizationId,batchId,vehicleId,packageId,current.userId,now)),
      env.DB.prepare("UPDATE transport_batches SET status='planning',updated_at=? WHERE id=?").bind(now,batchId),
      env.DB.prepare("UPDATE transport_batch_orders SET status='assigned',updated_at=? WHERE batch_id=? AND order_id=?").bind(now,batchId,orderId),
    ];
    try{await env.DB.batch(statements)}catch{return{formError:"订单货物分配失败，请检查是否已被重复配载"}}
    await synchronizeBatchTransport(current.organizationId,batchId,now);
    await synchronizeBatchWarehouseProgress(current.organizationId,batchId,current.userId);
    await writeAudit({request,action:"transport.batch.order.assign",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{orderId,vehicleId,packages:packageIds.length}});
    return{success:`装载指令已确认：整票订单分配到车辆，共 ${packageIds.length} 个包装；请到仓库端扫码装车`};
  }
  if(intent==="exit_confirm"){
    const actualExitAt=valueOf(form,"actualExitAt"),exitPort=valueOf(form,"exitPort"),exitVehiclePlate=valueOf(form,"exitVehiclePlate").trim().toUpperCase();
    const overseasVehiclePlate=(batch.overseas_vehicle_plate||"").trim().toUpperCase(),overseasCarrierName=batch.overseas_carrier_name||"",overseasVehicleType=batch.overseas_vehicle_type||"",overseasDriverName=batch.overseas_driver_name||"",overseasDriverPhone=batch.overseas_driver_phone||"";
    if(!actualExitAt||!exitPort||!exitVehiclePlate)return{formError:"请填写实际出境时间、出境口岸和出境车辆车牌"};
    if(!overseasCarrierName||!overseasVehicleType||!overseasVehiclePlate||!overseasDriverName||!overseasDriverPhone)return{formError:"境外承运方和车辆信息尚未完整，请先在本页配载单运输安排中补齐"};
    if(batch.road_status==="outbound_in_transit")return{formError:"该批次已经完成出境确认，请勿重复操作"};
    const orders=await env.DB.prepare(`SELECT bo.order_id,o.order_number,s.id shipment_id,s.customer_id,s.current_location FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id LEFT JOIN shipments s ON s.id=(SELECT id FROM shipments WHERE order_id=bo.order_id ORDER BY created_at DESC LIMIT 1) WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<{order_id:string;order_number:string;shipment_id:string|null;customer_id:string|null;current_location:string|null}>();
    if(!orders.results.length)return{formError:"当前批次没有有效订单"};
    const blockers:string[]=[];
    const batchCustomsStatus=await env.DB.prepare(
      `SELECT bo.order_id,
         COALESCE(MAX(CASE WHEN mi.id IS NOT NULL THEN 1 ELSE 0 END),0) customs_enabled,
         COUNT(d.id) total,
         COALESCE(SUM(CASE WHEN d.status='released' THEN 1 ELSE 0 END),0) released
       FROM transport_batch_orders bo
       LEFT JOIN order_module_instances mi ON mi.organization_id=bo.organization_id AND mi.order_id=bo.order_id AND mi.module_code='customs' AND mi.enabled=1
       LEFT JOIN order_customs_declarations d ON d.order_id=bo.order_id AND d.organization_id=bo.organization_id AND d.is_deleted=0 AND d.status!='cancelled'
       WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
       GROUP BY bo.order_id`,
    ).bind(batchId,current.organizationId).all<{ order_id: string; customs_enabled: number; total: number; released: number }>();
    const customsStatusByOrder = new Map(
      batchCustomsStatus.results.map((item) => [item.order_id, item]),
    );
    const sharedDocumentGate=await env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN review_status IN ('approved','archived') THEN 1 ELSE 0 END) approved FROM transport_batch_documents WHERE organization_id=? AND batch_id=? AND document_category='loading_manifest'").bind(current.organizationId,batchId).first<{total:number;approved:number|null}>();
    if(!(sharedDocumentGate?.total??0))blockers.push("配载清单尚未生成（可在配载单文件工作台一键生成）");
    else if((sharedDocumentGate?.approved??0)<(sharedDocumentGate?.total??0))blockers.push("配载清单尚未全部审核通过");
    for(const item of orders.results){
      const customsStatus=customsStatusByOrder.get(item.order_id)??{customs_enabled:0,total:0,released:0};
      if(customsStatus.customs_enabled===1 && customsStatus.total===0){
        blockers.push(`订单${item.order_number}尚未录入有效报关单`);
      }
      if(customsStatus.customs_enabled===1 && customsStatus.released!==customsStatus.total){
        blockers.push(`订单${item.order_number}的起运地/目的地报关尚未全部放行（${customsStatus.released}/${customsStatus.total}）`);
      }
      const dispatched=await env.DB.prepare(`SELECT 1 FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id WHERE d.organization_id=? AND s.order_id=? AND d.status='dispatched' LIMIT 1`).bind(current.organizationId,item.order_id).first();
      if(!dispatched){blockers.push("存在尚未完成仓库装车出库交接的订单");continue;}
      const readiness=await checkOrderDeparture(current.organizationId,item.order_id,undefined,{warehouseDispatchConfirmed:true});
      if(!readiness.ready)blockers.push(...readiness.reasons);
    }
    if(blockers.length)return{formError:`暂不能确认出境：${[...new Set(blockers)].join("；")}`};
    const statements:D1PreparedStatement[]=[
      env.DB.prepare("INSERT INTO transport_exit_confirmations(id,organization_id,batch_id,actual_exit_at,exit_port,exit_vehicle_plate,overseas_vehicle_plate,overseas_carrier_name,overseas_vehicle_type,overseas_driver_name,overseas_driver_phone,proof_reference,notes,confirmed_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),current.organizationId,batchId,actualExitAt,exitPort,exitVehiclePlate,overseasVehiclePlate||null,overseasCarrierName||null,overseasVehicleType||null,overseasDriverName||null,overseasDriverPhone||null,valueOf(form,"proofReference")||null,valueOf(form,"exitNotes")||null,current.userId,now),
      env.DB.prepare("UPDATE transport_batches SET status='departed',road_status='outbound_in_transit',actual_departure_at=?,border_port=?,updated_at=? WHERE id=? AND organization_id=?").bind(actualExitAt,exitPort,now,batchId,current.organizationId),
      env.DB.prepare("UPDATE transport_batch_vehicles SET status='departed',updated_at=? WHERE batch_id=? AND organization_id=? AND status!='cancelled'").bind(now,batchId,current.organizationId),
      env.DB.prepare("UPDATE transport_batch_orders SET status='departed',updated_at=? WHERE batch_id=? AND organization_id=? AND status!='removed'").bind(now,batchId,current.organizationId),
      env.DB.prepare("UPDATE order_module_instances SET status='in_progress',current_step_code='transit',current_step_name='出境运输中',progress_percent=50,started_at=COALESCE(started_at,?),blocking_reason=NULL,updated_at=? WHERE organization_id=? AND module_code='tracking' AND enabled=1 AND order_id IN (SELECT order_id FROM transport_batch_orders WHERE batch_id=? AND status!='removed')").bind(now,now,current.organizationId,batchId),
    ];
    for(const item of orders.results){
      statements.push(env.DB.prepare(`INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer,created_by_user_id,created_at)
        SELECT ?,?,?,'exported','出境',?,?,?,?,1,?,?
        WHERE NOT EXISTS(SELECT 1 FROM order_tracking_milestones WHERE organization_id=? AND order_id=? AND milestone_code='exported' AND event_at=?)`).bind(crypto.randomUUID(),current.organizationId,item.order_id,actualExitAt,exitPort,exitVehiclePlate,valueOf(form,"exitNotes")||null,current.userId,now,current.organizationId,item.order_id,actualExitAt));
      statements.push(env.DB.prepare("UPDATE order_cargo_packages SET status='in_transit' WHERE order_id=? AND organization_id=? AND status NOT IN ('cancelled','delivered')").bind(item.order_id,current.organizationId));
      statements.push(env.DB.prepare(`INSERT INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,priority,status,assignee_user_id,assigned_by_user_id,created_at,updated_at)
        SELECT ?,?,?, 'costs','start_receivable_reconciliation','发起客户应收对账','normal','pending',NULL,?,?,?
        WHERE NOT EXISTS(SELECT 1 FROM order_tasks WHERE organization_id=? AND order_id=? AND task_type='start_receivable_reconciliation' AND status IN ('pending','in_progress'))`).bind(crypto.randomUUID(),current.organizationId,item.order_id,current.userId,now,now,current.organizationId,item.order_id));
      if(item.shipment_id){
        const description=`批次 ${batch.batch_number} 已从 ${exitPort} 出境，车辆 ${exitVehiclePlate}${overseasVehiclePlate?`，境外车辆 ${overseasVehiclePlate}`:""}`;
        statements.push(
          env.DB.prepare("UPDATE shipments SET status='in_transit',current_location=?,updated_at=? WHERE id=? AND organization_id=?").bind(exitPort,now,item.shipment_id,current.organizationId),
          env.DB.prepare("INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at) VALUES(?,?,'in_transit',?,?,?,1,?,?)").bind(crypto.randomUUID(),item.shipment_id,exitPort,description,actualExitAt,current.userId,now),
        );
      }
    }
    await env.DB.batch(statements);
    await Promise.all(orders.results.map(async item=>{
      await syncTrackingModuleStatusForOrder(current.organizationId,item.order_id,"exported",current.userId,now);
      if(item.shipment_id&&item.customer_id)await recordWorkflowEvent({organizationId:current.organizationId,event:"shipment.in_transit",customerId:item.customer_id,orderId:item.order_id,shipmentId:item.shipment_id,actorUserId:current.userId,source:"admin",metadata:{batchId,batchNumber:batch.batch_number,exitPort,exitVehiclePlate,overseasVehiclePlate:overseasVehiclePlate||null,overseasCarrierName:overseasCarrierName||null,overseasDriverName:overseasDriverName||null}});
    }));
    await writeAudit({request,action:"transport.batch.exit.confirm",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{actualExitAt,exitPort,exitVehiclePlate,orders:orders.results.length}});
    return{success:"出境确认完成；批次内运单已统一进入出境运输中，轨迹已同步"};
  }
  if(intent==="overseas_arrival"){
    return{formError:"到达境外目的仓不能在配载单中手工确认，请由各订单指定的境外目的仓扫码入库并完成清点"};
  }
  if(intent==="batch_tracking_option_toggle"){
    const optionCode=valueOf(form,"optionCode");
    if(!BATCH_TRACKING_OPTIONAL_CODES.includes(optionCode))return{formError:"可选节点类型无效"};
    const enable=form.get("enable")==="on";
    const column=optionCode==="transloaded"?"requires_transloading":"requires_transit_customs";
    const orderIds=await getBatchOrderIds(current.organizationId,batchId);
    if(!orderIds.length)return{formError:"当前批次没有可操作的订单"};
    for (const chunk of chunkArray(orderIds, CHUNK_SIZE)) {
      await env.DB.prepare(`UPDATE transport_orders SET ${column}=?, updated_at=? WHERE organization_id=? AND id IN (${chunk.map(() => "?").join(",")})`).bind(enable ? 1 : 0, now, current.organizationId, ...chunk).run();
    }
    await writeAudit({request,action:"transport.batch.tracking_option.toggle",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{optionCode,enable,orders:orderIds.length}});
    return{success:enable?`已为 ${orderIds.length} 票订单开启"${optionCode==="transloaded"?"可换装":"可转运"}"`:`已为 ${orderIds.length} 票订单关闭"${optionCode==="transloaded"?"可换装":"可转运"}"`};
  }
  if(intent==="batch_tracking_add"){
    const milestoneCode=valueOf(form,"milestoneCode");
    const milestoneDef=BATCH_TRACKING_MILESTONES.find(item=>item.code===milestoneCode);
    if(!milestoneDef)return{formError:"请选择有效的运输节点"};
    if(milestoneCode==="exported")return{formError:"请在本页“出境门禁与确认”填写实际出境时间并确认，系统会自动登记出境节点"};
    if(milestoneCode==="station_arrived")return{formError:"到达境外目的仓不能手工登记，请由各订单指定的境外目的仓扫码入库并完成清点"};
    const eventAt=valueOf(form,"eventAt");
    if(!eventAt)return{formError:"请填写事件时间"};
    const orderIds=await getBatchOrderIds(current.organizationId,batchId);
    if(!orderIds.length)return{formError:"当前批次没有可操作的订单"};
    // 顺序门禁：批次内每个订单都必须已有前置节点
    const previousMissing=await validateBatchTrackingRequiredPrevious(current.organizationId,orderIds,milestoneCode);
    if(previousMissing){
      return{formError:`节点"${milestoneDef.name}"要求每个订单已登记${BATCH_TRACKING_REQUIRED_PREVIOUS[milestoneCode]?.join("、")||"前置节点"}；${previousMissing.missingOrders} 票订单未满足${previousMissing.sampleOrderNumber?`（示例：${previousMissing.sampleOrderNumber}）`:""}`};
    }
    const locationValue=valueOf(form,"location")||null;
    const notesValue=valueOf(form,"notes")||null;
    const vehicleReference=valueOf(form,"vehicleReference")||batch.overseas_vehicle_plate||null;
    const visibleToCustomer=form.get("visibleToCustomer")!=="off";
    await insertTrackingMilestoneForBatchOrders({
      organizationId:current.organizationId,
      orderIds,
      milestoneCode,
      milestoneName:milestoneDef.name,
      eventAt,
      location:locationValue,
      vehicleReference,
      notes:notesValue,
      visibleToCustomer,
      actorUserId:current.userId,
      createdAt:now,
    });
    // 同步每票订单的 tracking 模块实例进度
    for(const orderId of orderIds){
      await syncTrackingModuleStatusForOrder(current.organizationId,orderId,milestoneCode,current.userId,now);
    }
    // 同步每票订单的工作流快照（batch-tracking.server.ts 不再 import order-modules.server）
    await Promise.all(orderIds.map((orderId)=>syncOrderWorkflowSnapshotSafe(current.organizationId,orderId)));
    // 同步批次 road_status / transport_batch_orders 状态
    await syncBatchRoadStatusFromTracking(current.organizationId,batchId,orderIds,now);
    // 同步 shipment 轨迹事件
    const milestoneStatusMap:Record<string,string>={border_arrived:"customs",exported:"in_transit",transloaded:"in_transit",transit_customs:"in_transit",foreign_entered:"in_transit",customs_cleared:"in_transit",station_arrived:"in_transit"};
    await recordShipmentEventForBatchOrders({
      organizationId:current.organizationId,
      orderIds,
      eventAt,
      location:locationValue,
      description:`批次 ${batch.batch_number} 登记「${milestoneDef.name}」${locationValue?`，地点 ${locationValue}`:""}${vehicleReference?`，车辆 ${vehicleReference}`:""}`,
      status:milestoneStatusMap[milestoneCode]||"in_transit",
      actorUserId:current.userId,
      createdAt:now,
    });
    await writeAudit({request,action:"transport.batch.tracking.add",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{milestoneCode,eventAt,orders:orderIds.length,location:locationValue,vehicleReference}});
    return{success:`已为 ${orderIds.length} 票订单登记「${milestoneDef.name}」（${eventAt}）；模块进度与批次状态已同步`};
  }
  return{formError:"操作无效"};
}

export default function LoadingDetail({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle",manage=canManageOrderModule(loaderData.current,"loading");
  const totals=summarizeBatch(loaderData.orders,loaderData.vehicles);
  const unassignedOrders=loaderData.orders.filter(item=>item.package_count>0&&item.assigned_count<item.package_count).length;
  const assignedOrders=loaderData.orders.filter(item=>item.assigned_count>0);
  const planReady=Boolean(loaderData.batch.carrier_id&&loaderData.batch.border_port&&loaderData.batch.planned_departure_at&&loaderData.batch.planned_arrival_at);
  const loadPlanReady=planReady&&loaderData.vehicles.length>0&&unassignedOrders===0;
  const flagsByOrder=new Map(loaderData.trackingFlags.map(item=>[item.order_id,item]));
  const requiresTransloading=loaderData.orders.some(o=>flagsByOrder.get(o.order_id)?.requires_transloading===1);
  const dispatchedCount=loaderData.outboundStatuses.filter(item=>item.dispatched===1).length;
  const allDispatched=loaderData.orders.length>0&&dispatchedCount===loaderData.orders.length;
  const sharedDocumentsReady=BATCH_DOCUMENT_TYPES.filter(item=>item.required).every(type=>loaderData.batchDocuments.some(document=>document.document_category===type.code&&["approved","archived"].includes(document.review_status)));
  // 报关就绪：报关资料文件已审核 AND 报关单已放行
  const customsReadyForOrder=(orderId:string)=>{
    const customs=loaderData.customsSummaries.find(item=>item.order_id===orderId);
    const customsDeclReady=Boolean(customs&&customs.total>0&&customs.released===customs.total);
    const files=loaderData.orderDocuments.filter(item=>item.order_id===orderId);
    const customsDocApproved=files.some(item=>item.document_category==="customs_document"&&["approved","archived"].includes(item.review_status));
    return customsDeclReady&&customsDocApproved;
  };
  const firstOrderCustomsReady=assignedOrders.length>0?customsReadyForOrder(assignedOrders[0].order_id):false;
  const orderDepartureReady=loaderData.departureGateStatuses.every(item=>item.ready);
  const transportResourceReady=Boolean(loaderData.batch.overseas_carrier_name&&loaderData.batch.overseas_vehicle_type&&loaderData.batch.overseas_vehicle_count>0&&loaderData.batch.overseas_vehicle_plate&&loaderData.batch.overseas_driver_name&&loaderData.batch.overseas_driver_phone);
  const canConfirmExit=allDispatched&&sharedDocumentsReady&&orderDepartureReady&&transportResourceReady;
  const exitBlockers=[
    ...(!allDispatched?[`仓库装车出库交接未完成（${dispatchedCount}/${loaderData.orders.length} 票）`]:[]),
    ...(!transportResourceReady?["境外承运方、车型、车牌、司机姓名或司机电话尚未补齐"]:[]),
    ...(!sharedDocumentsReady?["配载清单尚未生成或审核通过（可在配载单文件工作台一键生成）"]:[]),
    ...loaderData.departureGateStatuses.flatMap(item=>item.reasons.map(reason=>`${loaderData.orders.find(order=>order.order_id===item.order_id)?.order_number||"订单"}：${reason}`)),
  ];
  return <><header className="page-header"><div><p className="eyebrow">LOAD SHEET · BATCH WORKBENCH</p><h1>{loaderData.batch.batch_number}</h1><p>{loaderData.batch.batch_name} · {loaderData.batch.origin_location} → {loaderData.batch.destination_location}</p></div><div className="page-actions">{loaderData.returnOrderId&&<Link className="secondary" to={`/admin/orders/${loaderData.returnOrderId}`}>返回订单详情</Link>}<Link className="secondary" to="/admin/loading">返回配载工作台</Link><span className="status-pill">{roadStatusLabels[loaderData.batch.road_status]||loaderData.batch.road_status}</span></div></header>{(actionData?.success||actionData?.formError)&&<div className={`alert ${actionData.formError?"error":"success"}`}>{actionData.formError??actionData.success}</div>}
  <section className="panel batch-command-panel">
    <div className="panel-header"><div><h2>配载单主工作台</h2><p>这张配载单挂载 {loaderData.orders.length} 票订单；从这里确认出境和到境外仓，系统会同步所有挂载订单。</p></div><span className="status-pill">{roadStatusLabels[loaderData.batch.road_status]||loaderData.batch.road_status}</span></div>
    <BatchCommandSteps status={loaderData.batch.road_status} loadPlanReady={loadPlanReady} warehouseReady={allDispatched}/>
  </section>
  <section className="panel loading-sheet" id="batch-arrangement">
    <div className="panel-header loading-sheet-header"><div><h2>配载单</h2><p>一屏完成批次安排、车辆录入、整票分配和合计复核；订单不能拆分，容量按仓库实收数据校验。</p></div><div className="loading-sheet-state"><span>{loaderData.orders.length} 票</span><span>{loaderData.vehicles.length} 车</span><b>{planReady&&unassignedOrders===0?"可交仓库装车":"待完善"}</b></div></div>
    <div className="loading-summary-strip">
      <span>起运地<strong>{loaderData.batch.origin_location}</strong></span>
      <span>目的地<strong>{loaderData.batch.destination_location}</strong></span>
      <span>承运商<strong>{loaderData.batch.carrier_name||"待选择"}</strong></span>
      <span>计划发车<strong>{formatShortDateTime(loaderData.batch.planned_departure_at)}</strong></span>
      <span>未分配订单<strong className={unassignedOrders?"danger-text":""}>{unassignedOrders}</strong></span>
    </div>
    {!loaderData.carriers.length&&manage&&<div className="alert error">当前没有启用的承运商，无法保存运输安排。请先到<Link to="/admin/shipments">运输执行</Link>维护承运商档案。</div>}
    <div className="loading-sheet-layout">
      {manage&&<Form method="post" className="loading-sheet-form"><input type="hidden" name="intent" value="arrangement"/>
        <label className="field"><span>承运商</span><select name="carrierId" defaultValue={loaderData.batch.carrier_id||""} required><option value="">请选择承运商</option>{loaderData.carriers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field"><span>集货仓库</span><select name="warehouseId" defaultValue={loaderData.batch.warehouse_id||""}><option value="">继承当前仓库</option>{loaderData.warehouses.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <input type="hidden" name="borderPort" value={loaderData.batch.border_port||""}/>
        <div className="loading-preparation-summary span-2">
          <span><b>汽运线路</b>{loaderData.batch.route_notes||"未确定"}</span>
          <span><b>出境口岸</b>{loaderData.batch.border_port||"未确定"}</span>
          <span><b>起运地清关地</b>{loaderData.batch.customs_location||"未确定"}</span>
          <span><b>中转地</b>{loaderData.batch.transit_location||"无"}</span>
        </div>
        <Field name="plannedDeparture" label="计划发车" type="datetime-local" required defaultValue={dateTimeLocal(loaderData.batch.planned_departure_at)}/>
        <Field name="plannedArrival" label="计划到达" type="datetime-local" required defaultValue={dateTimeLocal(loaderData.batch.planned_arrival_at)}/>
        <label className="field span-2"><span>业务备注</span><input name="notes" defaultValue={loaderData.batch.notes||""}/></label>
        <div className="form-section-title span-2"><strong>境外运输资源</strong><small>确定整车/拼车方案后立即登记；出境确认将直接继承。车辆与司机优先从承运商车辆库下拉选择，避免重复录入。</small></div>
        <OverseasResourceFields batch={loaderData.batch} carrierVehicles={loaderData.carrierVehicles} carrierDrivers={loaderData.carrierDrivers}/>
        <button className="primary" disabled={busy||!loaderData.carriers.length}>保存配载单信息</button>
      </Form>}
      <aside className="loading-sheet-tools">
        {manage&&<details className="loading-tool-card" open={loaderData.vehicles.length>0&&unassignedOrders>0}><summary>分配整票订单到车辆</summary><Form method="post" className="compact-tool-form"><input type="hidden" name="intent" value="assign_order"/><Select name="orderId" label="订单" items={loaderData.orders.map(item=>[item.order_id,`${item.order_number} · ${item.customer_name} · ${item.package_count} 包装`])}/><Select name="vehicleId" label="车辆" items={loaderData.vehicles.map(item=>[item.id,`${item.vehicle_no} · ${item.plate_number||"未录车牌"}`])}/>{!loaderData.vehicles.length&&<small className="field-error">请先添加至少一辆车。</small>}<button className="secondary" disabled={busy||!loaderData.vehicles.length||!loaderData.orders.length}>确认装载指令</button></Form>{actionData?.success?.startsWith("装载指令已确认")&&<div className="alert success loading-assignment-feedback">{actionData.success}</div>}<div className="loading-assignment-records"><header><strong>分配记录</strong><span>{assignedOrders.length}/{loaderData.orders.length} 票已分配</span></header>{assignedOrders.map(item=><div className="loading-assignment-record" key={item.order_id}><div><strong>{item.order_number}</strong><small>{item.customer_name}</small></div><div><span>装载车辆</span><strong>{item.vehicle_names||"未记录"}</strong></div><div><span>包装</span><strong>{item.assigned_count}/{item.package_count}</strong></div><span className={`status-pill ${item.assigned_count>=item.package_count?"success":""}`}>{item.assigned_count>=item.package_count?"已确认":"部分分配"}</span></div>)}{!assignedOrders.length&&<p className="empty-state">尚无分配记录；确认装载指令后将显示在这里。</p>}{assignedOrders.length>0&&<WarehouseOutboundAction orderId={assignedOrders[0].order_id} batchId={loaderData.batch.id} customsReady={firstOrderCustomsReady}/>}</div></details>}
      </aside>
    </div>
    <LoadingTotals totals={totals}/>
    <div className="loading-sheet-columns">
      <section className="loading-sheet-section"><header><h3>挂载订单</h3><span>货物名称按每票货物明细完整汇总；这些订单跟随本配载单批量推进</span></header><div className="table-wrap loading-sheet-table"><table><thead><tr><th>订单号</th><th>工作号</th><th>委托人</th><th>起运地</th><th>目的地</th><th>货物名称</th><th>件数</th><th>报关重量</th><th>报关体积</th><th>进仓重量</th><th>进仓体积</th><th>入库时间</th><th>货物状态</th><th>车辆</th><th>境外仓</th><th>操作</th></tr></thead><tbody>{loaderData.orders.map(item=><tr key={item.order_id}><td><Link to={`/admin/orders/${item.order_id}/modules/loading`}><strong>{item.order_number}</strong></Link></td><td>{item.work_number}</td><td>{item.customer_name}</td><td>{loaderData.batch.origin_location}</td><td>{loaderData.batch.destination_location}</td><td><strong className="loading-cargo-names">{item.cargo_names||item.cargo_description||"未填写"}</strong></td><td>{item.pieces}</td><td>{item.declared_weight_kg.toFixed(2)}</td><td>{item.declared_volume_cbm.toFixed(3)}</td><td>{item.gross_weight_kg.toFixed(2)}</td><td>{item.volume_cbm.toFixed(3)}</td><td>{item.inbound_at?formatShortDateTime(item.inbound_at):<span className="off">未入库</span>}</td><td>{item.dispatched_packages>0?<span className="status-pill success">已出库 {item.dispatched_packages}</span>:item.inbound_at?(item.in_stock_packages>0?<span className="status-pill">在库 {item.in_stock_packages}</span>:<span className="status-pill off">无在库包装</span>):<span className="status-pill off">未入库</span>}</td><td>{item.vehicle_names||"待分配"}</td><td>{item.overseas_status==="arrived"||item.overseas_status==="notified"||item.overseas_status==="appointment"||item.overseas_status==="picked_up"?<span className="status-pill success">{item.overseas_arrival_at?`已到仓 ${formatShortDateTime(item.overseas_arrival_at)}`:"已到仓"}</span>:<span className="status-pill off">未到仓</span>}</td><td><div className="loading-row-actions"><Link className="text-button" to={`/admin/orders/${item.order_id}`}>订单中心</Link><a className="text-button" href="#batch-files">处理文件</a></div></td></tr>)}</tbody></table></div></section>
      <section className="loading-sheet-section"><header><h3>车辆容量</h3><span>分配时自动校验重量和体积</span></header><div className="loading-vehicle-grid compact">{loaderData.vehicles.map(vehicle=><article key={vehicle.id}><header><strong>{vehicle.vehicle_no}</strong><span>{vehicle.plate_number||"车牌待录"}</span></header><p>{vehicle.vehicle_type||"车型待录"} · {vehicle.driver_name||"司机待定"} · {vehicle.driver_phone||"电话待录"}</p><div><span>重量 {vehicle.used_weight.toFixed(2)} / {vehicle.capacity_weight_kg||"不限"} KG</span><span>体积 {vehicle.used_volume.toFixed(3)} / {vehicle.capacity_volume_cbm||"不限"} CBM</span><span>{vehicle.loaded_orders} 票订单</span></div></article>)}</div>{!loaderData.vehicles.length&&<p className="empty-state">当前批次还没有车辆。</p>}</section>
    </div>
  </section>
  <BatchDocumentWorkbench batchId={loaderData.batch.id} orders={loaderData.orders} batchDocuments={loaderData.batchDocuments} orderDocuments={loaderData.orderDocuments} customsSummaries={loaderData.customsSummaries} customsDeclarations={loaderData.customsDeclarations} busy={busy} manage={manage} requiresTransloading={requiresTransloading}/>
  <BatchTrackingWorkbench batchId={loaderData.batch.id} batchNumber={loaderData.batch.batch_number} orders={loaderData.orders} trackingMilestones={loaderData.trackingMilestones} trackingFlags={loaderData.trackingFlags} batchVehiclePlate={loaderData.batchVehiclePlate} overseasVehiclePlate={loaderData.batch.overseas_vehicle_plate||null} borderPort={loaderData.batch.border_port||null} busy={busy} manage={manage}/>
  <CostAllocationSection allocations={loaderData.costAllocations} busy={busy} manage={manage}/>
  <section className="panel" id="batch-exit-gate"><div className="panel-header"><div><h2>6. 出境门禁与确认</h2><p>这里逐项核对整批订单；全部通过后，才能统一确认出境并同步所有挂载订单。</p></div><span className="status-pill">{roadStatusLabels[loaderData.batch.road_status]||loaderData.batch.road_status}</span></div>
    <div className="batch-exit-gates">
      <div className={`batch-exit-gate ${allDispatched?"ready":"blocked"}`}><span>仓库装车出库</span><strong>{allDispatched?"全部订单已完成交接":`${dispatchedCount}/${loaderData.orders.length} 票已完成`}</strong></div>
      <div className={`batch-exit-gate ${transportResourceReady?"ready":"blocked"}`}><span>境外运输资源</span><strong>{transportResourceReady?`${loaderData.batch.overseas_carrier_name} · ${loaderData.batch.overseas_vehicle_plate}`:"承运方、车辆或司机资料未齐"}</strong></div>
      <div className={`batch-exit-gate ${sharedDocumentsReady?"ready":"blocked"}`}><span>配载单文件</span><strong>{sharedDocumentsReady?"配载清单已生成并审核":"配载清单待生成"}</strong></div>
      <div className={`batch-exit-gate ${orderDepartureReady?"ready":"blocked"}`}><span>逐票资料与报关</span><strong>{orderDepartureReady?"全部订单门禁已通过":`${loaderData.departureGateStatuses.filter(item=>!item.ready).length} 票待处理`}</strong></div>
    </div>
    {loaderData.batch.road_status==="outbound_in_transit"?<div className="alert success">本配载单已出境；现在可以在下方继续确认到境外仓。</div>:["overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status)?<div className="alert success">本配载单已完成出境确认。</div>:canConfirmExit&&manage?<Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="exit_confirm"/><Field name="actualExitAt" label="实际出境时间" type="datetime-local" required/><label className="field"><span>实际出境口岸</span><select name="exitPort" defaultValue={loaderData.batch.border_port||""} required><option value="">请选择</option>{loaderData.borderPorts.map(item=><option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}</select></label><Field name="exitVehiclePlate" label="实际出境车辆车牌" required defaultValue={loaderData.batch.overseas_vehicle_plate||loaderData.vehicles.map(item=>item.plate_number).filter(Boolean).join("、")}/><Field name="proofReference" label="出境凭证 / 图片编号"/><Field name="exitNotes" label="出境备注"/><button className="primary" disabled={busy}>确认本配载单已出境并同步订单</button></Form>:<div className="batch-gate-blocker"><div><strong>当前还不能确认出境</strong><p>完成下面的未通过项目后，系统会自动开放“确认出境”。</p>{exitBlockers.length?<ul>{Array.from(new Set(exitBlockers)).map(reason=><li key={reason}>{reason}</li>)}</ul>:<p>当前账号只能查看门禁状态。</p>}</div><div className="batch-gate-actions">{!allDispatched&&assignedOrders[0]&&<WarehouseOutboundAction orderId={assignedOrders[0].order_id} batchId={loaderData.batch.id} customsReady={firstOrderCustomsReady}/>}<a className="secondary" href="#batch-files">处理配载单文件与逐票报关</a>{!loadPlanReady&&<a className="secondary" href="#batch-arrangement">完善配载和车辆安排</a>}</div></div>}
  </section>
  <section className="panel"><div className="panel-header"><div><h2>7. 境外目的仓收货清点</h2><p>配载单不能手工确认到仓。仓库逐票扫码入库并清点；全部挂载订单清点无误后，系统统一结束境外运输并开放客户通知。</p></div><span className="status-pill">{loaderData.orders.filter(item=>item.overseas_status&&item.overseas_status!=="waiting_arrival").length}/{loaderData.orders.length} 票到仓</span></div>{loaderData.batch.road_status==="outbound_in_transit"&&manage?<div className="loading-assignment-records">{loaderData.orders.map(item=><div className="loading-assignment-record" key={item.order_id}><div><strong>{item.order_number}</strong><small>{item.customer_name}</small></div><div><span>境外目的仓</span><strong>{item.overseas_warehouse_name||"未指定"}</strong></div><span className={`status-pill ${item.overseas_status&&item.overseas_status!=="waiting_arrival"?"success":""}`}>{item.overseas_status&&item.overseas_status!=="waiting_arrival"?"已清点到仓":"待仓库收货"}</span>{item.overseas_warehouse_id&&(!item.overseas_status||item.overseas_status==="waiting_arrival")?<WarehouseOverseasInboundAction orderId={item.order_id} batchId={loaderData.batch.id} warehouseId={item.overseas_warehouse_id}/>:null}</div>)}</div>:["overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status)?<div className="alert success">本配载单全部订单已经境外仓扫码入库并清点；现在可分别通知客户。</div>:<div className="alert warning">当前步骤尚未开放：请先在上方完成全部出境门禁并确认出境。</div>}</section>
  </>}

function BatchDocumentWorkbench({batchId,orders,batchDocuments,orderDocuments,customsSummaries,customsDeclarations,busy,manage,requiresTransloading}:{batchId:string;orders:BatchOrder[];batchDocuments:BatchDocument[];orderDocuments:OrderDocument[];customsSummaries:CustomsSummary[];customsDeclarations:BatchCustomsDeclaration[];busy:boolean;manage:boolean;requiresTransloading:boolean}){
  const approvedShared=new Set(batchDocuments.filter(item=>["approved","archived"].includes(item.review_status)).map(item=>item.document_category));
  const visibleBatchDocTypes=BATCH_DOCUMENT_TYPES.filter(type=>requiresTransloading||!["border_handover","transshipment_order"].includes(type.code));
  const missingShared=visibleBatchDocTypes.filter(item=>item.required&&!approvedShared.has(item.code));
  return <section className="panel batch-document-workbench" id="batch-files">
    <div className="panel-header"><div><h2>3. 配载单文件工作台</h2><p>在这一页处理整批共用文件和每票订单文件；上传结果仍归属原订单，出境门禁自动汇总检查。</p></div><span className={`status-pill ${missingShared.length?"":"success"}`}>{missingShared.length?`整批缺 ${missingShared.length} 项`:"整批文件已齐"}</span></div>
    <div className="batch-document-scope-note"><strong>整批共用</strong><span>配载清单由工作台自动生成，装车清单、批次运单{requiresTransloading?"、口岸交接文件与换装单":""}按需上传。</span><strong>逐票独立</strong><span>委托书、发票、装箱单、报关资料和报关单按订单分别检查。</span></div>
    <section className="batch-shared-documents"><header><div><h3>整批共用文件</h3><p>“配载清单”由配载工作台自动生成并自动审核通过，其他文件按实际业务发生时补充{requiresTransloading?"；换装文件仅在开启换装后显示":""}。</p></div></header>
      <div className="batch-document-grid">{visibleBatchDocTypes.map(type=>{
        const current=batchDocuments.find(item=>item.document_category===type.code);
        const isManifest=type.code==="loading_manifest";
        return <article className={current&&["approved","archived"].includes(current.review_status)?"ready":""} key={type.code}>
          <div><strong>{type.name}{type.required&&<b className="required-mark"> *</b>}</strong><small>{type.hint}</small></div>
          <div className="batch-document-current">{current?<><span className={`status-pill ${current.review_status==="approved"?"success":""}`}>{documentReviewLabel(current.review_status)}</span><a href={current.data_url} target="_blank" rel="noreferrer">{current.file_name}</a></>:<span className="status-pill off">{isManifest?"待生成":"待上传"}</span>}</div>
          {isManifest
            ?(manage&&<Form method="post" className="batch-document-upload"><input type="hidden" name="intent" value="generate_manifest"/><button className="secondary" disabled={busy}>{current?"重新生成配载单":"生成配载单"}</button><small className="field-hint">按当前车辆与订单分配实时生成，自动审核通过</small></Form>)
            :(manage&&<Form method="post" encType="multipart/form-data" className="batch-document-upload"><input type="hidden" name="intent" value="batch_document_upload"/><input type="hidden" name="documentCategory" value={type.code}/><input name="attachment" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required/><input name="documentDescription" placeholder="文件说明（选填）"/><button className="secondary" disabled={busy}>{current?"重新上传":"上传"}</button></Form>)}
          {!isManifest&&manage&&current&&current.review_status!=="approved"&&<Form method="post" className="batch-document-review"><input type="hidden" name="intent" value="batch_document_review"/><input type="hidden" name="attachmentId" value={current.id}/><input type="hidden" name="reviewStatus" value="approved"/><button className="text-button" disabled={busy}>审核通过</button></Form>}
        </article>})}</div>
    </section>
    <section className="batch-order-documents"><header><div><h3>逐票订单文件与报关门禁</h3><p>可在任意挂载订单进入本工作台，直接处理同一配载单内其他订单，不再逐页往返。</p></div></header>
      <div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>货物名称</th><th>实收数据</th><th>订单文件</th><th>报关单放行</th><th>操作</th></tr></thead><tbody>{orders.map(order=>{
        const files=orderDocuments.filter(item=>item.order_id===order.order_id);
        const latestFiles=ORDER_BATCH_DOCUMENT_CODES.map(code=>files.find(item=>item.document_category===code)).filter((item):item is OrderDocument=>Boolean(item));
        const approvedCodes=new Set(latestFiles.filter(item=>["approved","archived"].includes(item.review_status)).map(item=>item.document_category));
        const missingCodes=ORDER_BATCH_DOCUMENT_CODES.filter(code=>!approvedCodes.has(code));
        const customs=customsSummaries.find(item=>item.order_id===order.order_id);
        const customsReady=Boolean(customs&&customs.total>0&&customs.released===customs.total);
        return <tr key={order.order_id}>
          <td><strong>{order.order_number}</strong><small>{order.customer_name}</small></td>
          <td><strong className="loading-cargo-names">{order.cargo_names||order.cargo_description||"未填写"}</strong></td>
          <td>{order.pieces} 件 · {order.gross_weight_kg.toFixed(2)} KG · {order.volume_cbm.toFixed(3)} CBM</td>
          <td><span className={`status-pill ${missingCodes.length?"":"success"}`}>{missingCodes.length?`缺 ${missingCodes.length} 项`:`${ORDER_BATCH_DOCUMENT_CODES.length} 项已齐`}</span>{missingCodes.length>0&&<small>{missingCodes.map(orderDocumentTypeLabel).join("、")}</small>}</td>
          <td><span className={`status-pill ${customsReady?"success":""}`}>{customs?.total?`${customs.released}/${customs.total} 张放行`:"尚无有效报关单"}</span></td>
          <td><details className="batch-order-file-details"><summary>处理本票文件</summary><div className="batch-order-file-panel">
            <header className="batch-order-file-panel-header"><div><strong>处理本票文件</strong><span>{order.order_number} · {order.customer_name}</span></div><button type="button" aria-label="关闭文件处理窗口" onClick={event=>(event.currentTarget.closest("details") as HTMLDetailsElement|null)?.removeAttribute("open")}>×</button></header>
            <div className="batch-order-file-list">{ORDER_BATCH_DOCUMENT_CODES.map(code=>{const current=files.find(item=>item.document_category===code);return <div key={code}><strong>{orderDocumentTypeLabel(code)}</strong>{current?<><a href={current.data_url} target="_blank" rel="noreferrer">{current.file_name}</a><span className={`status-pill ${current.review_status==="approved"?"success":""}`}>{documentReviewLabel(current.review_status)}</span>{manage&&current.review_status!=="approved"&&<Form method="post"><input type="hidden" name="intent" value="batch_order_document_review"/><input type="hidden" name="orderId" value={order.order_id}/><input type="hidden" name="attachmentId" value={current.id}/><input type="hidden" name="reviewStatus" value="approved"/><button className="text-button" disabled={busy}>审核通过</button></Form>}</>:<span className="status-pill off">待上传</span>}</div>})}</div>
            {manage&&<Form method="post" encType="multipart/form-data" className="batch-order-file-upload"><input type="hidden" name="intent" value="batch_order_document_upload"/><input type="hidden" name="orderId" value={order.order_id}/><label><span>文件类型</span><select name="documentCategory" required><option value="">请选择</option>{ORDER_BATCH_DOCUMENT_CODES.map(code=><option key={code} value={code}>{orderDocumentTypeLabel(code)}</option>)}</select></label><label><span>选择文件</span><input name="attachment" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required/></label><label><span>说明</span><input name="documentDescription" placeholder="选填"/></label><button className="primary" disabled={busy}>上传到本订单</button></Form>}
            <BatchOrderCustomsWorkbench orderId={order.order_id} declarations={customsDeclarations.filter(item=>item.order_id===order.order_id)} manage={manage} busy={busy}/>
            <div className="batch-order-file-links"><Link className="secondary" to={`/admin/orders/${order.order_id}/modules/documents`}>查看完整文件中心</Link></div>
          </div></details></td>
        </tr>})}</tbody></table></div>
    </section>
  </section>
}

function BatchTrackingWorkbench({batchId,batchNumber,orders,trackingMilestones,trackingFlags,batchVehiclePlate,overseasVehiclePlate,borderPort,busy,manage}:{batchId:string;batchNumber:string;orders:BatchOrder[];trackingMilestones:BatchTrackingMilestone[];trackingFlags:BatchTrackingFlag[];batchVehiclePlate:string|null;overseasVehiclePlate:string|null;borderPort:string|null;busy:boolean;manage:boolean}){
  // 各订单的最新里程碑（按 progress 权重排序）
  const milestoneProgressWeight:Record<string,number>={departed:15,border_arrived:28,exported:40,transloaded:46,transit_customs:52,foreign_entered:64,customs_cleared:82,station_arrived:100};
  const milestonesByOrder=new Map<string,BatchTrackingMilestone[]>();
  for(const m of trackingMilestones){
    const list=milestonesByOrder.get(m.order_id)||[];
    list.push(m);
    milestonesByOrder.set(m.order_id,list);
  }
  const latestByOrder=new Map<string,BatchTrackingMilestone|null>();
  for(const order of orders){
    const list=milestonesByOrder.get(order.order_id)||[];
    const latest=list.slice().sort((a,b)=>(milestoneProgressWeight[b.milestone_code]??0)-(milestoneProgressWeight[a.milestone_code]??0)||b.event_at.localeCompare(a.event_at))[0]||null;
    latestByOrder.set(order.order_id,latest);
  }
  const flagsByOrder=new Map(trackingFlags.map(item=>[item.order_id,item]));
  const requiresTransloading=orders.some(o=>flagsByOrder.get(o.order_id)?.requires_transloading===1);
  const requiresTransitCustoms=orders.some(o=>flagsByOrder.get(o.order_id)?.requires_transit_customs===1);
  // 5 个主节点 + 2 个可选节点（按开关状态决定是否暴露）
  const visibleMilestones=BATCH_TRACKING_MILESTONES.filter(item=>!item.optional||(item.code==="transloaded"&&requiresTransloading)||(item.code==="transit_customs"&&requiresTransitCustoms));
  const defaultVehicle=batchVehiclePlate||overseasVehiclePlate||"";
  const defaultEventAt=dateTimeLocal(new Date().toISOString());
  return <section className="panel batch-tracking-workbench" id="batch-tracking">
    <div className="panel-header"><div><h2>4. 运输执行与跟踪</h2><p>在配载单这里登记的运输节点会同步写入本批次所有挂载订单的 <code>order_tracking_milestones</code>，与订单级"运输执行与跟踪"模块共用同一份数据；订单级入口仍保留。</p></div><span className="status-pill">{orders.length} 票 · {trackingMilestones.length} 条节点</span></div>
    <div className="batch-tracking-note"><strong>幂等写入</strong><span>同一订单同一节点同一事件时间只记一次；不同时间会留下多条记录，作为运输过程的多份痕迹。</span><strong>顺序门禁</strong><span>登记新节点前，批次内每票订单必须已有前置节点（如登记"出境"前要求"到达出境口岸"已存在）。</span></div>
    {manage&&<div className="batch-tracking-option-toggles">
      <Form method="post" className="inline-toggle"><input type="hidden" name="intent" value="batch_tracking_option_toggle"/><input type="hidden" name="optionCode" value="transloaded"/><label className="toggle-label"><input type="checkbox" name="enable" defaultChecked={requiresTransloading} onChange={event=>{if(event.target.checked)event.target.form?.requestSubmit();else event.target.form?.requestSubmit();}}/><span>可换装（给本批全部订单打开"换装"可选节点）</span></label><button className="text-button" disabled={busy}>应用</button></Form>
      <Form method="post" className="inline-toggle"><input type="hidden" name="intent" value="batch_tracking_option_toggle"/><input type="hidden" name="optionCode" value="transit_customs"/><label className="toggle-label"><input type="checkbox" name="enable" defaultChecked={requiresTransitCustoms} onChange={event=>{if(event.target.checked)event.target.form?.requestSubmit();else event.target.form?.requestSubmit();}}/><span>可转运（给本批全部订单打开"转关"可选节点）</span></label><button className="text-button" disabled={busy}>应用</button></Form>
    </div>}
    <div className="batch-tracking-card-grid">{visibleMilestones.map(node=>{
      const count=orders.filter(o=>{const list=milestonesByOrder.get(o.order_id)||[];return list.some(m=>m.milestone_code===node.code);}).length;
      const total=orders.length;
      const sample=trackingMilestones.find(m=>m.milestone_code===node.code);
      return <article className={`batch-tracking-card ${count===total?"ready":""} ${count>0&&count<total?"partial":""}`} key={node.code}>
        <header><strong>{node.name}</strong><small>进度 {node.progress}%</small></header>
        <div className="batch-tracking-card-status"><span className={`status-pill ${count===total?"success":""}`}>{count===total?"全票已登记":count>0?`${count}/${total} 票`:"未登记"}</span>{sample&&<small>最近：{formatShortDateTime(sample.event_at)}</small>}</div>
        {manage&&node.code!=="station_arrived"&&<details className="batch-tracking-card-form"><summary>登记节点</summary>
          <Form method="post" className="compact-tool-form batch-tracking-form">
            <input type="hidden" name="intent" value="batch_tracking_add"/>
            <input type="hidden" name="milestoneCode" value={node.code}/>
            <Field name="eventAt" label="事件时间 *" type="datetime-local" required defaultValue={defaultEventAt}/>
            <Field name="location" label="地点" defaultValue={node.code==="border_arrived"?borderPort||"":""}/>
            <Field name="vehicleReference" label="车辆/车牌" defaultValue={defaultVehicle}/>
            <label className="field"><span>备注</span><input name="notes" placeholder="例如换装方式、清关说明"/></label>
            <label className="field"><span>客户可见</span><select name="visibleToCustomer" defaultValue="on"><option value="on">客户可见</option><option value="off">仅内部</option></select></label>
            <button className="primary" disabled={busy}>登记到本批 {total} 票订单</button>
          </Form>
        </details>}
      </article>;
    })}</div>
    <section className="batch-tracking-orders"><header><div><h3>逐票节点状态</h3><p>下面列出本批每票订单的最新里程碑与历史节点；点击订单号可跳转订单的运输执行与跟踪模块。</p></div></header>
      <div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>最新节点</th><th>节点时间</th><th>地点</th><th>车辆</th><th>历史节点</th><th>操作</th></tr></thead><tbody>{orders.map(order=>{
        const latest=latestByOrder.get(order.order_id);
        const list=milestonesByOrder.get(order.order_id)||[];
        return <tr key={order.order_id}>
          <td><Link to={`/admin/orders/${order.order_id}/modules/tracking`}><strong>{order.order_number}</strong></Link><small>{order.customer_name}</small></td>
          <td>{latest?<span className={`status-pill ${milestoneProgressWeight[latest.milestone_code]??0>=100?"success":""}`}>{latest.milestone_name}</span>:<span className="status-pill off">未登记</span>}</td>
          <td>{latest?formatShortDateTime(latest.event_at):"—"}</td>
          <td>{latest?.location||"—"}</td>
          <td>{latest?.vehicle_reference||"—"}</td>
          <td><small className="tracking-history-list">{list.map(m=>`${m.milestone_name} ${formatShortDateTime(m.event_at)}`).join(" · ")||"无"}</small></td>
          <td><Link className="text-button" to={`/admin/orders/${order.order_id}/modules/tracking`}>订单跟踪</Link></td>
        </tr>;
      })}</tbody></table></div>
    </section>
  </section>;
}

function BatchOrderCustomsWorkbench({orderId,declarations,manage,busy}:{orderId:string;declarations:BatchCustomsDeclaration[];manage:boolean;busy:boolean}){
  const active=declarations.filter(item=>item.is_deleted!==1&&item.status!=="cancelled");
  const released=active.filter(item=>item.status==="released").length;
  return <section className="batch-order-customs-workbench">
    <header><div><strong>本票报关与放行</strong><span>在当前配载单内办理，无需跳转订单页面</span></div><span className={`status-pill ${active.length>0&&released===active.length?"success":""}`}>{active.length?`${released}/${active.length} 张放行`:"尚无有效报关单"}</span></header>
    {declarations.length>0&&<div className="batch-customs-list">{declarations.map(declaration=><div className="batch-customs-row" key={declaration.id}>
      <div><strong>{declaration.declaration_number}</strong><small>{customsStageLabel(declaration.clearance_stage)} · {declaration.declaration_type}</small></div>
      <div><span>{declaration.declaration_title}</span><small>{declaration.declaring_company}</small></div>
      <div><span>{declaration.currency} {Number(declaration.declared_amount).toLocaleString()}</span><small>{Number(declaration.gross_weight_kg).toLocaleString()} KG</small></div>
      <span className={`status-pill ${declaration.status==="released"?"success":""}`}>{customsDeclarationStatusLabel(declaration)}</span>
      <div className="batch-customs-actions">
        <Modal title={`查看报关单 · ${declaration.declaration_number}`} triggerLabel="查看" triggerClassName="text-button" size="wide"><BatchCustomsDeclarationView declaration={declaration}/></Modal>
        {manage&&<Modal title={`编辑报关单 · ${declaration.declaration_number}`} triggerLabel="编辑" triggerClassName="text-button" size="wide"><BatchCustomsDeclarationForm orderId={orderId} declaration={declaration} busy={busy}/></Modal>}
        {manage&&declaration.status!=="released"&&declaration.status!=="cancelled"&&declaration.is_deleted!==1&&<Modal title={`确认海关放行 · ${declaration.declaration_number}`} triggerLabel="放行" triggerClassName="text-button"><BatchCustomsReleaseForm orderId={orderId} declaration={declaration} busy={busy}/></Modal>}
      </div>
    </div>)}</div>}
    {!declarations.length&&<p className="empty-state">本票尚未登记报关单。先上传“报关资料”，再新增申报单。</p>}
    {manage&&<Modal title="新增本票报关单" triggerLabel="新增报关单" triggerClassName="secondary" size="wide"><BatchCustomsDeclarationForm orderId={orderId} busy={busy}/></Modal>}
  </section>;
}

function BatchCustomsDeclarationView({declaration}:{declaration:BatchCustomsDeclaration}){
  const flags=[declaration.is_deleted?"删单":"",declaration.is_redeclared?"删单重报":"",declaration.is_amended?"改单":"",declaration.is_inspected?"查验":""].filter(Boolean);
  return <dl className="quote-detail-grid customs-declaration-view">
    <div><dt>作业阶段</dt><dd>{customsStageLabel(declaration.clearance_stage)}</dd></div><div><dt>报关单号</dt><dd>{declaration.declaration_number}</dd></div>
    <div><dt>报关单类型</dt><dd>{declaration.declaration_type}</dd></div><div><dt>状态</dt><dd>{customsDeclarationStatusLabel(declaration)}</dd></div>
    <div><dt>申报抬头</dt><dd>{declaration.declaration_title}</dd></div><div><dt>申报公司</dt><dd>{declaration.declaring_company}</dd></div>
    <div><dt>申报金额</dt><dd>{declaration.currency} {Number(declaration.declared_amount).toLocaleString()}</dd></div><div><dt>申报毛重</dt><dd>{Number(declaration.gross_weight_kg).toLocaleString()} KG</dd></div>
    <div><dt>申报时间</dt><dd>{formatShortDateTime(declaration.declared_at)}</dd></div><div><dt>放行时间</dt><dd>{formatShortDateTime(declaration.released_at)}</dd></div>
    <div><dt>业务标记</dt><dd>{flags.join("、")||"无"}</dd></div><div><dt>变更原因</dt><dd>{declaration.change_reason||"—"}</dd></div>
  </dl>;
}

function BatchCustomsDeclarationForm({orderId,declaration,busy}:{orderId:string;declaration?:BatchCustomsDeclaration;busy:boolean}){
  return <Form method="post" className="form-grid compact customs-declaration-form">
    <input type="hidden" name="intent" value="batch_order_customs_declaration_save"/><input type="hidden" name="orderId" value={orderId}/>
    {declaration&&<><input type="hidden" name="declarationId" value={declaration.id}/><input type="hidden" name="customsRecordId" value={declaration.customs_record_id}/></>}
    <label className="field"><span>报关作业阶段 <b className="required-mark">*</b></span><select name="clearanceStage" defaultValue={declaration?.clearance_stage||"origin"} required><option value="origin">起运地报关</option><option value="transit">过境地报关/清关</option><option value="destination">目的地清关</option></select></label>
    <label className="field"><span>申报单状态 <b className="required-mark">*</b></span><select name="status" defaultValue={declaration?.status==="released"?"released":"declared"} required><option value="declared">已申报，待放行</option><option value="released">已放行</option></select></label>
    <Field name="declarationNumber" label="报关单号 *" required defaultValue={declaration?.declaration_number||""}/><Field name="declarationType" label="报关单类型 *" required defaultValue={declaration?.declaration_type||""}/>
    <Field name="declarationTitle" label="申报抬头 *" required defaultValue={declaration?.declaration_title||""}/><Field name="declaringCompany" label="申报公司 *" required defaultValue={declaration?.declaring_company||""}/>
    <Field name="declaredAt" label="申报时间 *" type="datetime-local" required defaultValue={dateTimeLocal(declaration?.declared_at||new Date().toISOString())}/><Field name="declaredAmount" label="申报金额 *" type="number" required defaultValue={String(declaration?.declared_amount??0)}/>
    <label className="field"><span>申报币种 <b className="required-mark">*</b></span><select name="currency" defaultValue={declaration?.currency||"USD"} required>{["USD","CNY","RUB","KZT","UZS","EUR"].map(item=><option key={item} value={item}>{item}</option>)}</select></label>
    <Field name="grossWeightKg" label="申报毛重 KG *" type="number" required defaultValue={String(declaration?.gross_weight_kg??0)}/>
    <div className="field span-2"><span>删单 / 重报 / 改单 / 查验</span><div className="check-row"><label><input name="isDeleted" type="checkbox" defaultChecked={declaration?.is_deleted===1}/>删单</label><label><input name="isRedeclared" type="checkbox" defaultChecked={declaration?.is_redeclared===1}/>删单重报</label><label><input name="isAmended" type="checkbox" defaultChecked={declaration?.is_amended===1}/>改单</label><label><input name="isInspected" type="checkbox" defaultChecked={declaration?.is_inspected===1}/>查验</label></div></div>
    <label className="field span-2"><span>变更原因</span><textarea name="changeReason" rows={2} defaultValue={declaration?.change_reason||""} placeholder="发生删单、重报、改单或查验时填写"/></label>
    <button className="primary span-2" disabled={busy}>保存报关单并同步本票工作流</button>
  </Form>;
}

function BatchCustomsReleaseForm({orderId,declaration,busy}:{orderId:string;declaration:BatchCustomsDeclaration;busy:boolean}){
  return <Form method="post" className="stack">
    <input type="hidden" name="intent" value="batch_order_customs_declaration_save"/><input type="hidden" name="orderId" value={orderId}/><input type="hidden" name="declarationId" value={declaration.id}/><input type="hidden" name="customsRecordId" value={declaration.customs_record_id}/><input type="hidden" name="clearanceStage" value={declaration.clearance_stage}/><input type="hidden" name="status" value="released"/><input type="hidden" name="declarationNumber" value={declaration.declaration_number}/><input type="hidden" name="declarationType" value={declaration.declaration_type}/><input type="hidden" name="declarationTitle" value={declaration.declaration_title}/><input type="hidden" name="declaringCompany" value={declaration.declaring_company}/><input type="hidden" name="declaredAt" value={dateTimeLocal(declaration.declared_at)}/><input type="hidden" name="declaredAmount" value={declaration.declared_amount}/><input type="hidden" name="currency" value={declaration.currency}/><input type="hidden" name="grossWeightKg" value={declaration.gross_weight_kg}/><input type="hidden" name="changeReason" value={declaration.change_reason||""}/>
    {declaration.is_redeclared===1&&<input type="hidden" name="isRedeclared" value="on"/>}{declaration.is_amended===1&&<input type="hidden" name="isAmended" value="on"/>}{declaration.is_inspected===1&&<input type="hidden" name="isInspected" value="on"/>}
    <BatchCustomsDeclarationView declaration={declaration}/><div className="alert warning">请确认上方报关内容无误且已获得海关放行。确认后将立即重算本票门禁、模块节点和订单主工作流。</div>
    <label className="field"><span>放行时间 <b className="required-mark">*</b></span><input name="releasedAt" type="datetime-local" defaultValue={dateTimeLocal(new Date().toISOString())} required/></label><button className="primary" disabled={busy}>确认放行并同步工作流</button>
  </Form>;
}

function customsStageLabel(stage:string){return stage==="origin"?"起运地报关":stage==="transit"?"过境地报关/清关":"目的地清关"}
function customsDeclarationStatusLabel(declaration:BatchCustomsDeclaration){if(declaration.is_deleted||declaration.status==="cancelled")return"已删单";return declaration.status==="released"?"已放行":"已申报"}

function BatchCommandSteps({status,loadPlanReady,warehouseReady}:{status:string;loadPlanReady:boolean;warehouseReady:boolean}){
  const finished=["overseas_arrived","waiting_pickup","pickup_completed"].includes(status);
  const current=finished?5:status==="outbound_in_transit"?4:status==="loaded_waiting_exit"||warehouseReady?3:loadPlanReady?2:1;
  const steps=[
    {rank:1,title:"生成配载单",body:"挂载同线路订单"},
    {rank:2,title:"仓库装车出库",body:"仓库端按车辆扫码"},
    {rank:3,title:"确认出境",body:"录出境时间和车号"},
    {rank:4,title:"境外仓收货",body:"逐票扫码，齐套后同步"},
  ];
  return <div className="batch-command-steps">{steps.map(step=><div key={step.rank} className={`batch-command-step ${current>step.rank?"done":current===step.rank?"current":""}`}><b>{current>step.rank?"✓":step.rank}</b><strong>{step.title}</strong><span>{step.body}</span></div>)}</div>;
}

function WarehouseOutboundAction({orderId,batchId,customsReady}:{orderId:string;batchId:string;customsReady?:boolean}){
  const returnTo=`/admin/loading/${batchId}?fromOrderId=${encodeURIComponent(orderId)}`;
  const warehouseTo=`/warehouse/outbound?orderId=${encodeURIComponent(orderId)}&returnTo=${encodeURIComponent(returnTo)}`;
  return <div className="loading-warehouse-handoff">
    {customsReady===false&&<div className="alert warning" style={{marginBottom:"0.5rem"}}>⚠️ 本票报关单尚未收齐放行，配载出库前请先到「配载单文件工作台」处理报关资料与报关单。</div>}
    <div><strong>下一步由仓库办理</strong><span>仓库按已确认的配载车辆扫码拣货、装车并完成出库交接。</span></div><Form method="post" action="/switch-site"><input type="hidden" name="target" value="warehouse"/><input type="hidden" name="warehouseTo" value={warehouseTo}/><button className="primary">去仓库端拣货装车</button></Form></div>;
}

function WarehouseOverseasInboundAction({orderId,batchId,warehouseId}:{orderId:string;batchId:string;warehouseId:string}){
  const returnTo=`/admin/loading/${batchId}?fromOrderId=${encodeURIComponent(orderId)}`;
  const warehouseTo=`/warehouse/inbound?warehouseId=${encodeURIComponent(warehouseId)}&orderId=${encodeURIComponent(orderId)}&returnTo=${encodeURIComponent(returnTo)}`;
  return <Form method="post" action="/switch-site"><input type="hidden" name="target" value="warehouse"/><input type="hidden" name="warehouseTo" value={warehouseTo}/><button className="secondary">去目的仓扫码收货</button></Form>;
}

function CostAllocationSection({allocations,busy,manage}:{allocations:Awaited<ReturnType<typeof loadCostAllocations>>;busy:boolean;manage:boolean}){
  return <section className="panel cost-allocation-section"><div className="panel-header"><div><h2>5. 拼车成本分摊</h2><p>按仓库实收重量和体积生成系统建议；人工确认前不入账，确认后只生成内部应付和毛利数据，不会改客户应收。</p></div><span className="status-pill">{allocations.filter(item=>item.status==="draft").length} 个待确认</span></div>
    {manage&&<details className="inline-details"><summary>新增分摊草稿</summary><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="create_cost_allocation"/><label className="field"><span>费用项目</span><select name="chargeCode" required><option value="">请选择</option>{COST_CHARGES.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label><Field name="counterpartyName" label="往来单位 / 供应商" required/><Field name="totalAmount" label="费用总额" type="number" required/><Field name="currency" label="币种" required defaultValue="CNY"/><Field name="exchangeRate" label="折本位币汇率" type="number" required defaultValue="1"/><label className="field"><span>分摊方式</span><select name="method" defaultValue="auto"><option value="auto">系统建议（推荐）</option><option value="weight">按实收重量</option><option value="volume">按实收体积</option><option value="equal">按订单均分</option></select></label><label className="field span-2"><span>费用备注</span><input name="allocationNotes" placeholder="例如口岸换装运费、报关费等"/></label><button className="primary" disabled={busy}>生成分摊草稿</button></Form></details>}
    {!allocations.length&&<p className="empty-state">暂无成本分摊。仓库完成实收后，可在这里生成分摊草稿。</p>}
    <div className="cost-allocation-list">{allocations.map(allocation=><article className="cost-allocation-card" key={allocation.id}><header><div><strong>{allocation.charge_name} · {allocation.currency} {allocation.total_amount.toFixed(2)}</strong><small>{allocation.counterparty_name}</small></div><span className={`status-pill ${allocation.status==="confirmed"?"success":""}`}>{allocation.status==="confirmed"?"已确认入账":"草稿待复核"}</span></header><div className="allocation-summary"><span>方式<strong>{allocationMethodLabel(allocation.allocation_method)}</strong></span><span>实收重量<strong>{allocation.total_actual_weight_kg.toFixed(2)} KG</strong></span><span>实收体积<strong>{allocation.total_actual_volume_cbm.toFixed(3)} CBM</strong></span><span>密度<strong>{allocation.density_kg_per_cbm.toFixed(2)} KG/CBM</strong></span></div><small>{allocation.density_result}{allocation.confirmed_at?` · 确认时间 ${allocation.confirmed_at}`:" · 系统建议可人工调整"}</small>
      {allocation.status==="draft"&&manage?<><Form method="post"><input type="hidden" name="intent" value="update_cost_allocation"/><input type="hidden" name="allocationId" value={allocation.id}/><label className="field allocation-method"><span>复核分摊方式</span><select name="method" defaultValue={allocation.allocation_method}><option value="weight">按实收重量</option><option value="volume">按实收体积</option><option value="equal">按订单均分</option></select></label><div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>实收重量</th><th>实收体积</th><th>建议比例</th><th>建议金额</th><th>最终金额</th><th>调整原因</th></tr></thead><tbody>{allocation.lines.map(line=><tr key={line.id}><td><strong>{line.order_number}</strong><small>{line.customer_name}</small><input type="hidden" name="lineId" value={line.id}/></td><td>{line.actual_weight_kg.toFixed(2)} KG</td><td>{line.actual_volume_cbm.toFixed(3)} CBM</td><td>{(line.suggested_ratio*100).toFixed(2)}%</td><td>{line.suggested_amount.toFixed(2)}</td><td><input className="table-input amount" type="number" min="0" step="0.01" name="lineAmount" defaultValue={line.final_amount.toFixed(2)} required/></td><td><input className="table-input reason" name="lineReason" defaultValue={line.adjustment_reason||""} placeholder="修改金额时必填"/></td></tr>)}</tbody></table></div><button className="secondary" disabled={busy}>保存人工复核结果</button></Form><Form method="post" className="allocation-confirm-form"><input type="hidden" name="intent" value="confirm_cost_allocation"/><input type="hidden" name="allocationId" value={allocation.id}/><p>确认后将生成正式应付费用并进入内部毛利核算；客户应收仍以订单费用模块的应收记录为准。</p><button className="primary" disabled={busy}>确认分摊并生成应付</button></Form></>:<div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>实收重量</th><th>实收体积</th><th>最终分摊</th><th>费用状态</th></tr></thead><tbody>{allocation.lines.map(line=><tr key={line.id}><td><strong>{line.order_number}</strong><small>{line.customer_name}</small></td><td>{line.actual_weight_kg.toFixed(2)} KG</td><td>{line.actual_volume_cbm.toFixed(3)} CBM</td><td>{allocation.currency} {line.final_amount.toFixed(2)}</td><td>{line.expense_id?"已生成应付":"待生成"}</td></tr>)}</tbody></table></div>}
    </article>)}</div>
  </section>
}

const COST_CHARGES=[
  {code:"FREIGHT",name:"运费"},{code:"LOADING",name:"装车费"},{code:"REINFORCEMENT",name:"加固费"},
  {code:"TRANSIT_CUSTOMS",name:"转关费"},{code:"CUSTOMS",name:"报关费"},{code:"INBOUND_WAREHOUSE",name:"入境仓储费"},
];
function summarizeBatch(orders:BatchOrder[],vehicles:Vehicle[]){
  return {
    orderCount:orders.length,
    pieces:orders.reduce((sum,item)=>sum+Number(item.pieces||0),0),
    declaredWeight:orders.reduce((sum,item)=>sum+Number(item.declared_weight_kg||0),0),
    declaredVolume:orders.reduce((sum,item)=>sum+Number(item.declared_volume_cbm||0),0),
    actualWeight:orders.reduce((sum,item)=>sum+Number(item.gross_weight_kg||0),0),
    actualVolume:orders.reduce((sum,item)=>sum+Number(item.volume_cbm||0),0),
    vehicleCount:vehicles.length,
    usedWeight:vehicles.reduce((sum,item)=>sum+Number(item.used_weight||0),0),
    usedVolume:vehicles.reduce((sum,item)=>sum+Number(item.used_volume||0),0),
  };
}
function LoadingTotals({totals}:{totals:ReturnType<typeof summarizeBatch>}){
  return <div className="loading-total-bar">
    <span>笔数：<strong>{totals.orderCount}</strong></span>
    <span>件数：<strong>{totals.pieces}</strong></span>
    <span>报关重量：<strong>{totals.declaredWeight.toFixed(2)}</strong> KG</span>
    <span>报关体积：<strong>{totals.declaredVolume.toFixed(3)}</strong> CBM</span>
    <span>进仓重量：<strong>{totals.actualWeight.toFixed(2)}</strong> KG</span>
    <span>进仓体积：<strong>{totals.actualVolume.toFixed(3)}</strong> CBM</span>
    <span>车辆：<strong>{totals.vehicleCount}</strong></span>
  </div>;
}
function OverseasResourceFields({batch,carrierVehicles,carrierDrivers}:{batch:Batch;carrierVehicles:CarrierVehicleOption[];carrierDrivers:CarrierDriverOption[]}){
  const [vehicleMasterId,setVehicleMasterId]=useState(""),[driverMasterId,setDriverMasterId]=useState("");
  const [vehicleType,setVehicleType]=useState(batch.overseas_vehicle_type||""),[plate,setPlate]=useState(batch.overseas_vehicle_plate||"");
  const [driverName,setDriverName]=useState(batch.overseas_driver_name||""),[driverPhone,setDriverPhone]=useState(batch.overseas_driver_phone||"");
  const [capacityWeight,setCapacityWeight]=useState(""),[capacityVolume,setCapacityVolume]=useState("");
  return <>
    {carrierVehicles.length>0&&<label className="field span-2"><span>承运商车辆库（选择后自动带出车型、车牌和容量）</span><select name="overseasVehicleMasterId" value={vehicleMasterId} onChange={event=>{const id=event.target.value;setVehicleMasterId(id);const master=carrierVehicles.find(item=>item.id===id);if(master){setVehicleType(master.vehicle_type||"");setPlate(master.plate_number);setCapacityWeight(master.capacity_weight_kg?String(master.capacity_weight_kg):"");setCapacityVolume(master.capacity_volume_cbm?String(master.capacity_volume_cbm):"");}}}><option value="">手动录入（不从车辆库选择）</option>{carrierVehicles.map(item=><option key={item.id} value={item.id}>{item.carrier_name} · {item.plate_number}{item.vehicle_type?` · ${item.vehicle_type}`:""}</option>)}</select></label>}
    <label className="field"><span>境外车型 *</span><select name="overseasVehicleType" required value={vehicleType} onChange={event=>setVehicleType(event.target.value)}><option value="">请选择车型</option>{Array.from(new Set([...VEHICLE_TYPE_OPTIONS,vehicleType].filter(Boolean))).map(item=><option key={item} value={item}>{item}</option>)}</select></label>
    <label className="field"><span>境外车牌号 *</span><input name="overseasVehiclePlate" required value={plate} onChange={event=>setPlate(event.target.value)}/></label>
    {carrierDrivers.length>0&&<label className="field span-2"><span>司机库（选择后自动带出姓名与电话）</span><select name="overseasDriverMasterId" value={driverMasterId} onChange={event=>{const id=event.target.value;setDriverMasterId(id);const master=carrierDrivers.find(item=>item.id===id);if(master){setDriverName(master.name);setDriverPhone(master.phone||"");}}}><option value="">手动录入（不从司机库选择）</option>{carrierDrivers.map(item=><option key={item.id} value={item.id}>{item.carrier_name} · {item.name}{item.phone?` · ${item.phone}`:""}</option>)}</select></label>}
    <label className="field"><span>司机姓名 *</span><input name="overseasDriverName" required value={driverName} onChange={event=>setDriverName(event.target.value)}/></label>
    <label className="field"><span>司机电话 *</span><input name="overseasDriverPhone" required value={driverPhone} onChange={event=>setDriverPhone(event.target.value)}/></label>
    <label className="field"><span>载重上限 KG</span><input name="capacityWeight" type="number" min={0} step="0.001" value={capacityWeight} onChange={event=>setCapacityWeight(event.target.value)}/></label>
    <label className="field"><span>体积上限 CBM</span><input name="capacityVolume" type="number" min={0} step="0.001" value={capacityVolume} onChange={event=>setCapacityVolume(event.target.value)}/></label>
  </>;
}

function Field({name,label,required,type="text",defaultValue}:{name:string;label:string;required?:boolean;type?:string;defaultValue?:string}){return <label className="field"><span>{label}</span><input name={name} required={required} type={type} defaultValue={defaultValue} min={type==="number"?0:undefined} step={type==="number"?"0.001":undefined}/></label>}
function Select({name,label,items}:{name:string;label:string;items:[string,string][]}){return <label className="field"><span>{label}</span><select name={name} required><option value="">请选择</option>{items.map(([value,text])=><option key={value} value={value}>{text}</option>)}</select></label>}
function numberOf(form:FormData,name:string){const value=Number(valueOf(form,name)||0);return Number.isFinite(value)&&value>=0?value:0}
function positiveNumberOf(form:FormData,name:string,fallback=0){const value=Number(valueOf(form,name)||fallback);return Number.isFinite(value)&&value>0?value:0}
function errorMessage(error:unknown){return error instanceof Error?error.message:"操作失败，请稍后重试"}
async function synchronizeBatchTransport(organizationId:string,batchId:string,now:string){
  const stats=await env.DB.prepare(`SELECT
      MAX(o.business_type) business_type,
      COUNT(DISTINCT v.id) vehicle_count,
      COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.plate_number),'') IS NOT NULL AND NULLIF(TRIM(v.driver_name),'') IS NOT NULL THEN v.id END) staffed_vehicle_count,
      MAX(CASE
        WHEN o.business_type='ftl'
          AND NULLIF(TRIM(b.overseas_carrier_name),'') IS NOT NULL
          AND NULLIF(TRIM(b.overseas_vehicle_type),'') IS NOT NULL
          AND COALESCE(b.overseas_vehicle_count,0)>0
          AND NULLIF(TRIM(b.overseas_vehicle_plate),'') IS NOT NULL
          AND NULLIF(TRIM(b.overseas_driver_name),'') IS NOT NULL
          AND NULLIF(TRIM(b.overseas_driver_phone),'') IS NOT NULL THEN 1
        WHEN COALESCE(o.business_type,'ltl')!='ftl'
          AND b.carrier_id IS NOT NULL
          AND b.warehouse_id IS NOT NULL
          AND b.border_port IS NOT NULL
          AND b.planned_departure_at IS NOT NULL
          AND b.planned_arrival_at IS NOT NULL THEN 1
        ELSE 0
      END) plan_complete,
      MAX(b.road_status) road_status
    FROM transport_batches b
    JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
    JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
    LEFT JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled'
    WHERE b.organization_id=? AND b.id=?`).bind(organizationId,batchId).first<{business_type:string|null;vehicle_count:number;staffed_vehicle_count:number;plan_complete:number;road_status:string|null}>();
  const orders=await env.DB.prepare(`SELECT bo.order_id,
      COUNT(DISTINCT p.id) package_count,
      COUNT(DISTINCT l.package_id) assigned_count
    FROM transport_batch_orders bo
    LEFT JOIN order_cargo_packages p ON p.order_id=bo.order_id AND p.status!='cancelled'
    LEFT JOIN transport_vehicle_loads l ON l.batch_id=bo.batch_id AND l.package_id=p.id
    WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
    GROUP BY bo.order_id ORDER BY bo.sequence_no`).bind(organizationId,batchId).all<{order_id:string;package_count:number;assigned_count:number}>();
  const isFtlBatch=stats?.business_type==="ftl";
  const batchBaseReady=Boolean(stats?.plan_complete&&stats.vehicle_count&&stats.staffed_vehicle_count===stats.vehicle_count);
  const batchReady=batchBaseReady&&orders.results.length>0&&orders.results.every((order)=>order.package_count>0&&order.assigned_count===order.package_count);
  const batchOutboundCompleted=["loaded_waiting_exit","outbound_in_transit","overseas_arrived","waiting_pickup","pickup_completed"].includes(stats?.road_status??"");
  const batchBlockers=[
    !stats?.plan_complete ? (isFtlBatch?"整车运输单车辆信息未完整":"配载运输单基础信息未完整") : null,
    !stats?.vehicle_count ? (isFtlBatch?"整车运输单尚未生成车辆":"配载运输单尚未添加车辆") : null,
    stats?.vehicle_count&&stats.staffed_vehicle_count!==stats.vehicle_count ? "车辆车牌/司机未完整" : null,
  ].filter(Boolean).join("；");
  const statements=[
    env.DB.prepare(`UPDATE transport_batches
      SET status=CASE
            WHEN road_status IN ('overseas_arrived','waiting_pickup','pickup_completed') THEN 'arrived'
            WHEN road_status='outbound_in_transit' THEN 'departed'
            ELSE ?
          END,
          road_status=CASE
            WHEN road_status IN ('loaded_waiting_exit','outbound_in_transit','overseas_arrived','waiting_pickup','pickup_completed') THEN road_status
            ELSE ?
          END,
          updated_at=?
      WHERE id=? AND organization_id=?`).bind(batchReady?"loading":"planning",batchReady?"preplanned":"waiting_loading",now,batchId,organizationId),
    ...orders.results.map((order)=>{
      const orderReady=batchBaseReady&&order.package_count>0&&order.assigned_count===order.package_count;
      const packageBlocker=!order.package_count?"订单尚未生成可装载包装编号":order.assigned_count!==order.package_count?`装载指令未确认（已分配 ${order.assigned_count}/${order.package_count} 个包装）`:null;
      const blockingReason=[batchBlockers,packageBlocker].filter(Boolean).join("；")||null;
      const currentStepName=batchOutboundCompleted?"装车出库交接完成":orderReady?(isFtlBatch?"整车运输单已安排，待装车出库":"配载运输单已安排，待装车出库"):order.package_count>0&&order.assigned_count===order.package_count?(isFtlBatch?"整车运输单已生成，待完善车辆信息":"配载成单，待完善车辆/批次"):order.assigned_count>0?(isFtlBatch?"整车运输单已生成，待完成装载":"配载成单，待整票分配"):(isFtlBatch?"整车运输单待生成":"配载成单");
      const progress=batchOutboundCompleted?100:orderReady?75:order.package_count>0&&order.assigned_count===order.package_count?70:order.assigned_count>0?65:60;
      return env.DB.prepare(`UPDATE order_module_instances
         SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
             started_at=COALESCE(started_at,?),
             completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,
             blocking_reason=?,updated_at=?
       WHERE organization_id=? AND module_code='loading' AND enabled=1 AND order_id=?`).bind(
        batchOutboundCompleted?"completed":"in_progress",
        batchOutboundCompleted?"confirmed":"planned",
        currentStepName,
        progress,
        now,
        batchOutboundCompleted?"completed":"in_progress",
        now,
        batchOutboundCompleted?null:blockingReason,
        now,
        organizationId,
        order.order_id,
      );
    }),
  ];
  await env.DB.batch(statements);
  await Promise.all(orders.results.map((item)=>syncOrderWorkflowSnapshotSafe(organizationId,item.order_id)));
}
async function synchronizeBatchWarehouseProgress(organizationId:string,batchId:string,actorUserId:string){
  const orders=await env.DB.prepare("SELECT order_id FROM transport_batch_orders WHERE organization_id=? AND batch_id=? AND status!='removed'").bind(organizationId,batchId).all<{order_id:string}>();
  await Promise.all(orders.results.map(async(item)=>{
    const readiness=await checkOrderLoadPlan(organizationId,item.order_id);
    if(readiness.ready){
      await recordWarehouseProgress({
        organizationId,
        orderId:item.order_id,
        actorUserId,
        stepCode:"loading",
        stepName:"按配载批次装车",
        actionCode:"load_plan_ready",
        actionName:"配载车辆与装载指令已完成",
        notes:"批次运输安排、车辆和整票装载指令已满足，仓库可创建装车任务",
      });
    }
  }));
}
async function syncBatchOrderDocumentsStatus(organizationId:string,orderId:string,actorUserId:string,now:string){
  const module=await env.DB.prepare("SELECT id,status,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='documents' AND enabled=1").bind(organizationId,orderId).first<{id:string;status:string;current_step_code:string|null}>();
  if(!module||module.status==="completed"){await syncOrderWorkflowSnapshotSafe(organizationId,orderId);return;}
  const readiness=await env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN review_status NOT IN ('approved','archived') THEN 1 ELSE 0 END) pending FROM order_document_metadata WHERE organization_id=? AND order_id=?`).bind(organizationId,orderId).first<{total:number;pending:number|null}>();
  const completed=(readiness?.total??0)>0&&(readiness?.pending??0)===0;
  const nextStepCode=completed?"archived":"checking",nextStepName=completed?"文件归档":"资料检查";
  await env.DB.batch([
    env.DB.prepare(`UPDATE order_module_instances SET status=?,current_step_code=?,current_step_name=?,progress_percent=CASE WHEN ?='completed' THEN 100 ELSE MAX(progress_percent,25) END,blocking_reason=NULL,started_at=COALESCE(started_at,?),completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,updated_at=? WHERE id=?`).bind(completed?"completed":"in_progress",nextStepCode,nextStepName,completed?"completed":"in_progress",now,completed?"completed":"in_progress",now,now,module.id),
    env.DB.prepare("INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),organizationId,orderId,module.id,completed?"documents_approved":"document_uploaded",completed?"批次工作台审核完成":"批次工作台上传文件",module.current_step_code,nextStepCode,nextStepName,actorUserId,completed?"全部现有文件已审核通过":"文件已上传并进入资料检查",now),
  ]);
  await syncOrderWorkflowSnapshotSafe(organizationId,orderId);
}
function validateDocumentFile(file:File){
  const allowed=new Set(["application/pdf","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","image/jpeg","image/png","image/webp"]);
  if(file.size>maxInlineOrderDocumentBytes)return"当前数据库直存模式下单个文件不能超过1.2MB";
  if(!allowed.has(file.type))return"仅支持 PDF、Word、Excel 和图片文件";
  return null;
}
async function toDataUrl(file:File){
  const bytes=new Uint8Array(await file.arrayBuffer());let binary="";
  for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));
  return `data:${file.type};base64,${btoa(binary)}`;
}
function documentReviewLabel(status:string){return({pending:"待审核",approved:"已通过",rejected:"已退回",archived:"已归档"} as Record<string,string>)[status]||status}
function batchDocumentTypeLabel(code:string){return BATCH_DOCUMENT_TYPES.find(item=>item.code===code)?.name||code}
function dateTimeLocal(value:string|null){return value?value.slice(0,16):""}
function formatShortDateTime(value:string|null){return value?value.slice(0,16).replace("T"," "):"待填写"}
export function meta(){return[{title:"配载批次详情 | International TMS"}]}
