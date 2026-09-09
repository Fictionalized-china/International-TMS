import { env } from "cloudflare:workers";
import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.outbound";
import { Modal, useModalScrollLock } from "../components/Modal";
import { QueryPagination } from "../components/QueryPagination";
import { ActionToast } from "../components/ActionToast";
import { Code39 } from "../components/OrderMarkLabelPage";
import { requireSessionUser } from "../lib/auth.server";
import { validatePhone, valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { syncOrderWorkflowSnapshot } from "../lib/order-modules.server";
import { isValidCustomerIdentityCode } from "../lib/customer-identity";
import { maxInlineOrderDocumentBytes } from "../lib/order-documents";
import { submitForm } from "../lib/form-submit";
import { checkOrderLoadPlan } from "../lib/order-readiness.server";
import { refreshLoadingManifest } from "../lib/loading-manifest.server";
import {
  currentStageLoadingDocumentRequirements,
  loadingOrderDocumentDefinitions,
  type LoadingOrderDocumentCode,
} from "../lib/loading-document-requirements";
import { loadOrderLoadingDocumentRequirements } from "../lib/loading-document-requirements.server";
import { loadOrderDocumentWorkflowMutationAccess } from "../lib/order-document-access.server";
import {
  hasOrderDocumentSystemOverride,
  isOrderDocumentSelfReviewBlocked,
} from "../lib/order-document-access";
import {
  loadingDispatchPlanPolicyIssues,
  loadingBatchResourcePolicy,
  resolveLoadingBatchFieldPolicies,
  resolveLoadingBatchStageGate,
  type LoadingBatchFieldPolicies,
  type LoadingBatchStageGate,
  type LoadingBatchWorkflowOrder,
} from "../lib/loading-batch-field-policy";
import { loadLoadingBatchWorkflowOrders } from "../lib/loading-batch-field-policy.server";
import { recordBatchOutboundProgress, recordWarehouseProgress } from "../lib/warehouse-progress.server";
import {
  isExplicitDispatchCreationConfirmation,
  resolveWarehouseOutboundWorkflowPolicyForOrders,
  type WarehouseOutboundWorkflowPolicy,
} from "../lib/warehouse-outbound-policy";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { canOperateWarehouseUi } from "../lib/warehouse-ui-access";
import { canUseAdminSite } from "../lib/site-account-access";
import {
  findWarehouseOutboundLoadUnit,
  filterWarehouseOutboundLoadUnits,
  isConsolidatedOutboundTask,
  normalizeWarehouseOutboundListFilters,
  validateFtlOutboundRouteFields,
  validateFtlOutboundRouteSubmission,
  validateFtlOutboundResourceSelection,
} from "../lib/warehouse-outbound-list";
import { warehouseOutboundRemediations } from "../lib/warehouse-outbound-remediation";
import { chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import { paginateList, readListPage } from "../lib/list-pagination";
import { completeWarehouseDispatchTransaction } from "../lib/warehouse-outbound-dispatch.server";
import { buildWarehousePackingPlan, type PackingOrderRequest } from "../lib/warehouse-packing-plan";
import { oulCode, randomOulSuffix } from "../lib/package-identity";

const LOADING_DOCUMENTS=loadingOrderDocumentDefinitions;
const LOADING_DOCUMENT_PLACEHOLDERS=LOADING_DOCUMENTS.map(()=>"?").join(",");
type LoadingDocumentCode=LoadingOrderDocumentCode;
type Batch={id:string;batch_number:string;shipment_id:string;shipment_number:string;order_id:string;order_number:string;customer_id:string;customer_name:string;customer_identity_code:string;business_type:string;exit_port:string|null;customs_location:string|null;destination_location:string;destination_summary?:string;item_count:number;total_pieces:number;total_weight_kg:number;total_volume_cbm:number;received_at:string|null;verified_at:string|null;storage_locations:string;packing_job_id:string;packing_job_status:"labelled"|"allocated";transport_batch_id:string|null;transport_batch_number:string|null;transport_batch_origin_location:string|null;transport_batch_destination_location:string|null;transport_batch_approval_status:string|null;related_order_ids:string;order_count:number;order_numbers:string;customer_names:string;customer_identity_codes:string};
type Dispatch={id:string;dispatch_number:string;batch_number:string;shipment_id:string;shipment_number:string;order_id:string;order_number:string;business_type:string;outbound_resource_confirmed:number;order_numbers:string|null;related_order_ids:string|null;customer_id:string;customer_name:string;customer_names:string|null;customer_identity_code:string;exit_port:string|null;customs_location:string|null;vehicle_plate:string;driver_name:string;driver_phone:string|null;carrier_name:string|null;notes:string|null;destination:string;status:string;item_count:number;loaded_count:number;pieces:number;weight_kg:number;volume_cbm:number;created_at:string;dispatched_at:string|null;creator_name:string|null;transport_batch_id:string|null;planned_departure_at:string|null;planned_arrival_at:string|null;road_status:string|null;actual_departure_at:string|null};
type Item={id:string;dispatch_id:string;order_id:string;order_number:string;barcode:string;package_number:string;cargo_name_cn:string|null;package_type:string|null;pieces:number;weight_kg:number|null;volume_cbm:number|null;length_cm:number|null;width_cm:number|null;height_cm:number|null;status:string;loaded_at:string|null};
type DispatchShipment={shipment_id:string;order_id:string;order_number:string;customer_id:string;current_location:string|null};
type DispatchPlan={batch_id:string|null;carrier_id:string|null;vehicle_id:string|null;vehicle_type:string|null;vehicle_plate:string|null;driver_id:string|null;driver_name:string|null;driver_phone:string|null;carrier_name:string|null;planned_departure_at:string|null;planned_arrival_at:string|null};
type CarrierOption={id:string;name:string};
type VehicleOption={id:string;carrier_id:string;carrier_name:string;plate_number:string;vehicle_type:string|null};
type DriverOption={id:string;carrier_id:string;carrier_name:string;name:string;phone:string|null};
type OutboundResources={carriers:CarrierOption[];vehicles:VehicleOption[];drivers:DriverOption[]};
type PendingOutboundDriver={id:string;carrierId:string;name:string;phone:string|null;licenseNumber:string|null};
type PackingBatchSummary={id:string;order_id:string;order_number:string;packing_mode:"preserve"|"merge"|"split";source_package_count:number;outbound_package_count:number;total_weight_kg:number|null;total_volume_cbm:number|null;revision:number;status:"generated"|"printed"|"labelled"|"allocated"|"loading"|"dispatched"|"cancelled";labels_printed_at:string|null;labeling_confirmed_at:string|null;flow_source:"predispatch"|"legacy"};
type ReferenceOption={category:"border_port"|"customs_place";code:string;name:string};
type ManifestDoc={id:string;order_id:string;file_name:string;review_status:string;created_at:string};
type OutboundDocument={orderId:string;orderNumber:string;customerId:string;customerName:string;required:boolean;attachmentId:string|null;code:LoadingDocumentCode;name:string;fileName:string|null;contentType:string|null;sizeBytes:number|null;reviewStatus:string|null;uploadedByUserId:string|null};
type OutboundDocumentGroup={orderId:string;orderNumber:string;customerId:string;customerName:string;documents:OutboundDocument[];allUploaded:boolean;allApproved:boolean};
type OutboundOrderSummary={orderId:string;orderNumber:string;customerName:string;cargoSummary:string;oulCount:number;pieces:number;weightKg:number;volumeCbm:number;storageLocations:string;requiredDocumentCount:number;approvedDocumentCount:number};
type PackingSource={id:string;orderId:string;orderNumber:string;shipmentId:string;cargoItemId:string|null;receiptId:string;locationId:string;markId:string;markCode:string;weightKg:number|null;volumeCbm:number|null};
type OutboundExecutionPolicy=WarehouseOutboundWorkflowPolicy&{batchFields:LoadingBatchFieldPolicies;resources:ReturnType<typeof loadingBatchResourcePolicy>;loadingStage:LoadingBatchStageGate};
type OutboundPolicyDifference={fieldKey:string;label:string;mode:"optional"};
type OutboundTaskWorkflowState={scanConfirmation:WarehouseOutboundWorkflowPolicy["scanConfirmation"];loadingStage:LoadingBatchStageGate;workflowSyncPending:boolean};
type OutboundInspection={batch:Batch;documentGroups:OutboundDocumentGroup[];documents:OutboundDocument[];orderSummaries:OutboundOrderSummary[];packingSources:PackingSource[];allUploaded:boolean;allApproved:boolean;notesActive:boolean;notesRequired:boolean;scanActive:boolean;scanRequired:boolean;executionPolicy:OutboundExecutionPolicy;dispatchPlan:DispatchPlan|null;resourceDifferences:OutboundPolicyDifference[];resourcePolicyError:string|null};
type ReadyPackingJob={id:string;order_id:string;status:"labelled"|"allocated";transport_batch_id:string|null;outbound_package_count:number;oul_count:number};

const availablePackedBatchSql=`SELECT b.id,b.batch_number,b.shipment_id,s.shipment_number,
    o.id order_id,o.order_number,o.customer_id,c.name customer_name,c.identity_code customer_identity_code,
    o.business_type,o.exit_port,o.customs_location,
    TRIM(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city) destination_summary,
    TRIM(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city||CASE WHEN NULLIF(TRIM(o.destination_address),'') IS NOT NULL THEN ' '||o.destination_address ELSE '' END) destination_location,
    COUNT(DISTINCT package_row.id) item_count,COALESCE(SUM(package_row.pieces),0) total_pieces,
    job.total_weight_kg total_weight_kg,job.total_volume_cbm total_volume_cbm,
    b.verified_at,COALESCE(REPLACE(GROUP_CONCAT(DISTINCT COALESCE(NULLIF(TRIM(location.code),''),location.name)),',','、'),'') storage_locations,
    (SELECT MIN(receipt.received_at) FROM warehouse_receipts receipt
      WHERE receipt.organization_id=job.organization_id AND receipt.shipment_id=job.shipment_id
        AND receipt.warehouse_id=job.warehouse_id AND receipt.status='completed') received_at,
    job.id packing_job_id,job.status packing_job_status,
    transport_batch.id transport_batch_id,transport_batch.batch_number transport_batch_number,
    transport_batch.origin_location transport_batch_origin_location,transport_batch.destination_location transport_batch_destination_location,
    CASE WHEN transport_batch.approval_status='approved' AND transport_batch.operation_assignee_user_id IS NOT NULL
      AND transport_batch.document_assignee_user_id IS NOT NULL THEN 'approved'
      WHEN transport_batch.approval_status='approved' THEN 'assignment_incomplete'
      ELSE transport_batch.approval_status END transport_batch_approval_status
  FROM warehouse_packing_jobs job
  JOIN transport_orders o ON o.id=job.order_id AND o.organization_id=job.organization_id
  JOIN shipments s ON s.id=job.shipment_id AND s.organization_id=job.organization_id AND s.order_id=o.id
  JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
  JOIN warehouse_packages package_row ON package_row.packing_job_id=job.id
    AND package_row.organization_id=job.organization_id AND package_row.warehouse_id=job.warehouse_id
    AND package_row.label_kind='oul' AND package_row.lifecycle_status='active' AND package_row.status='in_stock'
  JOIN warehouse_sorting_batches b ON b.organization_id=job.organization_id AND b.shipment_id=job.shipment_id
    AND b.status='verified' AND b.id=(SELECT latest.id FROM warehouse_sorting_batches latest
      WHERE latest.organization_id=job.organization_id AND latest.shipment_id=job.shipment_id
        AND latest.status='verified' ORDER BY latest.verified_at DESC,latest.id DESC LIMIT 1)
  LEFT JOIN warehouse_locations location ON location.id=package_row.location_id AND location.organization_id=package_row.organization_id
  LEFT JOIN transport_batches transport_batch ON transport_batch.id=job.transport_batch_id
    AND transport_batch.organization_id=job.organization_id AND transport_batch.warehouse_id=job.warehouse_id
    AND transport_batch.batch_number LIKE 'PZ-%' AND transport_batch.status IN ('planning','loading')
  WHERE job.organization_id=? AND job.warehouse_id=? AND job.dispatch_id IS NULL
    AND ((o.business_type='ftl' AND job.status='labelled' AND job.transport_batch_id IS NULL)
      OR (o.business_type='ltl' AND job.status='allocated' AND transport_batch.id IS NOT NULL))`;

export const NEW_OUTBOUND_DRIVER_ID="__new_outbound_driver__";

export function validateNewOutboundDriverRegistration(input:{
  driverId:string;
  carrierId:string;
  name:string;
  phone:string;
  phoneRequired:boolean;
}){
  if(input.driverId!==NEW_OUTBOUND_DRIVER_ID)return null;
  if(!input.carrierId.trim())return"请先选择境外承运商，再新建司机";
  if(input.name.trim().length<2)return"新司机姓名至少填写 2 个字符";
  if(input.phoneRequired&&!input.phone.trim())return"请填写新司机手机号";
  return input.phone.trim()?validatePhone(input.phone.trim(),"新司机手机号")??null:null;
}

export function warehouseDispatchCreationErrorMessage(error:unknown){
  const message=error instanceof Error?`${error.message} ${String((error as Error&{cause?:unknown}).cause??"")}`:String(error);
  if(message.includes("packing_job_dispatch_claim_invalid"))return"装车任务未创建：配载单中的包装任务归属已变化，请刷新本页核对订单与 OUL 后重试";
  return"装车任务创建失败，系统没有写入不完整任务；请刷新本页核对装车条件后重试";
}

export function warehouseDispatchCompletionResult({dispatchNumber,businessType,completionWarningText}:{dispatchNumber:string;businessType:string;completionWarningText:string}){
  return{success:(businessType==="ltl"
    ?`${dispatchNumber} 已完成装车出库交接，交接数据已同步管理端；请回 PZ 配载单执行实际出境确认，运单此时尚未进入在途`
    :`${dispatchNumber} 已完成整车装车出库交接，车辆与司机信息已同步管理端；后续由订单的报关及出境运输节点确认实际出境`)+completionWarningText};
}

export function warehouseOutboundWorkflowActionError(policy:{loadingStage:LoadingBatchStageGate}|null){
  if(!policy)return "当前订单工作流已隐藏装车与出库模块，不能继续办理";
  if(policy.loadingStage.available)return null;
  return policy.loadingStage.reason||"无法确认冻结工作流的装车与出库办理节点，请刷新后重试";
}

export function warehouseOutboundRouteSyncState(stage:LoadingBatchStageGate|null,currentStepKey:string|null){
  const targetStepKey=stage?.targetStepKey??null;
  if(!targetStepKey)return{targetStepKey:null,resynchronized:null,pendingReason:"该历史订单没有冻结装车节点，路线已保存，但无法判定工作流同步结果"};
  if(!currentStepKey)return{targetStepKey,resynchronized:null,pendingReason:"工作流同步后未返回当前节点，请刷新后重试"};
  const resynchronized=currentStepKey!==targetStepKey;
  return{
    targetStepKey,
    resynchronized,
    pendingReason:resynchronized?null:`当前仍处于“${stage?.targetStepName||targetStepKey}”，尚有其他工作流必填项待补`,
  };
}

export function warehouseOutboundNeedsScanDifferenceConfirmation(
  scanPolicy: Pick<WarehouseOutboundWorkflowPolicy["scanConfirmation"],"mode">,
  missingScanCount: number,
){
  return scanPolicy.mode==="optional"&&missingScanCount>0;
}

export function warehouseOutboundDispatchScanError(
  scanPolicy: Pick<WarehouseOutboundWorkflowPolicy["scanConfirmation"],"mode"|"isRequired">,
  total: number,
  loaded: number,
  differenceConfirmed: boolean,
){
  if(total<=0)return "当前装车任务没有货物，不能出库交接";
  const missing=Math.max(0,total-loaded);
  if(scanPolicy.isRequired&&missing>0)
    return `逐件扫码为必填：当前 ${loaded}/${total}，不能出库交接`;
  if(warehouseOutboundNeedsScanDifferenceConfirmation(scanPolicy,missing)&&!differenceConfirmed)
    return `尚有 ${missing} 个货物码未扫描；请在页面再次明确确认后出库`;
  return null;
}

export function warehouseOutboundWorkflowSyncPending(
  orders: readonly Pick<LoadingBatchWorkflowOrder,"usesFrozenSnapshot"|"currentStepKey"|"loadingTargetStepKey">[],
){
  return orders.some(order=>Boolean(
    order.usesFrozenSnapshot&&order.currentStepKey&&order.loadingTargetStepKey&&
    order.currentStepKey===order.loadingTargetStepKey,
  ));
}

export function OutboundBarcodeInput({busy}:{busy:boolean}){
  return <input name="barcode" placeholder="扫描或输入本任务中的货物标签条码" autoComplete="off" autoFocus required disabled={busy}/>;
}

function groupPendingLoadUnits(rows:Batch[]){
  const groups=new Map<string,Batch[]>();
  for(const row of rows){
    const key=isConsolidatedOutboundTask(row.business_type,row.transport_batch_id)?`pz:${row.transport_batch_id}`:`order:${row.id}`;
    groups.set(key,[...(groups.get(key)||[]),row]);
  }
  return[...groups.values()].map(group=>{
    const lead=group[0],orders=[...new Map(group.map(row=>[row.order_id,row])).values()];
    const storageLocations=[...new Set(group.flatMap(row=>row.storage_locations.split("、")).filter(Boolean))];
    return{...lead,batch_number:lead.transport_batch_number||lead.batch_number,related_order_ids:orders.map(row=>row.order_id).join(","),order_count:orders.length,order_numbers:orders.map(row=>row.order_number).join("、"),customer_names:[...new Set(orders.map(row=>row.customer_name))].join("、"),customer_identity_codes:[...new Set(orders.map(row=>row.customer_identity_code))].join("、"),item_count:group.reduce((sum,row)=>sum+Number(row.item_count||0),0),total_pieces:group.reduce((sum,row)=>sum+Number(row.total_pieces||0),0),total_weight_kg:group.reduce((sum,row)=>sum+Number(row.total_weight_kg||0),0),total_volume_cbm:group.reduce((sum,row)=>sum+Number(row.total_volume_cbm||0),0),received_at:group.map(row=>row.received_at).filter((value):value is string=>Boolean(value)).sort()[0]??null,verified_at:group.map(row=>row.verified_at).filter((value):value is string=>Boolean(value)).sort().at(-1)??null,storage_locations:storageLocations.join("、")};
  });
}

function dispatchOrderIds(dispatch:Pick<Dispatch,"related_order_ids"|"order_id">){
  const related=dispatch.related_order_ids?.split(",").filter(Boolean)??[];
  return related.length?related:[dispatch.order_id];
}

export async function loader({request}:Route.LoaderArgs){
  const user=await requireSessionUser(request,"warehouse.view","warehouse");
  const warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected,url=new URL(request.url),orderId=url.searchParams.get("orderId"),requestedView=url.searchParams.get("view"),requestedDispatchId=url.searchParams.get("dispatchId"),filters=normalizeWarehouseOutboundListFilters(url.searchParams),pendingPage=readListPage(url.searchParams,"pendingPage"),taskPage=readListPage(url.searchParams,"taskPage"),itemPage=readListPage(url.searchParams,"itemPage");
  if(warehouse.warehouse_role==="overseas_destination")throw redirect(`/warehouse/inbound${url.search}`);
  const [batches,dispatches,carriers,vehicles,drivers,routeOptions]=await Promise.all([
    env.DB.prepare(`${availablePackedBatchSql}
      GROUP BY b.id,job.id ORDER BY b.verified_at DESC`).bind(user.organizationId,warehouse.id).all<Batch>(),
    env.DB.prepare(`SELECT d.id,d.dispatch_number,COALESCE(tb.batch_number,b.batch_number) batch_number,d.shipment_id,s.shipment_number,o.id order_id,o.order_number,o.business_type,CASE WHEN o.business_type='ltl' AND d.transport_batch_id IS NOT NULL THEN 1 WHEN EXISTS(SELECT 1 FROM order_transport_assignments confirmed WHERE confirmed.organization_id=d.organization_id AND confirmed.order_id=o.id AND confirmed.leg_type='main' AND confirmed.status!='cancelled') THEN 1 ELSE 0 END outbound_resource_confirmed,GROUP_CONCAT(DISTINCT po.order_number) order_numbers,GROUP_CONCAT(DISTINCT ps.order_id) related_order_ids,c.id customer_id,c.name customer_name,GROUP_CONCAT(DISTINCT pc.name) customer_names,c.identity_code customer_identity_code,o.exit_port,o.customs_location,d.vehicle_plate,d.driver_name,d.driver_phone,d.carrier_name,d.notes,d.destination,d.status,COUNT(di.id) item_count,SUM(CASE WHEN di.status='loaded' THEN 1 ELSE 0 END) loaded_count,COALESCE(SUM(p.pieces),0) pieces,COALESCE(SUM(p.weight_kg),0) weight_kg,COALESCE(SUM(p.volume_cbm),0) volume_cbm,d.created_at,d.dispatched_at,u.display_name creator_name,tb.id transport_batch_id,COALESCE(tb.planned_departure_at,(SELECT a.planned_departure_at FROM order_transport_assignments a WHERE a.organization_id=d.organization_id AND a.order_id=o.id AND a.leg_type='main' AND a.status!='cancelled' ORDER BY a.updated_at DESC LIMIT 1)) planned_departure_at,COALESCE(tb.planned_arrival_at,(SELECT a.planned_arrival_at FROM order_transport_assignments a WHERE a.organization_id=d.organization_id AND a.order_id=o.id AND a.leg_type='main' AND a.status!='cancelled' ORDER BY a.updated_at DESC LIMIT 1)) planned_arrival_at,tb.road_status,tb.actual_departure_at
      FROM warehouse_dispatches d
      JOIN warehouse_sorting_batches b ON b.id=d.sorting_batch_id AND b.organization_id=d.organization_id
      JOIN shipments s ON s.id=d.shipment_id AND s.organization_id=d.organization_id
      JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
      LEFT JOIN transport_batches tb ON tb.id=d.transport_batch_id AND tb.organization_id=d.organization_id AND tb.warehouse_id=?
      JOIN customers c ON c.id=s.customer_id AND c.organization_id=s.organization_id AND c.id=o.customer_id
      LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
      LEFT JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
      LEFT JOIN shipments ps ON ps.id=p.shipment_id AND ps.organization_id=p.organization_id
      LEFT JOIN transport_orders po ON po.id=ps.order_id AND po.organization_id=ps.organization_id
      LEFT JOIN customers pc ON pc.id=po.customer_id AND pc.organization_id=po.organization_id
      LEFT JOIN users u ON u.id=d.created_by_user_id
        AND EXISTS(SELECT 1 FROM memberships creator_membership WHERE creator_membership.user_id=u.id AND creator_membership.organization_id=d.organization_id AND creator_membership.status='active')
      WHERE d.organization_id=?
        AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id AND wp.organization_id=wi.organization_id WHERE wi.dispatch_id=d.id AND wi.organization_id=d.organization_id AND wp.warehouse_id=?)
        AND NOT EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id AND wp.organization_id=wi.organization_id WHERE wi.dispatch_id=d.id AND wi.organization_id=d.organization_id AND wp.warehouse_id<>?)
      GROUP BY d.id ORDER BY CASE d.status WHEN 'loading' THEN 1 ELSE 2 END,d.updated_at DESC`).bind(warehouse.id,user.organizationId,warehouse.id,warehouse.id).all<Dispatch>(),
    env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND status='active' AND carrier_scope='overseas' ORDER BY name").bind(user.organizationId).all<CarrierOption>(),
    env.DB.prepare(`SELECT v.id,v.carrier_id,c.name carrier_name,v.plate_number,v.vehicle_type FROM carrier_vehicles v JOIN carriers c ON c.id=v.carrier_id AND c.organization_id=v.organization_id WHERE v.organization_id=? AND v.status='active' AND c.status='active' AND c.carrier_scope='overseas' ORDER BY c.name,v.plate_number`).bind(user.organizationId).all<VehicleOption>(),
    env.DB.prepare(`SELECT d.id,d.carrier_id,c.name carrier_name,d.name,d.phone FROM carrier_drivers d JOIN carriers c ON c.id=d.carrier_id AND c.organization_id=d.organization_id WHERE d.organization_id=? AND d.status='active' AND c.status='active' AND c.carrier_scope='overseas' ORDER BY c.name,d.name`).bind(user.organizationId).all<DriverOption>(),
    env.DB.prepare("SELECT category,code,name FROM reference_data WHERE organization_id=? AND category IN ('border_port','customs_place') AND status='active' ORDER BY category,sort_order,code").bind(user.organizationId).all<ReferenceOption>(),
  ]);
  const outboundOrderIds=[...new Set([
    ...batches.results.map(item=>item.order_id),
    ...dispatches.results.flatMap(dispatchOrderIds),
  ])];
  const [enabledLoadingOrderIds,outboundWorkflowOrders]=await Promise.all([
    loadEnabledLoadingOrderIds(user.organizationId,outboundOrderIds),
    loadLoadingBatchWorkflowOrders(user.organizationId,outboundOrderIds),
  ]);
  const outboundWorkflowByOrderId=new Map(outboundWorkflowOrders.map(order=>[order.orderId,order]));
  const outboundOrderLabels=new Map<string,string>(batches.results.map(item=>[item.order_id,item.order_number]));
  for(const dispatch of dispatches.results){
    const orderIds=dispatchOrderIds(dispatch);
    const orderNumbers=dispatch.order_numbers?.split(",").filter(Boolean)??[dispatch.order_number];
    orderIds.forEach((orderId,index)=>outboundOrderLabels.set(orderId,orderNumbers[index]??orderId));
  }
  const enabledBatches=batches.results.filter(item=>enabledLoadingOrderIds.has(item.order_id));
  const enabledDispatches=dispatches.results.filter(item=>dispatchOrderIds(item).every(orderId=>enabledLoadingOrderIds.has(orderId)));
  const pendingUnits=groupPendingLoadUnits(enabledBatches);
  const visibleBatches=orderId?pendingUnits.filter(batch=>batch.related_order_ids.split(",").includes(orderId)):pendingUnits;
  const visibleDispatches=orderId?enabledDispatches.filter((dispatch)=>dispatchOrderIds(dispatch).includes(orderId)):enabledDispatches;
  const taskWorkflowStates:Record<string,OutboundTaskWorkflowState>={};
  for(const dispatch of visibleDispatches){
    const orderIds=dispatchOrderIds(dispatch);
    const workflowOrders=orderIds.flatMap(orderId=>{
      const workflowOrder=outboundWorkflowByOrderId.get(orderId);
      return workflowOrder?[workflowOrder]:[];
    });
    const loadingStage=resolveLoadingBatchStageGate(workflowOrders,outboundOrderLabels);
    taskWorkflowStates[dispatch.id]={
      scanConfirmation:resolveWarehouseOutboundWorkflowPolicyForOrders(workflowOrders).scanConfirmation,
      loadingStage,
      workflowSyncPending:dispatch.status==="dispatched"&&warehouseOutboundWorkflowSyncPending(workflowOrders),
    };
  }
  const selectedDispatch=requestedDispatchId?visibleDispatches.find(dispatch=>dispatch.id===requestedDispatchId)??null:null;
  const items=selectedDispatch
    ?(await env.DB.prepare(`SELECT di.id,di.dispatch_id,o.id order_id,o.order_number,p.barcode,p.package_number,COALESCE(NULLIF(TRIM(ci.cargo_name_cn),''),NULLIF(TRIM(o.cargo_description),'')) cargo_name_cn,COALESCE(r.package_type,ci.package_type) package_type,p.pieces,p.weight_kg,p.volume_cbm,p.length_cm,p.width_cm,p.height_cm,di.status,di.loaded_at
      FROM warehouse_dispatch_items di
      JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
      LEFT JOIN warehouse_receipts r ON r.id=p.receipt_id AND r.organization_id=p.organization_id
      JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
      JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
      LEFT JOIN order_cargo_items ci ON ci.id=p.cargo_item_id AND ci.organization_id=p.organization_id
      WHERE di.organization_id=? AND p.warehouse_id=? AND di.dispatch_id=? AND p.label_kind='oul' AND p.lifecycle_status!='voided'
      ORDER BY o.order_number,COALESCE(di.loaded_at,p.created_at) DESC LIMIT 1000`).bind(user.organizationId,warehouse.id,selectedDispatch.id).all<Item>()).results
    :[];
  const itemPagination=paginateList(items,itemPage);
  const predispatchPackingJobs=selectedDispatch
    ?(await env.DB.prepare(`SELECT job.id,job.order_id,o.order_number,job.packing_mode,job.source_package_count,
        job.outbound_package_count,job.total_weight_kg,job.total_volume_cbm,1 revision,job.status,
        NULL labels_printed_at,job.labeling_confirmed_at,'predispatch' flow_source
      FROM warehouse_packing_jobs job
      JOIN transport_orders o ON o.id=job.order_id AND o.organization_id=job.organization_id
      WHERE job.organization_id=? AND job.warehouse_id=? AND job.dispatch_id=? AND job.status!='cancelled'
      ORDER BY o.order_number`).bind(user.organizationId,warehouse.id,selectedDispatch.id).all<PackingBatchSummary>()).results
    :[];
  const packingBatches=predispatchPackingJobs.length?predispatchPackingJobs:selectedDispatch
    ?(await env.DB.prepare(`SELECT pb.id,pb.order_id,o.order_number,pb.packing_mode,pb.source_package_count,pb.outbound_package_count,
        pb.total_weight_kg,pb.total_volume_cbm,pb.revision,pb.status,pb.labels_printed_at,pb.labeling_confirmed_at,'legacy' flow_source
      FROM warehouse_packing_batches pb
      JOIN transport_orders o ON o.id=pb.order_id AND o.organization_id=pb.organization_id
      WHERE pb.organization_id=? AND pb.warehouse_id=? AND pb.dispatch_id=? AND pb.status!='cancelled'
      ORDER BY o.order_number`).bind(user.organizationId,warehouse.id,selectedDispatch.id).all<PackingBatchSummary>()).results
    :[];
  const selectedExecutionPolicy=selectedDispatch
    ?await loadDispatchWorkflowPolicy(user.organizationId,warehouse.id,selectedDispatch.id)
    :null;
  let selectedResourceDifferences:OutboundPolicyDifference[]=[],selectedResourcePolicyError:string|null=null;
  if(selectedDispatch?.business_type==="ltl"&&selectedExecutionPolicy){
    const plan=await resolveDispatchPlan(user.organizationId,selectedDispatch.order_id,selectedDispatch.business_type,selectedDispatch.transport_batch_id,selectedExecutionPolicy.batchFields,warehouse.id);
    if("error" in plan)selectedResourcePolicyError=plan.error;
    else selectedResourceDifferences=dispatchPlanPolicyIssues(selectedExecutionPolicy.batchFields,plan).differences;
  }
  const evaluated:Array<{batch:Batch;readiness:{ready:boolean;reasons:string[]}}>=[];
  for(const batch of visibleBatches){
    const relatedOrderIds=batch.related_order_ids.split(",").filter(Boolean);
    const relatedWorkflowOrders=relatedOrderIds.flatMap(orderId=>{const workflowOrder=outboundWorkflowByOrderId.get(orderId);return workflowOrder?[workflowOrder]:[];});
    const loadingStage=resolveLoadingBatchStageGate(relatedWorkflowOrders,outboundOrderLabels);
    const stageReasons=loadingStage.available?[]:[loadingStage.reason||"无法确认冻结工作流的装车与出库办理节点，请刷新后重试"];
    if(batch.transport_batch_id){
      const readiness=await checkBatchWarehouseReadiness(user.organizationId,warehouse.id,batch.transport_batch_id);
      const blocked=readiness.orders.filter(item=>item.reasons.length>0);
      const approvalReasons=batch.transport_batch_approval_status==="approved"?[]:["配载单待操作主管审核并同时指定整单操作与单证负责人"];
      evaluated.push({batch,readiness:{ready:blocked.length===0&&approvalReasons.length===0&&loadingStage.available,reasons:[...stageReasons,...approvalReasons,...blocked.flatMap(item=>item.reasons.map(reason=>`${item.orderNumber}：${reason}`))]}});
    }else{
      const readiness=await checkOrderLoadPlan(user.organizationId,batch.order_id,undefined,undefined,{mode:"entry"});
      evaluated.push({batch,readiness:{ready:readiness.ready&&loadingStage.available,reasons:[...stageReasons,...readiness.reasons]}});
    }
  }
  const loadUnits=evaluated.map(item=>({...item.batch,ready:item.readiness.ready,reasons:item.readiness.reasons}));
  const filteredLoadUnits=filterWarehouseOutboundLoadUnits(loadUnits,filters);
  const pendingPagination=paginateList(filteredLoadUnits,pendingPage);
  const sortedExecutionTasks=[...visibleDispatches].sort((left,right)=>dispatchTaskPriority(left,taskWorkflowStates[left.id])-dispatchTaskPriority(right,taskWorkflowStates[right.id])||(right.dispatched_at||right.created_at).localeCompare(left.dispatched_at||left.created_at));
  const taskPagination=paginateList(sortedExecutionTasks,taskPage);
  const manifestsByOrder:Record<string,ManifestDoc>={};
  if(selectedDispatch?.transport_batch_id){
    const manifest=await env.DB.prepare(`SELECT d.id,? order_id,d.file_name,d.review_status,d.created_at
      FROM transport_batch_documents d
      JOIN transport_batches b ON b.id=d.batch_id AND b.organization_id=d.organization_id
      WHERE d.organization_id=? AND d.batch_id=? AND b.warehouse_id=?
        AND d.document_category='loading_manifest' AND d.review_status IN ('approved','archived')
      ORDER BY CASE d.review_status WHEN 'approved' THEN 0 ELSE 1 END,d.created_at DESC LIMIT 1`)
      .bind(selectedDispatch.order_id,user.organizationId,selectedDispatch.transport_batch_id,warehouse.id).first<ManifestDoc>();
    if(manifest)manifestsByOrder[manifest.order_id]=manifest;
  }
  const requestedBatchId=url.searchParams.get("batchId");
  const selectedLoadUnit=findWarehouseOutboundLoadUnit(loadUnits,requestedBatchId)
    ??(requestedView==="create"&&orderId&&visibleBatches.length===1
      ?loadUnits.find((unit)=>unit.id===visibleBatches[0].id)??null
      :null);
  const requestedInspection=selectedLoadUnit
    ?await loadOutboundInspection(user.organizationId,warehouse.id,selectedLoadUnit)
    :null;
  const view=requestedView==="execution"||requestedView==="pending"||requestedView==="create"
    ?requestedView
    :orderId&&visibleDispatches.some(dispatch=>dispatch.status==="loading")?"execution":"pending";
  const viewParams=new URLSearchParams(url.search);
  viewParams.delete("batchId");
  viewParams.delete("dispatchId");
  viewParams.delete("warehouseResult");
  viewParams.delete("warehouseError");
  const viewHref=(nextView:"pending"|"execution")=>{
    const params=new URLSearchParams(viewParams);
    params.set("view",nextView);
    return `/warehouse/outbound?${params.toString()}`;
  };
  return{
    user,warehouse,warehouseAccessLevel:warehouseContext.selectedAccessLevel,
    loadUnits:pendingPagination.items,
    pendingPagination,
    loadUnitCounts:{all:loadUnits.length,ready:loadUnits.filter(item=>item.ready).length,blocked:loadUnits.filter(item=>!item.ready).length},
    filters,
    dispatches:visibleDispatches,
    executionTasks:taskPagination.items,
    taskPagination,
    items,
    visibleItems:itemPagination.items,
    itemPagination,
    packingBatches,
    orderId,
    returnTo:url.searchParams.get("returnTo"),
    view,
    pendingHref:viewHref("pending"),
    executionHref:viewHref("execution"),
    requestedDispatchId,
    selectedExecutionPolicy,
    taskWorkflowStates,
    selectedResourceDifferences,
    selectedResourcePolicyError,
    selectedLoadUnit,
    requestedInspection,
    manifestsByOrder,
    outboundResources:{carriers:carriers.results,vehicles:vehicles.results,drivers:drivers.results},
    borderPorts:routeOptions.results.filter(item=>item.category==="border_port"),
    customsPlaces:routeOptions.results.filter(item=>item.category==="customs_place"),
  };
}

export async function action({request}:Route.ActionArgs){
  const user=await requireSessionUser(request,"warehouse.operate","warehouse"),warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected,form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  await requireWarehouseAssignment(user,warehouse.id,"operator");
  if(intent==="inspect_ftl_documents"){
    const batchId=valueOf(form,"batchId"),orderNumber=valueOf(form,"orderNumber").trim(),customerIdentityCode=valueOf(form,"customerIdentityCode").trim().toUpperCase();
    if(!batchId&&!orderNumber)return{formError:"请输入订单号或选择待装车单位"};
    if(customerIdentityCode&&!isValidCustomerIdentityCode(customerIdentityCode))return{formError:"客户识别码应为5位字母与数字混合，且不包含 O、0、1、L"};
    const matches=await findAvailableOutboundBatches(user.organizationId,warehouse.id,{batchId,orderNumber,customerIdentityCode});
    if(matches.length>1)return{formError:"该订单存在多个可用入库记录，请从待装车列表选择具体订单或 PZ 配载单"};
    const batch=matches[0];
    if(!batch){
      const existing=orderNumber?await findExistingDispatch(user.organizationId,warehouse.id,orderNumber):null;
      if(existing)return{formError:`${orderNumber} 已经创建装车任务 ${existing.dispatch_number}，当前状态：${existing.status==="loading"?"装车中":"已出库交接"}。请进入“装车与出库”页面继续办理。`};
      const diagnosis=orderNumber?await diagnoseOutboundOrder(user.organizationId,warehouse.id,orderNumber):null;
      return{formError:diagnosis||`未找到已确认货齐且尚未创建装车任务的订单${orderNumber?`：${orderNumber}`:""}`};
    }
    const inspection=await loadOutboundInspection(user.organizationId,warehouse.id,batch);
    if(!inspection)return{formError:"当前订单工作流未启用装车与出库模块，不能在仓库工作台办理"};
    return{actionKind:"ftl_inspected" as const,uploadOpenSignal:now,inspection};
  }
  if(intent==="loading_document_upload"){
    const inspectionOrderId=valueOf(form,"inspectionOrderId"),orderId=valueOf(form,"orderId"),batchId=valueOf(form,"batchId"),documentCategory=valueOf(form,"documentCategory") as LoadingDocumentCode;
    const inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,inspectionOrderId,batchId);
    if(!inspection)return{formError:"该订单已不在当前仓库、尚未货齐，或已经创建装车任务"};
    const stageError=warehouseOutboundWorkflowActionError(inspection.executionPolicy);
    if(stageError)return{formError:stageError,inspection};
    const documentGroup=inspection.documentGroups.find(group=>group.orderId===orderId);
    if(!documentGroup)return{formError:"该订单不属于当前待创建的装车任务",inspection};
    const documentType=LOADING_DOCUMENTS.find(item=>item.code===documentCategory);
    if(!documentType)return{formError:`请选择有效文件类型：${LOADING_DOCUMENTS.map(item=>item.name).join("、")}`,inspection};
    const workflowAccess=await loadOrderDocumentWorkflowMutationAccess(env.DB,user.organizationId,orderId,documentCategory);
    if(!workflowAccess.allowed)return{formError:workflowAccess.reason||"当前冻结工作流未开放该文件，不能上传",inspection};
    const file=form.get("attachment");
    if(!(file instanceof File)||file.size<=0)return{formError:`请选择要上传的${documentType.name}`,inspection};
    const fileError=validateOutboundDocumentFile(file);
    if(fileError)return{formError:fileError,inspection};
    const attachmentId=crypto.randomUUID();
    const requiresManualReview=hasOrderDocumentSystemOverride(user);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)")
        .bind(attachmentId,user.organizationId,orderId,documentGroup.customerId,file.name,file.type,file.size,await toDataUrl(file),user.userId,now),
      env.DB.prepare(`INSERT INTO order_document_metadata(
        attachment_id,organization_id,order_id,document_category,description,public_to_customer,
        review_status,reviewed_by_user_id,reviewed_at,updated_at
      ) VALUES(?,?,?,?,?,0,?,NULL,?,?)`)
        .bind(attachmentId,user.organizationId,orderId,documentCategory,documentType.name,requiresManualReview?"pending":"approved",requiresManualReview?null:now,now),
    ]);
    await writeAudit({request,action:"warehouse.outbound.document_upload",resourceType:"order_attachment",resourceId:attachmentId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{warehouseId:warehouse.id,orderId,orderNumber:documentGroup.orderNumber,documentCategory,fileName:file.name}});
    return{success:`${documentGroup.orderNumber} 的${documentType.name}已上传`,actionKind:"loading_document_uploaded" as const,uploadOpenSignal:now,inspection:await loadOutboundInspectionByIds(user.organizationId,warehouse.id,inspectionOrderId,batchId)};
  }
  if(intent==="loading_documents_approve"){
    const inspectionOrderId=valueOf(form,"inspectionOrderId"),batchId=valueOf(form,"batchId");
    const inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,inspectionOrderId,batchId);
    if(!inspection)return{formError:"该订单已不在当前仓库、尚未货齐，或已经创建装车任务"};
    const stageError=warehouseOutboundWorkflowActionError(inspection.executionPolicy);
    if(stageError)return{formError:stageError,inspection};
    const missing=inspection.documents.filter(document=>document.required&&!document.attachmentId);
    if(missing.length)return{formError:`请先上传：${missing.map(document=>`${document.orderNumber} ${document.name}`).join("、")}`,inspection};
    const uploadedDocuments=inspection.documents.filter(document=>
      document.attachmentId&&document.reviewStatus==="pending"&&
      !isOrderDocumentSelfReviewBlocked(user,document.uploadedByUserId)
    );
    const blockedSelfReview=inspection.documents.filter(document=>
      document.required&&document.attachmentId&&document.reviewStatus==="pending"&&
      isOrderDocumentSelfReviewBlocked(user,document.uploadedByUserId)
    );
    if(blockedSelfReview.length)return{formError:`以下文件不能由上传账号自行审核：${blockedSelfReview.map(document=>`${document.orderNumber} ${document.name}`).join("、")}`,inspection};
    const approvalStatements=chunkD1Values(uploadedDocuments,4).map(documentChunk=>env.DB.prepare(`UPDATE order_document_metadata
      SET review_status=CASE WHEN review_status='archived' THEN 'archived' ELSE 'approved' END,
          reviewed_by_user_id=?,reviewed_at=?,updated_at=?
      WHERE organization_id=? AND attachment_id IN (${d1Placeholders(documentChunk.length)})`)
      .bind(user.userId,now,now,user.organizationId,...documentChunk.map(document=>document.attachmentId)));
    if(approvalStatements.length)await env.DB.batch(approvalStatements);
    await writeAudit({request,action:"warehouse.outbound.documents_approve",resourceType:"transport_order",resourceId:inspectionOrderId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{warehouseId:warehouse.id,orderNumbers:inspection.documentGroups.map(group=>group.orderNumber),documents:inspection.documents.map(document=>`${document.orderNumber}:${document.code}`)}});
    return{success:"本装车任务涉及订单的必需发运文件已全部确认，现在可以创建装车任务",actionKind:"loading_documents_approved" as const,reviewCloseSignal:now,inspection:await loadOutboundInspectionByIds(user.organizationId,warehouse.id,inspectionOrderId,batchId)};
  }
  if(intent==="create"){
    if(!isExplicitDispatchCreationConfirmation(form.get("createConfirmation")))return{formError:"装车任务未创建：请由仓库人员明确点击“确认并创建装车任务”。工作流热插拔和页面刷新只重新计算门禁，不会代替人工确认。"};
    const batchId=valueOf(form,"batchId"),orderNumber=valueOf(form,"orderNumber").trim(),customerIdentityCode=valueOf(form,"customerIdentityCode").trim().toUpperCase(),notes=valueOf(form,"notes");
    const carrierId=valueOf(form,"outboundCarrierId"),vehicleId=valueOf(form,"outboundVehicleId"),driverId=valueOf(form,"outboundDriverId"),plannedDepartureAt=valueOf(form,"plannedDepartureAt"),plannedArrivalAt=valueOf(form,"plannedArrivalAt");
    const newDriverName=valueOf(form,"newOutboundDriverName").trim(),newDriverPhone=valueOf(form,"newOutboundDriverPhone").trim(),newDriverLicenseNumber=valueOf(form,"newOutboundDriverLicenseNumber").trim();
    const requestedExitPort=valueOf(form,"exitPort").trim(),requestedCustomsLocation=valueOf(form,"customsLocation").trim();
    if(!batchId&&!orderNumber)return{formError:"请输入订单号或选择货齐入库记录"};
    if(customerIdentityCode&&!isValidCustomerIdentityCode(customerIdentityCode))return{formError:"客户识别码应为5位字母与数字混合，且不包含 O、0、1、L"};
    // Stable integrity boundary (not a configurable business gate): only an
    // active, fully labelled OUL packing job may become one dispatch. FTL uses
    // the order directly; LTL must already be allocated to its active PZ.
    const availableBatchSql=availablePackedBatchSql;
    const matches=orderNumber
      ? await env.DB.prepare(`${availableBatchSql} AND UPPER(o.order_number)=UPPER(?) AND (?='' OR UPPER(c.identity_code)=UPPER(?)) GROUP BY b.id,job.id ORDER BY b.verified_at DESC LIMIT 2`).bind(user.organizationId,warehouse.id,orderNumber,customerIdentityCode,customerIdentityCode).all<Batch>()
      : await env.DB.prepare(`${availableBatchSql} AND b.id=? AND (?='' OR UPPER(c.identity_code)=UPPER(?)) GROUP BY b.id,job.id LIMIT 1`).bind(user.organizationId,warehouse.id,batchId,customerIdentityCode,customerIdentityCode).all<Batch>();
    if(matches.results.length>1)return{formError:"该订单存在多个货齐入库记录，请从列表选择具体记录"};
    const batch=matches.results[0];
    if(!batch && orderNumber){
      const existing=await env.DB.prepare(`SELECT d.dispatch_number,d.status,o.business_type
        FROM warehouse_dispatches d
        JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
        JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
        JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
        JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
        WHERE d.organization_id=? AND p.warehouse_id=? AND UPPER(o.order_number)=UPPER(?) AND d.status!='cancelled'
        ORDER BY d.created_at DESC LIMIT 1`).bind(user.organizationId,warehouse.id,orderNumber).first<{dispatch_number:string;status:string;business_type:string}>();
      if(existing)return{formError:`${orderNumber} 已经创建装车任务 ${existing.dispatch_number}，当前状态：${existing.status==="loading"?"装车中":"已出库交接"}。请进入“装车与出库”页面继续办理，不要重复新建任务。`};
      const diagnosis=await diagnoseOutboundOrder(user.organizationId,warehouse.id,orderNumber);
      if(diagnosis)return{formError:diagnosis};
      return{formError:`未找到已完成最终包装且尚未创建装车任务的订单：${orderNumber}。请确认：仓库已完成二次打包、生成 OUL 并确认全部贴标；拼车还需先进入 PZ 配载单。`};
    }
    if(!batch)return{formError:`未找到已贴标且尚未出库的最终包装${orderNumber?`：${orderNumber}`:""}，请核对订单号、客户识别码和包装状态`};
    let inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,batch.order_id,batch.id);
    if(!inspection)return{formError:"当前收货清点记录已经失效，请重新检查订单"};
    const rejectCreate=(formError:string)=>({formError,inspection});
    const stageError=warehouseOutboundWorkflowActionError(inspection.executionPolicy);
    if(stageError)return rejectCreate(stageError);
    if(batch.business_type==="ltl"&&inspection.batch.transport_batch_approval_status!=="approved")return rejectCreate("配载单尚未完成操作主管审核及整单操作、单证负责人分配，完成后才能创建装车任务");
    if(batch.business_type==="ftl"){
      const hiddenRouteError=validateFtlOutboundRouteSubmission({exitPort:requestedExitPort,customsLocation:requestedCustomsLocation,policies:inspection.executionPolicy.batchFields});
      if(hiddenRouteError)return rejectCreate(hiddenRouteError);
    }
    let exitPort=inspection.executionPolicy.batchFields.exit_port.isActive?requestedExitPort:batch.exit_port?.trim()||"";
    let customsLocation=inspection.executionPolicy.batchFields.customs_location.isActive?requestedCustomsLocation:batch.customs_location?.trim()||"";
    if(batch.business_type==="ftl"){
      const routeError=validateFtlOutboundRouteFields({exitPort,customsLocation,policies:inspection.executionPolicy.batchFields});
      if(routeError)return rejectCreate(routeError);
    }
    const missing=inspection.documents.filter(document=>document.required&&!document.attachmentId);
    if(missing.length)return rejectCreate(`请先上传：${missing.map(document=>`${document.orderNumber} ${document.name}`).join("、")}`);
    if(!inspection.allApproved){
      const pending=inspection.documents.filter(document=>document.required&&!["approved","archived"].includes(document.reviewStatus||""));
      const rejected=pending.filter(document=>document.reviewStatus==="rejected");
      const awaiting=pending.filter(document=>document.reviewStatus!=="rejected");
      const messages=[
        rejected.length?`已退回需重新上传：${rejected.map(document=>`${document.orderNumber} ${document.name}`).join("、")}`:"",
        awaiting.length?`待其他账号审核：${awaiting.map(document=>`${document.orderNumber} ${document.name}`).join("、")}`:"",
      ].filter(Boolean);
      return rejectCreate(messages.join("；"));
    }
    if(inspection.notesActive&&inspection.notesRequired&&!notes.trim())return rejectCreate("请填写装车交接备注");
    let newDriverRegistration:PendingOutboundDriver|null=null;
    if(batch.business_type==="ftl"){
      const newDriverError=validateNewOutboundDriverRegistration({
        driverId,
        carrierId,
        name:newDriverName,
        phone:newDriverPhone,
        phoneRequired:inspection.executionPolicy.batchFields.main_driver_phone.isRequired,
      });
      if(newDriverError)return rejectCreate(newDriverError);
      if(driverId===NEW_OUTBOUND_DRIVER_ID){
        const existingDriver=await env.DB.prepare("SELECT id FROM carrier_drivers WHERE organization_id=? AND carrier_id=? AND name=? LIMIT 1")
          .bind(user.organizationId,carrierId,newDriverName).first<{id:string}>();
        newDriverRegistration={id:existingDriver?.id??crypto.randomUUID(),carrierId,name:newDriverName,phone:newDriverPhone||null,licenseNumber:newDriverLicenseNumber||null};
      }
      const resourceError=validateFtlOutboundResourceSelection({
        carrierId,vehicleId,driverId,plannedDepartureAt,plannedArrivalAt,
        policies:{
          ...inspection.executionPolicy.resources,
          plannedDeparture:inspection.executionPolicy.batchFields.planned_exit_at,
          plannedArrival:inspection.executionPolicy.batchFields.planned_arrival_at,
        },
      });
      if(resourceError)return rejectCreate(resourceError);
    }
    let planned=batch.business_type==="ftl"
      ?await resolveFtlDispatchPlan(user.organizationId,{carrierId,vehicleId,driverId,plannedDepartureAt,plannedArrivalAt,newDriver:newDriverRegistration},inspection.executionPolicy.batchFields)
      :await resolveDispatchPlan(user.organizationId,batch.order_id,batch.business_type,inspection.batch.transport_batch_id,inspection.executionPolicy.batchFields,warehouse.id);
    if("error" in planned)return rejectCreate(planned.error);
    let plate=planned.vehicle_plate?.trim().toUpperCase()||"",driver=planned.driver_name?.trim()||"",phone=planned.driver_phone?.trim()||"",carrier=planned.carrier_name?.trim()||"";
    const destination=batch.destination_location;
    const planIssues=dispatchPlanPolicyIssues(inspection.executionPolicy.batchFields,planned);
    if(planIssues.requiredMissing.length)return rejectCreate(`请先补齐工作流必填项：${planIssues.requiredMissing.join("、")}`);
    // Optional gaps are audit context, not gates. Hidden fields are excluded by
    // dispatchPlanPolicyIssues and cannot be submitted by the action above.
    let resourceDifferences=planIssues.differences;
    const loadReadiness=batch.business_type==="ftl"
      ?await checkOrderLoadPlan(user.organizationId,batch.order_id,undefined,null,{mode:"submit",values:{
        exitPort:exitPort||null,
        customsLocation:customsLocation||null,
        carrierId:planned.carrier_id,
        vehicleType:planned.vehicle_type,
        vehicleCount:planned.vehicle_id?1:null,
        vehiclePlate:plate||null,
        driverName:driver||null,
        driverPhone:phone||null,
        plannedDepartureAt:planned.planned_departure_at,
        plannedArrivalAt:planned.planned_arrival_at,
      }})
      :await checkOrderLoadPlan(user.organizationId,batch.order_id,planned.batch_id?plate:undefined,planned.batch_id);
    if(!loadReadiness.ready)return rejectCreate(`暂不能创建装车任务：${loadReadiness.reasons.join("；")}`);
    if(planned.batch_id){
      const readiness=await checkBatchWarehouseReadiness(user.organizationId,warehouse.id,planned.batch_id,plate);
      const blocked=readiness.orders.filter(item=>item.reasons.length>0);
      if(blocked.length)return rejectCreate(`配载单 ${readiness.batchNumber} 尚不能装车：${formatOrderBlockers(blocked)}`);
    }
    const finalInspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,batch.order_id,batch.id);
    if(!finalInspection)return{formError:"创建前订单状态发生变化，请重新核验装车条件"};
    const finalStageError=warehouseOutboundWorkflowActionError(finalInspection.executionPolicy);
    if(finalStageError)return{formError:finalStageError,inspection:finalInspection};
    if(finalInspection.notesActive&&finalInspection.notesRequired&&!notes.trim())return{formError:"创建前工作流规则已变化：请填写装车交接备注",inspection:finalInspection};
    if(batch.business_type==="ftl"){
      const finalHiddenRouteError=validateFtlOutboundRouteSubmission({exitPort:requestedExitPort,customsLocation:requestedCustomsLocation,policies:finalInspection.executionPolicy.batchFields});
      if(finalHiddenRouteError)return{formError:`创建前工作流规则已变化：${finalHiddenRouteError}`,inspection:finalInspection};
      exitPort=finalInspection.executionPolicy.batchFields.exit_port.isActive?requestedExitPort:batch.exit_port?.trim()||"";
      customsLocation=finalInspection.executionPolicy.batchFields.customs_location.isActive?requestedCustomsLocation:batch.customs_location?.trim()||"";
      const finalRouteError=validateFtlOutboundRouteFields({exitPort,customsLocation,policies:finalInspection.executionPolicy.batchFields});
      if(finalRouteError)return{formError:`创建前工作流规则已变化：${finalRouteError}`,inspection:finalInspection};
    }
    if(batch.business_type==="ltl"&&finalInspection.batch.transport_batch_approval_status!=="approved")return{formError:"配载单审批或负责人分配状态已变化，请重新完成审核与分配后再创建",inspection:finalInspection};
    if(!finalInspection.allApproved){
      const pending=finalInspection.documents.filter(document=>document.required&&!["approved","archived"].includes(document.reviewStatus||""));
      return{formError:`创建前文件状态已变化，请重新上传、检查并确认：${pending.map(document=>`${document.orderNumber} ${document.name}`).join("、")}`,inspection:finalInspection};
    }
    if(finalInspection.resourcePolicyError)return{formError:finalInspection.resourcePolicyError,inspection:finalInspection};
    if(batch.business_type==="ftl"){
      const finalResourceError=validateFtlOutboundResourceSelection({carrierId,vehicleId,driverId,plannedDepartureAt,plannedArrivalAt,policies:{...finalInspection.executionPolicy.resources,plannedDeparture:finalInspection.executionPolicy.batchFields.planned_exit_at,plannedArrival:finalInspection.executionPolicy.batchFields.planned_arrival_at}});
      if(finalResourceError)return{formError:finalResourceError,inspection:finalInspection};
    }
    const finalPlanned=batch.business_type==="ftl"
      ?await resolveFtlDispatchPlan(user.organizationId,{carrierId,vehicleId,driverId,plannedDepartureAt,plannedArrivalAt,newDriver:newDriverRegistration},finalInspection.executionPolicy.batchFields)
      :await resolveDispatchPlan(user.organizationId,batch.order_id,batch.business_type,finalInspection.batch.transport_batch_id,finalInspection.executionPolicy.batchFields,warehouse.id);
    if("error" in finalPlanned)return{formError:finalPlanned.error,inspection:finalInspection};
    const finalPlanIssues=dispatchPlanPolicyIssues(finalInspection.executionPolicy.batchFields,finalPlanned);
    if(finalPlanIssues.requiredMissing.length)return{formError:`创建前工作流必填项状态已变化：${finalPlanIssues.requiredMissing.join("、")}`,inspection:finalInspection};
    planned=finalPlanned;
    plate=planned.vehicle_plate?.trim().toUpperCase()||"";
    driver=planned.driver_name?.trim()||"";
    phone=planned.driver_phone?.trim()||"";
    carrier=planned.carrier_name?.trim()||"";
    resourceDifferences=finalPlanIssues.differences;
    const finalLoadReadiness=batch.business_type==="ftl"
      ?await checkOrderLoadPlan(user.organizationId,batch.order_id,undefined,null,{mode:"submit",values:{exitPort:exitPort||null,customsLocation:customsLocation||null,carrierId:planned.carrier_id,vehicleType:planned.vehicle_type,vehicleCount:planned.vehicle_id?1:null,vehiclePlate:plate||null,driverName:driver||null,driverPhone:phone||null,plannedDepartureAt:planned.planned_departure_at,plannedArrivalAt:planned.planned_arrival_at}})
      :await checkOrderLoadPlan(user.organizationId,batch.order_id,planned.batch_id?plate:undefined,planned.batch_id);
    if(!finalLoadReadiness.ready)return{formError:`创建前装车条件已变化：${finalLoadReadiness.reasons.join("；")}`,inspection:finalInspection};
    if(planned.batch_id){
      const finalBatchReadiness=await checkBatchWarehouseReadiness(user.organizationId,warehouse.id,planned.batch_id,plate);
      const finalBlocked=finalBatchReadiness.orders.filter(item=>item.reasons.length>0);
      if(finalBlocked.length)return{formError:`配载单 ${finalBatchReadiness.batchNumber} 的装车条件已变化：${formatOrderBlockers(finalBlocked)}`,inspection:finalInspection};
    }
    inspection=finalInspection;
    const readyPacking=await loadReadyPackingJobs(
      user.organizationId,
      warehouse.id,
      inspection.documentGroups,
      batch.business_type,
      planned.batch_id,
    );
    if("error" in readyPacking)return{formError:readyPacking.error,inspection};
    const dispatchId=crypto.randomUUID(),number=generateDispatch(),mainAssignmentId=crypto.randomUUID();
    const packingStatements:D1PreparedStatement[]=[];
    for(const jobChunk of chunkD1Values(readyPacking.jobs,3)){
      const jobIds=jobChunk.map(job=>job.id);
      packingStatements.push(
        env.DB.prepare(`UPDATE warehouse_packing_jobs
          SET status='allocated',dispatch_id=?,updated_at=?
          WHERE organization_id=? AND warehouse_id=? AND id IN (${d1Placeholders(jobChunk.length)})`)
          .bind(dispatchId,now,user.organizationId,warehouse.id,...jobIds),
        env.DB.prepare(`INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status)
          SELECT lower(hex(randomblob(16))),package_row.organization_id,?,package_row.id,'pending'
          FROM warehouse_packages package_row
          WHERE package_row.organization_id=? AND package_row.warehouse_id=?
            AND package_row.packing_job_id IN (${d1Placeholders(jobChunk.length)})
            AND package_row.label_kind='oul' AND package_row.lifecycle_status='active' AND package_row.status='in_stock'`)
          .bind(dispatchId,user.organizationId,warehouse.id,...jobIds),
        env.DB.prepare(`UPDATE warehouse_packages SET status='allocated',updated_at=?
          WHERE organization_id=? AND warehouse_id=? AND packing_job_id IN (${d1Placeholders(jobChunk.length)})
            AND label_kind='oul' AND lifecycle_status='active' AND status='in_stock'`)
          .bind(now,user.organizationId,warehouse.id,...jobIds),
      );
    }
    const batchStateStatements=planned.batch_id?[
      env.DB.prepare("UPDATE transport_batches SET status='loading',road_status='waiting_loading',updated_at=? WHERE id=? AND organization_id=? AND warehouse_id=? AND status IN ('planning','loading')").bind(now,planned.batch_id,user.organizationId,warehouse.id),
    ]:[];
    const mainAssignmentStatements=batch.business_type==="ftl"?[
      env.DB.prepare("UPDATE order_transport_assignments SET status='cancelled',updated_at=? WHERE organization_id=? AND order_id=? AND leg_type='main' AND status!='cancelled'").bind(now,user.organizationId,batch.order_id),
      env.DB.prepare(`INSERT INTO order_transport_assignments(id,organization_id,order_id,leg_type,carrier_id,carrier_name,vehicle_type,plate_number,driver_name,driver_phone,freight_amount,freight_currency,origin_location,destination_location,border_port,planned_departure_at,planned_arrival_at,loading_requirements,notes,status,created_by_user_id,created_at,updated_at)
        VALUES(?,?,?,'main',?,?,?,?,?,?,0,'CNY',?,?,?,?,?,?,'仓库装车前确认并同步管理端','planned',?,?,?)`).bind(mainAssignmentId,user.organizationId,batch.order_id,planned.carrier_id,carrier,planned.vehicle_type,plate,driver,phone||null,warehouse.name,batch.destination_location,exitPort||null,planned.planned_departure_at,planned.planned_arrival_at,"整车出境运输资源由仓库装车前确认",user.userId,now,now),
    ]:[];
    const workflowFieldStatements=batch.business_type==="ftl"?[
      env.DB.prepare("UPDATE transport_orders SET exit_port=?,customs_location=?,updated_at=? WHERE organization_id=? AND id=?")
        .bind(exitPort||null,customsLocation||null,now,user.organizationId,batch.order_id),
    ]:[];
    const newDriverStatements=newDriverRegistration?[
      env.DB.prepare(`INSERT INTO carrier_drivers(id,organization_id,carrier_id,name,phone,license_number,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'active',?,?)
        ON CONFLICT(organization_id,carrier_id,name) DO UPDATE SET phone=excluded.phone,license_number=excluded.license_number,status='active',updated_at=excluded.updated_at`)
        .bind(newDriverRegistration.id,user.organizationId,newDriverRegistration.carrierId,newDriverRegistration.name,newDriverRegistration.phone,newDriverRegistration.licenseNumber,now,now),
    ]:[];
    try{
      await env.DB.batch([
        ...newDriverStatements,
        env.DB.prepare(`INSERT INTO warehouse_dispatches(id,organization_id,dispatch_number,sorting_batch_id,shipment_id,vehicle_plate,driver_name,driver_phone,carrier_name,seal_number,destination,status,notes,created_by_user_id,created_at,updated_at,transport_batch_id) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,'loading',?,?,?,?,?)`).bind(dispatchId,user.organizationId,number,batch.id,batch.shipment_id,plate,driver,phone||null,carrier||null,destination,inspection.notesActive?(notes||null):null,user.userId,now,now,planned.batch_id),
        ...packingStatements,
        ...workflowFieldStatements,
        ...mainAssignmentStatements,
        ...batchStateStatements,
      ]);
    }catch(error){
      console.error("warehouse dispatch creation failed",error);
      return{formError:warehouseDispatchCreationErrorMessage(error),inspection};
    }
    const postCreateWarnings:string[]=[];
    if(newDriverRegistration){
      try{
        const registeredDriver=await env.DB.prepare("SELECT id FROM carrier_drivers WHERE organization_id=? AND carrier_id=? AND name=? LIMIT 1")
          .bind(user.organizationId,newDriverRegistration.carrierId,newDriverRegistration.name).first<{id:string}>();
        await writeAudit({request,action:"carrier.driver.register_from_outbound",resourceType:"carrier_driver",resourceId:registeredDriver?.id??newDriverRegistration.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{carrierId:newDriverRegistration.carrierId,driverName:newDriverRegistration.name,dispatchNumber:number}});
      }catch(error){console.error("outbound driver registration audit failed",error);postCreateWarnings.push("新司机登记审计待重试")}
    }
    if(planned.batch_id){
      try{await refreshLoadingManifest(user.organizationId,planned.batch_id,user.userId,now)}catch(error){console.error("dispatch manifest sync failed",error);postCreateWarnings.push("配载舱单待重试")}
    }
    for(const group of inspection.documentGroups){
      try{
        await recordWarehouseProgress({organizationId:user.organizationId,orderId:group.orderId,actorUserId:user.userId,stepCode:"loading",stepName:planned.batch_id?"按配载单统一装车":"整车装车",actionCode:"dispatch_create",actionName:planned.batch_id?"创建配载单装车任务":"创建整车装车任务",notes:`装车任务 ${number}；车辆 ${plate}`});
      }catch(error){console.error("dispatch order progress sync failed",error);postCreateWarnings.push(`${group.orderNumber} 进度待重试`)}
    }
    try{
      await writeAudit({request,action:"warehouse.dispatch.create",resourceType:"warehouse_dispatch",resourceId:dispatchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{number,batchId:batch.id,transportBatchId:planned.batch_id,orderNumbers:inspection.documentGroups.map(group=>group.orderNumber),businessType:batch.business_type,exitPort,customsLocation,carrier,plate,driver,plannedDepartureAt:planned.planned_departure_at,plannedArrivalAt:planned.planned_arrival_at,resourceSource:planned.batch_id?"ltl_batch":"warehouse_ftl_confirmation",resourcePolicyDifferences:resourceDifferences}});
    }catch(error){console.error("dispatch audit write failed",error);postCreateWarnings.push("审计记录待重试")}
    const sourceUrl=new URL(request.url),redirectParams=new URLSearchParams();
    for(const key of ["warehouseId","returnTo","orderId"]){const value=sourceUrl.searchParams.get(key);if(value)redirectParams.set(key,value);}
    redirectParams.set("view","execution");
    redirectParams.set("dispatchId",dispatchId);
    redirectParams.set("warehouseResult",`装车任务 ${number} 已创建，已同步到“装车与出库”${postCreateWarnings.length?`；${[...new Set(postCreateWarnings)].join("、")}`:""}`);
    return redirect(`/warehouse/outbound?${redirectParams.toString()}`);
  }
  const dispatchId=valueOf(form,"dispatchId");
  let dispatch=await env.DB.prepare(`SELECT d.id,d.shipment_id,s.order_id,o.business_type,o.exit_port,o.customs_location,d.status,d.dispatch_number,d.vehicle_plate,d.driver_name,d.driver_phone,d.carrier_name,d.destination,d.transport_batch_id,
      COALESCE((SELECT a.vehicle_type FROM order_transport_assignments a WHERE a.organization_id=d.organization_id AND a.order_id=s.order_id AND a.leg_type='main' AND a.status!='cancelled' ORDER BY a.updated_at DESC LIMIT 1),(SELECT v.vehicle_type FROM transport_batch_vehicles v WHERE v.organization_id=d.organization_id AND v.batch_id=d.transport_batch_id AND v.status!='cancelled' ORDER BY v.created_at LIMIT 1)) vehicle_type,
      COALESCE((SELECT a.planned_departure_at FROM order_transport_assignments a WHERE a.organization_id=d.organization_id AND a.order_id=s.order_id AND a.leg_type='main' AND a.status!='cancelled' ORDER BY a.updated_at DESC LIMIT 1),(SELECT b.planned_departure_at FROM transport_batches b WHERE b.organization_id=d.organization_id AND b.id=d.transport_batch_id)) planned_departure_at,
      COALESCE((SELECT a.planned_arrival_at FROM order_transport_assignments a WHERE a.organization_id=d.organization_id AND a.order_id=s.order_id AND a.leg_type='main' AND a.status!='cancelled' ORDER BY a.updated_at DESC LIMIT 1),(SELECT b.planned_arrival_at FROM transport_batches b WHERE b.organization_id=d.organization_id AND b.id=d.transport_batch_id)) planned_arrival_at
    FROM warehouse_dispatches d
    JOIN shipments s ON s.id=d.shipment_id AND s.organization_id=d.organization_id
    JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
    WHERE d.id=? AND d.organization_id=?
      AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id AND wp.organization_id=wi.organization_id WHERE wi.dispatch_id=d.id AND wi.organization_id=d.organization_id AND wp.warehouse_id=?)
      AND NOT EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id AND wp.organization_id=wi.organization_id WHERE wi.dispatch_id=d.id AND wi.organization_id=d.organization_id AND wp.warehouse_id<>?)`).bind(dispatchId,user.organizationId,warehouse.id,warehouse.id).first<{id:string;shipment_id:string;order_id:string;business_type:string;exit_port:string|null;customs_location:string|null;status:string;dispatch_number:string;vehicle_plate:string;vehicle_type:string|null;driver_name:string;driver_phone:string|null;carrier_name:string|null;destination:string;transport_batch_id:string|null;planned_departure_at:string|null;planned_arrival_at:string|null}>();
  if(!dispatch)return{formError:"装车任务不存在"};
  if(intent==="repack_oul"){
    if(dispatch.status!=="loading")return{formError:"该任务已经完成出库交接，不能重做 OUL"};
    const predispatchJob=await env.DB.prepare("SELECT id FROM warehouse_packing_jobs WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status!='cancelled' LIMIT 1")
      .bind(user.organizationId,warehouse.id,dispatch.id).first<{id:string}>();
    if(predispatchJob)return{formError:"本任务使用装车前包装流程；如需重做，请在尚未创建装车任务前返回‘二次打包与贴标’页面处理"};
    const currentItems=await env.DB.prepare(`SELECT di.id dispatch_item_id,di.status,p.id package_id,p.packing_batch_id,o.id order_id,o.order_number
      FROM warehouse_dispatch_items di
      JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
      JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
      JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
      WHERE di.organization_id=? AND di.dispatch_id=? AND p.warehouse_id=? AND p.label_kind='oul' AND p.lifecycle_status!='voided'
      ORDER BY o.order_number,p.created_at,p.id`).bind(user.organizationId,dispatch.id,warehouse.id).all<{dispatch_item_id:string;status:string;package_id:string;packing_batch_id:string|null;order_id:string;order_number:string}>();
    if(!currentItems.results.length)return{formError:"当前任务没有可重做的 OUL"};
    if(currentItems.results.some(item=>item.status!=="pending"))return{formError:"装车扫码已经开始，OUL 成包方案已锁定，不能作废或重做"};
    if(currentItems.results.some(item=>!item.packing_batch_id))return{formError:"当前任务仍使用旧版 OUL 关系，请新建订单重新测试"};
    const activeBatches=await env.DB.prepare(`SELECT id,order_id,transport_batch_id,source_type,source_package_count,total_weight_kg,total_volume_cbm,notes,revision
      FROM warehouse_packing_batches
      WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status!='cancelled'
      ORDER BY order_id`).bind(user.organizationId,warehouse.id,dispatch.id).all<{
        id:string;order_id:string;transport_batch_id:string|null;source_type:"ftl_order"|"pz_order";source_package_count:number;
        total_weight_kg:number|null;total_volume_cbm:number|null;notes:string|null;revision:number;
      }>();
    if(!activeBatches.results.length)return{formError:"当前任务缺少最终包装批次，请新建订单重新测试"};
    const sourceRows=await env.DB.prepare(`SELECT source.packing_batch_id,p.id,p.shipment_id,p.receipt_id,p.location_id
      FROM warehouse_packing_batch_sources source
      JOIN warehouse_packages p ON p.id=source.inbound_warehouse_package_id AND p.organization_id=source.organization_id
      WHERE source.organization_id=? AND source.packing_batch_id IN (
        SELECT id FROM warehouse_packing_batches WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status!='cancelled'
      ) ORDER BY source.packing_batch_id,p.id`).bind(user.organizationId,user.organizationId,warehouse.id,dispatch.id).all<{
        packing_batch_id:string;id:string;shipment_id:string;receipt_id:string;location_id:string;
      }>();
    const requests:PackingOrderRequest[]=[];
    const sources:import("../lib/warehouse-packing-plan").PackingSource[]=[];
    for(const packingBatch of activeBatches.results){
      const orderItems=currentItems.results.filter(item=>item.order_id===packingBatch.order_id);
      const orderNumber=orderItems[0]?.order_number;
      if(!orderNumber)return{formError:"包装批次关联订单已失效，不能重做 OUL"};
      const batchSources=sourceRows.results.filter(source=>source.packing_batch_id===packingBatch.id);
      if(batchSources.length!==packingBatch.source_package_count)return{formError:`${orderNumber} 的入仓唛头来源不完整，不能安全重做 OUL`};
      const requested=Number(valueOf(form,`outboundPackageCount_${packingBatch.order_id}`));
      if(!Number.isInteger(requested)||requested<1||requested>500)return{formError:`${orderNumber} 的最终 OUL 数量必须是 1–500 的整数`};
      requests.push({
        orderId:packingBatch.order_id,orderNumber,sourceType:packingBatch.source_type,
        transportBatchId:packingBatch.transport_batch_id,
        mode:requested===batchSources.length?"preserve":requested<batchSources.length?"merge":"split",
        outboundPackageCount:requested,totalWeightKg:packingBatch.total_weight_kg,totalVolumeCbm:packingBatch.total_volume_cbm,
        notes:packingBatch.notes??"",
      });
      sources.push(...batchSources.map(source=>({
        id:source.id,orderId:packingBatch.order_id,shipmentId:source.shipment_id,
        receiptId:source.receipt_id,locationId:source.location_id,
      })));
    }
    let revisedPlan:ReturnType<typeof buildWarehousePackingPlan>;
    try{
      revisedPlan=buildWarehousePackingPlan({
        requests,sources,createId:()=>crypto.randomUUID(),
        createOulCode:({orderNumber,sequence,total})=>oulCode(orderNumber,sequence,total,randomOulSuffix()),
      });
    }catch(error){return{formError:error instanceof Error?error.message:"重做最终包装失败"};}
    const statements:D1PreparedStatement[]=[
      env.DB.prepare("UPDATE warehouse_packing_batches SET status='cancelled',updated_at=? WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status IN ('generated','printed','labelled')").bind(now,user.organizationId,warehouse.id,dispatch.id),
      env.DB.prepare(`UPDATE warehouse_packages SET status='dispatched',lifecycle_status='voided',voided_at=?,voided_by_user_id=?,void_reason='装车前成包方案变更',updated_at=? WHERE organization_id=? AND id IN (SELECT package_id FROM warehouse_dispatch_items WHERE organization_id=? AND dispatch_id=?)`).bind(now,user.userId,now,user.organizationId,user.organizationId,dispatch.id),
      env.DB.prepare("DELETE FROM warehouse_dispatch_items WHERE organization_id=? AND dispatch_id=?").bind(user.organizationId,dispatch.id),
    ];
    for(const revised of revisedPlan.batches){
      const previous=activeBatches.results.find(item=>item.order_id===revised.orderId)!;
      const revision=previous.revision+1;
      statements.push(env.DB.prepare(`INSERT INTO warehouse_packing_batches(
        id,organization_id,warehouse_id,order_id,transport_batch_id,dispatch_id,source_type,packing_mode,
        source_package_count,outbound_package_count,total_weight_kg,total_volume_cbm,notes,revision,status,
        created_by_user_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'generated',?,?,?)`).bind(
        revised.id,user.organizationId,warehouse.id,revised.orderId,revised.transportBatchId,dispatch.id,revised.sourceType,revised.mode,
        revised.sourcePackageIds.length,revised.outboundPackageCount,revised.totalWeightKg,revised.totalVolumeCbm,revised.notes||null,
        revision,user.userId,now,now,
      ));
      for(const sourceId of revised.sourcePackageIds){
        statements.push(env.DB.prepare("INSERT INTO warehouse_packing_batch_sources(id,organization_id,packing_batch_id,inbound_warehouse_package_id,created_at) VALUES(?,?,?,?,?)")
          .bind(crypto.randomUUID(),user.organizationId,revised.id,sourceId,now));
      }
      for(const output of revised.outputs){
        statements.push(
          env.DB.prepare(`INSERT INTO warehouse_packages(
            id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,pieces,
            weight_kg,volume_cbm,status,notes,created_at,updated_at,cargo_item_id,label_kind,lifecycle_status,
            source_order_package_id,packing_revision,packing_batch_id
          ) VALUES(?,?,?,?,?,?,?,?,1,NULL,NULL,'allocated',?,?,?,NULL,'oul','active',NULL,?,?)`)
            .bind(output.id,user.organizationId,output.receiptId,output.shipmentId,warehouse.id,output.locationId,output.code,output.code,
              `重做最终出仓包装 · 第 ${revision} 版`,now,now,revision,revised.id),
          env.DB.prepare("INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status) VALUES(?,?,?,?,'pending')")
            .bind(crypto.randomUUID(),user.organizationId,dispatch.id,output.id),
        );
      }
    }
    await env.DB.batch(statements);
    await writeAudit({request,action:"warehouse.dispatch.oul_repacked",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,orders:revisedPlan.batches.map(item=>({orderId:item.orderId,orderNumber:item.orderNumber,count:item.outboundPackageCount}))}});
    return{success:`${dispatch.dispatch_number} 已作废原 OUL 并生成新版，请重新打印后再开始装车扫码`};
  }
  if(intent==="record_oul_print"){
    if(dispatch.status!=="loading")return{formError:"该任务已经完成出库交接，不能重新打印 OUL"};
    const active=await env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='generated' THEN 1 ELSE 0 END) generated FROM warehouse_packing_batches WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status!='cancelled'")
      .bind(user.organizationId,warehouse.id,dispatch.id).first<{total:number;generated:number}>();
    if(!active?.total)return{formError:"当前任务没有可打印的最终包装批次"};
    await env.DB.prepare(`UPDATE warehouse_packing_batches
      SET status=CASE WHEN status='generated' THEN 'printed' ELSE status END,
          labels_printed_at=COALESCE(labels_printed_at,?),labels_printed_by_user_id=COALESCE(labels_printed_by_user_id,?),updated_at=?
      WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status IN ('generated','printed')`)
      .bind(now,user.userId,now,user.organizationId,warehouse.id,dispatch.id).run();
    await writeAudit({request,action:"warehouse.dispatch.oul_print",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number}});
    return{success:`${dispatch.dispatch_number} 的 OUL 已记录打印；贴到全部最终出仓包裹后，请确认贴标完成`};
  }
  if(intent==="confirm_oul_labeling"){
    if(dispatch.status!=="loading")return{formError:"该任务已经完成出库交接，不能重复确认贴标"};
    const active=await env.DB.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN status='generated' THEN 1 ELSE 0 END) unprinted,
        SUM(CASE WHEN status IN ('printed','labelled') THEN 1 ELSE 0 END) confirmable
      FROM warehouse_packing_batches
      WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status!='cancelled'`)
      .bind(user.organizationId,warehouse.id,dispatch.id).first<{total:number;unprinted:number;confirmable:number}>();
    if(!active?.total)return{formError:"当前任务没有可确认的最终包装批次"};
    if(Number(active.unprinted??0)>0)return{formError:"请先打印全部 OUL，再确认贴标完成"};
    await env.DB.prepare(`UPDATE warehouse_packing_batches
      SET status=CASE WHEN status='printed' THEN 'labelled' ELSE status END,
          labeling_confirmed_at=COALESCE(labeling_confirmed_at,?),labeling_confirmed_by_user_id=COALESCE(labeling_confirmed_by_user_id,?),updated_at=?
      WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status IN ('printed','labelled')`)
      .bind(now,user.userId,now,user.organizationId,warehouse.id,dispatch.id).run();
    await writeAudit({request,action:"warehouse.dispatch.oul_labeling_confirm",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number}});
    return{success:`${dispatch.dispatch_number} 已确认全部 OUL 贴标完成，现在可以连续扫码装车`};
  }
  const workflowMutationIntent=["route_fields","schedule","load","dispatch"].includes(intent);
  if(intent==="dispatch"&&dispatch.status==="dispatched")return warehouseDispatchCompletionResult({dispatchNumber:dispatch.dispatch_number,businessType:dispatch.business_type,completionWarningText:"；该任务此前已完成，本次未重复写入出库流水。如业务工作流仍停留在装车节点，可使用“恢复工作流同步”"});
  if(intent==="resync_workflow"){
    if(dispatch.status!=="dispatched")return{formError:"只有已经完成物理出库交接的任务可以恢复工作流同步"};
    const shipments=await loadDispatchShipments(user.organizationId,warehouse.id,dispatch.id);
    if(!shipments.length)return{formError:"该装车任务在当前仓库没有可同步的关联运单"};
    const warnings=await resyncDispatchedWorkflow({organizationId:user.organizationId,dispatch,shipments,actorUserId:user.userId});
    try{
      const refreshedWorkflowOrders=await loadLoadingBatchWorkflowOrders(user.organizationId,shipments.map(item=>item.order_id));
      if(warehouseOutboundWorkflowSyncPending(refreshedWorkflowOrders))warnings.push("业务工作流仍停留在装车节点，请检查该节点其他必填项后再次恢复同步");
    }catch(error){console.error("dispatch workflow resync verification failed",error);warnings.push("工作流同步结果待核验")}
    try{await writeAudit({request,action:"warehouse.dispatch.workflow_resync",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,orderIds:shipments.map(item=>item.order_id),warnings}})}catch(error){console.error("dispatch workflow resync audit failed",error);warnings.push("审计记录待重试")}
    return{success:`${dispatch.dispatch_number} 已执行幂等工作流同步${warnings.length?`；${[...new Set(warnings)].join("、")}`:"，当前已离开装车节点"}`};
  }
  const executionPolicy=workflowMutationIntent
    ?await loadDispatchWorkflowPolicy(user.organizationId,warehouse.id,dispatch.id)
    :null;
  const workflowActionError=workflowMutationIntent?warehouseOutboundWorkflowActionError(executionPolicy):null;
  if(workflowActionError)return{formError:workflowActionError};
  if(intent==="route_fields"){
    if(dispatch.business_type!=="ftl")return{formError:"拼车路线信息请在 PZ 配载单中统一维护"};
    if(!executionPolicy)return{formError:"无法读取该任务的工作流规则，请刷新后重试"};
    if(!executionPolicy.batchFields.exit_port.isActive&&!executionPolicy.batchFields.customs_location.isActive)return{formError:"当前工作流已隐藏出境路线字段，不能在此登记"};
    const requestedExitPort=valueOf(form,"exitPort").trim(),requestedCustomsLocation=valueOf(form,"customsLocation").trim();
    const hiddenRouteError=validateFtlOutboundRouteSubmission({exitPort:requestedExitPort,customsLocation:requestedCustomsLocation,policies:executionPolicy.batchFields});
    if(hiddenRouteError)return{formError:hiddenRouteError};
    const finalRoutePolicy=await loadDispatchWorkflowPolicy(user.organizationId,warehouse.id,dispatch.id);
    const finalRouteStageError=warehouseOutboundWorkflowActionError(finalRoutePolicy);
    if(finalRouteStageError)return{formError:finalRouteStageError};
    if(!finalRoutePolicy)return{formError:"保存前无法读取最新工作流规则，请刷新后重试"};
    const finalHiddenRouteError=validateFtlOutboundRouteSubmission({exitPort:requestedExitPort,customsLocation:requestedCustomsLocation,policies:finalRoutePolicy.batchFields});
    if(finalHiddenRouteError)return{formError:`保存前工作流规则已变化：${finalHiddenRouteError}`};
    const exitPort=finalRoutePolicy.batchFields.exit_port.isActive?requestedExitPort:dispatch.exit_port?.trim()||"";
    const customsLocation=finalRoutePolicy.batchFields.customs_location.isActive?requestedCustomsLocation:dispatch.customs_location?.trim()||"";
    const routeError=validateFtlOutboundRouteFields({exitPort,customsLocation,policies:finalRoutePolicy.batchFields});
    if(routeError)return{formError:routeError};
    await env.DB.batch([
      env.DB.prepare("UPDATE transport_orders SET exit_port=?,customs_location=?,updated_at=? WHERE organization_id=? AND id=?")
        .bind(exitPort||null,customsLocation||null,now,user.organizationId,dispatch.order_id),
      env.DB.prepare("UPDATE order_transport_assignments SET border_port=?,updated_at=? WHERE organization_id=? AND order_id=? AND leg_type='main' AND status!='cancelled'")
        .bind(exitPort||null,now,user.organizationId,dispatch.order_id),
    ]);
    const warnings:string[]=[];
    let workflowStepKey:string|null=null;
    try{
      await syncOrderWorkflowSnapshot(user.organizationId,dispatch.order_id);
      const workflowState=await env.DB.prepare(`SELECT wi.current_step_key
        FROM transport_orders o
        LEFT JOIN workflow_instances wi
          ON wi.id=o.workflow_instance_id
         AND wi.organization_id=o.organization_id
         AND wi.order_id=o.id
        WHERE o.organization_id=? AND o.id=?`).bind(user.organizationId,dispatch.order_id).first<{current_step_key:string|null}>();
      workflowStepKey=workflowState?.current_step_key??null;
    }catch(error){console.error("dispatch route workflow sync failed",error);warnings.push("工作流同步待重试")}
    const routeSyncState=warehouseOutboundRouteSyncState(finalRoutePolicy.loadingStage,workflowStepKey);
    if(routeSyncState.pendingReason)warnings.push(routeSyncState.pendingReason);
    try{await writeAudit({request,action:"warehouse.dispatch.route_fields",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,orderId:dispatch.order_id,exitPort,customsLocation,workflowStepKey,workflowTargetStepKey:routeSyncState.targetStepKey,workflowResynchronized:routeSyncState.resynchronized}})}catch(error){console.error("dispatch route audit write failed",error);warnings.push("审计记录待重试")}
    return{success:`${dispatch.dispatch_number} 的出境口岸与清关地已保存${warnings.length?`；${warnings.join("、")}`:"，业务工作流已重新同步"}`};
  }
  if(intent==="schedule"){
    const plannedDepartureAt=valueOf(form,"plannedDepartureAt").trim();
    if(!dispatch.transport_batch_id)return{formError:"整车任务不使用配载单计划出境时间"};
    if(!executionPolicy?.batchFields.planned_exit_at.isActive)return{formError:"当前工作流已隐藏计划出境发车时间，不能在此登记"};
    if(!plannedDepartureAt)return{formError:"请填写计划出境发车时间"};
    const finalSchedulePolicy=await loadDispatchWorkflowPolicy(user.organizationId,warehouse.id,dispatch.id);
    const finalScheduleStageError=warehouseOutboundWorkflowActionError(finalSchedulePolicy);
    if(finalScheduleStageError)return{formError:finalScheduleStageError};
    if(!finalSchedulePolicy?.batchFields.planned_exit_at.isActive)return{formError:"保存前工作流已隐藏计划出境发车时间，未写入"};
    const result=await env.DB.prepare("UPDATE transport_batches SET planned_departure_at=?,updated_at=? WHERE id=? AND organization_id=? AND warehouse_id=? AND status!='cancelled'").bind(plannedDepartureAt,now,dispatch.transport_batch_id,user.organizationId,warehouse.id).run();
    if(!result.meta.changes)return{formError:"配载单不存在或不属于当前仓库"};
    await writeAudit({request,action:"warehouse.dispatch.schedule",resourceType:"transport_batch",resourceId:dispatch.transport_batch_id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,plannedDepartureAt}});
    return{success:`${dispatch.dispatch_number} 的计划出境发车时间已保存`};
  }
  if((intent==="load"||intent==="dispatch")&&(!dispatch.vehicle_plate.trim()||!dispatch.driver_name.trim()||!dispatch.carrier_name?.trim())&&dispatch.transport_batch_id&&(executionPolicy?.resources.carrier.isActive||executionPolicy?.resources.vehicle.isActive||executionPolicy?.resources.driver.isActive)){
    const resources=await env.DB.prepare(`SELECT v.plate_number,v.driver_name,v.driver_phone,COALESCE(c.name,bc.name) carrier_name
      FROM transport_batch_vehicles v
      JOIN transport_batches b ON b.id=v.batch_id AND b.organization_id=v.organization_id
      LEFT JOIN carriers c ON c.id=v.carrier_id AND c.organization_id=v.organization_id
      LEFT JOIN carriers bc ON bc.id=b.carrier_id AND bc.organization_id=b.organization_id
      WHERE v.batch_id=? AND v.organization_id=? AND b.warehouse_id=? AND v.status!='cancelled' ORDER BY v.created_at LIMIT 2`)
      .bind(dispatch.transport_batch_id,user.organizationId,warehouse.id).all<{plate_number:string|null;driver_name:string|null;driver_phone:string|null;carrier_name:string|null}>();
    if(resources.results.length===1){
      const resource=resources.results[0];
      const vehiclePlate=resource.plate_number?.trim().toUpperCase()||"",driverName=resource.driver_name?.trim()||"",carrierName=resource.carrier_name?.trim()||"";
      if(vehiclePlate&&driverName&&carrierName){
        await env.DB.prepare(`UPDATE warehouse_dispatches SET vehicle_plate=?,driver_name=?,driver_phone=?,carrier_name=?,updated_at=?
          WHERE id=? AND organization_id=? AND status='loading'
            AND EXISTS(SELECT 1 FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id WHERE di.dispatch_id=warehouse_dispatches.id AND di.organization_id=warehouse_dispatches.organization_id AND p.warehouse_id=?)`)
          .bind(vehiclePlate,driverName,resource.driver_phone?.trim()||null,carrierName,now,dispatch.id,user.organizationId,warehouse.id).run();
        dispatch={...dispatch,vehicle_plate:vehiclePlate,driver_name:driverName,driver_phone:resource.driver_phone?.trim()||null,carrier_name:carrierName};
      }
    }
  }
  if((intent==="load"||intent==="dispatch")&&dispatch.business_type==="ftl"&&executionPolicy){
    const routeError=validateFtlOutboundRouteFields({exitPort:dispatch.exit_port||"",customsLocation:dispatch.customs_location||"",policies:executionPolicy.batchFields});
    if(routeError)return{formError:`${routeError}；请先在本页“出境路线信息”中补齐后再继续`};
  }
  let resourceDifferences:OutboundPolicyDifference[]=[];
  if((intent==="load"||intent==="dispatch")&&executionPolicy){
    const currentPlan=dispatch.business_type==="ltl"
      ?await resolveDispatchPlan(user.organizationId,dispatch.order_id,dispatch.business_type,dispatch.transport_batch_id,executionPolicy.batchFields,warehouse.id)
      :{
        batch_id:null,carrier_id:null,vehicle_id:null,vehicle_type:dispatch.vehicle_type,
        vehicle_plate:dispatch.vehicle_plate,driver_id:null,driver_name:dispatch.driver_name,
        driver_phone:dispatch.driver_phone,carrier_name:dispatch.carrier_name,
        planned_departure_at:dispatch.planned_departure_at,
        planned_arrival_at:dispatch.planned_arrival_at,
      } satisfies DispatchPlan;
    if("error" in currentPlan)return{formError:currentPlan.error};
    const planIssues=dispatchPlanPolicyIssues(executionPolicy.batchFields,currentPlan);
    if(planIssues.requiredMissing.length)return{formError:`请先补齐工作流必填项：${planIssues.requiredMissing.join("、")}`};
    resourceDifferences=planIssues.differences;
  }
  if(intent==="load"){
    if(dispatch.status!=="loading")return{formError:"该装车任务已完成出库交接，不能继续装车"};
    const predispatchPackingReady=await env.DB.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN status IN ('allocated','loading') AND labeling_confirmed_at IS NOT NULL THEN 1 ELSE 0 END) ready
      FROM warehouse_packing_jobs
      WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status!='cancelled'`)
      .bind(user.organizationId,warehouse.id,dispatch.id).first<{total:number;ready:number}>();
    const legacyPackingReady=Number(predispatchPackingReady?.total??0)>0?null:await env.DB.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN status IN ('labelled','loading') AND labeling_confirmed_at IS NOT NULL THEN 1 ELSE 0 END) ready
      FROM warehouse_packing_batches
      WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status!='cancelled'`)
      .bind(user.organizationId,warehouse.id,dispatch.id).first<{total:number;ready:number}>();
    const packingReady=Number(predispatchPackingReady?.total??0)>0?predispatchPackingReady:legacyPackingReady;
    if(!packingReady?.total||Number(packingReady.ready??0)!==Number(packingReady.total))return{formError:"请先在‘二次打包与贴标’页面生成 OUL 并确认全部标签已贴完，再开始扫码装车"};
    const barcode=valueOf(form,"barcode").toUpperCase();
    // Package ownership is a permanent integrity gate: workflow configuration
    // may hide/relax scanning, but can never load a code from another task.
    const item=await env.DB.prepare(`SELECT di.id,di.status,p.id package_id
      FROM warehouse_dispatch_items di
      JOIN warehouse_dispatches d ON d.id=di.dispatch_id AND d.organization_id=di.organization_id
      JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
      WHERE d.id=? AND d.organization_id=? AND d.status='loading' AND p.warehouse_id=? AND p.barcode=? AND p.label_kind='oul' AND p.lifecycle_status='active' AND p.status='allocated'`).bind(dispatch.id,user.organizationId,warehouse.id,barcode).first<{id:string;status:string;package_id:string}>();
    if(!item)return{formError:"该货物不属于当前装车任务"};
    if(item.status==="loaded")return{formError:"该货物已经装车，请勿重复扫描"};
    const finalExecutionPolicy=await loadDispatchWorkflowPolicy(user.organizationId,warehouse.id,dispatch.id);
    const finalWorkflowActionError=warehouseOutboundWorkflowActionError(finalExecutionPolicy);
    if(finalWorkflowActionError)return{formError:finalWorkflowActionError};
    if(!finalExecutionPolicy)return{formError:"扫码前无法读取最新工作流规则，请刷新后重试"};
    if(dispatch.business_type==="ftl"){
      const finalRouteError=validateFtlOutboundRouteFields({exitPort:dispatch.exit_port||"",customsLocation:dispatch.customs_location||"",policies:finalExecutionPolicy.batchFields});
      if(finalRouteError)return{formError:`扫码前工作流规则已变化：${finalRouteError}`};
    }
    const finalPlan=dispatch.business_type==="ltl"
      ?await resolveDispatchPlan(user.organizationId,dispatch.order_id,dispatch.business_type,dispatch.transport_batch_id,finalExecutionPolicy.batchFields,warehouse.id)
      :{batch_id:null,carrier_id:null,vehicle_id:null,vehicle_type:dispatch.vehicle_type,vehicle_plate:dispatch.vehicle_plate,driver_id:null,driver_name:dispatch.driver_name,driver_phone:dispatch.driver_phone,carrier_name:dispatch.carrier_name,planned_departure_at:dispatch.planned_departure_at,planned_arrival_at:dispatch.planned_arrival_at} satisfies DispatchPlan;
    if("error" in finalPlan)return{formError:finalPlan.error};
    const finalPlanIssues=dispatchPlanPolicyIssues(finalExecutionPolicy.batchFields,finalPlan);
    if(finalPlanIssues.requiredMissing.length)return{formError:`扫码前工作流规则已变化，请补齐：${finalPlanIssues.requiredMissing.join("、")}`};
    resourceDifferences=finalPlanIssues.differences;
    const loadResults=await env.DB.batch([
      env.DB.prepare(`UPDATE warehouse_dispatch_items SET status='loaded',loaded_by_user_id=?,loaded_at=?
      WHERE id=? AND organization_id=? AND status!='loaded'
        AND EXISTS(SELECT 1 FROM warehouse_dispatches d JOIN warehouse_packages p ON p.id=? AND p.organization_id=warehouse_dispatch_items.organization_id WHERE d.id=warehouse_dispatch_items.dispatch_id AND d.organization_id=warehouse_dispatch_items.organization_id AND d.status='loading' AND d.id=? AND p.warehouse_id=? AND p.label_kind='oul' AND p.lifecycle_status='active' AND p.status='allocated')`)
        .bind(user.userId,now,item.id,user.organizationId,item.package_id,dispatch.id,warehouse.id),
      env.DB.prepare("UPDATE warehouse_packing_batches SET status='loading',updated_at=? WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status='labelled'")
        .bind(now,user.organizationId,warehouse.id,dispatch.id),
      env.DB.prepare("UPDATE warehouse_packing_jobs SET status='loading',updated_at=? WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status='allocated'")
        .bind(now,user.organizationId,warehouse.id,dispatch.id),
    ]);
    if(!loadResults[0]?.meta.changes)return{formError:"装车任务或货物状态已变化，请刷新后重试"};
    if(resourceDifferences.length)await writeAudit({request,action:"warehouse.dispatch.resource_difference_confirmed",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,stage:"scan",resourcePolicyDifferences:resourceDifferences}});
    return{success:`${barcode} 已装车，请核对下方货物信息`,actionKind:"package_loaded" as const,scannedBarcode:barcode,scannedDispatchId:dispatch.id};
  }
  if(intent==="dispatch"){
    if(dispatch.status!=="loading")return{formError:"该任务已经完成发车"};
    // A zero-cargo dispatch is structurally invalid regardless of optional
    // workflow fields; this protects shipment and inventory consistency.
    const counts=await env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN di.status='loaded' THEN 1 ELSE 0 END) loaded
      FROM warehouse_dispatch_items di
      JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
      WHERE di.dispatch_id=? AND di.organization_id=? AND p.warehouse_id=? AND p.label_kind='oul' AND p.lifecycle_status='active'`).bind(dispatch.id,user.organizationId,warehouse.id).first<{total:number;loaded:number}>();
    if(!counts?.total)return{formError:"当前装车任务没有货物，不能出库交接"};
    const loadedCount=Number(counts.loaded??0),missingScanCount=Math.max(0,counts.total-loadedCount);
    if(missingScanCount>0)return{formError:`必须扫齐全部 ${counts.total} 张 OUL 后才能确认出库，当前还差 ${missingScanCount} 张`};
    const scanDifferenceConfirmed=valueOf(form,"scanDifferenceConfirmed")==="yes";
    if(!executionPolicy)return{formError:"无法读取该任务的最新工作流规则，请刷新后重试"};
    const scanError=warehouseOutboundDispatchScanError(executionPolicy.scanConfirmation,counts.total,loadedCount,scanDifferenceConfirmed);
    if(scanError)return{formError:scanError};
    const shipments=await loadDispatchShipments(user.organizationId,warehouse.id,dispatch.id);
    if(!shipments.length)return{formError:"关联运单不存在"};
    const departureBlockers:string[]=[];
    for(const shipment of shipments){
      const readiness=await checkOrderLoadPlan(user.organizationId,shipment.order_id,dispatch.transport_batch_id?dispatch.vehicle_plate:undefined,dispatch.transport_batch_id);
      if(!readiness.ready)departureBlockers.push(...readiness.reasons.map(reason=>`${shipment.order_number}：${reason}`));
    }
    if(departureBlockers.length)return{formError:`暂不能完成出库交接：${[...new Set(departureBlockers)].join("；")}`};
    const transportSummary=[dispatch.vehicle_plate&&`车辆 ${dispatch.vehicle_plate}`,dispatch.driver_name&&`司机 ${dispatch.driver_name}`].filter(Boolean).join("；")||"当前工作流未要求登记车辆司机";
    const referenceOrderId=shipments[0].order_id;
    const linkedBatch=dispatch.transport_batch_id?{batch_id:dispatch.transport_batch_id}:null;
    const finalExecutionPolicy=await loadDispatchWorkflowPolicy(user.organizationId,warehouse.id,dispatch.id);
    const finalWorkflowActionError=warehouseOutboundWorkflowActionError(finalExecutionPolicy);
    if(finalWorkflowActionError)return{formError:finalWorkflowActionError};
    if(!finalExecutionPolicy)return{formError:"出库前无法读取最新工作流规则，请刷新后重试"};
    const finalScanError=warehouseOutboundDispatchScanError(finalExecutionPolicy.scanConfirmation,counts.total,loadedCount,scanDifferenceConfirmed);
    if(finalScanError)return{formError:`出库前工作流规则已变化：${finalScanError}`};
    if(dispatch.business_type==="ftl"){
      const finalRouteError=validateFtlOutboundRouteFields({exitPort:dispatch.exit_port||"",customsLocation:dispatch.customs_location||"",policies:finalExecutionPolicy.batchFields});
      if(finalRouteError)return{formError:`出库前工作流规则已变化：${finalRouteError}`};
    }
    const finalPlan=dispatch.business_type==="ltl"
      ?await resolveDispatchPlan(user.organizationId,dispatch.order_id,dispatch.business_type,dispatch.transport_batch_id,finalExecutionPolicy.batchFields,warehouse.id)
      :{batch_id:null,carrier_id:null,vehicle_id:null,vehicle_type:dispatch.vehicle_type,vehicle_plate:dispatch.vehicle_plate,driver_id:null,driver_name:dispatch.driver_name,driver_phone:dispatch.driver_phone,carrier_name:dispatch.carrier_name,planned_departure_at:dispatch.planned_departure_at,planned_arrival_at:dispatch.planned_arrival_at} satisfies DispatchPlan;
    if("error" in finalPlan)return{formError:finalPlan.error};
    const finalPlanIssues=dispatchPlanPolicyIssues(finalExecutionPolicy.batchFields,finalPlan);
    if(finalPlanIssues.requiredMissing.length)return{formError:`出库前工作流规则已变化，请补齐：${finalPlanIssues.requiredMissing.join("、")}`};
    resourceDifferences=finalPlanIssues.differences;
    const finalDepartureBlockers:string[]=[];
    for(const shipment of shipments){
      const readiness=await checkOrderLoadPlan(user.organizationId,shipment.order_id,dispatch.transport_batch_id?dispatch.vehicle_plate:undefined,dispatch.transport_batch_id);
      if(!readiness.ready)finalDepartureBlockers.push(...readiness.reasons.map(reason=>`${shipment.order_number}：${reason}`));
    }
    if(finalDepartureBlockers.length)return{formError:`出库前办理条件已变化：${[...new Set(finalDepartureBlockers)].join("；")}`};
    const scanDifferenceNote=missingScanCount>0
      ?`；逐件扫码${finalExecutionPolicy.scanConfirmation.mode==="hidden"?"已隐藏":"为选填"}，未扫描 ${missingScanCount}/${counts.total}，已由操作员二次确认`
      :"";
    const description=`${transportSummary}；已完成仓库装车，等待出境确认${scanDifferenceNote}`;
    const transaction=await completeWarehouseDispatchTransaction({db:env.DB,organizationId:user.organizationId,warehouseId:warehouse.id,dispatchId:dispatch.id,actorUserId:user.userId,occurredAt:now,description,transportBatchId:linkedBatch?.batch_id});
    if(!transaction.transitioned)return warehouseDispatchCompletionResult({dispatchNumber:dispatch.dispatch_number,businessType:dispatch.business_type,completionWarningText:"；该任务已由另一请求完成，本次未重复写入出库流水"});
    const completionWarnings:string[]=[];
    if(linkedBatch?.batch_id){
      try{await refreshLoadingManifest(user.organizationId,linkedBatch.batch_id,user.userId,now)}catch(error){console.error("completed dispatch manifest sync failed",error);completionWarnings.push("配载舱单待重试")}
      try{await recordBatchOutboundProgress({organizationId:user.organizationId,batchId:linkedBatch.batch_id,actorUserId:user.userId,dispatchNumber:dispatch.dispatch_number,referenceOrderId})}catch(error){console.error("completed dispatch batch progress sync failed",error);completionWarnings.push("批次进度待重试")}
    }else{
      for (const item of shipments) {
        try{
          await recordWarehouseProgress({organizationId:user.organizationId,orderId:item.order_id,actorUserId:user.userId,stepCode:"outbound",stepName:"装车出库交接完成",actionCode:"dispatch_complete",actionName:"完成装车出库交接",notes:`装车任务 ${dispatch.dispatch_number} 完成装车出库，等待出境确认`});
        }catch(error){console.error("completed dispatch order progress sync failed",error);completionWarnings.push(`${item.order_number} 进度待重试`)}
      }
    }
    try{
      const refreshedWorkflowOrders=await loadLoadingBatchWorkflowOrders(user.organizationId,shipments.map(item=>item.order_id));
      if(warehouseOutboundWorkflowSyncPending(refreshedWorkflowOrders))completionWarnings.push("业务工作流待恢复同步")
    }catch(error){console.error("completed dispatch workflow verification failed",error);completionWarnings.push("工作流同步结果待核验")}
    try{
      await writeAudit({request,action:"warehouse.dispatch.complete",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,packages:counts.total,scanPolicy:finalExecutionPolicy.scanConfirmation.mode,scannedPackages:loadedCount,unscannedPackages:missingScanCount,scanDifferenceConfirmed:missingScanCount>0&&scanDifferenceConfirmed,resourcePolicyDifferences:resourceDifferences}});
    }catch(error){console.error("completed dispatch audit write failed",error);completionWarnings.push("审计记录待重试")}
    const completionWarningText=completionWarnings.length?`；${[...new Set(completionWarnings)].join("、")}`:"";
    return warehouseDispatchCompletionResult({dispatchNumber:dispatch.dispatch_number,businessType:dispatch.business_type,completionWarningText});
  }
  return{formError:"无效的出库操作"};
}

