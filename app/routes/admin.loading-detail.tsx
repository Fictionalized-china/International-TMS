import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/admin.loading-detail";
import { OrderNumberLink } from "../components/EntityNumberLink";
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
} from "../lib/batch-tracking.server";
import { Modal } from "../components/Modal";
import {
  createBatchException,
  listBatchExceptionPackages,
  listBatchExceptions,
  listBlockingBatchExceptions,
  progressBatchException,
  resolveBatchException,
  type BatchException,
  type BatchExceptionPackage,
} from "../lib/batch-exceptions.server";
import { broadcastInternalNotification } from "../lib/internal-notifications.server";
import { isActiveExceptionStatus } from "../lib/batch-exception-policy";
import { synchronizeBatchTransport } from "../lib/batch-transport-sync.server";

const CHUNK_SIZE = 800;
const WAREHOUSE_OWNED_BATCH_INTENTS = new Set([
  "arrangement",
  "vehicle",
  "generate_manifest",
  "batch_document_upload",
  "batch_document_review",
  "batch_order_document_upload",
  "batch_order_document_review",
]);

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
type BatchOrder={order_id:string;order_number:string;business_type:string|null;work_number:string;customer_name:string;cargo_description:string|null;cargo_names:string|null;pieces:number;gross_weight_kg:number;volume_cbm:number;declared_weight_kg:number;declared_volume_cbm:number;inbound_at:string|null;dispatched_packages:number;in_stock_packages:number;overseas_warehouse_id:string|null;overseas_warehouse_name:string|null;overseas_status:string|null;overseas_arrival_at:string|null};
type Vehicle={id:string;vehicle_no:string;vehicle_type:string|null;plate_number:string|null;driver_name:string|null;driver_phone:string|null;capacity_weight_kg:number;capacity_volume_cbm:number;used_weight:number;used_volume:number;loaded_orders:number;status:string};
type Option={id:string;name:string};
type ReferenceOption={code:string;name:string};
type BatchDocument={id:string;document_category:string;file_name:string;content_type:string;size_bytes:number;description:string|null;review_status:string;created_at:string};
type OrderDocument={id:string;order_id:string;document_category:string;file_name:string;content_type:string;size_bytes:number;description:string|null;review_status:string;created_at:string};
type CustomsSummary={order_id:string;total:number;released:number};
type BatchCustomsDeclaration={id:string;order_id:string;customs_record_id:string;clearance_stage:string;declaration_number:string;declaration_type:string;declaration_title:string;declaring_company:string;declared_at:string;declared_amount:number;currency:string;gross_weight_kg:number;released_at:string|null;status:string;is_deleted:number;is_redeclared:number;is_amended:number;is_inspected:number;change_reason:string|null;updated_at:string};
type BatchOutboundStatus={order_id:string;dispatched:number};
type DepartureGateStatus={order_id:string;ready:boolean;reasons:string[]};
type BatchTrackingMilestone={id:string;order_id:string;milestone_code:string;milestone_name:string;event_at:string;location:string|null;vehicle_reference:string|null;notes:string|null;visible_to_customer:number;created_at:string};
type BatchTrackingFlag={order_id:string;requires_transloading:number;requires_transit_customs:number};
type CarrierVehicleOption={id:string;carrier_id:string;plate_number:string;vehicle_type:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null;carrier_name:string};
type CarrierDriverOption={id:string;carrier_id:string;name:string;phone:string|null;carrier_name:string};
type ManifestOrderRow={order_id:string;order_number:string;work_number:string;customer_name:string;cargo_names:string|null;pieces:number;gross_weight_kg:number;volume_cbm:number};
type ManifestVehicleRow={vehicle_no:string;vehicle_type:string|null;plate_number:string|null;driver_name:string|null;driver_phone:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null};
type ManifestBatchRow={batch_number:string;batch_name:string;origin_location:string;destination_location:string;planned_departure_at:string|null;planned_arrival_at:string|null;border_port:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null;carrier_name:string|null};

function escapeHtml(value: string | null | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
}

function buildLoadingManifestHtml(batch: ManifestBatchRow, orders: ManifestOrderRow[], vehicles: ManifestVehicleRow[], generatedAt: string) {
  const totalPieces = orders.reduce((sum, item) => sum + item.pieces, 0);
  const totalWeight = orders.reduce((sum, item) => sum + item.gross_weight_kg, 0);
  const totalVolume = orders.reduce((sum, item) => sum + item.volume_cbm, 0);
  const rows = orders.map((item) => `<tr><td>${escapeHtml(item.order_number)}</td><td>${escapeHtml(item.work_number)}</td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.cargo_names || "未填写")}</td><td class="num">${item.pieces}</td><td class="num">${item.gross_weight_kg.toFixed(2)}</td><td class="num">${item.volume_cbm.toFixed(3)}</td><td>${escapeHtml(batch.overseas_vehicle_plate || "待安排")}</td></tr>`).join("");
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
  {code:"loading_manifest",name:"配载单",hint:"仓库生成 PZ 配载单时自动形成，只读留档，不参与审核或出境门禁",required:false},
  {code:"vehicle_manifest",name:"装车清单",hint:"仓库按 PZ 配载订单、车辆和司机自动生成并同步",required:false},
  {code:"batch_waybill",name:"批次运单",hint:"仓库按 PZ 配载单运输资源自动生成并同步",required:false},
  {code:"border_handover",name:"口岸交接文件",hint:"口岸换装、过境或交接凭证",required:false},
  {code:"transshipment_order",name:"换装单",hint:"发生换装时上传的批次共用凭证",required:false},
] as const;
const ORDER_BATCH_DOCUMENT_CODES=["consignment_letter","commercial_invoice","packing_list","customs_document","customs_declaration_file"] as const;
const BATCH_WORKSPACE_TAB_CODES=["batch","documents","outbound","tracking","overseas","exceptions"] as const;
type BatchWorkspaceTab=(typeof BATCH_WORKSPACE_TAB_CODES)[number];

function isBatchWorkspaceTab(value:string|null):value is BatchWorkspaceTab{
  return BATCH_WORKSPACE_TAB_CODES.includes(value as BatchWorkspaceTab);
}

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
  const [orders,vehicles,carriers,warehouses,borderPorts,costAllocations,batchDocuments,orderDocuments,customsSummaries,customsDeclarations,batchExceptions,exceptionPackages]=await Promise.all([
    env.DB.prepare(`SELECT bo.order_id,o.order_number,o.business_type,COALESCE((SELECT s.shipment_number FROM shipments s WHERE s.order_id=o.id ORDER BY s.created_at DESC LIMIT 1),o.order_number) work_number,c.name customer_name,o.cargo_description,
        COALESCE((SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.order_id=o.id AND i.organization_id=o.organization_id),o.cargo_description) cargo_names,
        COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.pieces) pieces,
        COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg) gross_weight_kg,
        COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm) volume_cbm,
        o.gross_weight_kg declared_weight_kg,o.volume_cbm declared_volume_cbm,
        (SELECT MIN(r.received_at) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed') inbound_at,
        (SELECT COUNT(*) FROM warehouse_packages wp JOIN shipments s2 ON s2.id=wp.shipment_id WHERE s2.order_id=o.id AND wp.status='dispatched') dispatched_packages,
        (SELECT COUNT(*) FROM warehouse_packages wp JOIN shipments s2 ON s2.id=wp.shipment_id WHERE s2.order_id=o.id AND wp.status IN ('in_stock','allocated')) in_stock_packages,
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
      FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id JOIN customers c ON c.id=o.customer_id LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id LEFT JOIN overseas_warehouse_operations op ON op.batch_id=bo.batch_id AND op.order_id=bo.order_id AND op.organization_id=bo.organization_id
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
    env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND status='active' AND carrier_scope='overseas' ORDER BY name").bind(current.organizationId).all<Option>(),
    env.DB.prepare("SELECT id,name FROM warehouses WHERE organization_id=? AND status='active' AND warehouse_role IN ('domestic_collection','port') ORDER BY CASE warehouse_role WHEN 'domestic_collection' THEN 10 ELSE 20 END,code,name").bind(current.organizationId).all<Option>(),
    env.DB.prepare("SELECT code,name FROM reference_data WHERE organization_id=? AND category='border_port' AND status='active' ORDER BY sort_order,code").bind(current.organizationId).all<ReferenceOption>(),
    loadCostAllocations(env.DB,current.organizationId,batchId),
    env.DB.prepare(`WITH ranked AS (
      SELECT id,document_category,file_name,content_type,size_bytes,description,review_status,created_at,
        ROW_NUMBER() OVER(PARTITION BY document_category ORDER BY created_at DESC,id DESC) row_no
      FROM transport_batch_documents WHERE organization_id=? AND batch_id=?
    ) SELECT id,document_category,file_name,content_type,size_bytes,description,review_status,created_at
      FROM ranked WHERE row_no=1 ORDER BY created_at DESC`).bind(current.organizationId,batchId).all<BatchDocument>(),
    env.DB.prepare(`WITH ranked AS (
      SELECT a.id,a.order_id,m.document_category,a.file_name,a.content_type,a.size_bytes,m.description,m.review_status,a.created_at,
        ROW_NUMBER() OVER(PARTITION BY a.order_id,m.document_category ORDER BY a.created_at DESC,a.id DESC) row_no
      FROM transport_batch_orders bo JOIN order_attachments a ON a.order_id=bo.order_id AND a.organization_id=bo.organization_id
      JOIN order_document_metadata m ON m.attachment_id=a.id AND m.order_id=bo.order_id AND m.organization_id=bo.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
    ) SELECT id,order_id,document_category,file_name,content_type,size_bytes,description,review_status,created_at
      FROM ranked WHERE row_no=1 ORDER BY created_at DESC`).bind(batchId,current.organizationId).all<OrderDocument>(),
    env.DB.prepare(`SELECT bo.order_id,COUNT(d.id) total,COALESCE(SUM(CASE WHEN d.status='released' THEN 1 ELSE 0 END),0) released
      FROM transport_batch_orders bo
      LEFT JOIN order_customs_records r ON r.order_id=bo.order_id AND r.organization_id=bo.organization_id AND r.clearance_stage='origin'
      LEFT JOIN order_customs_declarations d ON d.customs_record_id=r.id AND d.order_id=bo.order_id AND d.organization_id=bo.organization_id AND d.is_deleted=0 AND d.status!='cancelled'
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' GROUP BY bo.order_id`).bind(batchId,current.organizationId).all<CustomsSummary>(),
    env.DB.prepare(`SELECT d.id,d.order_id,d.customs_record_id,r.clearance_stage,d.declaration_number,d.declaration_type,d.declaration_title,d.declaring_company,d.declared_at,d.declared_amount,d.currency,d.gross_weight_kg,d.released_at,d.status,d.is_deleted,d.is_redeclared,d.is_amended,d.is_inspected,d.change_reason,d.updated_at
      FROM transport_batch_orders bo
      JOIN order_customs_declarations d ON d.order_id=bo.order_id AND d.organization_id=bo.organization_id
      JOIN order_customs_records r ON r.id=d.customs_record_id AND r.organization_id=d.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
      ORDER BY bo.sequence_no,r.clearance_stage,d.created_at DESC`).bind(batchId,current.organizationId).all<BatchCustomsDeclaration>(),
    listBatchExceptions(current.organizationId,batchId),
    listBatchExceptionPackages(current.organizationId,batchId),
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
        WHERE d.organization_id=bo.organization_id AND d.transport_batch_id=bo.batch_id AND s.order_id=bo.order_id AND d.status='dispatched'
      ) THEN 1 ELSE 0 END dispatched
    FROM transport_batch_orders bo
    WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
    ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<BatchOutboundStatus>();
  const departureGateStatuses:DepartureGateStatus[]=await Promise.all(orders.results.map(async item=>({
    order_id:item.order_id,
    ...await checkOrderDeparture(current.organizationId,item.order_id,undefined,{warehouseDispatchConfirmed:true}),
  })));
  const batchOrderIds=orders.results.map((item)=>item.order_id);
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
      WHERE v.organization_id=? AND v.status='active' AND c.status='active' AND c.carrier_scope='overseas'
      ORDER BY c.name,v.plate_number`).bind(current.organizationId).all<CarrierVehicleOption>(),
    env.DB.prepare(`SELECT d.id,d.carrier_id,d.name,d.phone,c.name carrier_name
      FROM carrier_drivers d JOIN carriers c ON c.id=d.carrier_id
      WHERE d.organization_id=? AND d.status='active' AND c.status='active' AND c.carrier_scope='overseas'
      ORDER BY c.name,d.name`).bind(current.organizationId).all<CarrierDriverOption>(),
  ]);
  return{current,batch,orders:orders.results,vehicles:vehicles.results,carriers:carriers.results,warehouses:warehouses.results,borderPorts:borderPorts.results,costAllocations,batchDocuments:batchDocuments.results,orderDocuments:orderDocuments.results,customsSummaries:customsSummaries.results,customsDeclarations:customsDeclarations.results,batchExceptions,exceptionPackages,outboundStatuses:outboundStatuses.results,departureGateStatuses,returnOrderId,trackingMilestones,trackingFlags:trackingFlags.results,batchVehiclePlate,carrierVehicles:carrierVehicles.results,carrierDrivers:carrierDrivers.results};
}

export async function action({request,params}:Route.ActionArgs){
  const current=await requireSessionUser(request,"order.view"),batchId=params.batchId,form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  const customsIntent=intent==="batch_order_customs_declaration_save";
  const exceptionIntent=["batch_exception_create","batch_exception_progress","batch_exception_resolve"].includes(intent);
  const allowed=customsIntent
    ? canManageOrderModule(current,"customs")
    : exceptionIntent
      ? canManageOrderModule(current,"loading")||canManageOrderModule(current,"exceptions")
      : canManageOrderModule(current,"loading");
  if(!allowed)throw new Response(customsIntent?"无权办理报关作业":exceptionIntent?"无权办理配载异常":"无权办理拼车配载",{status:403});
  const batch=await env.DB.prepare("SELECT id,batch_number,status,road_status,border_port,customs_location,route_notes,warehouse_id,overseas_carrier_name,overseas_vehicle_type,overseas_vehicle_count,overseas_vehicle_plate,overseas_driver_name,overseas_driver_phone FROM transport_batches WHERE id=? AND organization_id=? AND status!='cancelled'").bind(batchId,current.organizationId).first<{id:string;batch_number:string;status:string;road_status:string;border_port:string|null;customs_location:string|null;route_notes:string|null;warehouse_id:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null}>();
  if(!batch)return{formError:"配载批次无效"};
  if(intent==="batch_exception_create"){
    try{
      const created=await createBatchException({
        organizationId:current.organizationId,
        batchId,
        scope:valueOf(form,"exceptionScope"),
        orderId:valueOf(form,"orderId")||null,
        packageId:valueOf(form,"packageId")||null,
        exceptionType:valueOf(form,"exceptionType"),
        severity:valueOf(form,"severity"),
        blocksProgress:form.get("blocksProgress")==="on",
        description:valueOf(form,"description"),
        actorUserId:current.userId,
        now,
      });
      await writeAudit({request,action:"transport.batch.exception.create",resourceType:"transport_batch_exception",resourceId:created.id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,exceptionNumber:created.exceptionNumber,scope:created.scope,orderId:created.orderId,packageId:created.packageId,severity:created.severity,blocksProgress:created.blocksProgress,affectedOrders:created.affectedOrderIds.length}});
      await broadcastInternalNotification({
        organizationId:current.organizationId,
        actorUserId:current.userId,
        category:"transport_batch_exception_created",
        severity:created.severity==="critical"||created.severity==="high"?"critical":"warning",
        title:`配载单异常：${created.exceptionNumber}`,
        message:`${batch.batch_number} 新增${batchExceptionScopeLabel(created.scope)}异常：${created.description}${created.blocksProgress?"；异常关闭前阻断整批推进":"；仅提醒，不阻断推进"}。`,
        link:`/admin/loading/${encodeURIComponent(batchId)}?tab=exceptions`,
        requiresLeadershipAck:created.blocksProgress,
      });
      return{success:`异常 ${created.exceptionNumber} 已登记并同步 ${created.affectedOrderIds.length} 票订单${created.blocksProgress?"；当前会阻断整批推进":""}`};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="batch_exception_progress"){
    try{
      await progressBatchException({organizationId:current.organizationId,batchId,exceptionId:valueOf(form,"exceptionId"),actorUserId:current.userId,now});
      await writeAudit({request,action:"transport.batch.exception.progress",resourceType:"transport_batch_exception",resourceId:valueOf(form,"exceptionId"),organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId}});
      return{success:"异常已进入处理中"};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="batch_exception_resolve"){
    const exceptionId=valueOf(form,"exceptionId");
    const target=await env.DB.prepare("SELECT exception_number FROM transport_batch_exceptions WHERE id=? AND organization_id=? AND batch_id=?").bind(exceptionId,current.organizationId,batchId).first<{exception_number:string}>();
    try{
      const resolved=await resolveBatchException({organizationId:current.organizationId,batchId,exceptionId,actorUserId:current.userId,resolution:valueOf(form,"resolution"),now});
      await writeAudit({request,action:"transport.batch.exception.resolve",resourceType:"transport_batch_exception",resourceId:exceptionId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,exceptionNumber:target?.exception_number,resolution:resolved.resolution,affectedOrders:resolved.affectedOrderIds.length}});
      await broadcastInternalNotification({organizationId:current.organizationId,actorUserId:current.userId,category:"transport_batch_exception_resolved",severity:"info",title:`配载异常已关闭：${target?.exception_number||"异常"}`,message:`${batch.batch_number} 的异常已处理：${resolved.resolution}。相关订单异常状态已重新计算，历史流程不回退。`,link:`/admin/loading/${encodeURIComponent(batchId)}?tab=exceptions`});
      return{success:`${target?.exception_number||"异常"} 已结案；${resolved.affectedOrderIds.length} 票订单状态已重新计算`};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(WAREHOUSE_OWNED_BATCH_INTENTS.has(intent))return{formError:"该数据由仓库端配载单维护，管理后台仅同步查看"};
  if(["batch_tracking_option_toggle","batch_tracking_add"].includes(intent)){
    const dispatchGate=await env.DB.prepare(`SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN EXISTS(
        SELECT 1 FROM warehouse_dispatches d
        JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
        JOIN warehouse_packages p ON p.id=di.package_id
        JOIN shipments s ON s.id=p.shipment_id
        WHERE d.organization_id=bo.organization_id AND s.order_id=bo.order_id AND d.status='dispatched'
      ) THEN 1 ELSE 0 END),0) dispatched
      FROM transport_batch_orders bo WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'`).bind(batchId,current.organizationId).first<{total:number;dispatched:number}>();
    if(!dispatchGate?.total||dispatchGate.dispatched!==dispatchGate.total)return{formError:"仓库端尚未完成整批装车出库，运输执行与跟踪暂不可登记"};
  }
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
          COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm) volume_cbm
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
    const carrier=await env.DB.prepare("SELECT id,name FROM carriers WHERE id=? AND organization_id=? AND status='active' AND carrier_scope='overseas'").bind(carrierId,current.organizationId).first<{id:string;name:string}>();
    if(!carrier)return{formError:"承运商无效"};
    overseasCarrierName=carrier.name;
    if(!overseasVehicleMasterId||!overseasDriverMasterId)return{formError:"请选择当前境外承运商名下的车辆和司机"};
    const vehicleMaster=await env.DB.prepare("SELECT carrier_id,plate_number,vehicle_type,capacity_weight_kg,capacity_volume_cbm FROM carrier_vehicles WHERE id=? AND organization_id=? AND status='active'").bind(overseasVehicleMasterId,current.organizationId).first<{carrier_id:string;plate_number:string;vehicle_type:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null}>();
    if(!vehicleMaster||vehicleMaster.carrier_id!==carrierId)return{formError:"所选车辆不属于当前境外承运商或已停用"};
    const driverMaster=await env.DB.prepare("SELECT carrier_id,name,phone FROM carrier_drivers WHERE id=? AND organization_id=? AND status='active'").bind(overseasDriverMasterId,current.organizationId).first<{carrier_id:string;name:string;phone:string|null}>();
    if(!driverMaster||driverMaster.carrier_id!==carrierId)return{formError:"所选司机不属于当前境外承运商或已停用"};
    overseasVehicleType=vehicleMaster.vehicle_type||"";
    overseasVehiclePlate=vehicleMaster.plate_number;
    capacityWeight=vehicleMaster.capacity_weight_kg||0;
    capacityVolume=vehicleMaster.capacity_volume_cbm||0;
    overseasDriverName=driverMaster.name;
    overseasDriverPhone=driverMaster.phone||"";
    const overseasVehicleCount=1;
    overseasVehiclePlate=overseasVehiclePlate.toUpperCase();
    if(!batch.border_port||!batch.customs_location||!batch.warehouse_id)return{formError:"配载准备不完整，请返回订单补齐装车仓、出境口岸和清关地"};
    if(!carrierId||!borderPort||!plannedDeparture||!plannedArrival)return{formError:"请先确定承运商、出境口岸、计划发车和计划到达时间"};
    if(!overseasCarrierName||!overseasVehicleType||!overseasVehiclePlate||!overseasDriverName||!overseasDriverPhone)return{formError:"请完整填写境外承运方、车型、车辆数、车牌号、司机姓名和电话（可从承运商车辆库 / 司机库下拉选择自动带出）"};
    if(warehouseId&&!(await env.DB.prepare("SELECT 1 FROM warehouses WHERE id=? AND organization_id=? AND status='active' AND warehouse_role IN ('domestic_collection','port')").bind(warehouseId,current.organizationId).first()))return{formError:"集货仓库无效，只能选择国内集货仓或口岸仓"};
    if(!(await env.DB.prepare("SELECT 1 FROM reference_data WHERE organization_id=? AND category='border_port' AND code=? AND status='active'").bind(current.organizationId,borderPort).first()))return{formError:"出境口岸无效"};
    const existingVehicle=await env.DB.prepare("SELECT id FROM transport_batch_vehicles WHERE batch_id=? AND organization_id=? AND status!='cancelled' ORDER BY created_at LIMIT 1").bind(batchId,current.organizationId).first<{id:string}>();
    const primaryVehicleId=existingVehicle?.id||crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE transport_batches SET carrier_id=?,warehouse_id=COALESCE(?,warehouse_id),planned_departure_at=?,planned_arrival_at=?,notes=?,overseas_carrier_name=?,overseas_vehicle_type=?,overseas_vehicle_count=?,overseas_vehicle_plate=?,overseas_driver_name=?,overseas_driver_phone=?,updated_at=? WHERE id=? AND organization_id=?").bind(carrierId,warehouseId||null,plannedDeparture,plannedArrival,valueOf(form,"notes")||null,overseasCarrierName,overseasVehicleType,overseasVehicleCount,overseasVehiclePlate,overseasDriverName,overseasDriverPhone,now,batchId,current.organizationId),
      existingVehicle
        ? env.DB.prepare("UPDATE transport_batch_vehicles SET carrier_id=?,vehicle_master_id=?,driver_master_id=?,vehicle_type=?,plate_number=?,driver_name=?,driver_phone=?,capacity_weight_kg=?,capacity_volume_cbm=?,status='planned',updated_at=? WHERE id=? AND organization_id=?").bind(carrierId,overseasVehicleMasterId,overseasDriverMasterId,overseasVehicleType,overseasVehiclePlate,overseasDriverName,overseasDriverPhone,capacityWeight,capacityVolume,now,existingVehicle.id,current.organizationId)
        : env.DB.prepare("INSERT INTO transport_batch_vehicles(id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,carrier_id,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at,vehicle_master_id,driver_master_id) VALUES(?,?,?,'MAIN-1',?,?,?,?,?,?,?,'planned',?,?,?,?)").bind(primaryVehicleId,current.organizationId,batchId,overseasVehicleType,overseasVehiclePlate,carrierId,overseasDriverName,overseasDriverPhone,capacityWeight,capacityVolume,now,now,overseasVehicleMasterId,overseasDriverMasterId),
      env.DB.prepare("UPDATE transport_batch_vehicles SET status='cancelled',updated_at=? WHERE organization_id=? AND batch_id=? AND id!=? AND status!='cancelled'").bind(now,current.organizationId,batchId,primaryVehicleId),
      env.DB.prepare("UPDATE transport_vehicle_loads SET vehicle_id=? WHERE organization_id=? AND batch_id=? AND vehicle_id!=?").bind(primaryVehicleId,current.organizationId,batchId,primaryVehicleId),
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
  if(intent==="exit_confirm"){
    const actualExitAt=valueOf(form,"actualExitAt"),exitPort=valueOf(form,"exitPort"),exitVehiclePlate=valueOf(form,"exitVehiclePlate").trim().toUpperCase();
    const overseasVehiclePlate=(batch.overseas_vehicle_plate||"").trim().toUpperCase(),overseasCarrierName=batch.overseas_carrier_name||"",overseasVehicleType=batch.overseas_vehicle_type||"",overseasDriverName=batch.overseas_driver_name||"",overseasDriverPhone=batch.overseas_driver_phone||"";
    if(!actualExitAt||!exitPort||!exitVehiclePlate)return{formError:"请填写实际出境时间、出境口岸和出境车辆车牌"};
    if(!overseasCarrierName||!overseasVehicleType||!overseasVehiclePlate||!overseasDriverName||!overseasDriverPhone)return{formError:"仓库端尚未同步完整的境外承运方、车辆和司机信息"};
    if(batch.road_status==="outbound_in_transit")return{formError:"该批次已经完成出境确认，请勿重复操作"};
    const blockingExceptions=await listBlockingBatchExceptions(current.organizationId,batchId);
    if(blockingExceptions.length)return{formError:`暂不能确认出境：仍有 ${blockingExceptions.length} 个阻断异常（${blockingExceptions.slice(0,3).map(item=>item.exception_number).join("、")}）`};
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
       LEFT JOIN order_customs_records r ON r.order_id=bo.order_id AND r.organization_id=bo.organization_id AND r.clearance_stage='origin'
       LEFT JOIN order_customs_declarations d ON d.customs_record_id=r.id AND d.order_id=bo.order_id AND d.organization_id=bo.organization_id AND d.is_deleted=0 AND d.status!='cancelled'
       WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
       GROUP BY bo.order_id`,
    ).bind(batchId,current.organizationId).all<{ order_id: string; customs_enabled: number; total: number; released: number }>();
    const customsStatusByOrder = new Map(
      batchCustomsStatus.results.map((item) => [item.order_id, item]),
    );
    for(const item of orders.results){
      const customsStatus=customsStatusByOrder.get(item.order_id)??{customs_enabled:0,total:0,released:0};
      if(customsStatus.customs_enabled===1 && customsStatus.total===0){
        blockers.push(`订单${item.order_number}尚未录入有效报关单`);
      }
      if(customsStatus.customs_enabled===1 && customsStatus.released!==customsStatus.total){
        blockers.push(`订单${item.order_number}的起运地报关尚未全部放行（${customsStatus.released}/${customsStatus.total}）`);
      }
      const dispatched=await env.DB.prepare(`SELECT 1 FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id WHERE d.organization_id=? AND d.transport_batch_id=? AND s.order_id=? AND d.status='dispatched' LIMIT 1`).bind(current.organizationId,batchId,item.order_id).first();
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
    const blockingExceptions=await listBlockingBatchExceptions(current.organizationId,batchId);
    if(blockingExceptions.length){
      const sample=blockingExceptions.slice(0,3).map(item=>item.exception_number).join("、");
      return{formError:`存在 ${blockingExceptions.length} 项阻断推进的配载异常（${sample}），请先在“异常处理”中结案`};
    }
    if(milestoneCode==="exported")return{formError:"请切换到“装车出库与出境确认”，填写实际出境时间并确认；系统会自动登记出境节点"};
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
  const [searchParams]=useSearchParams();
  const busy=useNavigation().state!=="idle",manage=canManageOrderModule(loaderData.current,"loading"),manageCustoms=canManageOrderModule(loaderData.current,"customs");
  const totals=summarizeBatch(loaderData.orders,loaderData.vehicles);
  const planReady=Boolean(loaderData.batch.carrier_id&&loaderData.batch.border_port&&loaderData.batch.planned_departure_at);
  const loadPlanReady=planReady&&loaderData.vehicles.length>0;
  const flagsByOrder=new Map(loaderData.trackingFlags.map(item=>[item.order_id,item]));
  const requiresTransloading=loaderData.orders.some(o=>flagsByOrder.get(o.order_id)?.requires_transloading===1);
  const dispatchedCount=loaderData.outboundStatuses.filter(item=>item.dispatched===1).length;
  const allDispatched=loaderData.orders.length>0&&dispatchedCount===loaderData.orders.length;
  const pendingDispatchOrders=loaderData.orders.filter(order=>!loaderData.outboundStatuses.find(item=>item.order_id===order.order_id)?.dispatched);
  // 报关就绪：报关资料文件已审核 AND 报关单已放行
  const customsReadyForOrder=(orderId:string)=>{
    const customs=loaderData.customsSummaries.find(item=>item.order_id===orderId);
    const customsDeclReady=Boolean(customs&&customs.total>0&&customs.released===customs.total);
    const files=loaderData.orderDocuments.filter(item=>item.order_id===orderId);
    const customsFilesApproved=["customs_document","customs_declaration_file"].every(code=>files.some(item=>item.document_category===code&&["approved","archived"].includes(item.review_status)));
    return customsDeclReady&&customsFilesApproved;
  };
  const allCustomsReady=loaderData.orders.length>0&&loaderData.orders.every(order=>customsReadyForOrder(order.order_id));
  const activeExceptions=loaderData.batchExceptions.filter(item=>isActiveExceptionStatus(item.status));
  const blockingExceptions=activeExceptions.filter(item=>item.blocks_progress===1);
  const exited=["outbound_in_transit","overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status);
  const arrived=["overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status);
  const defaultActiveTab:BatchWorkspaceTab=activeExceptions.length?"exceptions":arrived?"overseas":exited?"tracking":allDispatched&&!allCustomsReady?"documents":allDispatched?"outbound":"batch";
  const requestedTab=searchParams.get("tab");
  const activeTab:BatchWorkspaceTab=isBatchWorkspaceTab(requestedTab)?requestedTab:defaultActiveTab;
  const tabHref=(tab:BatchWorkspaceTab)=>{const next=new URLSearchParams(searchParams);next.set("tab",tab);return `?${next.toString()}`};
  const orderDepartureReady=loaderData.departureGateStatuses.every(item=>item.ready);
  const transportResourceReady=Boolean(loaderData.batch.overseas_carrier_name&&loaderData.batch.overseas_vehicle_type&&loaderData.batch.overseas_vehicle_count>0&&loaderData.batch.overseas_vehicle_plate&&loaderData.batch.overseas_driver_name&&loaderData.batch.overseas_driver_phone);
  const canConfirmExit=allDispatched&&orderDepartureReady&&transportResourceReady&&!blockingExceptions.length;
  const exitBlockers=[
    ...pendingDispatchOrders.map(order=>`${order.order_number}：仓库装车出库交接未完成`),
    ...(!transportResourceReady?["境外承运方、车型、车牌、司机姓名或司机电话尚未补齐"]:[]),
    ...blockingExceptions.map(item=>`${item.exception_number}：${item.description}`),
    ...loaderData.departureGateStatuses.flatMap(item=>item.reasons.map(reason=>`${loaderData.orders.find(order=>order.order_id===item.order_id)?.order_number||"订单"}：${reason}`)),
  ];
  return <><header className="page-header batch-tracking-page-header"><div><p className="eyebrow">PZ LOAD · TRANSPORT TRACKING</p><h1>{loaderData.batch.batch_number}</h1><p>{loaderData.batch.batch_name} · {loaderData.batch.origin_location} → {loaderData.batch.destination_location}</p></div><div className="page-actions">{loaderData.returnOrderId&&<Link className="secondary" to={`/admin/orders/${loaderData.returnOrderId}`}>返回订单详情</Link>}<Link className="secondary" to="/admin/loading">返回配载单跟踪</Link><span className="status-pill">{allDispatched?"后台运输跟踪":"等待仓库出库"}</span><span className="status-pill">{roadStatusLabels[loaderData.batch.road_status]||loaderData.batch.road_status}</span></div></header><ActionToast signal={actionData} message={actionData?.formError??actionData?.success} tone={actionData?.formError?"error":"success"}/>
  <section className="panel batch-command-panel">
    <div className="panel-header"><div><h2>配载单执行总览</h2><p>仓库端负责配载、文件确认、车辆司机安排和装车出库；整批出库后，本页才开放运输执行与跟踪。</p></div><span className="status-pill">{roadStatusLabels[loaderData.batch.road_status]||loaderData.batch.road_status}</span></div>
    <BatchWorkspaceTabs status={loaderData.batch.road_status} customsReady={allCustomsReady} loadPlanReady={loadPlanReady} warehouseReady={allDispatched} exceptionCount={activeExceptions.length} activeTab={activeTab} tabHref={tabHref}/>
  </section>
  {activeTab==="tracking"&&<BatchTrackingWorkbench batchId={loaderData.batch.id} batchNumber={loaderData.batch.batch_number} orders={loaderData.orders} trackingMilestones={loaderData.trackingMilestones} trackingFlags={loaderData.trackingFlags} batchVehiclePlate={loaderData.batchVehiclePlate} overseasVehiclePlate={loaderData.batch.overseas_vehicle_plate||null} borderPort={loaderData.batch.border_port||null} customsLocation={loaderData.batch.customs_location||null} busy={busy} manage={manage&&allDispatched} warehouseReady={allDispatched} exitConfirmed={exited} exitGateHref={tabHref("outbound")} actionCloseSignal={actionData?.success?actionData:undefined}/>}
  {activeTab==="documents"&&<BatchDocumentWorkbench batchId={loaderData.batch.id} orders={loaderData.orders} batchDocuments={loaderData.batchDocuments} orderDocuments={loaderData.orderDocuments} customsSummaries={loaderData.customsSummaries} customsDeclarations={loaderData.customsDeclarations} busy={busy} manageCustoms={manageCustoms} requiresTransloading={requiresTransloading} ready={allCustomsReady} customsCloseSignal={actionData?.success?actionData:undefined}/>}
  {activeTab==="exceptions"&&<BatchExceptionWorkbench batch={loaderData.batch} orders={loaderData.orders} packages={loaderData.exceptionPackages} exceptions={loaderData.batchExceptions} busy={busy} manage={manage||canManageOrderModule(loaderData.current,"exceptions")} closeSignal={actionData?.success?actionData:undefined}/>}
  {activeTab==="batch"&&<><section className="panel loading-sheet batch-tab-panel" id="batch-arrangement">
    <div className="batch-detail-summary"><div><h2>仓库配载结果</h2><p>由仓库端自动同步，管理后台只读查看。</p></div><div className="loading-sheet-state batch-detail-summary-status"><span>{loaderData.orders.length} 票</span><span>{loaderData.vehicles.length} 车</span><b>{allDispatched?"仓库已出库":loadPlanReady&&allCustomsReady?"待仓库装车":"待仓库补齐"}</b></div></div>
    <div className="batch-detail-disclosure-body">
    <div className="loading-summary-strip">
      <span>起运地<strong>{loaderData.batch.origin_location}</strong></span>
      <span>目的地<strong>{loaderData.batch.destination_location}</strong></span>
      <span>承运商<strong>{loaderData.batch.carrier_name||"待选择"}</strong></span>
      <span>计划发车<strong>{formatShortDateTime(loaderData.batch.planned_departure_at)}</strong></span>
      <span>报关门禁<strong className={allCustomsReady?"":"danger-text"}>{allCustomsReady?"全部通过":"待处理"}</strong></span>
    </div>
    <div className="loading-sheet-layout">
      <div className="loading-preparation-summary loading-sheet-readonly">
        <span><b>生成仓库</b>{loaderData.batch.warehouse_name||"未记录"}</span>
        <span><b>运输线路</b>{loaderData.batch.route_notes||"未填写"}</span>
        <span><b>出境口岸</b>{loaderData.batch.border_port||"待仓库补齐"}</span>
        <span><b>清关地</b>{loaderData.batch.customs_location||"待仓库补齐"}</span>
        <span><b>计划发车</b>{formatShortDateTime(loaderData.batch.planned_departure_at)}</span>
        <span><b>计划到达</b>{formatShortDateTime(loaderData.batch.planned_arrival_at)}</span>
        <span><b>境外承运商</b>{loaderData.batch.overseas_carrier_name||loaderData.batch.carrier_name||"待仓库补齐"}</span>
        <span><b>车辆 / 司机</b>{loaderData.batch.overseas_vehicle_plate||"待仓库补齐"} · {loaderData.batch.overseas_driver_name||"待仓库补齐"} · {loaderData.batch.overseas_driver_phone||"电话待补齐"}</span>
      </div>
      <aside className="loading-sheet-tools">
        <section className="loading-tool-table"><div className="table-wrap"><table><thead><tr><th>数据来源</th><th>同步方式</th></tr></thead><tbody><tr><td><strong>仓库端货物配载</strong><small>配载单、挂载订单、车辆司机、文件和出库状态均以仓库端数据为准。</small></td><td><span className="status-pill success">自动同步</span></td></tr></tbody></table></div></section>
      </aside>
    </div>
    <LoadingTotals totals={totals}/>
    <div className="loading-sheet-columns">
      <section className="loading-sheet-section"><header><h3>挂载订单</h3><span>货物名称按每票货物明细完整汇总；这些完整订单跟随本配载单统一推进</span></header><div className="table-wrap loading-sheet-table"><table><thead><tr><th>订单号</th><th>工作号</th><th>委托人</th><th>起运地</th><th>目的地</th><th>货物名称</th><th>件数</th><th>报关重量</th><th>报关体积</th><th>进仓重量</th><th>进仓体积</th><th>入库时间</th><th>货物状态</th><th>配载车辆</th><th>境外仓</th><th>查看</th></tr></thead><tbody>{loaderData.orders.map(item=><tr key={item.order_id}><td><strong><OrderNumberLink id={item.order_id} number={item.order_number}/></strong></td><td>{item.work_number}</td><td>{item.customer_name}</td><td>{loaderData.batch.origin_location}</td><td>{loaderData.batch.destination_location}</td><td><strong className="loading-cargo-names">{item.cargo_names||item.cargo_description||"未填写"}</strong></td><td>{item.pieces}</td><td>{item.declared_weight_kg.toFixed(2)}</td><td>{item.declared_volume_cbm.toFixed(3)}</td><td>{item.gross_weight_kg.toFixed(2)}</td><td>{item.volume_cbm.toFixed(3)}</td><td>{item.inbound_at?formatShortDateTime(item.inbound_at):<span className="off">未入库</span>}</td><td>{item.dispatched_packages>0?<span className="status-pill success">已出库 {item.dispatched_packages}</span>:item.inbound_at?(item.in_stock_packages>0?<span className="status-pill">在库 {item.in_stock_packages}</span>:<span className="status-pill off">无在库包装</span>):<span className="status-pill off">未入库</span>}</td><td>{loaderData.vehicles.map(vehicle=>vehicle.plate_number||vehicle.vehicle_no).join("、")||"待仓库补齐"}</td><td>{item.overseas_status==="arrived"||item.overseas_status==="notified"||item.overseas_status==="appointment"||item.overseas_status==="picked_up"?<span className="status-pill success">{item.overseas_arrival_at?`已到仓 ${formatShortDateTime(item.overseas_arrival_at)}`:"已到仓"}</span>:<span className="status-pill off">未到仓</span>}</td><td><div className="loading-row-actions"><Link className="text-button" to={`/admin/orders/${item.order_id}`}>订单详情</Link><Link className="text-button" to={tabHref("documents")}>报关状态</Link></div></td></tr>)}</tbody></table></div></section>
      <section className="loading-sheet-section"><header><h3>运输车辆</h3><span>重量和体积仅供人工判断，系统不校验是否超载</span></header><div className="table-wrap loading-vehicle-table"><table><thead><tr><th>车辆编号</th><th>车牌</th><th>车型</th><th>司机</th><th>电话</th><th>整批实收重量</th><th>整批实收体积</th><th>挂载订单</th></tr></thead><tbody>{loaderData.vehicles.map(vehicle=><tr key={vehicle.id}><td><strong>{vehicle.vehicle_no}</strong></td><td>{vehicle.plate_number||"车牌待录"}</td><td>{vehicle.vehicle_type||"车型待录"}</td><td>{vehicle.driver_name||"司机待定"}</td><td>{vehicle.driver_phone||"电话待录"}</td><td>{totals.actualWeight.toFixed(2)} KG</td><td>{totals.actualVolume.toFixed(3)} CBM</td><td>{loaderData.orders.length} 票完整订单</td></tr>)}{!loaderData.vehicles.length&&<tr><td colSpan={8} className="empty-state">当前配载单还没有运输车辆。</td></tr>}</tbody></table></div></section>
    </div>
    </div>
  </section>
  <CostAllocationSection allocations={loaderData.costAllocations} busy={busy} manage={manage&&allDispatched}/></>}
  {activeTab==="outbound"&&<section className="panel batch-tab-panel" id="batch-exit-gate"><div className="panel-header"><div><h2>装车出库与出境确认</h2><p>这里逐项核对整批订单；全部通过后，才能统一确认出境并同步所有挂载订单。</p></div><span className="status-pill">{roadStatusLabels[loaderData.batch.road_status]||loaderData.batch.road_status}</span></div>
    <div className="table-wrap batch-exit-gate-table"><table><thead><tr><th>门禁项目</th><th>当前状态</th><th>核对结果</th></tr></thead><tbody>
      <tr className={allDispatched?"completed-row":"blocked-row"}><td><strong>仓库装车出库</strong></td><td><span className={`status-pill ${allDispatched?"success":"danger"}`}>{allDispatched?"已通过":"未通过"}</span></td><td>{allDispatched?"全部订单已完成交接":`${dispatchedCount}/${loaderData.orders.length} 票已完成；待处理：${pendingDispatchOrders.map(order=>order.order_number).join("、")}`}</td></tr>
      <tr className={transportResourceReady?"completed-row":"blocked-row"}><td><strong>境外运输资源</strong></td><td><span className={`status-pill ${transportResourceReady?"success":"danger"}`}>{transportResourceReady?"已通过":"未通过"}</span></td><td>{transportResourceReady?`${loaderData.batch.overseas_carrier_name} · ${loaderData.batch.overseas_vehicle_plate}`:"承运方、车辆或司机资料未齐"}</td></tr>
      <tr className="completed-row"><td><strong>配载单同步</strong></td><td><span className="status-pill success">已通过</span></td><td>{loaderData.batch.batch_number} 已由仓库生成</td></tr>
      <tr className={orderDepartureReady?"completed-row":"blocked-row"}><td><strong>逐票资料与报关</strong></td><td><span className={`status-pill ${orderDepartureReady?"success":"danger"}`}>{orderDepartureReady?"已通过":"未通过"}</span></td><td>{orderDepartureReady?"全部订单门禁已通过":`${loaderData.departureGateStatuses.filter(item=>!item.ready).length} 票待处理`}</td></tr>
      <tr className={!blockingExceptions.length?"completed-row":"blocked-row"}><td><strong>配载异常门禁</strong></td><td><span className={`status-pill ${!blockingExceptions.length?"success":"danger"}`}>{!blockingExceptions.length?"已通过":`${blockingExceptions.length} 项阻断`}</span></td><td>{!blockingExceptions.length?"没有未关闭的阻断异常":blockingExceptions.map(item=>item.exception_number).join("、")}</td></tr>
    </tbody></table></div>
    {loaderData.batch.road_status==="outbound_in_transit"?<div className="alert success">本配载单已出境；现在可以切换到“出境运输”继续登记节点。</div>:["overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status)?<div className="alert success">本配载单已完成出境确认。</div>:canConfirmExit&&manage?<Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="exit_confirm"/><Field name="actualExitAt" label="实际出境时间" type="datetime-local" required defaultValue={dateTimeLocal(new Date().toISOString())}/><label className="field"><span>实际出境口岸</span><select name="exitPort" defaultValue={loaderData.batch.border_port||""} required><option value="">请选择</option>{loaderData.borderPorts.map(item=><option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}</select></label><Field name="exitVehiclePlate" label="实际出境车辆车牌" required defaultValue={loaderData.batch.overseas_vehicle_plate||loaderData.vehicles.map(item=>item.plate_number).filter(Boolean).join("、")}/><Field name="proofReference" label="出境凭证 / 图片编号"/><Field name="exitNotes" label="出境备注"/><button className="primary" disabled={busy}>确认本配载单已出境并同步订单</button></Form>:<div className="batch-gate-blocker"><div><strong>当前还不能确认出境</strong><p>仓库端及逐票业务门禁完成后，系统会自动开放“确认出境”。</p>{exitBlockers.length?<ul>{Array.from(new Set(exitBlockers)).map(reason=><li key={reason}>{reason}</li>)}</ul>:<p>当前账号只能查看门禁状态。</p>}</div><div className="batch-gate-actions"><Link className="secondary" to={tabHref("documents")}>查看文件与报关状态</Link><Link className="secondary" to={tabHref("batch")}>查看仓库配载结果</Link></div></div>}
  </section>}
  {activeTab==="overseas"&&<section className="panel batch-tab-panel" id="overseas-warehouse-receiving"><div className="panel-header"><div><h2>境外目的仓收货清点</h2><p>配载单不能手工确认到仓。仓库逐票扫码入库并清点；全部挂载订单清点无误后，系统统一结束境外运输并自动通知客户。</p></div><span className="status-pill">{loaderData.orders.filter(item=>item.overseas_status&&item.overseas_status!=="waiting_arrival").length}/{loaderData.orders.length} 票到仓</span></div>{loaderData.batch.road_status==="outbound_in_transit"&&manage?<div className="table-wrap overseas-receiving-table"><table><thead><tr><th>订单</th><th>客户</th><th>境外目的仓</th><th>当前状态</th><th>操作</th></tr></thead><tbody>{loaderData.orders.map(item=><tr key={item.order_id}><td><strong><OrderNumberLink id={item.order_id} number={item.order_number}/></strong></td><td>{item.customer_name}</td><td>{item.overseas_warehouse_name||"未指定"}</td><td><span className={`status-pill ${item.overseas_status&&item.overseas_status!=="waiting_arrival"?"success":""}`}>{item.overseas_status&&item.overseas_status!=="waiting_arrival"?"已清点到仓":"待仓库收货"}</span></td><td>{item.overseas_warehouse_id&&(!item.overseas_status||item.overseas_status==="waiting_arrival")?<WarehouseOverseasInboundAction orderId={item.order_id} batchId={loaderData.batch.id} warehouseId={item.overseas_warehouse_id}/>:"—"}</td></tr>)}</tbody></table></div>:["overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status)?<div className="alert success">本配载单全部订单已经境外仓扫码入库并清点，客户通知已由系统自动发送。</div>:<div className="alert warning">当前步骤尚未开放：请先完成装车出库与出境确认。</div>}</section>}
  </>}

function BatchExceptionWorkbench({batch,orders,packages,exceptions,busy,manage,closeSignal}:{batch:Batch;orders:BatchOrder[];packages:BatchExceptionPackage[];exceptions:BatchException[];busy:boolean;manage:boolean;closeSignal?:unknown}){
  const [scope,setScope]=useState<"batch"|"order"|"package">("batch");
  const active=exceptions.filter(item=>isActiveExceptionStatus(item.status));
  const blocking=active.filter(item=>item.blocks_progress===1);
  return <section className="panel batch-tab-panel batch-exception-workbench" id="batch-exceptions">
    <div className="panel-header"><div><h2>配载单异常处理</h2><p>异常可作用于整批、单张订单或一个 OUL 货物标签；处理全程留痕，已完成节点不会回退。</p></div><div className="page-actions"><span className={`status-pill ${blocking.length?"danger":"success"}`}>{blocking.length?`${blocking.length} 项阻断推进`:"无阻断异常"}</span>{manage&&<Modal title={`登记配载异常 · ${batch.batch_number}`} triggerLabel="＋ 登记异常" triggerClassName="primary" size="wide" closeSignal={closeSignal}><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="batch_exception_create"/><label className="field"><span>影响范围</span><select name="exceptionScope" value={scope} onChange={event=>setScope(event.target.value as typeof scope)}><option value="batch">整张配载单</option><option value="order">指定订单</option><option value="package">指定 OUL 货物</option></select></label>{scope==="order"&&<label className="field span-2"><span>关联订单</span><select name="orderId" required><option value="">请选择订单</option>{orders.map(order=><option key={order.order_id} value={order.order_id}>{order.order_number} · {order.customer_name}</option>)}</select></label>}{scope==="package"&&<label className="field span-2"><span>OUL 货物标签</span><select name="packageId" required><option value="">请选择 OUL 标签</option>{packages.map(item=><option key={item.id} value={item.id}>{item.barcode} · {item.order_number}</option>)}</select></label>}<label className="field"><span>异常类型</span><select name="exceptionType" defaultValue="other"><option value="cargo_damage">货损</option><option value="cargo_shortage">货差/短少</option><option value="document">文件资料</option><option value="customs">报关/清关</option><option value="vehicle">车辆司机</option><option value="delay">时效延误</option><option value="route">线路/口岸</option><option value="warehouse">仓库作业</option><option value="other">其他</option></select></label><label className="field"><span>严重等级</span><select name="severity" defaultValue="medium"><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">紧急</option></select></label><label className="check-field span-2"><input name="blocksProgress" type="checkbox" defaultChecked/>异常关闭前阻断本配载单继续推进</label><label className="field span-2"><span>异常说明</span><textarea name="description" rows={4} minLength={4} maxLength={500} placeholder="说明发生了什么、影响范围和当前处置建议" required/></label><button className="primary span-2" disabled={busy}>登记异常并同步订单</button></Form></Modal>}</div></div>
    <div className="batch-exception-summary"><span>全部异常 <strong>{exceptions.length}</strong></span><span>待处理 <strong>{active.length}</strong></span><span>阻断推进 <strong>{blocking.length}</strong></span><span>已结案 <strong>{exceptions.filter(item=>item.status==="resolved").length}</strong></span></div>
    <div className="table-wrap"><table><thead><tr><th>异常单</th><th>范围</th><th>类型 / 等级</th><th>异常说明</th><th>推进影响</th><th>状态 / 负责人</th><th>处理结果</th><th>操作</th></tr></thead><tbody>{exceptions.map(item=><tr key={item.id} className={item.status==="resolved"?"completed-row":item.blocks_progress?"blocked-row":""}><td><strong>{item.exception_number}</strong><small>{new Date(item.reported_at).toLocaleString("zh-CN")} · {item.reporter_name||"系统"}</small></td><td>{batchExceptionScopeLabel(item.scope)}<small>{item.scope==="batch"?batch.batch_number:item.scope==="order"?item.order_number:item.package_barcode}</small></td><td>{batchExceptionTypeLabel(item.exception_type)}<small><span className={`severity-badge ${item.severity}`}>{batchExceptionSeverityLabel(item.severity)}</span></small></td><td>{item.description}</td><td><span className={`status-pill ${item.blocks_progress?"danger":""}`}>{item.blocks_progress?"阻断推进":"仅提醒"}</span></td><td><span className={`status-pill ${item.status==="resolved"?"success":item.status==="processing"?"":"off"}`}>{batchExceptionStatusLabel(item.status)}</span><small>{item.assignee_name||"未分配"}</small></td><td>{item.resolution||"—"}{item.resolved_at&&<small>{item.resolved_by_name||"系统"} · {new Date(item.resolved_at).toLocaleString("zh-CN")}</small>}</td><td>{manage&&(item.status==="open"||item.status==="processing")?<div className="row-actions">{item.status==="open"&&<Form method="post"><input type="hidden" name="intent" value="batch_exception_progress"/><input type="hidden" name="exceptionId" value={item.id}/><button className="text-button" disabled={busy}>开始处理</button></Form>}<Modal title={`解决异常 · ${item.exception_number}`} triggerLabel="解决并关闭" triggerClassName="text-button" closeSignal={closeSignal}><Form method="post" className="stack"><input type="hidden" name="intent" value="batch_exception_resolve"/><input type="hidden" name="exceptionId" value={item.id}/><div className="alert warning">关闭后立即重新计算受影响订单与配载单门禁；历史流程节点不会回退。</div><label className="field"><span>处理结果</span><textarea name="resolution" rows={5} minLength={4} maxLength={500} required/></label><button className="primary" disabled={busy}>确认解决并关闭异常</button></Form></Modal></div>:"—"}</td></tr>)}{!exceptions.length&&<tr><td colSpan={8} className="empty-state">当前配载单没有异常。发生问题时可在这里就地登记，无需跳转订单页。</td></tr>}</tbody></table></div>
  </section>;
}

function BatchDocumentWorkbench({batchId,orders,batchDocuments,orderDocuments,customsSummaries,customsDeclarations,busy,manageCustoms,requiresTransloading,ready,customsCloseSignal}:{batchId:string;orders:BatchOrder[];batchDocuments:BatchDocument[];orderDocuments:OrderDocument[];customsSummaries:CustomsSummary[];customsDeclarations:BatchCustomsDeclaration[];busy:boolean;manageCustoms:boolean;requiresTransloading:boolean;ready:boolean;customsCloseSignal?:unknown}){
  const visibleBatchDocTypes=BATCH_DOCUMENT_TYPES.filter(type=>requiresTransloading||!["border_handover","transshipment_order"].includes(type.code));
  const systemDocumentCodes=new Set(["loading_manifest","vehicle_manifest","batch_waybill"]);
  return <section className="panel batch-document-workbench batch-tab-panel" id="batch-files">
    <div className="batch-detail-summary"><div><h2>报关与文件工作台</h2><p>在当前配载单内查看逐票文件，并直接新增、编辑或放行报关单，无需跳回订单页。</p></div><div className="batch-detail-summary-status"><span>{orders.length} 票订单</span><b>{ready?"报关门禁已通过":"存在待办资料"}</b></div></div>
    <div className="batch-detail-disclosure-body">
    <div className="batch-document-scope-note"><strong>整批共用</strong><span>配载单、装车清单和批次运单均由仓库数据自动生成；{requiresTransloading?"口岸交接文件与换装单按实际业务收集。":"无需人工重复上传。"}</span><strong>逐票独立</strong><span>委托书、发票、装箱单、报关资料及报关单/预录报关单文件按订单检查；正式报关单号与放行状态在本区逐票登记。</span></div>
    <section className="batch-shared-documents"><header><div><h3>整批共用文件</h3><p>三类系统单据随仓库配载与装车数据自动形成，仅供查看，不参与人工审核{requiresTransloading?"；换装文件仅在开启换装后显示":""}。</p></div></header>
      <div className="table-wrap batch-document-table"><table><thead><tr><th>文件类型</th><th>用途说明</th><th>当前状态</th><th>文件</th></tr></thead><tbody>{visibleBatchDocTypes.map(type=>{
        const current=batchDocuments.find(item=>item.document_category===type.code);
        const isSystemDocument=systemDocumentCodes.has(type.code);
        return <tr className={current&&["approved","archived"].includes(current.review_status)?"completed-row":""} key={type.code}>
          <td><strong>{type.name}{type.required&&<b className="required-mark"> *</b>}</strong></td><td>{type.hint}</td>
          <td>{current?<span className={`status-pill ${current.review_status==="approved"?"success":""}`}>{isSystemDocument?"已自动同步":documentReviewLabel(current.review_status)}</span>:<span className="status-pill off">{isSystemDocument?"待自动生成":"待上传"}</span>}</td>
          <td>{current?<a href={`/admin/document-files/batch/${current.id}?mode=view`} target="_blank" rel="noreferrer">{current.file_name}</a>:"—"}</td>
        </tr>})}</tbody></table></div>
    </section>
    <section className="batch-order-documents"><header><div><h3>逐票订单文件与报关门禁</h3><p>点击“办理本票报关”即可在当前页面查看文件、新增申报单、编辑和放行。</p></div></header>
      <div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>货物名称</th><th>实收数据</th><th>订单文件</th><th>申报登记 / 放行</th><th>操作</th></tr></thead><tbody>{orders.map(order=>{
        const files=orderDocuments.filter(item=>item.order_id===order.order_id);
        const latestFiles=ORDER_BATCH_DOCUMENT_CODES.map(code=>files.find(item=>item.document_category===code)).filter((item):item is OrderDocument=>Boolean(item));
        const approvedCodes=new Set(latestFiles.filter(item=>["approved","archived"].includes(item.review_status)).map(item=>item.document_category));
        const missingCodes=ORDER_BATCH_DOCUMENT_CODES.filter(code=>!approvedCodes.has(code));
        const customs=customsSummaries.find(item=>item.order_id===order.order_id);
        const customsReady=Boolean(customs&&customs.total>0&&customs.released===customs.total);
        return <tr key={order.order_id} id={`batch-customs-${order.order_id}`}>
          <td><strong><OrderNumberLink id={order.order_id} number={order.order_number}/></strong><small>{order.customer_name}</small></td>
          <td><strong className="loading-cargo-names">{order.cargo_names||order.cargo_description||"未填写"}</strong></td>
          <td>{order.pieces} 件 · {order.gross_weight_kg.toFixed(2)} KG · {order.volume_cbm.toFixed(3)} CBM</td>
          <td><span className={`status-pill ${missingCodes.length?"":"success"}`}>{missingCodes.length?`缺 ${missingCodes.length} 项`:`${ORDER_BATCH_DOCUMENT_CODES.length} 项已齐`}</span>{missingCodes.length>0&&<small>{missingCodes.map(orderDocumentTypeLabel).join("、")}</small>}</td>
          <td><span className={`status-pill ${customsReady?"success":""}`}>{customs?.total?`${customs.released}/${customs.total} 张放行`:["customs_document","customs_declaration_file"].every(code=>files.some(item=>item.document_category===code&&["approved","archived"].includes(item.review_status)))?"文件已齐，待登记正式报关单":"待补齐报关资料与申报单文件"}</span></td>
          <td><details className="batch-order-file-details"><summary>{manageCustoms?"办理本票报关":"查看本票文件"}</summary><div className="batch-order-file-panel">
            <header className="batch-order-file-panel-header"><div><strong>{manageCustoms?"办理本票报关":"查看本票文件"}</strong><span><OrderNumberLink id={order.order_id} number={order.order_number}/> · {order.customer_name}</span></div><button type="button" aria-label="关闭文件查看窗口" onClick={event=>(event.currentTarget.closest("details") as HTMLDetailsElement|null)?.removeAttribute("open")}>×</button></header>
            <div className="batch-order-file-list">{ORDER_BATCH_DOCUMENT_CODES.map(code=>{const current=files.find(item=>item.document_category===code);return <div key={code}><strong>{orderDocumentTypeLabel(code)}</strong>{current?<><a href={`/admin/document-files/order/${current.id}?mode=view`} target="_blank" rel="noreferrer">{current.file_name}</a><span className={`status-pill ${current.review_status==="approved"?"success":""}`}>{documentReviewLabel(current.review_status)}</span></>:<span className="status-pill off">待仓库上传</span>}</div>})}</div>
            <BatchOrderCustomsWorkbench orderId={order.order_id} declarations={customsDeclarations.filter(item=>item.order_id===order.order_id)} manage={manageCustoms} busy={busy} closeSignal={customsCloseSignal}/>
            <div className="batch-order-file-links"><Link className="secondary" to={`/admin/orders/${order.order_id}/modules/documents`}>查看完整文件中心</Link></div>
          </div></details></td>
        </tr>})}</tbody></table></div>
    </section>
    </div>
  </section>
}

function ActionToast({signal,message,tone}:{signal?:unknown;message?:string;tone:"success"|"error"}){
  const [visible,setVisible]=useState(Boolean(message));
  useEffect(()=>{
    if(!message)return;
    setVisible(true);
    const timer=window.setTimeout(()=>setVisible(false),4200);
    return()=>window.clearTimeout(timer);
  },[message,signal]);
  if(!message||!visible)return null;
  return <div className={`batch-action-toast ${tone}`} role={tone==="error"?"alert":"status"} aria-live={tone==="error"?"assertive":"polite"}>
    <span>{tone==="error"?"操作未完成":"操作成功"}</span>
    <p>{message}</p>
    <button type="button" aria-label="关闭提示" onClick={()=>setVisible(false)}>×</button>
  </div>;
}

function BatchTrackingWorkbench({batchId,batchNumber,orders,trackingMilestones,trackingFlags,batchVehiclePlate,overseasVehiclePlate,borderPort,customsLocation,busy,manage,warehouseReady,exitConfirmed,exitGateHref,actionCloseSignal}:{batchId:string;batchNumber:string;orders:BatchOrder[];trackingMilestones:BatchTrackingMilestone[];trackingFlags:BatchTrackingFlag[];batchVehiclePlate:string|null;overseasVehiclePlate:string|null;borderPort:string|null;customsLocation:string|null;busy:boolean;manage:boolean;warehouseReady:boolean;exitConfirmed:boolean;exitGateHref:string;actionCloseSignal?:unknown}){
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
  const defaultLocation=(nodeCode:string)=>["border_arrived","exported"].includes(nodeCode)?borderPort||"":nodeCode==="customs_cleared"?customsLocation||"":"";
  return <section className="panel batch-tracking-workbench" id="batch-tracking">
    <div className="panel-header"><div><h2>4. 运输执行与跟踪</h2><p>仓库整批出库后开放登记；时间、口岸、车辆等优先继承配载单，登记结果同步写入全部挂载订单。</p></div><div className="batch-tracking-header-actions"><span className="status-pill">{orders.length} 票 · {trackingMilestones.length} 条节点</span>{manage&&<Modal title="可选运输节点设置" triggerLabel={`可选节点${requiresTransloading||requiresTransitCustoms?" · 已启用":""}`} triggerClassName="text-button batch-optional-node-trigger" closeSignal={actionCloseSignal}>
      <div className="batch-optional-node-dialog"><p className="muted">仅在运输途中实际发生换装或转关时启用；默认不参与主流程。</p><div className="table-wrap batch-tracking-option-table"><table><thead><tr><th>可选节点</th><th>适用范围</th><th>当前设置</th><th>操作</th></tr></thead><tbody>
        <tr><td><strong>换装</strong></td><td>给本批全部订单开放“换装”节点</td><td><span className={`status-pill ${requiresTransloading?"success":"off"}`}>{requiresTransloading?"已启用":"未启用"}</span></td><td><Form method="post"><input type="hidden" name="intent" value="batch_tracking_option_toggle"/><input type="hidden" name="optionCode" value="transloaded"/><label className="toggle-label"><input type="checkbox" name="enable" defaultChecked={requiresTransloading}/><span>启用</span></label><button className="text-button" disabled={busy}>应用</button></Form></td></tr>
        <tr><td><strong>转关</strong></td><td>给本批全部订单开放“转关”节点</td><td><span className={`status-pill ${requiresTransitCustoms?"success":"off"}`}>{requiresTransitCustoms?"已启用":"未启用"}</span></td><td><Form method="post"><input type="hidden" name="intent" value="batch_tracking_option_toggle"/><input type="hidden" name="optionCode" value="transit_customs"/><label className="toggle-label"><input type="checkbox" name="enable" defaultChecked={requiresTransitCustoms}/><span>启用</span></label><button className="text-button" disabled={busy}>应用</button></Form></td></tr>
      </tbody></table></div></div>
    </Modal>}</div></div>
    {!warehouseReady&&<div className="alert warning">仓库端尚未完成整批装车出库。当前仅可查看，完成出库后系统会自动开放节点登记。</div>}
    {warehouseReady&&!exitConfirmed&&<div className="batch-exit-prerequisite" role="status"><div><strong>当前待办：确认实际出境</strong><span>出境节点不在这里手工登记；完成出境确认后，系统会自动写入本批全部订单。</span></div><Link className="primary" to={exitGateHref}>去确认实际出境</Link></div>}
    <div className="batch-tracking-note"><strong>幂等写入</strong><span>同一订单同一节点同一事件时间只记一次；不同时间会留下多条记录，作为运输过程的多份痕迹。</span><strong>顺序门禁</strong><span>登记新节点前，批次内每票订单必须已有前置节点（如登记"出境"前要求"到达出境口岸"已存在）。</span></div>
    <div className="table-wrap batch-tracking-node-table"><table><thead><tr><th>顺序</th><th>运输节点</th><th>流程进度</th><th>批次登记状态</th><th>最近登记</th><th>操作</th></tr></thead><tbody>{visibleMilestones.map((node,index)=>{
      const count=orders.filter(o=>{const list=milestonesByOrder.get(o.order_id)||[];return list.some(m=>m.milestone_code===node.code);}).length;
      const total=orders.length;
      const sample=trackingMilestones.find(m=>m.milestone_code===node.code);
      return <tr className={count===total?"completed-row":count>0?"partial-row":""} key={node.code}>
        <td>{String(index+1).padStart(2,"0")}</td><td><strong>{node.name}</strong></td><td>{node.progress}%</td><td><span className={`status-pill ${count===total?"success":""}`}>{count===total?"全票已登记":count>0?`${count}/${total} 票`:"未登记"}</span></td><td>{sample?formatShortDateTime(sample.event_at):"—"}</td>
        <td>{node.code==="exported"&&!exitConfirmed?<Link className="text-button batch-exit-gate-link" to={exitGateHref}>去确认实际出境</Link>:manage&&node.code!=="station_arrived"&&node.code!=="exported"?<Modal title={`登记运输节点 · ${node.name}`} triggerLabel="登记节点" triggerClassName="text-button" size="wide" closeSignal={actionCloseSignal}>
          <Form method="post" className="compact-tool-form batch-tracking-form batch-tracking-modal-form">
            <input type="hidden" name="intent" value="batch_tracking_add"/>
            <input type="hidden" name="milestoneCode" value={node.code}/>
            <Field name="eventAt" label="事件时间 *" type="datetime-local" required defaultValue={defaultEventAt}/>
            <Field name="location" label="地点" defaultValue={defaultLocation(node.code)}/>
            <Field name="vehicleReference" label="车辆/车牌" defaultValue={defaultVehicle}/>
            <label className="field"><span>备注</span><input name="notes" placeholder="例如换装方式、清关说明"/></label>
            <label className="field"><span>客户可见</span><select name="visibleToCustomer" defaultValue="on"><option value="on">客户可见</option><option value="off">仅内部</option></select></label>
            <button className="primary" disabled={busy}>登记到本批 {total} 票订单</button>
          </Form>
        </Modal>:<span className="muted">{node.code==="exported"?"出境确认自动登记":"仓库自动登记"}</span>}</td>
      </tr>;
    })}</tbody></table></div>
    <details className="batch-tracking-orders batch-inline-disclosure"><summary><span><strong>逐票节点状态</strong><small>查看每票订单的最新里程碑与历史节点</small></span><em aria-hidden="true"/></summary>
      <div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>最新节点</th><th>节点时间</th><th>地点</th><th>车辆</th><th>历史节点</th><th>操作</th></tr></thead><tbody>{orders.map(order=>{
        const latest=latestByOrder.get(order.order_id);
        const list=milestonesByOrder.get(order.order_id)||[];
        return <tr key={order.order_id}>
          <td><strong><OrderNumberLink id={order.order_id} number={order.order_number}/></strong><small>{order.customer_name}</small></td>
          <td>{latest?<span className={`status-pill ${milestoneProgressWeight[latest.milestone_code]??0>=100?"success":""}`}>{latest.milestone_name}</span>:<span className="status-pill off">未登记</span>}</td>
          <td>{latest?formatShortDateTime(latest.event_at):"—"}</td>
          <td>{latest?.location||"—"}</td>
          <td>{latest?.vehicle_reference||"—"}</td>
          <td><small className="tracking-history-list">{list.map(m=>`${m.milestone_name} ${formatShortDateTime(m.event_at)}`).join(" · ")||"无"}</small></td>
          <td><Link className="text-button" to={`/admin/orders/${order.order_id}/modules/tracking`}>订单跟踪</Link></td>
        </tr>;
      })}</tbody></table></div>
    </details>
  </section>;
}

function BatchOrderCustomsWorkbench({orderId,declarations,manage,busy,closeSignal}:{orderId:string;declarations:BatchCustomsDeclaration[];manage:boolean;busy:boolean;closeSignal?:unknown}){
  const active=declarations.filter(item=>item.is_deleted!==1&&item.status!=="cancelled");
  const released=active.filter(item=>item.status==="released").length;
  return <section className="batch-order-customs-workbench">
    <header><div><strong>本票报关与放行</strong><span>{manage?"在当前配载单内办理":"只读汇总；办理操作在订单报关作业中完成"}</span></div><span className={`status-pill ${active.length>0&&released===active.length?"success":""}`}>{active.length?`${released}/${active.length} 张放行`:"尚无有效报关单"}</span></header>
    {declarations.length>0&&<div className="batch-customs-list">{declarations.map(declaration=><div className="batch-customs-row" key={declaration.id}>
      <div><strong>{declaration.declaration_number}</strong><small>{customsStageLabel(declaration.clearance_stage)} · {declaration.declaration_type}</small></div>
      <div><span>{declaration.declaration_title}</span><small>{declaration.declaring_company}</small></div>
      <div><span>{declaration.currency} {Number(declaration.declared_amount).toLocaleString()}</span><small>{Number(declaration.gross_weight_kg).toLocaleString()} KG</small></div>
      <span className={`status-pill ${declaration.status==="released"?"success":""}`}>{customsDeclarationStatusLabel(declaration)}</span>
      <div className="batch-customs-actions">
        <Modal title={`查看报关单 · ${declaration.declaration_number}`} triggerLabel="查看" triggerClassName="text-button" size="wide"><BatchCustomsDeclarationView declaration={declaration}/></Modal>
        {manage&&<Modal title={`编辑报关单 · ${declaration.declaration_number}`} triggerLabel="编辑" triggerClassName="text-button" size="wide" closeSignal={closeSignal}><BatchCustomsDeclarationForm orderId={orderId} declaration={declaration} busy={busy}/></Modal>}
        {manage&&declaration.status!=="released"&&declaration.status!=="cancelled"&&declaration.is_deleted!==1&&<Modal title={`确认海关放行 · ${declaration.declaration_number}`} triggerLabel="放行" triggerClassName="text-button" closeSignal={closeSignal}><BatchCustomsReleaseForm orderId={orderId} declaration={declaration} busy={busy}/></Modal>}
      </div>
    </div>)}</div>}
    {!declarations.length&&<p className="empty-state">本票尚未登记报关单。先上传“报关资料”，再新增申报单。</p>}
    {manage&&<Modal title="新增本票报关单" triggerLabel="新增报关单" triggerClassName="secondary" size="wide" closeSignal={closeSignal}><BatchCustomsDeclarationForm orderId={orderId} busy={busy}/></Modal>}
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
function batchExceptionScopeLabel(scope:string){return scope==="batch"?"整批":scope==="order"?"订单":"OUL 货物"}
function batchExceptionTypeLabel(type:string){return({cargo_damage:"货损",cargo_shortage:"货差/短少",document:"文件资料",customs:"报关/清关",vehicle:"车辆司机",delay:"时效延误",route:"线路/口岸",warehouse:"仓库作业",other:"其他"} as Record<string,string>)[type]||type}
function batchExceptionSeverityLabel(severity:string){return({low:"低",medium:"中",high:"高",critical:"紧急"} as Record<string,string>)[severity]||severity}
function batchExceptionStatusLabel(status:string){return({open:"待处理",processing:"处理中",resolved:"已结案",cancelled:"已取消"} as Record<string,string>)[status]||status}

function BatchWorkspaceTabs({status,customsReady,loadPlanReady,warehouseReady,exceptionCount,activeTab,tabHref}:{status:string;customsReady:boolean;loadPlanReady:boolean;warehouseReady:boolean;exceptionCount:number;activeTab:BatchWorkspaceTab;tabHref:(tab:BatchWorkspaceTab)=>string}){
  const exited=["outbound_in_transit","overseas_arrived","waiting_pickup","pickup_completed"].includes(status);
  const arrived=["overseas_arrived","waiting_pickup","pickup_completed"].includes(status);
  const tabs:{code:BatchWorkspaceTab;title:string;body:string;done:boolean}[]=[
    {code:"batch",title:"配载与车辆",body:"配载订单、车辆司机与分摊",done:loadPlanReady},
    {code:"documents",title:"报关与文件",body:"逐票文件、申报、编辑与放行",done:customsReady},
    {code:"outbound",title:"装车出库与出境确认",body:warehouseReady?"仓库已交接，待确认实际出境":"待仓库装车出库",done:exited},
    {code:"tracking",title:"出境运输",body:"配载单统一更新运输节点",done:exited},
    {code:"overseas",title:"境外到仓",body:"全部子订单扫码收货清点",done:arrived},
    {code:"exceptions",title:"异常处理",body:exceptionCount?`${exceptionCount} 项待处理 · 批次/订单/OUL`:"批次、订单或 OUL 就地登记",done:exceptionCount===0},
  ];
  const currentTitle=exceptionCount?`有 ${exceptionCount} 项异常待处理`:arrived?"配载单流程已完成":exited?"境外运输中":warehouseReady&&!customsReady?"待报关放行":warehouseReady?"待出境确认":loadPlanReady?"待仓库装车出库":"待完善配载与车辆";
  const currentHint=exceptionCount?"异常处理不会回退已经完成的历史节点；标记为阻断推进的异常结案后才可继续。":!customsReady&&warehouseReady?"仓库交接已完成；请在“报关与文件”内直接补齐申报并放行。":"标签页仅切换当前工作区，不再滚动跳转到页面其他位置。";
  return <><div className="batch-current-node"><span>当前业务节点</span><strong>{currentTitle}</strong><small>{currentHint}</small></div><nav className="batch-workspace-tabs" aria-label="配载单工作区">{tabs.map(tab=><Link key={tab.code} to={tabHref(tab.code)} className={`${activeTab===tab.code?"active":""} ${tab.done?"done":""}`.trim()} aria-current={activeTab===tab.code?"page":undefined}><span className={`status-pill ${tab.done?"success":"off"}`}>{tab.done?"已完成":"待处理"}</span><strong>{tab.title}</strong><small>{tab.body}</small></Link>)}</nav></>;
}

function BatchCustomsPortal({orders,customsSummaries}:{orders:BatchOrder[];customsSummaries:CustomsSummary[]}){
  return <section className="batch-customs-portal-table"><div className="table-wrap"><table><thead><tr><th>订单</th><th>客户</th><th>报关放行状态</th><th>操作</th></tr></thead><tbody>{orders.map(order=>{const customs=customsSummaries.find(item=>item.order_id===order.order_id);const ready=Boolean(customs&&customs.total>0&&customs.released===customs.total);return <tr className={ready?"completed-row":""} key={order.order_id}><td><strong><OrderNumberLink id={order.order_id} number={order.order_number}/></strong></td><td>{order.customer_name}</td><td><span className={`status-pill ${ready?"success":""}`}>{ready?`${customs?.released} 张已放行`:customs?.total?`${customs.released}/${customs.total} 张放行`:"待录入"}</span></td><td><a className="text-button" href={`#batch-customs-${order.order_id}`}>查看本票报关</a></td></tr>})}</tbody><tfoot><tr><td colSpan={3}>全部通过 {orders.filter(order=>{const item=customsSummaries.find(summary=>summary.order_id===order.order_id);return item&&item.total>0&&item.released===item.total}).length}/{orders.length} 票</td><td><a className="secondary" href="#batch-files">打开逐票报关工作台</a></td></tr></tfoot></table></div></section>;
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
  const draftCount=allocations.filter(item=>item.status==="draft").length;
  return <details className="panel cost-allocation-section batch-detail-disclosure"><summary className="batch-detail-summary"><div><h2>拼车成本分摊</h2><p>仅影响内部应付与毛利，不改变客户应收。</p></div><div className="batch-detail-summary-status"><span>{allocations.length} 条</span><b>{draftCount} 个待确认</b><em aria-hidden="true"/></div></summary><div className="batch-detail-disclosure-body">
    {manage&&<details className="inline-details"><summary>新增分摊草稿</summary><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="create_cost_allocation"/><label className="field"><span>费用项目</span><select name="chargeCode" required><option value="">请选择</option>{COST_CHARGES.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label><Field name="counterpartyName" label="往来单位 / 供应商" required/><Field name="totalAmount" label="费用总额" type="number" required/><Field name="currency" label="币种" required defaultValue="CNY"/><Field name="exchangeRate" label="折本位币汇率" type="number" required defaultValue="1"/><label className="field"><span>分摊方式</span><select name="method" defaultValue="auto"><option value="auto">系统建议（推荐）</option><option value="weight">按实收重量</option><option value="volume">按实收体积</option><option value="equal">按订单均分</option></select></label><label className="field span-2"><span>费用备注</span><input name="allocationNotes" placeholder="例如口岸换装运费、报关费等"/></label><button className="primary" disabled={busy}>生成分摊草稿</button></Form></details>}
    {!allocations.length&&<p className="empty-state">暂无成本分摊。仓库完成实收后，可在这里生成分摊草稿。</p>}
    <div className="cost-allocation-list">{allocations.map(allocation=><section className="cost-allocation-sheet" key={allocation.id}><div className="table-wrap cost-allocation-summary-table"><table><thead><tr><th>费用项目</th><th>往来单位</th><th>总额</th><th>分摊方式</th><th>实收重量</th><th>实收体积</th><th>密度</th><th>状态</th></tr></thead><tbody><tr><td><strong>{allocation.charge_name}</strong></td><td>{allocation.counterparty_name}</td><td>{allocation.currency} {allocation.total_amount.toFixed(2)}</td><td>{allocationMethodLabel(allocation.allocation_method)}</td><td>{allocation.total_actual_weight_kg.toFixed(2)} KG</td><td>{allocation.total_actual_volume_cbm.toFixed(3)} CBM</td><td>{allocation.density_kg_per_cbm.toFixed(2)} KG/CBM<small>{allocation.density_result}</small></td><td><span className={`status-pill ${allocation.status==="confirmed"?"success":""}`}>{allocation.status==="confirmed"?"已确认入账":"草稿待复核"}</span><small>{allocation.confirmed_at?`确认时间 ${allocation.confirmed_at}`:"系统建议可人工调整"}</small></td></tr></tbody></table></div>
      {allocation.status==="draft"&&manage?<><Form method="post"><input type="hidden" name="intent" value="update_cost_allocation"/><input type="hidden" name="allocationId" value={allocation.id}/><label className="field allocation-method"><span>复核分摊方式</span><select name="method" defaultValue={allocation.allocation_method}><option value="weight">按实收重量</option><option value="volume">按实收体积</option><option value="equal">按订单均分</option></select></label><div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>实收重量</th><th>实收体积</th><th>建议比例</th><th>建议金额</th><th>最终金额</th><th>调整原因</th></tr></thead><tbody>{allocation.lines.map(line=><tr key={line.id}><td><strong><OrderNumberLink id={line.order_id} number={line.order_number}/></strong><small>{line.customer_name}</small><input type="hidden" name="lineId" value={line.id}/></td><td>{line.actual_weight_kg.toFixed(2)} KG</td><td>{line.actual_volume_cbm.toFixed(3)} CBM</td><td>{(line.suggested_ratio*100).toFixed(2)}%</td><td>{line.suggested_amount.toFixed(2)}</td><td><input className="table-input amount" type="number" min="0" step="0.01" name="lineAmount" defaultValue={line.final_amount.toFixed(2)} required/></td><td><input className="table-input reason" name="lineReason" defaultValue={line.adjustment_reason||""} placeholder="修改金额时必填"/></td></tr>)}</tbody></table></div><button className="secondary" disabled={busy}>保存人工复核结果</button></Form><Form method="post" className="allocation-confirm-form"><input type="hidden" name="intent" value="confirm_cost_allocation"/><input type="hidden" name="allocationId" value={allocation.id}/><p>确认后将生成正式应付费用并进入内部毛利核算；客户应收仍以订单费用模块的应收记录为准。</p><button className="primary" disabled={busy}>确认分摊并生成应付</button></Form></>:<div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>实收重量</th><th>实收体积</th><th>最终分摊</th><th>费用状态</th></tr></thead><tbody>{allocation.lines.map(line=><tr key={line.id}><td><strong><OrderNumberLink id={line.order_id} number={line.order_number}/></strong><small>{line.customer_name}</small></td><td>{line.actual_weight_kg.toFixed(2)} KG</td><td>{line.actual_volume_cbm.toFixed(3)} CBM</td><td>{allocation.currency} {line.final_amount.toFixed(2)}</td><td>{line.expense_id?"已生成应付":"待生成"}</td></tr>)}</tbody></table></div>}
    </section>)}</div>
  </div></details>
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
function OverseasResourceFields({batch,carrierId,carrierVehicles,carrierDrivers}:{batch:Batch;carrierId:string;carrierVehicles:CarrierVehicleOption[];carrierDrivers:CarrierDriverOption[]}){
  const vehicles=carrierVehicles.filter(item=>item.carrier_id===carrierId);
  const drivers=carrierDrivers.filter(item=>item.carrier_id===carrierId);
  const initialVehicle=vehicles.find(item=>item.plate_number===batch.overseas_vehicle_plate);
  const initialDriver=drivers.find(item=>item.name===batch.overseas_driver_name);
  const [vehicleMasterId,setVehicleMasterId]=useState(initialVehicle?.id||""),[driverMasterId,setDriverMasterId]=useState(initialDriver?.id||"");
  const [vehicleType,setVehicleType]=useState(batch.overseas_vehicle_type||""),[plate,setPlate]=useState(batch.overseas_vehicle_plate||"");
  const [driverName,setDriverName]=useState(batch.overseas_driver_name||""),[driverPhone,setDriverPhone]=useState(batch.overseas_driver_phone||"");
  return <>
    <label className="field span-2"><span>境外车辆 *</span><select name="overseasVehicleMasterId" required value={vehicleMasterId} disabled={!carrierId} onChange={event=>{const id=event.target.value;setVehicleMasterId(id);const master=vehicles.find(item=>item.id===id);setVehicleType(master?.vehicle_type||"");setPlate(master?.plate_number||"");}}><option value="">{carrierId?"请选择当前境外承运商名下车辆":"请先选择境外承运商"}</option>{vehicles.map(item=><option key={item.id} value={item.id}>{item.plate_number}{item.vehicle_type?` · ${item.vehicle_type}`:""}</option>)}</select></label>
    <label className="field"><span>境外车型</span><input name="overseasVehicleType" value={vehicleType} readOnly placeholder="选择车辆后自动带出" /></label>
    <label className="field"><span>境外车牌号</span><input name="overseasVehiclePlate" value={plate} readOnly placeholder="选择车辆后自动带出" /></label>
    <label className="field span-2"><span>境外司机 *</span><select name="overseasDriverMasterId" required value={driverMasterId} disabled={!carrierId} onChange={event=>{const id=event.target.value;setDriverMasterId(id);const master=drivers.find(item=>item.id===id);setDriverName(master?.name||"");setDriverPhone(master?.phone||"");}}><option value="">{carrierId?"请选择当前境外承运商名下司机":"请先选择境外承运商"}</option>{drivers.map(item=><option key={item.id} value={item.id}>{item.name}{item.phone?` · ${item.phone}`:""}</option>)}</select></label>
    <label className="field"><span>司机姓名</span><input name="overseasDriverName" value={driverName} readOnly placeholder="选择司机后自动带出" /></label>
    <label className="field"><span>司机电话</span><input name="overseasDriverPhone" value={driverPhone} readOnly placeholder="选择司机后自动带出" /></label>
  </>;
}

function Field({name,label,required,type="text",defaultValue}:{name:string;label:string;required?:boolean;type?:string;defaultValue?:string}){return <label className="field"><span>{label}</span><input name={name} required={required} type={type} defaultValue={defaultValue} min={type==="number"?0:undefined} step={type==="number"?"0.001":undefined}/></label>}
function numberOf(form:FormData,name:string){const value=Number(valueOf(form,name)||0);return Number.isFinite(value)&&value>=0?value:0}
function positiveNumberOf(form:FormData,name:string,fallback=0){const value=Number(valueOf(form,name)||fallback);return Number.isFinite(value)&&value>0?value:0}
function errorMessage(error:unknown){return error instanceof Error?error.message:"操作失败，请稍后重试"}
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
        actionName:"配载单运输安排已完成",
        notes:"批次运输安排和整批车辆信息已满足，仓库可按配载单创建装车任务",
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