export default function WarehouseOutbound({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle",canOperate=canOperateWarehouseUi(loaderData.user,loaderData.warehouseAccessLevel),canOpenAdminSite=canUseAdminSite(loaderData.user.roleCodes),completed=loaderData.dispatches.filter(x=>x.status==="dispatched");
  const selectedTask=loaderData.requestedDispatchId?loaderData.dispatches.find(task=>task.id===loaderData.requestedDispatchId):undefined;
  const taskStage=(task:Dispatch)=>{const state=loaderData.taskWorkflowStates[task.id];return warehouseOutboundTaskStage(task,state?.scanConfirmation,state?.loadingStage,state?.workflowSyncPending)};
  const selectedStage=selectedTask?taskStage(selectedTask):undefined;
  const taskStages=loaderData.dispatches.map(task=>taskStage(task));
  const actionSuccess=actionData&&"success" in actionData?actionData.success:undefined;
  const actionError=actionData&&"formError" in actionData?actionData.formError:undefined;
  const scannedBarcode=actionData&&"scannedBarcode" in actionData?actionData.scannedBarcode:undefined;
  const scannedDispatchId=actionData&&"scannedDispatchId" in actionData?actionData.scannedDispatchId:undefined;
  const inspection=actionData&&"inspection" in actionData
    ?actionData.inspection??loaderData.requestedInspection
    :loaderData.requestedInspection;
  const selectedPackingReady=loaderData.packingBatches.length>0&&loaderData.packingBatches.every(batch=>
    ["labelled","allocated","loading","dispatched"].includes(batch.status)&&Boolean(batch.labeling_confirmed_at)
  );
  const usesPredispatchPacking=loaderData.packingBatches.some(batch=>batch.flow_source==="predispatch");
  if(loaderData.view==="create"){
    const unit=loaderData.selectedLoadUnit,isLtl=unit?.business_type==="ltl"&&Boolean(unit.transport_batch_id);
    return <div className="outbound-create-page">
      <ActionToast data={actionData}/>
      <header className="page-header" id="warehouse-outbound-workbench"><div><p className="eyebrow">CREATE LOADING TASK</p><h1>创建装车任务</h1><p>{unit?`${isLtl?unit.batch_number:unit.order_number} · ${isLtl?`${unit.order_count} 票拼车订单`:unit.customer_name}`:"请从在仓订单列表选择要办理的订单。"}</p></div><Link className="secondary" to={loaderData.pendingHref}>返回在仓订单</Link></header>
      <ol className="outbound-create-rhythm" aria-label="创建装车任务步骤">
        <li className={unit?"complete":"current"}><span>1</span><div><strong>选择在仓订单</strong><small>{unit?"已选定":"当前步骤"}</small></div></li>
        <li className={unit?"current":"upcoming"}><span>2</span><div><strong>核验发运文件</strong><small>{unit?.ready?"文件条件已满足":"补齐缺失文件与条件"}</small></div></li>
        <li className={inspection?.allUploaded?"current":"upcoming"}><span>3</span><div><strong>{isLtl?"确认创建任务":"确认出境车辆并创建"}</strong><small>{inspection?.allUploaded?(isLtl?"文件已齐":"仓库确认车辆、司机与计划时间"):"文件齐全后开放"}</small></div></li>
      </ol>
      {!unit&&<div className="alert error" role="alert">未找到对应的在仓订单，该订单可能已创建装车任务或已离仓。<Link to={loaderData.pendingHref}>返回列表重新选择</Link></div>}
      {unit&&!unit.ready&&<BlockedLoadingDocumentRemediation key={unit.id} inspection={inspection} reasons={unit.reasons} pendingHref={loaderData.pendingHref} canOperate={canOperate} busy={busy} actionSuccess={actionSuccess} actionError={actionError}/>}
      {unit?.ready&&<section className="panel outbound-create-section"><div className="panel-header"><div><h2>核验发运文件</h2><p>按订单页签查看和上传对应文件；全部必需文件齐全后，可在右下角直接创建装车任务。</p></div><span className="status-pill success">装车条件已满足</span></div>{canOperate?<CreateDispatchWorkbench warehouseId={loaderData.warehouse.id} inspection={inspection} outboundResources={loaderData.outboundResources} borderPorts={loaderData.borderPorts} customsPlaces={loaderData.customsPlaces} busy={busy} actionError={actionError}/>:<div className="alert warning">当前账户可查看装车条件，但不能创建任务。</div>}</section>}
    </div>;
  }
  if(loaderData.view==="pending")return <>
    <header className="page-header" id="warehouse-outbound-workbench"><div><p className="eyebrow">IN-WAREHOUSE ORDERS</p><h1>在仓订单</h1><p>先筛选并选定订单，再进入独立页面核验文件、创建装车任务。拼车订单仍按 PZ 配载单整批办理。</p></div><Link className="secondary" to={loaderData.executionHref}>查看装车与出库</Link></header>
    <section className="panel outbound-pending-orders">
      <div className="panel-header"><div><h2>在仓订单列表</h2><p>点击订单号或 PZ 配载单号进入“创建装车任务”；暂不满足条件的订单会直接标明原因。</p></div><span>{loaderData.pendingPagination.total} / {loaderData.loadUnitCounts.all} 个装车单位</span></div>
      <Form method="get" className="outbound-order-filter-form" role="search">
        <input type="hidden" name="view" value="pending"/><input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/>{loaderData.orderId&&<input type="hidden" name="orderId" value={loaderData.orderId}/>} {loaderData.returnTo&&<input type="hidden" name="returnTo" value={loaderData.returnTo}/>}
        <label><span>搜索</span><input name="q" defaultValue={loaderData.filters.query} placeholder="订单号、PZ 单号、客户或目的地" autoComplete="off"/></label>
        <label><span>运输类型</span><select name="type" defaultValue={loaderData.filters.businessType}><option value="all">全部类型</option><option value="ftl">整车</option><option value="ltl">拼车</option></select></label>
        <label><span>装车条件</span><select name="readiness" defaultValue={loaderData.filters.readiness}><option value="all">全部状态</option><option value="ready">可创建任务</option><option value="blocked">待补条件</option></select></label>
        <div className="outbound-order-filter-actions"><button className="primary warehouse-primary">查询</button><Link className="secondary" to={clearOutboundFiltersHref(loaderData.pendingHref)}>重置</Link></div>
      </Form>
      <div className="outbound-list-summary" aria-live="polite"><span>全部 <strong>{loaderData.loadUnitCounts.all}</strong></span><span>可创建 <strong>{loaderData.loadUnitCounts.ready}</strong></span><span>待补条件 <strong>{loaderData.loadUnitCounts.blocked}</strong></span></div>
      <div className="table-wrap"><table className="outbound-load-units-table"><colgroup><col className="outbound-order-column"/><col className="outbound-customer-column"/><col className="outbound-type-column"/><col className="outbound-storage-column"/><col className="outbound-cargo-column"/><col className="outbound-destination-column"/><col className="outbound-readiness-column"/><col className="outbound-action-column"/></colgroup><thead><tr><th>订单 / PZ 配载单</th><th>客户</th><th>类型</th><th>入仓 / 库位</th><th>最终出仓包装</th><th>目的地</th><th>装车条件</th><th>操作</th></tr></thead><tbody>{loaderData.loadUnits.map(unit=>{const unitIsLtl=unit.business_type==="ltl"&&Boolean(unit.transport_batch_id),createHref=createLoadUnitHref(loaderData.pendingHref,unit.id),destinationSummary=unit.destination_summary||unit.destination_location;return <tr key={unit.transport_batch_id||unit.id} className={unit.ready?"":"blocked-row"}><td><Link className="outbound-order-number-link" to={createHref}><strong>{unitIsLtl?unit.batch_number:unit.order_number}</strong><small>{unitIsLtl?unit.order_numbers:unit.batch_number}</small></Link></td><td><strong>{unitIsLtl?`${unit.order_count} 票 · ${unit.customer_names.split("、").filter(Boolean).length} 个客户`:unit.customer_name}</strong><small title={unitIsLtl?unit.customer_names:unit.customer_identity_code}>{unitIsLtl?unit.customer_names:unit.customer_identity_code}</small></td><td><span className={`status-pill ${unitIsLtl?"":"off"}`}>{unitIsLtl?"拼车配载":"整车订单"}</span></td><td><strong>{formatWarehouseTime(unit.received_at||unit.verified_at)}</strong><small title={unit.storage_locations}>{unit.storage_locations||"待分配库位"}</small></td><td><strong>{unit.item_count} 个 OUL 包裹</strong><small>{Number(unit.total_weight_kg).toFixed(2)} KG · {Number(unit.total_volume_cbm).toFixed(3)} CBM</small></td><td className="outbound-destination" title={destinationSummary}>{destinationSummary}</td><td><span className={`status-pill ${unit.ready?"success":"warning"}`}>{unit.ready?"可创建任务":"待补条件"}</span><small className="outbound-block-reason" title={unit.reasons.join("；")}>{unit.ready?"点击订单号继续":unit.reasons[0]}</small></td><td className="outbound-action-cell"><Link className={canOperate&&unit.ready?"primary warehouse-primary":"secondary"} to={createHref}>{canOperate?"创建装车任务":"查看装车条件"}</Link></td></tr>})}{!loaderData.loadUnits.length&&<tr><td colSpan={8} className="empty-state">没有符合当前筛选条件的在仓订单。请调整筛选条件或重置查询。</td></tr>}</tbody></table></div>
      <QueryPagination {...loaderData.pendingPagination} pageParam="pendingPage" unit="个装车单位"/>
    </section>
  </>;
  return <>
    <header className={`page-header${selectedTask?" outbound-detail-header":""}`} id="warehouse-outbound-workbench"><div><p className="eyebrow">LOAD · SCAN · DISPATCH</p><h1>{selectedTask?"装车出库任务详情":"装车与出库任务中心"}</h1><p>{selectedTask?"按任务完成扫码装车、出库交接，并查看进入境外运输前的后续节点。":"集中查看已有装车出库任务、当前节点和办理进度；点击任务后进入操作详情。"}</p></div><div className="button-row">{selectedTask&&<Link className="secondary" to={loaderData.executionHref}>返回任务中心</Link>}<Link className="secondary" to={loaderData.pendingHref}>返回在仓订单</Link></div></header>
    <ActionToast data={actionData}/>
    {selectedTask?<section className="outbound-task-detail-workbench">
      <DispatchNodeStrip task={selectedTask} scanPolicy={loaderData.selectedExecutionPolicy?.scanConfirmation} packingBatches={loaderData.packingBatches}/>
      {selectedTask.business_type==="ftl"&&!selectedTask.outbound_resource_confirmed&&<div className="alert warning" role="alert"><strong>历史整车任务提示：</strong>该任务创建于仓库出境资源确认上线之前，当前显示的车辆可能来自旧版国内运输安排，只保留为审计记录。新建整车任务将强制由仓库选择境外承运商、车辆和司机，不再沿用此逻辑。</div>}
      {selectedTask.business_type==="ftl"&&loaderData.selectedExecutionPolicy&&<FtlOutboundRouteEditor task={selectedTask} workflowPolicy={loaderData.selectedExecutionPolicy} borderPorts={loaderData.borderPorts} customsPlaces={loaderData.customsPlaces} busy={busy} canOperate={canOperate}/>}
      {!usesPredispatchPacking&&<OulLabelPanel task={selectedTask} items={loaderData.items.filter(x=>x.dispatch_id===selectedTask.id)} packingBatches={loaderData.packingBatches} busy={busy} canOperate={canOperate} closeSignal={actionSuccess}/>}
      {selectedTask.status==="loading"?(selectedPackingReady?<DispatchCard key={selectedTask.id} warehouseId={loaderData.warehouse.id} task={selectedTask} items={loaderData.visibleItems.filter(x=>x.dispatch_id===selectedTask.id)} itemPagination={loaderData.itemPagination} manifest={loaderData.manifestsByOrder[selectedTask.order_id]} busy={busy} canOperate={canOperate} workflowPolicy={loaderData.selectedExecutionPolicy} resourceDifferences={loaderData.selectedResourceDifferences} resourcePolicyError={loaderData.selectedResourcePolicyError} highlightedBarcode={scannedDispatchId===selectedTask.id?scannedBarcode:undefined}/>:<section className="panel outbound-loading-locked"><strong>下一步：打印并贴好全部 OUL</strong><span>确认贴标完成后，系统自动开放连续扫码装车区。</span></section>):<>
        <section className="panel outbound-completed-task"><div className="panel-header"><div><h2>{selectedStage?.code==="overseas_transit"?"境外运输进行中":selectedStage?.code==="overseas_arrived"?"货物已到境外":"出库交接已完成"}</h2><p>{selectedStage?.code==="overseas_transit"?"实际出境已经确认，订单当前处于境外运输中。":selectedStage?.code==="overseas_arrived"?"境外运输节点已经完成，等待或正在办理境外仓作业。":"装车模块已经推进完成，当前进入“已装车待出境”；实际出境确认后才进入境外运输中。"}</p></div><span className={`status-pill ${selectedStage?.tone||"success"}`}>{selectedStage?.label}</span></div>{selectedStage?.code==="handover_done"?<div className="outbound-next-node-action"><div><strong>下一节点：实际出境确认</strong><span>{isConsolidatedOutboundTask(selectedTask.business_type,selectedTask.transport_batch_id)?"拼车按 PZ 配载单统一确认出境并同步全部订单。":selectedTask.outbound_resource_confirmed?"整车车辆与司机已经由仓库确认并同步管理端，后续直接在订单的报关及出境运输节点办理。":"该历史整车任务未经过新版仓库资源确认；请在管理端核实车辆后，直接在订单的报关及出境运输节点办理。"}</span></div>{isConsolidatedOutboundTask(selectedTask.business_type,selectedTask.transport_batch_id)?canOpenAdminSite?<Link className="primary warehouse-primary" to={`/admin/loading/${selectedTask.transport_batch_id}?tab=tracking`}>进入 PZ 配载单确认实际出境</Link>:<span className="status-pill off">请切换至配载单操作负责人账号办理实际出境</span>:<span className="status-pill success">整车无需进入配载页</span>}</div>:<div className="outbound-next-node-action"><div><strong>{selectedStage?.next}</strong><span>当前节点状态已同步到管理端。</span></div>{isConsolidatedOutboundTask(selectedTask.business_type,selectedTask.transport_batch_id)&&(canOpenAdminSite?<Link className="secondary" to={`/admin/loading/${selectedTask.transport_batch_id}`}>查看 PZ 配载单</Link>:<span className="status-pill off">管理端由配载单负责人继续办理</span>)}</div>}</section>
        {loaderData.taskWorkflowStates[selectedTask.id]?.workflowSyncPending&&<section className="panel outbound-workflow-resync"><div className="panel-header"><div><h2>物理出库已完成，业务工作流待同步</h2><p>货物不会重复出库。这里只重试配载/订单进度和冻结工作流快照。</p></div><span className="status-pill warning">待恢复</span></div>{canOperate?<Form method="post" className="button-row"><input type="hidden" name="intent" value="resync_workflow"/><input type="hidden" name="dispatchId" value={selectedTask.id}/><button className="primary warehouse-primary" disabled={busy}>恢复工作流同步</button></Form>:<div className="alert info">请由当前仓库的操作账号执行“恢复工作流同步”；本账号仅可查看状态。</div>}</section>}
        <section className="panel handover-section"><div className="panel-header no-print"><div><h2>仓库装车出库交接单</h2><p>本交接单记录仓库装车结果，不等同于车辆已实际出境。</p></div><button className="secondary" type="button" onClick={()=>window.print()}>打印交接单</button></div><Handover warehouseId={loaderData.warehouse.id} task={selectedTask} items={loaderData.items.filter(x=>x.dispatch_id===selectedTask.id)} manifest={loaderData.manifestsByOrder[selectedTask.order_id]}/></section>
      </>}
    </section>:<>
      <section className="panel outbound-execution-summary"><div className="table-wrap"><table><thead><tr><th>全部任务</th><th>待扫码 / 装车中</th><th>待出库交接</th><th>门禁 / 同步待处理</th><th>已完成物理出库</th><th>下一业务节点</th></tr></thead><tbody><tr><td>{loaderData.dispatches.length} 个</td><td>{taskStages.filter(stage=>["waiting_scan","loading"].includes(stage.code)).length} 个</td><td>{taskStages.filter(stage=>stage.code==="handover_ready").length} 个</td><td>{taskStages.filter(stage=>["workflow_blocked","workflow_sync_pending"].includes(stage.code)).length} 个</td><td>{completed.length} 个</td><td>实际出境确认 → 境外运输中</td></tr></tbody></table></div></section>
      <section className="panel outbound-task-center"><div className="panel-header"><div><h2>装车出库任务</h2><p>拼车以 PZ 配载单为一个任务统一累计扫码进度；整车仍按订单独立办理。</p></div><span>{loaderData.taskPagination.total} 个任务</span></div><div className="table-wrap"><table><thead><tr><th>装车任务</th><th>订单 / PZ 配载单</th><th>当前节点</th><th>装车进度</th><th>车辆 / 司机</th><th>目的地</th><th>创建 / 交接时间</th><th>操作</th></tr></thead><tbody>{loaderData.executionTasks.map(task=>{const stage=taskStage(task),subject=dispatchTaskSubject(task);return <tr key={task.id} className={["handover_ready","workflow_sync_pending","workflow_blocked"].includes(stage.code)?"task-attention":""}><td><strong>{task.dispatch_number}</strong><small>{subject.typeLabel}</small></td><td><strong>{subject.primary}</strong><small title={subject.secondary}>{subject.secondary}</small></td><td><span className={`status-pill ${stage.tone}`}>{stage.label}</span><small>{stage.next}</small></td><td><strong>{task.loaded_count}/{task.item_count}</strong><small>{task.item_count?`${Math.round(task.loaded_count/task.item_count*100)}%`:"无货物"}</small></td><td>{task.vehicle_plate}<small>{task.driver_name}</small></td><td>{task.destination}</td><td>{new Date(task.dispatched_at||task.created_at).toLocaleString("zh-CN",{hour12:false})}</td><td><Link className={canOperate&&["handover_ready","workflow_sync_pending"].includes(stage.code)?"primary warehouse-primary":"secondary"} to={executionTaskHref(loaderData.executionHref,task.id)}>{canOperate?stage.action:"查看任务"}</Link></td></tr>})}{!loaderData.executionTasks.length&&<tr><td colSpan={8} className="empty-state">暂无装车出库任务，请先从“在仓待装”选择订单创建。</td></tr>}</tbody></table></div><QueryPagination {...loaderData.taskPagination} pageParam="taskPage" unit="个任务"/></section>
    </>}
  </>;
}

function executionTaskHref(executionHref:string,dispatchId:string){return`${executionHref}${executionHref.includes("?")?"&":"?"}dispatchId=${encodeURIComponent(dispatchId)}`;}
function createLoadUnitHref(pendingHref:string,batchId:string){const [path,query=""]=pendingHref.split("?"),params=new URLSearchParams(query);params.set("view","create");params.set("batchId",batchId);return`${path}?${params.toString()}`;}
function clearOutboundFiltersHref(pendingHref:string){const [path,query=""]=pendingHref.split("?"),params=new URLSearchParams(query);params.delete("q");params.delete("type");params.delete("readiness");params.set("view","pending");return`${path}?${params.toString()}`;}
function formatWarehouseTime(value:string|null){return value?new Date(value).toLocaleString("zh-CN",{hour12:false}):"入仓时间待补";}
function dispatchTaskSubject(task:Dispatch){const isBatch=isConsolidatedOutboundTask(task.business_type,task.transport_batch_id);const orderNumbers=task.order_numbers||task.order_number,customerNames=task.customer_names||task.customer_name;return isBatch?{primary:task.batch_number,secondary:`${orderNumbers} · ${customerNames}`,typeLabel:`PZ 配载单 · ${orderNumbers.split(",").filter(Boolean).length} 票订单`}:{primary:task.order_number,secondary:task.customer_name,typeLabel:"整车订单"};}
function dispatchTaskPriority(task:Dispatch,state?:OutboundTaskWorkflowState){const code=warehouseOutboundTaskStage(task,state?.scanConfirmation,state?.loadingStage,state?.workflowSyncPending).code;return code==="workflow_sync_pending"?0:code==="handover_ready"?1:code==="loading"?2:code==="waiting_scan"?3:code==="workflow_blocked"?4:code==="handover_done"?5:6;}
export function warehouseOutboundTaskStage(task:Pick<Dispatch,"status"|"road_status"|"actual_departure_at"|"item_count"|"loaded_count">,_scanPolicy?:Pick<WarehouseOutboundWorkflowPolicy["scanConfirmation"],"mode"|"isRequired">,loadingStage?:Pick<LoadingBatchStageGate,"available"|"reason">,workflowSyncPending=false){
  if(task.status==="dispatched"&&workflowSyncPending)return{code:"workflow_sync_pending",label:"工作流待同步",next:"物理出库已完成，请恢复业务工作流同步",action:"恢复同步",tone:"warning"};
  if(["overseas_arrived","waiting_pickup","pickup_completed"].includes(task.road_status||""))return{code:"overseas_arrived",label:"已到境外",next:"等待境外仓办理",action:"查看任务",tone:"success"};
  if(task.road_status==="outbound_in_transit"||task.actual_departure_at)return{code:"overseas_transit",label:"境外运输中",next:"下一节点：到达境外仓",action:"查看任务",tone:"success"};
  if(task.status==="dispatched")return{code:"handover_done",label:"出库交接完成",next:"下一节点：实际出境确认",action:"查看交接与下一节点",tone:"success"};
  if(loadingStage&&!loadingStage.available)return{code:"workflow_blocked",label:"工作流门禁关闭",next:loadingStage.reason||"当前不能办理装车与出库",action:"查看原因",tone:"warning"};
  if(task.item_count>0&&task.loaded_count===task.item_count)return{code:"handover_ready",label:"待出库交接",next:"货物已全部扫码",action:"办理出库交接",tone:"warning"};
  if(task.loaded_count>0)return{code:"loading",label:"装车中",next:`还需扫描 ${Math.max(0,task.item_count-task.loaded_count)} 张 OUL`,action:"继续扫码装车",tone:""};
  return{code:"waiting_scan",label:"待扫码装车",next:`共 ${task.item_count} 张 OUL`,action:"装车出库",tone:"off"};
}
function DispatchNodeStrip({task,packingBatches=[]}:{task:Dispatch;scanPolicy?:WarehouseOutboundWorkflowPolicy["scanConfirmation"];packingBatches?:PackingBatchSummary[]}){
  const loaded=task.item_count>0&&task.loaded_count===task.item_count,scanGateSatisfied=loaded,handedOver=task.status==="dispatched",labelsReady=packingBatches.length>0&&packingBatches.every(batch=>["labelled","allocated","loading","dispatched"].includes(batch.status)&&Boolean(batch.labeling_confirmed_at)),inTransit=task.road_status==="outbound_in_transit"||Boolean(task.actual_departure_at),arrived=["overseas_arrived","waiting_pickup","pickup_completed"].includes(task.road_status||"");
  const nodes=[
    {label:"任务已创建",hint:task.dispatch_number,state:"complete"},
    {label:"打印并贴 OUL",hint:"每个最终出仓包裹一张",state:handedOver||labelsReady?"complete":task.status==="loading"?"current":"complete"},
    {label:"扫码装车",hint:loaded?`${task.loaded_count}/${task.item_count} 已完成`:`${task.loaded_count}/${task.item_count} 已扫描`,state:scanGateSatisfied?"complete":task.status==="loading"&&labelsReady?"current":"upcoming"},
    {label:"出库交接",hint:handedOver?"仓库交接已完成":scanGateSatisfied?"当前待办理":"扫齐全部 OUL 后开放",state:handedOver?"complete":scanGateSatisfied?"current":"upcoming"},
    {label:"境外运输",hint:arrived?"已到达境外":inTransit?"运输进行中":handedOver?"待实际出境确认":"完成交接后进入",state:arrived?"complete":inTransit?"current":"upcoming"},
  ];
  return <section className="outbound-node-table" aria-label="装车出库任务节点"><div className="table-wrap"><table><thead><tr>{nodes.map((node,index)=><th key={node.label}>{index+1}. {node.label}</th>)}</tr></thead><tbody><tr>{nodes.map(node=><td key={node.label} className={node.state}><span className={`status-pill ${node.state==="complete"?"success":node.state==="current"?"":"off"}`}>{node.state==="complete"?"已完成":node.state==="current"?"当前节点":"未开始"}</span><small>{node.hint}</small></td>)}</tr></tbody></table></div></section>;
}

function BlockedLoadingDocumentRemediation({inspection,reasons,pendingHref,canOperate,busy,actionSuccess,actionError}:{inspection:OutboundInspection|null;reasons:string[];pendingHref:string;canOperate:boolean;busy:boolean;actionSuccess?:string;actionError?:string}){
  const unresolvedRequired=inspection?.documents.filter(document=>document.required&&!['approved','archived'].includes(document.reviewStatus||""))??[];
  const missingRequired=unresolvedRequired.filter(document=>!document.attachmentId);
  const stageError=inspection?warehouseOutboundWorkflowActionError(inspection.executionPolicy):null;
  const [open,setOpen]=useState(unresolvedRequired.length>0);
  const taskLabel=inspection?.batch.business_type==="ltl"?inspection.batch.batch_number:inspection?.batch.order_number;
  const retryHref=inspection?createLoadUnitHref(pendingHref,inspection.batch.id):pendingHref;
  const remediationTargets=inspection?warehouseOutboundRemediations({
    orderId:inspection.batch.order_id,
    transportBatchId:inspection.batch.transport_batch_id,
    reasons,
    retryHref,
  }):[];
  useEffect(()=>{
    if(actionError||(actionSuccess&&inspection&&!inspection.allApproved))setOpen(true);
  },[actionError,actionSuccess,inspection?.allApproved]);
  return <section className="panel outbound-create-blocked">
    <div className="panel-header"><div><h2>暂不能创建装车任务</h2><p>{stageError?"当前未到冻结工作流的装车办理节点；本页只展示已有信息，进入目标节点后再补充文件或创建任务。":unresolvedRequired.length?"请在当前页面补齐以下必需文件；上传并确认后系统立即重新核验装车条件。":"文件条件已经满足，仍需处理下列其他装车条件。"}</p></div><span className="status-pill warning">待补条件</span></div>
    {!stageError&&unresolvedRequired.length>0&&<div className="outbound-blocked-document-summary"><strong>需要补充或确认以下文件</strong><span>{unresolvedRequired.map(document=>`${document.orderNumber} ${document.name}`).join("、")}</span></div>}
    <ul>{reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>
    {remediationTargets.length>0&&<div className="outbound-remediation-portals" aria-label="截断处理入口">
      {remediationTargets.map(target=><article key={target.key}>
        <div><strong>{target.title}</strong><span>{target.hint}</span></div>
        <Link className="secondary" to={target.href} target="_blank" rel="noreferrer">打开处理入口</Link>
      </article>)}
      <div className="outbound-remediation-recheck">
        <span>处理页会在新标签打开；完成后无需重复查找订单，回到本页重新核验即可。</span>
        <Link className="primary warehouse-primary" to={retryHref} reloadDocument>已处理，重新核验</Link>
      </div>
    </div>}
    <div className="panel-footer">
      <Link className="secondary" to={pendingHref}>返回在仓订单</Link>
      {canOperate&&inspection&&!stageError&&unresolvedRequired.length>0&&<Modal
        title={`补充装车必需文件 · ${taskLabel}`}
        triggerLabel={missingRequired.length?`补充必需文件 ${missingRequired.length}`:`核验必需文件 ${unresolvedRequired.length}`}
        triggerClassName="primary warehouse-primary"
        size="xwide"
        isOpen={open}
        onOpenChange={setOpen}
        closeSignal={inspection.allApproved?actionSuccess:undefined}
        initialFocusSelector=".outbound-document-name-upload.missing input"
      >
        <div className="outbound-upload-modal outbound-blocked-upload-modal">
          <OutboundDocumentUploadList inspection={inspection} busy={busy} onlyRequiredUnresolved/>
          <Form method="post" className="outbound-upload-modal-actions">
            <input type="hidden" name="intent" value="loading_documents_approve"/>
            <input type="hidden" name="inspectionOrderId" value={inspection.batch.order_id}/>
            <input type="hidden" name="batchId" value={inspection.batch.id}/>
            <span>{inspection.allUploaded?"必需文件已上传，可完成补充并重新核验。":`还需上传 ${missingRequired.length} 份必需文件。`}</span>
            <button className="primary warehouse-primary" disabled={!inspection.allUploaded||busy}>完成补充并重新核验</button>
          </Form>
        </div>
      </Modal>}
    </div>
  </section>;
}

function OutboundDocumentUploadList({inspection,busy,onlyRequiredUnresolved=false,orderId,warehouseId,showIntro=true}:{inspection:OutboundInspection;busy:boolean;onlyRequiredUnresolved?:boolean;orderId?:string;warehouseId?:string;showIntro?:boolean}){
  const visibleGroups=inspection.documentGroups.filter(group=>!orderId||group.orderId===orderId).map(group=>({
    ...group,
    documents:onlyRequiredUnresolved
      ?group.documents.filter(document=>document.required&&!['approved','archived'].includes(document.reviewStatus||""))
      :group.documents,
  })).filter(group=>group.documents.length>0);
  return <>
    {showIntro&&<div className="outbound-upload-modal-intro"><strong>{onlyRequiredUnresolved?"需要补充以下文件":"装车任务文件"}</strong><span>点击文件名称即可选择上传；系统沿用已有有效版本，上传成功后会立即刷新当前清单。</span></div>}
    {visibleGroups.map(group=><section className="outbound-upload-order" key={group.orderId}>
      <header><strong>{group.orderNumber} · {group.customerName}</strong><span>{group.documents.filter(document=>document.attachmentId).length}/{group.documents.length} 已上传</span></header>
      <div className="table-wrap outbound-document-table"><table><thead><tr><th>点击文件名选择上传</th><th>当前状态</th><th>当前文件</th><th>说明</th></tr></thead><tbody>{group.documents.map(document=><tr className={document.attachmentId?"completed-row":document.required?"required-missing-row":"optional-missing-row"} key={`${document.orderId}:${document.code}`}>
        <td><Form method="post" encType="multipart/form-data" className="outbound-document-upload-form">
          <input type="hidden" name="intent" value="loading_document_upload"/><input type="hidden" name="inspectionOrderId" value={inspection.batch.order_id}/><input type="hidden" name="orderId" value={document.orderId}/><input type="hidden" name="batchId" value={inspection.batch.id}/><input type="hidden" name="documentCategory" value={document.code}/>
          <label className={`outbound-document-name-upload${document.attachmentId?"":document.required?" missing required-missing":" optional-missing"}`}><input className="document-upload-input" name="attachment" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required disabled={busy} onChange={(event)=>submitForm(event.currentTarget.form)}/><strong>{document.name}</strong><small>{document.required?"必需文件":"选填文件"} · 点击选择{document.attachmentId?"替换":"上传"}</small></label>
        </Form></td>
        <td><span className={`status-pill ${document.attachmentId?"":document.required?"warning":"off"}`}>{outboundDocumentStatus(document)}</span></td>
        <td title={document.fileName??undefined}>{document.attachmentId&&warehouseId?<a className="outbound-document-current-file" href={warehouseOrderDocumentHref(document.attachmentId,warehouseId)} target="_blank" rel="noreferrer"><strong>{document.fileName}</strong><small>{formatBytes(document.sizeBytes)}</small></a>:document.fileName||"尚未上传"}</td>
        <td>{document.attachmentId&&warehouseId?<a className="secondary outbound-document-view-button" href={warehouseOrderDocumentHref(document.attachmentId,warehouseId)} target="_blank" rel="noreferrer">查看文件</a>:document.attachmentId?"可点击文件名替换当前版本":"选择后自动上传并刷新"}</td>
      </tr>)}</tbody></table></div>
    </section>)}
  </>;
}

function OutboundOrderDocumentWorkspace({inspection,warehouseId,busy}:{inspection:OutboundInspection;warehouseId:string;busy:boolean}){
  const groups=inspection.documentGroups;
  const [activeOrderId,setActiveOrderId]=useState(groups[0]?.orderId??"");
  const activeGroup=groups.find(group=>group.orderId===activeOrderId)??groups[0];
  useEffect(()=>{
    if(activeGroup&&activeOrderId!==activeGroup.orderId)setActiveOrderId(activeGroup.orderId);
  },[activeGroup?.orderId,activeOrderId]);
  if(!activeGroup)return <div className="empty-state">当前装车单位没有需要核验的订单文件。</div>;
  const focusTab=(nextIndex:number)=>{
    const next=groups[nextIndex];
    if(!next)return;
    setActiveOrderId(next.orderId);
    window.requestAnimationFrame(()=>document.getElementById(`outbound-order-tab-${next.orderId}`)?.focus());
  };
  return <section className="outbound-order-document-workspace" aria-label="按订单核验发运文件">
    <div className="outbound-order-document-tabs peer-page-tabs" role="tablist" aria-label="装车订单">
      {groups.map((group,index)=>{
        const required=group.documents.filter(document=>document.required);
        const uploaded=required.filter(document=>document.attachmentId).length;
        const active=group.orderId===activeGroup.orderId;
        return <button
          key={group.orderId}
          id={`outbound-order-tab-${group.orderId}`}
          type="button"
          role="tab"
          aria-selected={active}
          aria-controls={`outbound-order-panel-${group.orderId}`}
          tabIndex={active?0:-1}
          className={active?"active":undefined}
          onClick={()=>setActiveOrderId(group.orderId)}
          onKeyDown={event=>{
            if(event.key==="ArrowRight"){event.preventDefault();focusTab((index+1)%groups.length);}
            if(event.key==="ArrowLeft"){event.preventDefault();focusTab((index-1+groups.length)%groups.length);}
            if(event.key==="Home"){event.preventDefault();focusTab(0);}
            if(event.key==="End"){event.preventDefault();focusTab(groups.length-1);}
          }}
        ><strong>{group.orderNumber}</strong><small>{group.customerName} · {uploaded}/{required.length} 必需文件</small></button>;
      })}
    </div>
    <div className="outbound-order-document-viewport">
      <section
        key={activeGroup.orderId}
        id={`outbound-order-panel-${activeGroup.orderId}`}
        role="tabpanel"
        aria-labelledby={`outbound-order-tab-${activeGroup.orderId}`}
        className="outbound-order-document-panel"
      >
        <header><div><strong>{activeGroup.orderNumber}</strong><span>{activeGroup.customerName} · 当前仅显示本订单文件</span></div><span className={`status-pill ${activeGroup.allUploaded?"success":"warning"}`}>{activeGroup.allUploaded?"必需文件已齐":`待补 ${activeGroup.documents.filter(document=>document.required&&!document.attachmentId).length} 份`}</span></header>
        <OutboundDocumentUploadList inspection={inspection} warehouseId={warehouseId} busy={busy} orderId={activeGroup.orderId} showIntro={false}/>
      </section>
    </div>
  </section>;
}

function CreateDispatchWorkbench({warehouseId,inspection,outboundResources,borderPorts,customsPlaces,busy,actionError}:{warehouseId:string;inspection:OutboundInspection|null;outboundResources:OutboundResources;borderPorts:ReferenceOption[];customsPlaces:ReferenceOption[];busy:boolean;actionError?:string}){
  const [carrierId,setCarrierId]=useState("");
  const [vehicleId,setVehicleId]=useState("");
  const [driverId,setDriverId]=useState("");
  const [creatingDriver,setCreatingDriver]=useState(false);
  const [documentDrawerOpen,setDocumentDrawerOpen]=useState(false);
  useModalScrollLock(documentDrawerOpen);
  const isFtl=inspection?.batch.business_type==="ftl";
  const taskLabel=isFtl?inspection?.batch.order_number:inspection?.batch.batch_number;
  const uploadedCount=inspection?.documents.filter(document=>document.required&&document.attachmentId).length??0;
  const requiredCount=inspection?.documents.filter(document=>document.required).length??0;
  const carrierVehicles=outboundResources.vehicles.filter(vehicle=>vehicle.carrier_id===carrierId);
  const carrierDrivers=outboundResources.drivers.filter(driver=>driver.carrier_id===carrierId);
  const resourcePolicy=inspection?.executionPolicy.resources;
  const plannedDeparturePolicy=inspection?.executionPolicy.batchFields.planned_exit_at;
  const plannedArrivalPolicy=inspection?.executionPolicy.batchFields.planned_arrival_at;
  const stageError=inspection?warehouseOutboundWorkflowActionError(inspection.executionPolicy):null;
  const requiredOutboundMasterDataReady=!resourcePolicy||(
    (!resourcePolicy.carrier.isRequired||outboundResources.carriers.length>0)&&
    (!resourcePolicy.vehicle.isRequired||outboundResources.vehicles.length>0)&&
    (!resourcePolicy.driver.isRequired||outboundResources.carriers.length>0)
  );
  const remainingRequired=Math.max(0,requiredCount-uploadedCount);
  const batchPlan=!isFtl?inspection?.dispatchPlan:null;
  const batchOrigin=inspection?.batch.transport_batch_origin_location||"起运地待登记";
  const batchDestination=inspection?.batch.transport_batch_destination_location||inspection?.batch.destination_location||"目的地待登记";
  const batchCustomerCount=inspection?new Set(inspection.documentGroups.map(group=>group.customerName)).size:0;
  return <div className="outbound-create-workbench">
    {!inspection&&<div className="alert error" role="alert">无法读取该订单的装车文件清单，请返回在仓订单列表重新进入。</div>}
    {stageError&&stageError!==actionError&&<div className="alert warning" role="alert">{stageError}</div>}
    {inspection&&<>
      <div className={`outbound-inspection-summary${isFtl?"":" is-batch"}`}>
        <span>{isFtl?"订单":"PZ 配载单"}<strong>{taskLabel}</strong></span>
        <span>{isFtl?"客户":"订单 / 客户"}<strong>{isFtl?inspection.batch.customer_name:`${inspection.documentGroups.length} 票 · ${batchCustomerCount} 个客户`}</strong></span>
        <span>{isFtl?"运输类型":"运输线路"}<strong title={isFtl?undefined:`${batchOrigin} → ${batchDestination}`}>{isFtl?"整车":`${batchOrigin} → ${batchDestination}`}</strong></span>
        {!isFtl&&<span>承运车辆<strong>{batchPlan?.carrier_name||"承运商待登记"} · {batchPlan?.vehicle_plate||"车辆待登记"}</strong></span>}
        {!isFtl&&<span>司机 / 发车<strong>{batchPlan?.driver_name||"司机待登记"} · {batchPlan?.planned_departure_at?formatWarehouseTime(batchPlan.planned_departure_at):"时间待登记"}</strong></span>}
        <span>文件进度<strong>{uploadedCount}/{requiredCount} 已上传</strong></span>
      </div>
      {stageError?<OutboundCreationReadOnly inspection={inspection} warehouseId={warehouseId}/>:<>
      <section className="outbound-document-gate-summary">
        <div><strong>发运文件</strong><span>{inspection.allApproved?"必需文件已齐并已确认":inspection.allUploaded?"文件已齐，等待其他账号确认":`还需补充 ${remainingRequired} 份必需文件`}</span></div>
        <span className={`status-pill ${inspection.allApproved?"success":"warning"}`}>{uploadedCount}/{requiredCount}</span>
        <button type="button" className="secondary" onClick={()=>setDocumentDrawerOpen(true)}>查看 / 补充文件</button>
      </section>
      {documentDrawerOpen&&<div className="linear-drawer-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setDocumentDrawerOpen(false)}}>
        <aside className="linear-order-drawer outbound-document-drawer" role="dialog" aria-modal="true" aria-label="装车发运文件">
          <header className="linear-drawer-head"><div><span>LOADING DOCUMENTS</span><h2>装车发运文件</h2></div><button type="button" onClick={()=>setDocumentDrawerOpen(false)} aria-label="关闭">×</button></header>
          <div className="outbound-document-drawer-body"><OutboundOrderDocumentWorkspace inspection={inspection} warehouseId={warehouseId} busy={busy}/></div>
        </aside>
      </div>}
      <Form method="post" className="outbound-inline-create-form" onKeyDown={event=>{if(event.key==="Enter")event.preventDefault();}} onSubmit={event=>{const submitter=(event.nativeEvent as SubmitEvent).submitter;if(!(submitter instanceof HTMLButtonElement)||submitter.name!=="createConfirmation"||submitter.value!=="confirm_dispatch_creation")event.preventDefault();}}>
        <input type="hidden" name="intent" value="create"/><input type="hidden" name="batchId" value={inspection.batch.id}/><input type="hidden" name="orderNumber" value={isFtl?inspection.batch.order_number:""}/><input type="hidden" name="customerIdentityCode" value={isFtl?inspection.batch.customer_identity_code:""}/>
        <section className="outbound-packing-ready-summary">
          <header><div><strong>最终包装与贴标已完成</strong><span>本页只创建装车任务，不会重新成包或生成 OUL。</span></div><span className="status-pill success">已锁定</span></header>
          <div><span>订单范围<strong>{inspection.documentGroups.length} 票</strong></span><span>最终出仓包装<strong>{inspection.batch.item_count} 个 OUL</strong></span><span>总重量<strong>{Number(inspection.batch.total_weight_kg).toFixed(2)} KG</strong></span><span>总体积<strong>{Number(inspection.batch.total_volume_cbm).toFixed(3)} CBM</strong></span><Link className="secondary" to={`/warehouse/packing?warehouseId=${encodeURIComponent(warehouseId)}`}>查看包装与标签</Link></div>
        </section>
        {!isFtl&&<section className="outbound-batch-order-check" aria-label="配载单挂载订单核对">
          <header><div><strong>挂载订单与最终包装</strong><span>创建前核对每票订单的客户、货物、OUL、实测数据、库位和发运文件。</span></div><span>{inspection.orderSummaries.length} 票 · {inspection.orderSummaries.reduce((total,order)=>total+order.oulCount,0)} 个 OUL</span></header>
          <div className="table-wrap"><table className="outbound-order-check-table"><thead><tr><th>订单 / 客户</th><th>货物</th><th>最终包装</th><th>实重 / 体积</th><th>库位</th><th>发运文件</th></tr></thead><tbody>{inspection.orderSummaries.map(order=><tr key={order.orderId}><td><strong>{order.orderNumber}</strong><small>{order.customerName}</small></td><td title={order.cargoSummary}>{order.cargoSummary}</td><td><strong>{order.oulCount} 个 OUL</strong><small>{order.pieces} 件</small></td><td><strong>{order.weightKg.toFixed(2)} KG</strong><small>{order.volumeCbm.toFixed(3)} CBM</small></td><td title={order.storageLocations}>{order.storageLocations}</td><td><span className={`status-pill ${order.approvedDocumentCount===order.requiredDocumentCount?"success":"warning"}`}>{order.approvedDocumentCount}/{order.requiredDocumentCount} 已确认</span></td></tr>)}</tbody></table></div>
        </section>}
        {isFtl&&<section className="ftl-outbound-resource-confirmation">
          <header><div><strong>确认整车出境路线与运输资源</strong><span>本区字段直接采用当前订单的工作流显示/必填规则；创建后原子同步到管理端。</span></div><span className="status-pill warning">创建前确认</span></header>
          {!requiredOutboundMasterDataReady&&<div className="alert error" role="alert">工作流必填的境外运输主数据尚无可选项，请先在管理端承运商台账补齐。选填项缺失不会阻断创建。</div>}
          <div className="ftl-outbound-resource-grid">
            <div className="ftl-outbound-route-row">
              {inspection.executionPolicy.batchFields.exit_port.isActive&&<label className="field"><span>出境口岸{inspection.executionPolicy.batchFields.exit_port.isRequired?" *":"（选填）"}</span><select name="exitPort" defaultValue={inspection.batch.exit_port||""} required={inspection.executionPolicy.batchFields.exit_port.isRequired}><option value="">请选择出境口岸</option><ReferenceOptions currentValue={inspection.batch.exit_port} options={borderPorts}/></select></label>}
              {inspection.executionPolicy.batchFields.customs_location.isActive&&<label className="field"><span>起运地清关地{inspection.executionPolicy.batchFields.customs_location.isRequired?" *":"（选填）"}</span><select name="customsLocation" defaultValue={inspection.batch.customs_location||""} required={inspection.executionPolicy.batchFields.customs_location.isRequired}><option value="">请选择起运地清关地</option><ReferenceOptions currentValue={inspection.batch.customs_location} options={customsPlaces}/></select></label>}
            </div>
            <div className="ftl-outbound-transport-row">
              {resourcePolicy?.carrier.isActive&&<label className="field"><span>境外承运商{resourcePolicy.carrier.isRequired?" *":"（选填）"}</span><select name="outboundCarrierId" value={carrierId} required={resourcePolicy.carrier.isRequired} onChange={event=>{setCarrierId(event.target.value);setVehicleId("");setDriverId("");setCreatingDriver(false);}}><option value="">请选择境外承运商</option>{outboundResources.carriers.map(carrier=><option key={carrier.id} value={carrier.id}>{carrier.name}</option>)}</select></label>}
              {resourcePolicy?.driver.isActive&&<div className="field outbound-driver-field"><span id="outbound-driver-label">出境司机{resourcePolicy.driver.isRequired?" *":"（选填）"}</span><OutboundDriverPicker carrierId={carrierId} drivers={carrierDrivers} value={driverId} required={resourcePolicy.driver.isRequired} onChange={value=>{setDriverId(value);setCreatingDriver(false);}} onCreate={()=>{setDriverId(NEW_OUTBOUND_DRIVER_ID);setCreatingDriver(true);}}/></div>}
              {resourcePolicy?.vehicle.isActive&&<label className="field"><span>出境车辆{resourcePolicy.vehicle.isRequired?" *":"（选填）"}</span><select name="outboundVehicleId" value={vehicleId} required={resourcePolicy.vehicle.isRequired} disabled={!carrierId} onChange={event=>setVehicleId(event.target.value)}><option value="">{carrierId?"请选择该承运商车辆":"请先选择承运商"}</option>{carrierVehicles.map(vehicle=><option key={vehicle.id} value={vehicle.id}>{vehicle.plate_number} · {vehicle.vehicle_type||"车型未登记"}</option>)}</select></label>}
              {plannedDeparturePolicy?.isActive&&<label className="field"><span>计划出境发车时间{plannedDeparturePolicy.isRequired?" *":"（选填）"}</span><input type="datetime-local" name="plannedDepartureAt" required={plannedDeparturePolicy.isRequired}/></label>}
              {plannedArrivalPolicy?.isActive&&<label className="field"><span>计划境外到仓时间{plannedArrivalPolicy.isRequired?" *":"（选填）"}</span><input type="datetime-local" name="plannedArrivalAt" required={plannedArrivalPolicy.isRequired}/></label>}
            </div>
            {creatingDriver&&resourcePolicy?.driver.isActive&&<fieldset className="outbound-new-driver-panel"><legend>新司机资料</legend><p>保存装车任务时自动登记到当前承运商，并立即用于本次出境运输。</p><div className="outbound-new-driver-grid"><label className="field"><span>司机姓名 *</span><input name="newOutboundDriverName" minLength={2} maxLength={80} autoComplete="name" required placeholder="请输入司机姓名"/></label>{inspection.executionPolicy.batchFields.main_driver_phone.isActive&&<label className="field"><span>司机手机号{inspection.executionPolicy.batchFields.main_driver_phone.isRequired?" *":"（选填）"}</span><input name="newOutboundDriverPhone" maxLength={30} autoComplete="tel" required={inspection.executionPolicy.batchFields.main_driver_phone.isRequired} placeholder="请输入司机联系电话"/></label>}<label className="field"><span>驾驶证号（选填）</span><input name="newOutboundDriverLicenseNumber" maxLength={80} placeholder="用于司机台账识别"/></label><button type="button" className="secondary outbound-cancel-new-driver" onClick={()=>{setCreatingDriver(false);setDriverId("");}}>取消新建</button></div></fieldset>}
          </div>
        </section>}
        {!isFtl&&inspection.resourcePolicyError&&<div className="alert error" role="alert">{inspection.resourcePolicyError}</div>}
        {!isFtl&&inspection.resourceDifferences.length>0&&<div className="alert info" role="status"><strong>选填运输信息未登记：</strong>{inspection.resourceDifferences.map(item=>item.label).join("、")}。不阻断装车任务，系统会在审计中记录当前差异。</div>}
        {inspection.notesActive&&<label className="field outbound-handover-notes"><span>交接备注{inspection.notesRequired?" *":""}</span><textarea name="notes" rows={3} required={inspection.notesRequired} placeholder="填写装车交接、装载要求或出库注意事项"/></label>}
        <div className="outbound-inline-create-footer">
          <div role="status" aria-live="polite"><strong>{inspection.allApproved?"文件核验已完成":inspection.allUploaded?"等待文件确认":"必需文件尚未齐全"}</strong><span>{inspection.allApproved?(isFtl?"确认出境资源后即可创建装车任务。":"全部订单文件已确认，可按当前 PZ 配载单统一创建装车任务。"):inspection.allUploaded?"请由非上传账号确认待审文件。":`还需上传 ${remainingRequired} 份必需文件。`}</span></div>
          <button type="submit" name="createConfirmation" value="confirm_dispatch_creation" className="primary warehouse-primary" disabled={!inspection.allApproved||busy||(isFtl&&!requiredOutboundMasterDataReady)||Boolean(inspection.resourcePolicyError)}>确认并创建装车任务</button>
        </div>
      </Form>
      </>}
    </>}
  </div>;
}

function OutboundDriverPicker({carrierId,drivers,value,required,onChange,onCreate}:{carrierId:string;drivers:OutboundResources["drivers"];value:string;required:boolean;onChange:(value:string)=>void;onCreate:()=>void}){
  const [open,setOpen]=useState(false);
  const rootRef=useRef<HTMLDivElement>(null);
  const selected=drivers.find(driver=>driver.id===value);
  useEffect(()=>{setOpen(false)},[carrierId]);
  useEffect(()=>{
    if(!open)return;
    const closeOnOutside=(event:PointerEvent)=>{if(event.target instanceof Node&&!rootRef.current?.contains(event.target))setOpen(false)};
    const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();setOpen(false);rootRef.current?.querySelector<HTMLButtonElement>(".outbound-driver-picker-trigger")?.focus()}};
    document.addEventListener("pointerdown",closeOnOutside,true);
    document.addEventListener("keydown",closeOnEscape,true);
    return()=>{document.removeEventListener("pointerdown",closeOnOutside,true);document.removeEventListener("keydown",closeOnEscape,true)};
  },[open]);
  const label=value===NEW_OUTBOUND_DRIVER_ID?"正在新建未登记司机":selected?`${selected.name} · ${selected.phone||"电话未登记"}`:carrierId?"请选择该承运商司机":"请先选择承运商";
  return <div ref={rootRef} className={`outbound-driver-picker${open?" is-open":""}`}>
    <input type="hidden" name="outboundDriverId" value={value}/>
    <button type="button" className="outbound-driver-picker-trigger" aria-labelledby="outbound-driver-label" aria-haspopup="listbox" aria-expanded={open} aria-required={required} disabled={!carrierId} onClick={()=>setOpen(current=>!current)}><span>{label}</span><b aria-hidden="true">▾</b></button>
    {open&&<div className="outbound-driver-picker-drawer" role="listbox" aria-label="选择出境司机">
      <div className="outbound-driver-picker-options">
        {drivers.map(driver=><button key={driver.id} type="button" role="option" aria-selected={driver.id===value} onClick={()=>{onChange(driver.id);setOpen(false)}}><strong>{driver.name}</strong><span>{driver.phone||"电话未登记"}</span></button>)}
        {!drivers.length&&<p>当前承运商还没有已登记司机。</p>}
      </div>
      <footer><button type="button" className="primary" onClick={()=>{onCreate();setOpen(false)}}>＋ 新建司机</button><span>新建后随本次装车任务自动登记并使用</span></footer>
    </div>}
  </div>;
}

function OutboundCreationReadOnly({inspection,warehouseId}:{inspection:OutboundInspection;warehouseId:string}){
  return <section className="outbound-order-document-workspace" aria-label="装车资料只读预览">
    <header><div><strong>已有装车资料</strong><span>当前节点只读；不会显示上传、确认或创建控件。</span></div><span className="status-pill off">只读</span></header>
    <div className="table-wrap"><table><thead><tr><th>订单</th><th>文件</th><th>状态</th><th>当前版本</th></tr></thead><tbody>{inspection.documents.map(document=><tr key={`${document.orderId}:${document.code}`}><td>{document.orderNumber}</td><td>{document.name}</td><td>{outboundDocumentStatus(document)}</td><td>{document.attachmentId?<a href={warehouseOrderDocumentHref(document.attachmentId,warehouseId)} target="_blank" rel="noreferrer">{document.fileName||"查看文件"}</a>:"尚未提供"}</td></tr>)}</tbody></table></div>
  </section>;
}

function ReferenceOptions({currentValue,options}:{currentValue:string|null;options:ReferenceOption[]}){
  const hasCurrent=Boolean(currentValue&&options.some(option=>option.code===currentValue));
  return <>{currentValue&&!hasCurrent&&<option value={currentValue}>{currentValue}（历史值）</option>}{options.map(option=><option key={option.code} value={option.code}>{option.name} · {option.code}</option>)}</>;
}

export function WarehouseOutboundRouteReadOnly({exitPort,customsLocation,targetStepName,reason,exitPolicy={isActive:true},customsPolicy={isActive:true}}:{exitPort:string|null;customsLocation:string|null;targetStepName:string;reason:string;exitPolicy?:{isActive:boolean};customsPolicy?:{isActive:boolean}}){
  if(!exitPolicy.isActive&&!customsPolicy.isActive)return null;
  return <section className="panel outbound-route-field-editor">
    <div className="panel-header"><div><h2>出境路线信息</h2><p>来源于当前订单“{targetStepName}”节点，当前仅供查看。</p></div><span className="status-pill off">只读</span></div>
    <div className="alert warning" role="status">{reason}</div>
    <div className="table-wrap"><table><thead><tr>{exitPolicy.isActive&&<th>出境口岸</th>}{customsPolicy.isActive&&<th>起运地清关地</th>}</tr></thead><tbody><tr>{exitPolicy.isActive&&<td>{exitPort||"未登记"}</td>}{customsPolicy.isActive&&<td>{customsLocation||"未登记"}</td>}</tr></tbody></table></div>
  </section>;
}

function FtlOutboundRouteEditor({task,workflowPolicy,borderPorts,customsPlaces,busy,canOperate}:{task:Dispatch;workflowPolicy:OutboundExecutionPolicy;borderPorts:ReferenceOption[];customsPlaces:ReferenceOption[];busy:boolean;canOperate:boolean}){
  const exitPolicy=workflowPolicy.batchFields.exit_port,customsPolicy=workflowPolicy.batchFields.customs_location;
  const stageError=warehouseOutboundWorkflowActionError(workflowPolicy);
  const targetStepName=workflowPolicy.loadingStage.targetStepName||"装车与出库";
  if(!exitPolicy.isActive&&!customsPolicy.isActive)return null;
  if(stageError||!canOperate)return <WarehouseOutboundRouteReadOnly exitPort={task.exit_port} customsLocation={task.customs_location} targetStepName={targetStepName} reason={stageError||"当前账户仅可查看该节点信息"} exitPolicy={exitPolicy} customsPolicy={customsPolicy}/>;
  const routeError=validateFtlOutboundRouteFields({exitPort:task.exit_port||"",customsLocation:task.customs_location||"",policies:workflowPolicy.batchFields});
  const workflowSyncPending=task.status==="dispatched";
  return <section className={`panel outbound-route-field-editor${routeError||workflowSyncPending?" needs-attention":""}`}>
    <div className="panel-header"><div><h2>出境路线信息</h2><p>来源于当前订单“{targetStepName}”节点；保存后立即同步管理端并重新计算业务工作流门禁。</p></div><span className={`status-pill ${routeError||workflowSyncPending?"warning":"success"}`}>{routeError?"必填项待补":workflowSyncPending?"工作流待同步":"已同步"}</span></div>
    <Form method="post" className="ftl-outbound-route-form">
      <input type="hidden" name="intent" value="route_fields"/><input type="hidden" name="dispatchId" value={task.id}/>
      {exitPolicy.isActive&&<label className="field"><span>出境口岸{exitPolicy.isRequired?" *":"（选填）"}</span><select name="exitPort" defaultValue={task.exit_port||""} required={exitPolicy.isRequired} disabled={busy}><option value="">请选择出境口岸</option><ReferenceOptions currentValue={task.exit_port} options={borderPorts}/></select></label>}
      {customsPolicy.isActive&&<label className="field"><span>起运地清关地{customsPolicy.isRequired?" *":"（选填）"}</span><select name="customsLocation" defaultValue={task.customs_location||""} required={customsPolicy.isRequired} disabled={busy}><option value="">请选择起运地清关地</option><ReferenceOptions currentValue={task.customs_location} options={customsPlaces}/></select></label>}
      <button className="primary warehouse-primary" disabled={busy}>{routeError?"补齐并重新同步":workflowSyncPending?"重新同步业务工作流":"保存路线信息"}</button>
    </Form>
  </section>;
}

function outboundDocumentStatus(document:OutboundDocument){if(!document.attachmentId)return document.required?"待上传":"选填";if(["approved","archived"].includes(document.reviewStatus||""))return"已确认";if(document.reviewStatus==="rejected")return"已退回";return"待检查";}
function formatBytes(value:number|null){if(!value)return"—";return value>=1024*1024?`${(value/1024/1024).toFixed(2)} MB`:`${(value/1024).toFixed(1)} KB`;}
function packageTypeLabel(value:string|null){return({carton:"纸箱",pallet:"托盘",wooden_case:"木箱",bag:"袋装",drum:"桶装",bundle:"捆装",other:"其他",mixed:"混合包装"} as Record<string,string>)[value||"other"]||value||"其他";}
function cargoDimensions(item:Item){return item.length_cm!==null&&item.width_cm!==null&&item.height_cm!==null?`${item.length_cm} × ${item.width_cm} × ${item.height_cm} cm`:"—";}
function cargoLoadedAt(value:string|null){return value?new Date(value).toLocaleString("zh-CN",{hour12:false}):"—";}
function printOulLabels(){document.body.classList.add("printing-oul-labels");window.print();window.setTimeout(()=>document.body.classList.remove("printing-oul-labels"),250);}
function OulLabelPanel({task,items,packingBatches,busy,canOperate,closeSignal}:{task:Dispatch;items:Item[];packingBatches:PackingBatchSummary[];busy:boolean;canOperate:boolean;closeSignal?:string}){
  const [drawerOpen,setDrawerOpen]=useState(false);
  useModalScrollLock(drawerOpen);
  const groups=[...new Map(items.map(item=>[item.order_id,{orderId:item.order_id,orderNumber:item.order_number,count:items.filter(row=>row.order_id===item.order_id).length}])).values()];
  const canRepack=task.status==="loading"&&task.loaded_count===0&&items.length>0;
  const allPrinted=packingBatches.length>0&&packingBatches.every(batch=>["printed","labelled","loading","dispatched"].includes(batch.status));
  const allLabelled=packingBatches.length>0&&packingBatches.every(batch=>["labelled","loading","dispatched"].includes(batch.status)&&Boolean(batch.labeling_confirmed_at));
  return <section className="panel oul-label-panel">
    <div className="panel-header no-print"><div><h2>最终出库包装（OUL）</h2><p>每张 OUL 只属于一张订单，并贯穿国内装车、境外仓收货和客户自提。</p></div><div className="button-row"><button type="button" className="primary warehouse-primary" onClick={()=>setDrawerOpen(true)} disabled={!items.length}>{allLabelled?"查看 / 补打 OUL":allPrinted?"继续贴标确认":"打印 OUL"}</button>{canOperate&&canRepack&&<Modal title="重做最终出库包装" triggerLabel="调整成包数量" triggerClassName="secondary" closeSignal={closeSignal}><Form method="post" className="stack"><input type="hidden" name="intent" value="repack_oul"/><input type="hidden" name="dispatchId" value={task.id}/><div className="alert warning">保存后原 OUL 立即作废并生成新版。仅在尚未扫描任何 OUL 时允许操作。</div>{groups.map(group=><label className="field" key={group.orderId}><span>{group.orderNumber} · 最终 OUL 数量 *</span><input type="number" min="1" max="500" step="1" name={`outboundPackageCount_${group.orderId}`} defaultValue={group.count} required/></label>)}<button className="primary warehouse-primary" disabled={busy}>作废原标签并生成新版</button></Form></Modal>}</div></div>
    <div className="oul-label-summary no-print"><span>{groups.length} 票订单</span><span>{items.length} 个最终出仓包裹</span><span className={`status-pill ${allLabelled?"success":allPrinted?"warning":"off"}`}>{allLabelled?"已贴标，可扫码":allPrinted?"待确认贴标":"待打印"}</span>{task.loaded_count>0&&<span className="status-pill warning">已开始装车，成包已锁定</span>}</div>
    {drawerOpen&&<div className="linear-drawer-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setDrawerOpen(false)}}><aside className="linear-order-drawer outbound-oul-drawer" role="dialog" aria-modal="true" aria-label="OUL 标签"><header className="linear-drawer-head no-print"><div><span>OUTBOUND UNIT LABELS</span><h2>{task.dispatch_number} · OUL 标签</h2></div><button type="button" onClick={()=>setDrawerOpen(false)} aria-label="关闭">×</button></header><div className="outbound-oul-drawer-body"><div className="oul-label-print-area">{items.map(item=>{const orderItems=items.filter(row=>row.order_id===item.order_id),sequence=orderItems.findIndex(row=>row.id===item.id)+1;return <article className="oul-label" key={item.id}><header><strong>OULING 国际物流</strong><span>出境包装标签</span></header><Code39 value={item.barcode}/><b>{item.barcode}</b><dl><div><dt>订单号</dt><dd>{item.order_number}</dd></div><div><dt>包装序号</dt><dd>{sequence} / {orderItems.length}</dd></div><div><dt>货物</dt><dd>{item.cargo_name_cn||"—"}</dd></div><div><dt>任务</dt><dd>{task.dispatch_number}</dd></div></dl><footer>OUL 全程身份：国内装车 → 境外整批收货 → 客户整单自提签收</footer></article>})}</div></div>{canOperate&&task.status==="loading"&&<footer className="outbound-oul-drawer-actions no-print">{!allLabelled&&<Form method="post"><input type="hidden" name="intent" value="record_oul_print"/><input type="hidden" name="dispatchId" value={task.id}/><button type="submit" className="secondary" onClick={printOulLabels} disabled={busy}>打印全部并记录</button></Form>}{allPrinted&&!allLabelled&&<Form method="post"><input type="hidden" name="intent" value="confirm_oul_labeling"/><input type="hidden" name="dispatchId" value={task.id}/><button className="primary warehouse-primary" disabled={busy}>已贴好全部标签，开始装车</button></Form>}{allLabelled&&<span className="status-pill success">全部贴标已确认</span>}</footer>}</aside></div>}
  </section>;
}
export function DispatchCard({warehouseId,task,items,itemPagination,manifest,busy,canOperate,workflowPolicy,resourceDifferences,resourcePolicyError,highlightedBarcode}:{warehouseId:string;task:Dispatch;items:Item[];itemPagination:{page:number;pageCount:number;pageSize:number;total:number};manifest?:ManifestDoc;busy:boolean;canOperate:boolean;workflowPolicy:OutboundExecutionPolicy|null;resourceDifferences:OutboundPolicyDifference[];resourcePolicyError:string|null;highlightedBarcode?:string}){
  const allLoaded=task.item_count>0&&task.loaded_count===task.item_count;
  const stageError=warehouseOutboundWorkflowActionError(workflowPolicy),stageAvailable=!stageError;
  const scanPolicy=workflowPolicy?.scanConfirmation??{isActive:false,isRequired:false,mode:"hidden" as const};
  const plannedExitPolicy=workflowPolicy?.batchFields.planned_exit_at??{isActive:false,isRequired:false,mode:"hidden" as const};
  const missingScanCount=Math.max(0,task.item_count-task.loaded_count);
  const canDispatch=stageAvailable&&task.item_count>0&&allLoaded;
  const subject=dispatchTaskSubject(task);
  return <section className="panel dispatch-sheet">
    <div className="panel-header"><div><h2>{task.dispatch_number}</h2><p><strong>{subject.primary}</strong> · {subject.secondary}</p></div><div className="dispatch-progress"><strong>{task.loaded_count}/{task.item_count}</strong><span>整单已装车</span></div></div>
    {stageError&&<div className="alert warning" role="alert"><strong>当前仅可查看：</strong>{stageError}</div>}
    {stageAvailable&&!canOperate&&<div className="alert info" role="status"><strong>当前账户仅可查看：</strong>装车任务、扫码进度和货物信息实时展示；本页不显示提交控件。</div>}
    <div className="table-wrap dispatch-meta-table"><table><thead><tr><th>车辆</th><th>司机</th><th>目的地</th><th>计划出境</th></tr></thead><tbody><tr><td><strong>{task.vehicle_plate}</strong></td><td>{task.driver_name}</td><td>{task.destination}</td><td>{task.planned_departure_at?new Date(task.planned_departure_at).toLocaleString("zh-CN"):"未填写"}</td></tr></tbody></table></div>
    {canOperate&&stageAvailable&&task.transport_batch_id&&!task.planned_departure_at&&plannedExitPolicy.isActive&&<Form method="post" className="scan-inline outbound-schedule-inline"><input type="hidden" name="intent" value="schedule"/><input type="hidden" name="dispatchId" value={task.id}/><label className="field"><span>计划出境发车时间{plannedExitPolicy.isRequired?" *":"（选填）"}</span><input type="datetime-local" name="plannedDepartureAt" required={plannedExitPolicy.isRequired}/></label><button className="primary warehouse-primary" disabled={busy}>保存计划时间</button></Form>}
    {manifest&&<div className="table-wrap dispatch-manifest-table"><table><thead><tr><th>配载单</th><th>数据来源</th></tr></thead><tbody><tr><td><a href={warehouseBatchDocumentHref(manifest.id,warehouseId)} target="_blank" rel="noreferrer">{manifest.file_name}</a></td><td>工作台自动生成，点击打开对照装车</td></tr></tbody></table></div>}
    {resourcePolicyError&&<div className="alert error" role="alert">{resourcePolicyError}</div>}
    {!resourcePolicyError&&resourceDifferences.length>0&&<div className="alert info" role="status"><strong>选填运输信息未登记：</strong>{resourceDifferences.map(item=>item.label).join("、")}。该差异仅记录审计，不阻断扫码或出库。</div>}
    {canOperate&&stageAvailable&&!resourcePolicyError&&<Form key={task.loaded_count} method="post" className={`scan-inline outbound-loading-scan${allLoaded?" scan-complete":""}`}><input type="hidden" name="intent" value={allLoaded?"dispatch":"load"}/><input type="hidden" name="dispatchId" value={task.id}/>{allLoaded?<div className="outbound-final-action-guide" role="status" aria-live="polite"><span className="outbound-final-action-step" aria-hidden="true">4</span><span className="outbound-final-action-copy"><span className="outbound-final-action-kicker">下一步 · 出库交接</span><strong>全部 OUL 已扫码，等待最终确认</strong><small>确认后同步管理端；如需纸质交接单，可在成功页打印。</small></span></div>:<label className="field outbound-scan-code-field"><span>连续扫描 OUL *</span><OutboundBarcodeInput busy={busy}/><small>扫描一张后按 Enter 即自动登记并继续聚焦，无需点击按钮。</small></label>}<button type="submit" className={allLoaded?"primary warehouse-primary outbound-finalize-button":"visually-hidden"} autoFocus={allLoaded} aria-keyshortcuts={allLoaded?"Enter":undefined} disabled={busy}>{allLoaded?<><span>确认整批装车出库</span><span className="outbound-finalize-arrow" aria-hidden="true">→</span></>:"登记本张 OUL"}</button></Form>}
    <section className="dispatch-cargo-list"><header><div><h3>最终出仓包裹</h3><p>每行是一件贴有 OUL 的实体包裹；必须全部扫码后才能整批出库。</p></div><span>{task.loaded_count}/{task.item_count} 已扫描</span></header><div className="table-wrap"><table><thead><tr><th>状态</th><th>货物名称</th><th>OUL</th><th>订单</th><th>包装</th><th>装车时间</th></tr></thead><tbody aria-live="polite">{items.map(item=><tr key={item.id} className={item.barcode===highlightedBarcode?"current-scan":""}><td><span className={`status-pill ${item.status!=="loaded"?"off":"success"}`}>{item.status==="loaded"?"已扫描":"未扫描"}</span></td><td><strong>{item.cargo_name_cn||"订单货物"}</strong></td><td><strong>{item.barcode}</strong></td><td>{item.order_number}</td><td>最终出仓包装</td><td>{cargoLoadedAt(item.loaded_at)}</td></tr>)}</tbody></table></div><QueryPagination {...itemPagination} pageParam="itemPage" unit="个包裹"/></section>
    {canOperate&&canDispatch&&(!scanPolicy.isActive||!allLoaded)&&!resourcePolicyError&&<DispatchConfirmation task={task} busy={busy} scanPolicy={scanPolicy} missingScanCount={missingScanCount}/>}
  </section>;
}

export function DispatchConfirmation({task,busy,scanPolicy,missingScanCount}:{task:Dispatch;busy:boolean;scanPolicy:WarehouseOutboundWorkflowPolicy["scanConfirmation"];missingScanCount:number}){
  const [differenceAcknowledged,setDifferenceAcknowledged]=useState(false);
  const hasDifference=missingScanCount>0;
  if(!hasDifference)return null;
  if(!warehouseOutboundNeedsScanDifferenceConfirmation(scanPolicy,missingScanCount))return <section className="outbound-handover-action ready" id="outbound-handover-action">
    <div><p className="eyebrow">WAREHOUSE HANDOVER</p><h3>逐件扫码已隐藏</h3><p>当前冻结工作流不要求逐件扫码；确认后直接完成出库交接，系统自动记录未扫描数量。</p></div>
    <Form method="post" className="dispatch-confirm"><input type="hidden" name="intent" value="dispatch"/><input type="hidden" name="dispatchId" value={task.id}/><button type="submit" className="primary warehouse-primary" disabled={busy}>确认出库交接</button></Form>
  </section>;
  if(hasDifference&&!differenceAcknowledged)return <section className="outbound-handover-action ready" id="outbound-handover-action">
    <div><p className="eyebrow">WAREHOUSE HANDOVER</p><h3>{scanPolicy.mode==="hidden"?"逐件扫码已隐藏":"仍有货物未扫码"}</h3><p>当前有 {missingScanCount}/{task.item_count} 个货物码未扫描。确认继续后，还需再次点击最终出库按钮；差异将永久写入审计记录。</p></div>
    <button type="button" className="secondary" disabled={busy} onClick={()=>setDifferenceAcknowledged(true)}>我已核对，继续办理出库</button>
  </section>;
  return <section className="outbound-handover-action ready" id="outbound-handover-action">
    <div><p className="eyebrow">WAREHOUSE HANDOVER</p><h3>二次确认未扫码差异</h3><p>将按当前工作流{scanPolicy.mode==="hidden"?"隐藏":"选填"}策略出库，并审计 {missingScanCount} 个未扫描货物码。</p></div>
    <Form method="post" className="dispatch-confirm"><input type="hidden" name="intent" value="dispatch"/><input type="hidden" name="dispatchId" value={task.id}/><input type="hidden" name="scanDifferenceConfirmed" value="yes"/><button type="submit" className="primary warehouse-primary" autoFocus disabled={busy}>确认差异并出库</button></Form>
  </section>;
}
function Handover({warehouseId,task,items,manifest}:{warehouseId:string;task:Dispatch;items:Item[];manifest?:ManifestDoc}){const subject=dispatchTaskSubject(task),isBatch=isConsolidatedOutboundTask(task.business_type,task.transport_batch_id);return <article className="handover-sheet"><header><div><strong>欧凌国际物流</strong><h2>仓库装车交接单</h2></div><b>{task.dispatch_number}</b></header>{manifest&&<p className="handover-manifest-link no-print">配载单：<a href={warehouseBatchDocumentHref(manifest.id,warehouseId)} target="_blank" rel="noreferrer">{manifest.file_name}</a>（点击打开核对装载顺序）</p>}<div className="handover-grid"><span>{isBatch?"PZ 配载单":"订单"}：<strong>{subject.primary}</strong></span><span>订单范围：<strong>{task.order_numbers||task.order_number}</strong></span><span>客户范围：<strong>{task.customer_names||task.customer_name}</strong></span><span>目的地：<strong>{task.destination}</strong></span><span>车牌：<strong>{task.vehicle_plate}</strong></span><span>司机：<strong>{task.driver_name}</strong></span><span>电话：<strong>{task.driver_phone||"—"}</strong></span><span>承运商：<strong>{task.carrier_name||"—"}</strong></span><span>发车时间：<strong>{task.dispatched_at?new Date(task.dispatched_at).toLocaleString("zh-CN"):"—"}</strong></span><span className="wide">交接备注：<strong>{task.notes||"—"}</strong></span></div><table><thead><tr><th>序号</th><th>订单</th><th>货物条码</th><th>件数</th><th>重量 KG</th><th>体积 CBM</th></tr></thead><tbody>{items.map((item,index)=><tr key={item.id}><td>{index+1}</td><td>{item.order_number}</td><td><strong className="handover-cargo-barcode">{item.barcode}</strong></td><td>{item.pieces}</td><td>{item.weight_kg??"—"}</td><td>{item.volume_cbm??"—"}</td></tr>)}</tbody><tfoot><tr><td colSpan={3}>合计</td><td>{task.pieces}</td><td>{task.weight_kg}</td><td>{task.volume_cbm}</td></tr></tfoot></table><footer><span>仓库交接人签字：________________</span><span>司机签字：________________</span><span>交接时间：________________</span></footer></article>}

function warehouseOrderDocumentHref(attachmentId:string,warehouseId:string){return `/warehouse/document-files/order/${attachmentId}?warehouseId=${encodeURIComponent(warehouseId)}&mode=view`;}
function warehouseBatchDocumentHref(fileId:string,warehouseId:string){return `/warehouse/document-files/batch/${fileId}?warehouseId=${encodeURIComponent(warehouseId)}&mode=view`;}
type WarehouseOrderBlocker = { orderId: string; orderNumber: string; reasons: string[] };

async function loadDispatchShipments(organizationId:string,warehouseId:string,dispatchId:string){
  const rows=await env.DB.prepare(`SELECT DISTINCT s.id shipment_id,s.order_id,o.order_number,s.customer_id,s.current_location
    FROM warehouse_dispatch_items di
    JOIN warehouse_dispatches d ON d.id=di.dispatch_id AND d.organization_id=di.organization_id
    JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
    JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
    JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
    WHERE d.id=? AND d.organization_id=? AND p.warehouse_id=?`)
    .bind(dispatchId,organizationId,warehouseId).all<DispatchShipment>();
  return rows.results;
}

async function resyncDispatchedWorkflow({organizationId,dispatch,shipments,actorUserId}:{organizationId:string;dispatch:Pick<Dispatch,"transport_batch_id"|"dispatch_number">;shipments:DispatchShipment[];actorUserId:string}){
  const warnings:string[]=[];
  if(dispatch.transport_batch_id){
    try{await recordBatchOutboundProgress({organizationId,batchId:dispatch.transport_batch_id,actorUserId,dispatchNumber:dispatch.dispatch_number,referenceOrderId:shipments[0]?.order_id})}catch(error){console.error("dispatch batch workflow resync failed",error);warnings.push("批次业务进度待重试")}
  }else{
    for(const item of shipments){
      try{await recordWarehouseProgress({organizationId,orderId:item.order_id,actorUserId,stepCode:"outbound",stepName:"装车出库交接完成",actionCode:"dispatch_complete",actionName:"完成装车出库交接",notes:`装车任务 ${dispatch.dispatch_number} 已完成物理出库，恢复业务工作流同步`})}catch(error){console.error("dispatch order progress resync failed",error);warnings.push(`${item.order_number} 业务进度待重试`)}
    }
  }
  for(const item of shipments){
    try{await syncOrderWorkflowSnapshot(organizationId,item.order_id)}catch(error){console.error("dispatch frozen workflow resync failed",error);warnings.push(`${item.order_number} 冻结工作流待重试`)}
  }
  return warnings;
}
async function loadEnabledLoadingOrderIds(organizationId:string,orderIds:readonly string[]){
  const enabled=new Set<string>(),unique=[...new Set(orderIds.filter(Boolean))];
  for(const chunk of chunkD1Values(unique,1)){
    const rows=await env.DB.prepare(`SELECT order_id FROM order_module_instances WHERE organization_id=? AND module_code='loading' AND enabled=1 AND order_id IN (${d1Placeholders(chunk.length)})`)
      .bind(organizationId,...chunk).all<{order_id:string}>();
    for(const row of rows.results)enabled.add(row.order_id);
  }
  return enabled;
}

async function loadReadyPackingJobs(
  organizationId:string,
  warehouseId:string,
  orderGroups:Array<{orderId:string;orderNumber:string}>,
  businessType:string,
  transportBatchId:string|null,
):Promise<{jobs:ReadyPackingJob[];error?:never}|{jobs?:never;error:string}>{
  const rows:ReadyPackingJob[]=[];
  for(const orderChunk of chunkD1Values(orderGroups,2)){
    const result=await env.DB.prepare(`SELECT job.id,job.order_id,job.status,job.transport_batch_id,
        job.outbound_package_count,COUNT(package_row.id) oul_count
      FROM warehouse_packing_jobs job
      LEFT JOIN warehouse_packages package_row ON package_row.packing_job_id=job.id
        AND package_row.organization_id=job.organization_id AND package_row.warehouse_id=job.warehouse_id
        AND package_row.label_kind='oul' AND package_row.lifecycle_status='active' AND package_row.status='in_stock'
      WHERE job.organization_id=? AND job.warehouse_id=? AND job.order_id IN (${d1Placeholders(orderChunk.length)})
        AND job.status!='cancelled' AND job.dispatch_id IS NULL
      GROUP BY job.id`).bind(organizationId,warehouseId,...orderChunk.map(order=>order.orderId)).all<ReadyPackingJob>();
    rows.push(...result.results);
  }
  const byOrder=new Map(rows.map(row=>[row.order_id,row]));
  for(const group of orderGroups){
    const job=byOrder.get(group.orderId);
    if(!job)return{error:`${group.orderNumber} 尚未完成二次打包与贴标`};
    if(Number(job.oul_count)!==Number(job.outbound_package_count)||Number(job.oul_count)<1)
      return{error:`${group.orderNumber} 的最终 OUL 包装数量不完整，请返回二次打包与贴标页面检查`};
    if(businessType==="ltl"){
      if(!transportBatchId||job.status!=="allocated"||job.transport_batch_id!==transportBatchId)
        return{error:`${group.orderNumber} 的最终包装尚未分配到当前配载单`};
    }else if(job.status!=="labelled"||job.transport_batch_id)
      return{error:`${group.orderNumber} 尚未确认全部 OUL 标签已贴完`};
  }
  return{jobs:orderGroups.map(group=>byOrder.get(group.orderId)!)};
}

async function checkWarehouseOrders(
  organizationId:string,
  warehouseId:string,
  orders:Array<{order_id:string;order_number:string}>,
  vehiclePlate?:string,
  transportBatchId?:string,
):Promise<WarehouseOrderBlocker[]> {
  const results:WarehouseOrderBlocker[]=[];
  for(const order of orders){
    const [loadPlan,warehouseState]=await Promise.all([
      checkOrderLoadPlan(organizationId,order.order_id,vehiclePlate,transportBatchId),
      env.DB.prepare(`SELECT
          o.business_type,
          EXISTS(SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id AND s.organization_id=r.organization_id WHERE r.organization_id=o.organization_id AND s.order_id=o.id AND r.warehouse_id=? AND r.status='completed' AND r.cargo_complete=1) cargo_ready,
          job.id packing_job_id,job.status packing_status,job.transport_batch_id,
          (SELECT COUNT(*) FROM warehouse_packages p
            WHERE p.organization_id=o.organization_id AND p.warehouse_id=? AND p.packing_job_id=job.id
              AND p.label_kind='oul' AND p.lifecycle_status='active' AND p.status='in_stock') package_count
        FROM transport_orders o
        LEFT JOIN warehouse_packing_jobs job ON job.organization_id=o.organization_id
          AND job.warehouse_id=? AND job.order_id=o.id AND job.status!='cancelled'
        WHERE o.organization_id=? AND o.id=?`)
        .bind(warehouseId,warehouseId,warehouseId,organizationId,order.order_id)
        .first<{business_type:string;cargo_ready:number;packing_job_id:string|null;packing_status:string|null;transport_batch_id:string|null;package_count:number}>(),
    ]);
    const reasons=[...loadPlan.reasons];
    if(!warehouseState?.cargo_ready)reasons.push("未在当前仓库完成实收并确认‘货齐’");
    if(!warehouseState?.packing_job_id)reasons.push("尚未完成二次打包与贴标");
    else if(!warehouseState.package_count)reasons.push("最终出库包装没有有效 OUL 标签");
    else if(warehouseState.business_type==="ltl"){
      if(!transportBatchId)reasons.push("拼车订单尚未进入配载单");
      else if(warehouseState.packing_status!=="allocated"||warehouseState.transport_batch_id!==transportBatchId)
        reasons.push("最终出库包装未分配到当前配载单");
    }else if(warehouseState.packing_status!=="labelled")reasons.push("最终出库包装尚未确认贴标完成");
    results.push({orderId:order.order_id,orderNumber:order.order_number,reasons:[...new Set(reasons)]});
  }
  return results;
}
async function checkBatchWarehouseReadiness(organizationId:string,warehouseId:string,batchId:string,vehiclePlate?:string){
  const [batch,orders]=await Promise.all([
    env.DB.prepare("SELECT batch_number FROM transport_batches WHERE id=? AND organization_id=? AND warehouse_id=?").bind(batchId,organizationId,warehouseId).first<{batch_number:string}>(),
    env.DB.prepare(`SELECT bo.order_id,o.order_number FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id AND b.warehouse_id=? JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(warehouseId,organizationId,batchId).all<{order_id:string;order_number:string}>(),
  ]);
  return{batchNumber:batch?.batch_number||batchId,orders:await checkWarehouseOrders(organizationId,warehouseId,orders.results,vehiclePlate,batchId)};
}
function formatOrderBlockers(items:WarehouseOrderBlocker[]){
  return items.map(item=>`${item.orderNumber}：${item.reasons.join("、")}`).join("；");
}
async function findAvailableOutboundBatches(organizationId:string,warehouseId:string,input:{batchId?:string;orderNumber?:string;customerIdentityCode?:string}){
  const baseSql=availablePackedBatchSql;
  if(input.batchId){
    const result=await env.DB.prepare(`${baseSql} AND b.id=? AND (?='' OR UPPER(c.identity_code)=UPPER(?)) GROUP BY b.id,job.id LIMIT 1`)
      .bind(organizationId,warehouseId,input.batchId,input.customerIdentityCode||"",input.customerIdentityCode||"").all<Batch>();
    return result.results;
  }
  if(input.orderNumber){
    const result=await env.DB.prepare(`${baseSql} AND UPPER(o.order_number)=UPPER(?) AND (?='' OR UPPER(c.identity_code)=UPPER(?)) GROUP BY b.id,job.id ORDER BY b.verified_at DESC LIMIT 2`)
      .bind(organizationId,warehouseId,input.orderNumber,input.customerIdentityCode||"",input.customerIdentityCode||"").all<Batch>();
    return result.results;
  }
  return[];
}
async function findExistingDispatch(organizationId:string,warehouseId:string,orderNumber:string){
  return env.DB.prepare(`SELECT d.dispatch_number,d.status FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id AND di.organization_id=d.organization_id JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id WHERE d.organization_id=? AND p.warehouse_id=? AND UPPER(o.order_number)=UPPER(?) AND d.status!='cancelled' ORDER BY d.created_at DESC LIMIT 1`)
    .bind(organizationId,warehouseId,orderNumber).first<{dispatch_number:string;status:string}>();
}
async function loadDispatchWorkflowPolicy(organizationId:string,warehouseId:string,dispatchId:string):Promise<OutboundExecutionPolicy|null>{
  const orders=await env.DB.prepare(`SELECT DISTINCT s.order_id,o.order_number
    FROM warehouse_dispatch_items di
    JOIN warehouse_dispatches d ON d.id=di.dispatch_id AND d.organization_id=di.organization_id
    JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
    JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
    JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
    WHERE d.organization_id=? AND d.id=? AND p.warehouse_id=?
    ORDER BY s.order_id`).bind(organizationId,dispatchId,warehouseId).all<{order_id:string;order_number:string}>();
  const orderIds=orders.results.map(order=>order.order_id);
  const enabledOrderIds=await loadEnabledLoadingOrderIds(organizationId,orderIds);
  if(!orderIds.length||orderIds.some(orderId=>!enabledOrderIds.has(orderId)))return null;
  const workflowOrders=await loadLoadingBatchWorkflowOrders(organizationId,orderIds);
  const batchFields=resolveLoadingBatchFieldPolicies(workflowOrders);
  return{
    ...resolveWarehouseOutboundWorkflowPolicyForOrders(workflowOrders),
    batchFields,
    resources:loadingBatchResourcePolicy(batchFields),
    loadingStage:resolveLoadingBatchStageGate(workflowOrders,new Map(orders.results.map(order=>[order.order_id,order.order_number]))),
  };
}
async function loadOutboundInspectionByIds(organizationId:string,warehouseId:string,orderId:string,batchId:string){
  const matches=await findAvailableOutboundBatches(organizationId,warehouseId,{batchId});
  const batch=matches.find(item=>item.order_id===orderId);
  return batch?loadOutboundInspection(organizationId,warehouseId,batch):null;
}
async function loadOutboundInspection(organizationId:string,warehouseId:string,batch:Batch):Promise<OutboundInspection|null>{
  const scopeOrders=batch.business_type==="ltl"
    ?await env.DB.prepare(`SELECT DISTINCT o.id order_id,o.order_number,o.customer_id,c.name customer_name
      FROM transport_batch_orders selected
      JOIN transport_batches tb ON tb.id=selected.batch_id AND tb.organization_id=selected.organization_id AND tb.warehouse_id=? AND tb.status IN ('planning','loading')
      JOIN transport_batch_orders bo ON bo.batch_id=selected.batch_id AND bo.organization_id=selected.organization_id AND bo.status!='removed'
      JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
      JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
      WHERE selected.organization_id=? AND selected.order_id=? AND selected.status!='removed'
        AND (? IS NULL OR selected.batch_id=?)
      ORDER BY bo.sequence_no`).bind(warehouseId,organizationId,batch.order_id,batch.transport_batch_id,batch.transport_batch_id).all<{order_id:string;order_number:string;customer_id:string;customer_name:string}>()
    :{results:[{order_id:batch.order_id,order_number:batch.order_number,customer_id:batch.customer_id,customer_name:batch.customer_name}]};
  const orderRows=scopeOrders.results.length?scopeOrders.results:[{order_id:batch.order_id,order_number:batch.order_number,customer_id:batch.customer_id,customer_name:batch.customer_name}];
  const enabledOrderIds=await loadEnabledLoadingOrderIds(organizationId,orderRows.map(order=>order.order_id));
  if(orderRows.some(order=>!enabledOrderIds.has(order.order_id)))return null;
  type OrderSummaryRow={order_id:string;order_number:string;customer_name:string;cargo_summary:string|null;oul_count:number;pieces:number;weight_kg:number;volume_cbm:number;storage_locations:string|null};
  const orderSummaryRows:OrderSummaryRow[]=[];
  for(const orderChunk of chunkD1Values(orderRows,1)){
    const result=await env.DB.prepare(`SELECT o.id order_id,o.order_number,c.name customer_name,
        (SELECT REPLACE(GROUP_CONCAT(DISTINCT NULLIF(TRIM(cargo.cargo_name_cn),'')),',','、')
          FROM order_cargo_items cargo WHERE cargo.organization_id=o.organization_id AND cargo.order_id=o.id) cargo_summary,
        COUNT(DISTINCT package_row.id) oul_count,COALESCE(SUM(package_row.pieces),0) pieces,
        job.total_weight_kg weight_kg,job.total_volume_cbm volume_cbm,
        REPLACE(GROUP_CONCAT(DISTINCT COALESCE(NULLIF(TRIM(location.code),''),location.name)),',','、') storage_locations
      FROM transport_orders o
      JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
      JOIN warehouse_packing_jobs job ON job.order_id=o.id AND job.organization_id=o.organization_id
        AND job.warehouse_id=? AND job.dispatch_id IS NULL
        AND ((o.business_type='ftl' AND job.status='labelled' AND job.transport_batch_id IS NULL)
          OR (o.business_type='ltl' AND job.status='allocated' AND job.transport_batch_id=?))
      JOIN warehouse_packages package_row ON package_row.packing_job_id=job.id
        AND package_row.organization_id=job.organization_id AND package_row.warehouse_id=job.warehouse_id
        AND package_row.label_kind='oul' AND package_row.lifecycle_status='active' AND package_row.status='in_stock'
      LEFT JOIN warehouse_locations location ON location.id=package_row.location_id AND location.organization_id=package_row.organization_id
      WHERE o.organization_id=? AND o.id IN (${d1Placeholders(orderChunk.length)})
      GROUP BY o.id,o.order_number,c.name,job.id,job.total_weight_kg,job.total_volume_cbm
      ORDER BY o.order_number`)
      .bind(warehouseId,batch.transport_batch_id,organizationId,...orderChunk.map(order=>order.order_id)).all<OrderSummaryRow>();
    orderSummaryRows.push(...result.results);
  }
  const packingSources:PackingSource[]=[];
  for(const orderChunk of chunkD1Values(orderRows,1)){
    const sourceRows=await env.DB.prepare(`SELECT p.id,o.id order_id,o.order_number,p.shipment_id,p.cargo_item_id,p.receipt_id,p.location_id,
        mark.id mark_id,mark.package_code mark_code,p.weight_kg,p.volume_cbm
      FROM warehouse_packages p
      JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
      JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
      JOIN order_cargo_packages mark ON mark.id=p.source_order_package_id AND mark.organization_id=p.organization_id
      WHERE p.organization_id=? AND p.warehouse_id=? AND o.id IN (${d1Placeholders(orderChunk.length)})
        AND p.label_kind='inbound_mark' AND p.lifecycle_status='active' AND p.status='in_stock'
        AND mark.is_active=1 AND mark.status='received'
      ORDER BY o.order_number,mark.package_sequence`)
      .bind(organizationId,warehouseId,...orderChunk.map(order=>order.order_id)).all<{
        id:string;order_id:string;order_number:string;shipment_id:string;cargo_item_id:string|null;receipt_id:string;location_id:string;
        mark_id:string;mark_code:string;weight_kg:number|null;volume_cbm:number|null;
      }>();
    packingSources.push(...sourceRows.results.map(row=>({
      id:row.id,orderId:row.order_id,orderNumber:row.order_number,shipmentId:row.shipment_id,cargoItemId:row.cargo_item_id,
      receiptId:row.receipt_id,locationId:row.location_id,markId:row.mark_id,markCode:row.mark_code,weightKg:row.weight_kg,volumeCbm:row.volume_cbm,
    })));
  }
  type DocumentRow={order_id:string;attachment_id:string;document_category:LoadingDocumentCode;file_name:string;content_type:string;size_bytes:number;review_status:string;created_at:string;uploaded_by_user_id:string|null};
  const documentRows:DocumentRow[]=[];
  const documentRowsPromise=(async()=>{
    for(const orderChunk of chunkD1Values(orderRows,1+LOADING_DOCUMENTS.length)){
      const result=await env.DB.prepare(`WITH ranked AS (
      SELECT m.order_id,m.attachment_id,m.document_category,a.file_name,a.content_type,a.size_bytes,m.review_status,a.created_at,a.uploaded_by_user_id,
        ROW_NUMBER() OVER(PARTITION BY m.order_id,m.document_category ORDER BY a.created_at DESC,a.id DESC) row_no
      FROM order_document_metadata m JOIN order_attachments a ON a.id=m.attachment_id AND a.organization_id=m.organization_id AND a.order_id=m.order_id
      WHERE m.organization_id=? AND m.order_id IN (${d1Placeholders(orderChunk.length)}) AND m.document_category IN (${LOADING_DOCUMENT_PLACEHOLDERS})
      ) SELECT order_id,attachment_id,document_category,file_name,content_type,size_bytes,review_status,created_at,uploaded_by_user_id
        FROM ranked WHERE row_no=1 ORDER BY created_at DESC`).bind(organizationId,...orderChunk.map(order=>order.order_id),...LOADING_DOCUMENTS.map(document=>document.code)).all<DocumentRow>();
      documentRows.push(...result.results);
    }
  })();
  const [,workflowOrders,documentRequirements]=await Promise.all([
    documentRowsPromise,
    loadLoadingBatchWorkflowOrders(organizationId,orderRows.map(order=>order.order_id)),
    loadOrderLoadingDocumentRequirements(organizationId,orderRows.map(order=>order.order_id)),
  ]);
  const requirementsByOrder=new Map(documentRequirements.map(requirement=>[requirement.orderId,requirement]));
  const latestByOrderCode=new Map<string,DocumentRow>();
  for(const row of documentRows){const key=`${row.order_id}:${row.document_category}`;if(!latestByOrderCode.has(key))latestByOrderCode.set(key,row);}
  const documentGroups=orderRows.map(order=>{
    const requirements=requirementsByOrder.get(order.order_id);
    const documents=currentStageLoadingDocumentRequirements(requirements?.documents??[]).map(type=>{
      const row=latestByOrderCode.get(`${order.order_id}:${type.code}`);
      const required=type.isRequired;
      return{orderId:order.order_id,orderNumber:order.order_number,customerId:order.customer_id,customerName:order.customer_name,required,attachmentId:row?.attachment_id??null,code:type.code,name:type.name,fileName:row?.file_name??null,contentType:row?.content_type??null,sizeBytes:row?.size_bytes??null,reviewStatus:row?.review_status??null,uploadedByUserId:row?.uploaded_by_user_id??null};
    });
    return{orderId:order.order_id,orderNumber:order.order_number,customerId:order.customer_id,customerName:order.customer_name,documents,allUploaded:documents.filter(document=>document.required).every(document=>Boolean(document.attachmentId)),allApproved:documents.filter(document=>document.required).every(document=>["approved","archived"].includes(document.reviewStatus||""))};
  });
  const summaryByOrder=new Map(orderSummaryRows.map(row=>[row.order_id,row]));
  const orderSummaries=orderRows.map(order=>{
    const row=summaryByOrder.get(order.order_id),documentGroup=documentGroups.find(group=>group.orderId===order.order_id);
    const requiredDocuments=documentGroup?.documents.filter(document=>document.required)??[];
    return{orderId:order.order_id,orderNumber:order.order_number,customerName:order.customer_name,cargoSummary:row?.cargo_summary||"货物名称待补",oulCount:Number(row?.oul_count||0),pieces:Number(row?.pieces||0),weightKg:Number(row?.weight_kg||0),volumeCbm:Number(row?.volume_cbm||0),storageLocations:row?.storage_locations||"库位待补",requiredDocumentCount:requiredDocuments.length,approvedDocumentCount:requiredDocuments.filter(document=>["approved","archived"].includes(document.reviewStatus||"")).length};
  });
  const documents=documentGroups.flatMap(group=>group.documents);
  const workflowPolicy=resolveWarehouseOutboundWorkflowPolicyForOrders(workflowOrders);
  const batchFields=resolveLoadingBatchFieldPolicies(workflowOrders);
  const executionPolicy={...workflowPolicy,batchFields,resources:loadingBatchResourcePolicy(batchFields),loadingStage:resolveLoadingBatchStageGate(workflowOrders,new Map(orderRows.map(order=>[order.order_id,order.order_number])))};
  let dispatchPlan:DispatchPlan|null=null,resourceDifferences:OutboundPolicyDifference[]=[],resourcePolicyError:string|null=null;
  if(batch.business_type==="ltl"){
    const plan=await resolveDispatchPlan(organizationId,batch.order_id,batch.business_type,batch.transport_batch_id,batchFields,warehouseId);
    if("error" in plan)resourcePolicyError=plan.error;
    else{dispatchPlan=plan;resourceDifferences=dispatchPlanPolicyIssues(batchFields,plan).differences;}
  }
  const inspectionBatch={...batch,batch_number:batch.transport_batch_number||batch.batch_number,related_order_ids:documentGroups.map(group=>group.orderId).join(","),order_count:documentGroups.length,order_numbers:documentGroups.map(group=>group.orderNumber).join("、"),customer_names:[...new Set(documentGroups.map(group=>group.customerName))].join("、"),customer_identity_codes:batch.customer_identity_code};
  return{batch:inspectionBatch,documentGroups,documents,orderSummaries,packingSources,allUploaded:documentGroups.every(group=>group.allUploaded),allApproved:documentGroups.every(group=>group.allApproved),notesActive:workflowPolicy.handoverNotes.isActive,notesRequired:workflowPolicy.handoverNotes.isRequired,scanActive:workflowPolicy.scanConfirmation.isActive,scanRequired:workflowPolicy.scanConfirmation.isRequired,executionPolicy,dispatchPlan,resourceDifferences,resourcePolicyError};
}
function validateOutboundDocumentFile(file:File){
  const allowed=new Set(["application/pdf","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","image/jpeg","image/png","image/webp"]);
  if(file.size>maxInlineOrderDocumentBytes)return"当前数据库直存模式下单个文件不能超过1.2MB";
  if(!allowed.has(file.type))return"仅支持 PDF、Word、Excel 和图片文件";
  return null;
}
async function toDataUrl(file:File){
  const bytes=new Uint8Array(await file.arrayBuffer());let binary="";
  for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));
  return`data:${file.type};base64,${btoa(binary)}`;
}
async function diagnoseOutboundOrder(organizationId:string,warehouseId:string,orderNumber:string){
  const order=await env.DB.prepare(`SELECT o.id order_id,o.order_number,o.business_type,(SELECT bo.batch_id FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id AND b.warehouse_id=? AND b.status!='cancelled' AND b.batch_number LIKE 'PZ-%' WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' ORDER BY b.updated_at DESC LIMIT 1) batch_id FROM transport_orders o WHERE o.organization_id=? AND UPPER(o.order_number)=UPPER(?)`).bind(warehouseId,organizationId,orderNumber).first<{order_id:string;order_number:string;business_type:string;batch_id:string|null}>();
  if(!order)return null;
  if(order.business_type==="ltl"&&order.batch_id){
    const readiness=await checkBatchWarehouseReadiness(organizationId,warehouseId,order.batch_id);
    const blocked=readiness.orders.filter(item=>item.reasons.length>0);
    return blocked.length?`配载单 ${readiness.batchNumber} 尚不能创建装车任务：${formatOrderBlockers(blocked)}`:`配载单 ${readiness.batchNumber} 在当前仓库没有可创建的装车任务，请检查是否已经生成过出库任务。`;
  }
  const [readiness]=await checkWarehouseOrders(organizationId,warehouseId,[order]);
  return readiness.reasons.length?`${order.order_number} 尚不能创建装车任务：${readiness.reasons.join("、")}`:null;
}
function generateDispatch(){return `OUT-${new Date().toISOString().slice(2,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,5).toUpperCase()}`}
function optionalPackingMeasure(form:FormData,name:string,label:string){
  const raw=valueOf(form,name).trim();
  if(!raw)return null;
  const value=Number(raw);
  if(!Number.isFinite(value)||value<=0)throw new Error(`${label}必须大于 0，未实测时请留空`);
  return value;
}
export function parsePackingRequests(form:FormData,inspection:OutboundInspection){
  try{
    const requests:PackingOrderRequest[]=inspection.documentGroups.map(group=>{
      const sources=inspection.packingSources.filter(source=>source.orderId===group.orderId);
      if(!sources.length)throw new Error(`${group.orderNumber} 没有可成包的入仓唛头，请先完成国内仓收货`);
      const requestedMode=valueOf(form,`packingMode_${group.orderId}`)==="repack"?"repack":"preserve";
      const requested=requestedMode==="preserve"?sources.length:Number(valueOf(form,`outboundPackageCount_${group.orderId}`));
      const mode=requestedMode==="preserve"||requested===sources.length?"preserve":requested<sources.length?"merge":"split";
      return{
        orderId:group.orderId,
        orderNumber:group.orderNumber,
        sourceType:inspection.batch.business_type==="ltl"?"pz_order":"ftl_order",
        transportBatchId:inspection.batch.business_type==="ltl"?inspection.batch.transport_batch_id:null,
        mode,
        outboundPackageCount:requested,
        totalWeightKg:optionalPackingMeasure(form,`packingTotalWeightKg_${group.orderId}`,`${group.orderNumber} 最终总重量`),
        totalVolumeCbm:optionalPackingMeasure(form,`packingTotalVolumeCbm_${group.orderId}`,`${group.orderNumber} 最终总体积`),
        notes:valueOf(form,`packingNotes_${group.orderId}`).trim(),
      };
    });
    return buildWarehousePackingPlan({
      requests,
      sources:inspection.packingSources.map(source=>({
        id:source.id,orderId:source.orderId,shipmentId:source.shipmentId,
        receiptId:source.receiptId,locationId:source.locationId,
      })),
      createId:()=>crypto.randomUUID(),
      createOulCode:({orderNumber,sequence,total})=>oulCode(orderNumber,sequence,total,randomOulSuffix()),
    });
  }catch(error){
    return{error:error instanceof Error?error.message:"最终出仓包装信息无效"};
  }
}
function dispatchPlanPolicyIssues(policies:LoadingBatchFieldPolicies,plan:DispatchPlan){
  const issues=loadingDispatchPlanPolicyIssues(policies,plan);
  return{
    requiredMissing:issues.requiredMissing,
    differences:issues.optionalMissing.map(item=>({...item,mode:"optional" as const})),
  };
}
async function resolveDispatchPlan(organizationId:string,orderId:string,businessType:string,transportBatchId?:string|null,policies?:LoadingBatchFieldPolicies,warehouseId?:string):Promise<DispatchPlan|{error:string}>{
  if(businessType==="ltl"){
    const rows=await env.DB.prepare(`SELECT b.id batch_id,COALESCE(v.carrier_id,b.carrier_id) carrier_id,v.id vehicle_id,v.vehicle_type,v.vehicle_master_id,v.driver_master_id driver_id,v.plate_number vehicle_plate,v.driver_name,v.driver_phone,COALESCE(vc.name,bc.name) carrier_name,b.planned_departure_at,b.planned_arrival_at
      FROM transport_batch_orders bo
      JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id AND b.status IN ('planning','loading') AND b.approval_status='approved' AND b.operation_assignee_user_id IS NOT NULL AND b.document_assignee_user_id IS NOT NULL
      LEFT JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled'
      LEFT JOIN carriers vc ON vc.id=v.carrier_id AND vc.organization_id=v.organization_id
      LEFT JOIN carriers bc ON bc.id=b.carrier_id AND bc.organization_id=b.organization_id
      WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND (?='' OR b.id=?) AND (?='' OR b.warehouse_id=?)
      ORDER BY v.created_at LIMIT 2`).bind(organizationId,orderId,transportBatchId||"",transportBatchId||"",warehouseId||"",warehouseId||"").all<DispatchPlan&{id:string}>();
    if(!rows.results.length)return{error:"未找到有效的 PZ 配载单"};
    const resources=policies?loadingBatchResourcePolicy(policies):null;
    if(rows.results.length>1&&(resources?.carrier.isActive||resources?.vehicle.isActive||resources?.driver.isActive))return{error:"当前配载单存在多辆有效车辆；请保留本批次实际使用的一辆主车"};
    const plan=rows.results[0];
    if(policies){
      const issues=dispatchPlanPolicyIssues(policies,plan);
      if(issues.requiredMissing.length)return{error:`请先补齐工作流必填项：${issues.requiredMissing.join("、")}`};
    }
    return plan;
  }
  return{error:"整车任务必须由仓库在创建装车任务前确认出境承运商、车辆和司机"};
}
async function resolveFtlDispatchPlan(
  organizationId:string,
  input:{carrierId:string;vehicleId:string;driverId:string;plannedDepartureAt:string;plannedArrivalAt:string;newDriver?:PendingOutboundDriver|null},
  policies:LoadingBatchFieldPolicies,
):Promise<DispatchPlan|{error:string}>{
  const carrierId=input.carrierId.trim(),vehicleId=input.vehicleId.trim(),driverId=input.driverId.trim();
  const emptyPlan:DispatchPlan={
    batch_id:null,carrier_id:null,vehicle_id:null,vehicle_type:null,vehicle_plate:null,
    driver_id:null,driver_name:null,driver_phone:null,carrier_name:null,
    planned_departure_at:policies.planned_exit_at.isActive?input.plannedDepartureAt.trim()||null:null,
    planned_arrival_at:policies.planned_arrival_at.isActive?input.plannedArrivalAt.trim()||null:null,
  };
  if(!carrierId){
    if(vehicleId||driverId)return{error:"请先选择承运商，再选择其名下车辆或司机"};
    return emptyPlan;
  }
  const carrier=await env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND id=? AND status='active' AND carrier_scope='overseas'")
    .bind(organizationId,carrierId).first<{id:string;name:string}>();
  if(!carrier)return{error:"所选境外承运商已失效，请刷新后重新选择"};
  const vehicle=vehicleId
    ?await env.DB.prepare("SELECT id,vehicle_type,plate_number FROM carrier_vehicles WHERE organization_id=? AND id=? AND carrier_id=? AND status='active'")
      .bind(organizationId,vehicleId,carrierId).first<{id:string;vehicle_type:string|null;plate_number:string|null}>()
    :null;
  if(vehicleId&&!vehicle)return{error:"所选出境车辆已失效或不属于该承运商，请刷新后重新选择"};
  const driver=driverId===NEW_OUTBOUND_DRIVER_ID
    ?input.newDriver&&input.newDriver.carrierId===carrierId
      ?{id:input.newDriver.id,name:input.newDriver.name,phone:input.newDriver.phone}
      :null
    :driverId
      ?await env.DB.prepare("SELECT id,name,phone FROM carrier_drivers WHERE organization_id=? AND id=? AND carrier_id=? AND status='active'")
        .bind(organizationId,driverId,carrierId).first<{id:string;name:string;phone:string|null}>()
      :null;
  if(driverId&&!driver)return{error:"所选出境司机已失效或不属于该承运商，请刷新后重新选择"};
  return{
    ...emptyPlan,
    carrier_id:carrier.id,
    carrier_name:policies.main_carrier_id.isActive?carrier.name:null,
    vehicle_id:vehicle?.id??null,
    vehicle_type:policies.main_vehicle_type.isActive?vehicle?.vehicle_type??null:null,
    vehicle_plate:policies.main_plate_number.isActive?vehicle?.plate_number??null:null,
    driver_id:driver?.id??null,
    driver_name:policies.main_driver_name.isActive?driver?.name??null:null,
    driver_phone:policies.main_driver_phone.isActive?driver?.phone??null:null,
  };
}
export function meta(){return[{title:"在仓待装 / 装车与出库 | International TMS"}]}
