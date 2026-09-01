import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.outbound";
import { Modal } from "../components/Modal";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { isValidCustomerIdentityCode } from "../lib/customer-identity";
import { maxInlineOrderDocumentBytes } from "../lib/order-documents";
import { submitForm } from "../lib/form-submit";
import { checkOrderLoadPlan, checkOrderPreDepartureDocuments } from "../lib/order-readiness.server";
import { refreshLoadingManifest } from "../lib/loading-manifest.server";
import {
  loadingOrderDocumentDefinitions,
  type LoadingOrderDocumentCode,
} from "../lib/loading-document-requirements";
import { loadOrderLoadingDocumentRequirements } from "../lib/loading-document-requirements.server";
import {
  loadingBatchResourcePolicy,
  resolveLoadingBatchFieldPolicies,
  type LoadingBatchFieldPolicies,
} from "../lib/loading-batch-field-policy";
import { loadLoadingBatchWorkflowOrders } from "../lib/loading-batch-field-policy.server";
import { recordBatchOutboundProgress, recordWarehouseProgress } from "../lib/warehouse-progress.server";
import {
  resolveWarehouseOutboundWorkflowPolicy,
  type WarehouseOutboundWorkflowPolicy,
} from "../lib/warehouse-outbound-policy";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import {
  filterWarehouseOutboundLoadUnits,
  isConsolidatedOutboundTask,
  normalizeWarehouseOutboundListFilters,
  validateFtlOutboundResourceSelection,
} from "../lib/warehouse-outbound-list";
import { chunkD1Values, d1Placeholders } from "../lib/d1-bindings";

const LOADING_DOCUMENTS=loadingOrderDocumentDefinitions;
const LOADING_DOCUMENT_PLACEHOLDERS=LOADING_DOCUMENTS.map(()=>"?").join(",");
type LoadingDocumentCode=LoadingOrderDocumentCode;
type Batch={id:string;batch_number:string;shipment_id:string;shipment_number:string;order_id:string;order_number:string;customer_id:string;customer_name:string;customer_identity_code:string;business_type:string;exit_port:string|null;destination_location:string;item_count:number;total_pieces:number;total_weight_kg:number;total_volume_cbm:number;received_at:string|null;verified_at:string|null;storage_locations:string;transport_batch_id:string|null;transport_batch_number:string|null;related_order_ids:string;order_count:number;order_numbers:string;customer_names:string;customer_identity_codes:string};
type Dispatch={id:string;dispatch_number:string;batch_number:string;shipment_id:string;shipment_number:string;order_id:string;order_number:string;business_type:string;outbound_resource_confirmed:number;order_numbers:string|null;related_order_ids:string|null;customer_id:string;customer_name:string;customer_names:string|null;customer_identity_code:string;vehicle_plate:string;driver_name:string;driver_phone:string|null;carrier_name:string|null;notes:string|null;destination:string;status:string;item_count:number;loaded_count:number;pieces:number;weight_kg:number;volume_cbm:number;created_at:string;dispatched_at:string|null;creator_name:string|null;transport_batch_id:string|null;planned_departure_at:string|null;road_status:string|null;actual_departure_at:string|null};
type Item={id:string;dispatch_id:string;order_number:string;barcode:string;package_number:string;cargo_name_cn:string|null;package_type:string|null;pieces:number;weight_kg:number|null;volume_cbm:number|null;length_cm:number|null;width_cm:number|null;height_cm:number|null;status:string;loaded_at:string|null};
type DispatchPlan={batch_id:string|null;carrier_id:string|null;vehicle_id:string|null;vehicle_type:string|null;vehicle_plate:string|null;driver_id:string|null;driver_name:string|null;driver_phone:string|null;carrier_name:string|null;planned_departure_at:string|null};
type CarrierOption={id:string;name:string};
type VehicleOption={id:string;carrier_id:string;carrier_name:string;plate_number:string;vehicle_type:string|null};
type DriverOption={id:string;carrier_id:string;carrier_name:string;name:string;phone:string|null};
type OutboundResources={carriers:CarrierOption[];vehicles:VehicleOption[];drivers:DriverOption[]};
type ManifestDoc={id:string;order_id:string;file_name:string;review_status:string;created_at:string};
type OutboundDocument={orderId:string;orderNumber:string;customerId:string;customerName:string;required:boolean;attachmentId:string|null;code:LoadingDocumentCode;name:string;fileName:string|null;contentType:string|null;sizeBytes:number|null;reviewStatus:string|null};
type OutboundDocumentGroup={orderId:string;orderNumber:string;customerId:string;customerName:string;documents:OutboundDocument[];allUploaded:boolean;allApproved:boolean};
type OutboundExecutionPolicy=WarehouseOutboundWorkflowPolicy&{batchFields:LoadingBatchFieldPolicies;resources:ReturnType<typeof loadingBatchResourcePolicy>};
type OutboundPolicyDifference={fieldKey:string;label:string;mode:"optional"|"hidden"};
type OutboundInspection={batch:Batch;documentGroups:OutboundDocumentGroup[];documents:OutboundDocument[];allUploaded:boolean;allApproved:boolean;notesActive:boolean;notesRequired:boolean;scanActive:boolean;scanRequired:boolean;executionPolicy:OutboundExecutionPolicy;resourceDifferences:OutboundPolicyDifference[];resourcePolicyError:string|null};

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

export async function loader({request}:Route.LoaderArgs){
  const user=await requireSessionUser(request,"warehouse.view","warehouse");
  const warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected,url=new URL(request.url),orderId=url.searchParams.get("orderId"),requestedView=url.searchParams.get("view"),requestedDispatchId=url.searchParams.get("dispatchId"),filters=normalizeWarehouseOutboundListFilters(url.searchParams);
  if(warehouse.warehouse_role==="overseas_destination")throw redirect(`/warehouse/inbound${url.search}`);
  const [batches,dispatches,carriers,vehicles,drivers]=await Promise.all([
    env.DB.prepare(`SELECT b.id,b.batch_number,b.shipment_id,s.shipment_number,o.id order_id,o.order_number,o.customer_id,c.name customer_name,c.identity_code customer_identity_code,o.business_type,o.exit_port,TRIM(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city||CASE WHEN NULLIF(TRIM(o.destination_address),'') IS NOT NULL THEN ' '||o.destination_address ELSE '' END) destination_location,COUNT(DISTINCT i.id) item_count,COALESCE(SUM(bp.pieces),0) total_pieces,COALESCE(SUM(bp.weight_kg),0) total_weight_kg,COALESCE(SUM(bp.volume_cbm),0) total_volume_cbm,b.verified_at,COALESCE(REPLACE(GROUP_CONCAT(DISTINCT COALESCE(NULLIF(TRIM(wl.code),''),wl.name)),',','、'),'') storage_locations,
      (SELECT MIN(r.received_at) FROM warehouse_receipts r WHERE r.organization_id=b.organization_id AND r.shipment_id=b.shipment_id AND r.warehouse_id=? AND r.status='completed') received_at,
      (SELECT tb.id FROM transport_batch_orders bo JOIN transport_batches tb ON tb.id=bo.batch_id AND tb.organization_id=bo.organization_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND tb.batch_number LIKE 'PZ-%' AND tb.status IN ('planning','loading') ORDER BY tb.updated_at DESC LIMIT 1) transport_batch_id,
      (SELECT tb.batch_number FROM transport_batch_orders bo JOIN transport_batches tb ON tb.id=bo.batch_id AND tb.organization_id=bo.organization_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND tb.batch_number LIKE 'PZ-%' AND tb.status IN ('planning','loading') ORDER BY tb.updated_at DESC LIMIT 1) transport_batch_number
      FROM warehouse_sorting_batches b JOIN shipments s ON s.id=b.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id JOIN warehouse_sorting_items i ON i.batch_id=b.id JOIN warehouse_packages bp ON bp.id=i.package_id AND bp.warehouse_id=? LEFT JOIN warehouse_locations wl ON wl.id=bp.location_id AND wl.organization_id=bp.organization_id WHERE b.organization_id=? AND b.status='verified' AND NOT EXISTS (SELECT 1 FROM warehouse_sorting_items xi JOIN warehouse_dispatch_items xdi ON xdi.package_id=xi.package_id JOIN warehouse_dispatches xd ON xd.id=xdi.dispatch_id WHERE xi.batch_id=b.id AND xd.status!='cancelled') GROUP BY b.id ORDER BY b.verified_at DESC`).bind(warehouse.id,warehouse.id,user.organizationId).all<Batch>(),
    env.DB.prepare(`SELECT d.id,d.dispatch_number,COALESCE(tb.batch_number,b.batch_number) batch_number,d.shipment_id,s.shipment_number,o.id order_id,o.order_number,o.business_type,CASE WHEN o.business_type='ltl' AND d.transport_batch_id IS NOT NULL THEN 1 WHEN EXISTS(SELECT 1 FROM order_transport_assignments confirmed WHERE confirmed.organization_id=d.organization_id AND confirmed.order_id=o.id AND confirmed.leg_type='main' AND confirmed.status!='cancelled') THEN 1 ELSE 0 END outbound_resource_confirmed,GROUP_CONCAT(DISTINCT po.order_number) order_numbers,GROUP_CONCAT(DISTINCT ps.order_id) related_order_ids,c.id customer_id,c.name customer_name,GROUP_CONCAT(DISTINCT pc.name) customer_names,c.identity_code customer_identity_code,d.vehicle_plate,d.driver_name,d.driver_phone,d.carrier_name,d.notes,d.destination,d.status,COUNT(di.id) item_count,SUM(CASE WHEN di.status='loaded' THEN 1 ELSE 0 END) loaded_count,COALESCE(SUM(p.pieces),0) pieces,COALESCE(SUM(p.weight_kg),0) weight_kg,COALESCE(SUM(p.volume_cbm),0) volume_cbm,d.created_at,d.dispatched_at,u.display_name creator_name,tb.id transport_batch_id,COALESCE(tb.planned_departure_at,(SELECT a.planned_departure_at FROM order_transport_assignments a WHERE a.organization_id=d.organization_id AND a.order_id=o.id AND a.leg_type='main' AND a.status!='cancelled' ORDER BY a.updated_at DESC LIMIT 1)) planned_departure_at,tb.road_status,tb.actual_departure_at FROM warehouse_dispatches d JOIN warehouse_sorting_batches b ON b.id=d.sorting_batch_id JOIN shipments s ON s.id=d.shipment_id JOIN transport_orders o ON o.id=s.order_id LEFT JOIN transport_batches tb ON tb.id=d.transport_batch_id AND tb.organization_id=d.organization_id JOIN customers c ON c.id=s.customer_id LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id LEFT JOIN warehouse_packages p ON p.id=di.package_id LEFT JOIN shipments ps ON ps.id=p.shipment_id LEFT JOIN transport_orders po ON po.id=ps.order_id LEFT JOIN customers pc ON pc.id=po.customer_id LEFT JOIN users u ON u.id=d.created_by_user_id WHERE d.organization_id=? AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.dispatch_id=d.id AND wp.warehouse_id=?) GROUP BY d.id ORDER BY CASE d.status WHEN 'loading' THEN 1 ELSE 2 END,d.updated_at DESC LIMIT 50`).bind(user.organizationId,warehouse.id).all<Dispatch>(),
    env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND status='active' AND carrier_scope='overseas' ORDER BY name").bind(user.organizationId).all<CarrierOption>(),
    env.DB.prepare(`SELECT v.id,v.carrier_id,c.name carrier_name,v.plate_number,v.vehicle_type FROM carrier_vehicles v JOIN carriers c ON c.id=v.carrier_id AND c.organization_id=v.organization_id WHERE v.organization_id=? AND v.status='active' AND c.status='active' AND c.carrier_scope='overseas' ORDER BY c.name,v.plate_number`).bind(user.organizationId).all<VehicleOption>(),
    env.DB.prepare(`SELECT d.id,d.carrier_id,c.name carrier_name,d.name,d.phone FROM carrier_drivers d JOIN carriers c ON c.id=d.carrier_id AND c.organization_id=d.organization_id WHERE d.organization_id=? AND d.status='active' AND c.status='active' AND c.carrier_scope='overseas' ORDER BY c.name,d.name`).bind(user.organizationId).all<DriverOption>(),
  ]);
  const pendingUnits=groupPendingLoadUnits(batches.results);
  const visibleBatches=orderId?pendingUnits.filter(batch=>batch.related_order_ids.split(",").includes(orderId)):pendingUnits;
  const visibleDispatches=orderId?dispatches.results.filter((dispatch)=>dispatch.related_order_ids?.split(",").includes(orderId)||dispatch.order_id===orderId):dispatches.results;
  const selectedDispatch=requestedDispatchId?visibleDispatches.find(dispatch=>dispatch.id===requestedDispatchId)??null:null;
  const items=selectedDispatch
    ?(await env.DB.prepare(`SELECT di.id,di.dispatch_id,o.order_number,p.barcode,p.package_number,COALESCE(NULLIF(TRIM(ci.cargo_name_cn),''),NULLIF(TRIM(o.cargo_description),'')) cargo_name_cn,COALESCE(r.package_type,ci.package_type) package_type,p.pieces,p.weight_kg,p.volume_cbm,p.length_cm,p.width_cm,p.height_cm,di.status,di.loaded_at
      FROM warehouse_dispatch_items di
      JOIN warehouse_packages p ON p.id=di.package_id
      LEFT JOIN warehouse_receipts r ON r.id=p.receipt_id AND r.organization_id=p.organization_id
      JOIN shipments s ON s.id=p.shipment_id
      JOIN transport_orders o ON o.id=s.order_id
      LEFT JOIN order_cargo_items ci ON ci.id=p.cargo_item_id AND ci.organization_id=p.organization_id
      WHERE di.organization_id=? AND p.warehouse_id=? AND di.dispatch_id=?
      ORDER BY o.order_number,COALESCE(di.loaded_at,p.created_at) DESC LIMIT 1000`).bind(user.organizationId,warehouse.id,selectedDispatch.id).all<Item>()).results
    :[];
  const selectedExecutionPolicy=selectedDispatch
    ?await loadDispatchWorkflowPolicy(user.organizationId,selectedDispatch.id)
    :null;
  let selectedResourceDifferences:OutboundPolicyDifference[]=[],selectedResourcePolicyError:string|null=null;
  if(selectedDispatch?.business_type==="ltl"&&selectedExecutionPolicy){
    const plan=await resolveDispatchPlan(user.organizationId,selectedDispatch.order_id,selectedDispatch.business_type,selectedDispatch.transport_batch_id,selectedExecutionPolicy.batchFields);
    if("error" in plan)selectedResourcePolicyError=plan.error;
    else selectedResourceDifferences=dispatchPlanPolicyIssues(selectedExecutionPolicy.batchFields,plan).differences;
  }
  const evaluated:Array<{batch:Batch;readiness:{ready:boolean;reasons:string[]}}>=[];
  for(const batch of visibleBatches){
    if(batch.transport_batch_id){
      const readiness=await checkBatchWarehouseReadiness(user.organizationId,warehouse.id,batch.transport_batch_id);
      const blocked=readiness.orders.filter(item=>item.reasons.length>0);
      evaluated.push({batch,readiness:{ready:blocked.length===0,reasons:blocked.flatMap(item=>item.reasons.map(reason=>`${item.orderNumber}：${reason}`))}});
    }else{
      evaluated.push({batch,readiness:await checkOrderLoadPlan(user.organizationId,batch.order_id)});
    }
  }
  const loadUnits=evaluated.map(item=>({...item.batch,ready:item.readiness.ready,reasons:item.readiness.reasons}));
  const filteredLoadUnits=filterWarehouseOutboundLoadUnits(loadUnits,filters);
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
  const selectedLoadUnit=requestedBatchId?loadUnits.find(batch=>batch.id===requestedBatchId)??null:null;
  const requestedInspection=selectedLoadUnit?.ready
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
    user,warehouse,
    loadUnits:filteredLoadUnits,
    loadUnitCounts:{all:loadUnits.length,ready:loadUnits.filter(item=>item.ready).length,blocked:loadUnits.filter(item=>!item.ready).length},
    filters,
    dispatches:visibleDispatches,
    items,
    orderId,
    returnTo:url.searchParams.get("returnTo"),
    view,
    pendingHref:viewHref("pending"),
    executionHref:viewHref("execution"),
    requestedDispatchId,
    selectedExecutionPolicy,
    selectedResourceDifferences,
    selectedResourcePolicyError,
    selectedLoadUnit,
    requestedInspection,
    manifestsByOrder,
    outboundResources:{carriers:carriers.results,vehicles:vehicles.results,drivers:drivers.results},
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
    return{actionKind:"ftl_inspected" as const,uploadOpenSignal:now,inspection};
  }
  if(intent==="loading_document_upload"){
    const inspectionOrderId=valueOf(form,"inspectionOrderId"),orderId=valueOf(form,"orderId"),batchId=valueOf(form,"batchId"),documentCategory=valueOf(form,"documentCategory") as LoadingDocumentCode;
    const inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,inspectionOrderId,batchId);
    if(!inspection)return{formError:"该订单已不在当前仓库、尚未货齐，或已经创建装车任务"};
    const documentGroup=inspection.documentGroups.find(group=>group.orderId===orderId);
    if(!documentGroup)return{formError:"该订单不属于当前待创建的装车任务",inspection};
    const documentType=LOADING_DOCUMENTS.find(item=>item.code===documentCategory);
    if(!documentType)return{formError:`请选择有效文件类型：${LOADING_DOCUMENTS.map(item=>item.name).join("、")}`,inspection};
    const file=form.get("attachment");
    if(!(file instanceof File)||file.size<=0)return{formError:`请选择要上传的${documentType.name}`,inspection};
    const fileError=validateOutboundDocumentFile(file);
    if(fileError)return{formError:fileError,inspection};
    const attachmentId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)")
        .bind(attachmentId,user.organizationId,orderId,documentGroup.customerId,file.name,file.type,file.size,await toDataUrl(file),user.userId,now),
      env.DB.prepare("INSERT INTO order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,updated_at) VALUES(?,?,?,?,?,0,'pending',?)")
        .bind(attachmentId,user.organizationId,orderId,documentCategory,documentType.name,now),
    ]);
    await writeAudit({request,action:"warehouse.outbound.document_upload",resourceType:"order_attachment",resourceId:attachmentId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{warehouseId:warehouse.id,orderId,orderNumber:documentGroup.orderNumber,documentCategory,fileName:file.name}});
    return{success:`${documentGroup.orderNumber} 的${documentType.name}已上传`,actionKind:"loading_document_uploaded" as const,uploadOpenSignal:now,inspection:await loadOutboundInspectionByIds(user.organizationId,warehouse.id,inspectionOrderId,batchId)};
  }
  if(intent==="loading_documents_approve"){
    const inspectionOrderId=valueOf(form,"inspectionOrderId"),batchId=valueOf(form,"batchId");
    const inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,inspectionOrderId,batchId);
    if(!inspection)return{formError:"该订单已不在当前仓库、尚未货齐，或已经创建装车任务"};
    const missing=inspection.documents.filter(document=>document.required&&!document.attachmentId);
    if(missing.length)return{formError:`请先上传：${missing.map(document=>`${document.orderNumber} ${document.name}`).join("、")}`,inspection};
    const uploadedDocuments=inspection.documents.filter(document=>document.attachmentId);
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
    const batchId=valueOf(form,"batchId"),orderNumber=valueOf(form,"orderNumber").trim(),customerIdentityCode=valueOf(form,"customerIdentityCode").trim().toUpperCase(),notes=valueOf(form,"notes");
    const carrierId=valueOf(form,"outboundCarrierId"),vehicleId=valueOf(form,"outboundVehicleId"),driverId=valueOf(form,"outboundDriverId"),plannedDepartureAt=valueOf(form,"plannedDepartureAt");
    if(!batchId&&!orderNumber)return{formError:"请输入订单号或选择货齐入库记录"};
    if(customerIdentityCode&&!isValidCustomerIdentityCode(customerIdentityCode))return{formError:"客户识别码应为5位字母与数字混合，且不包含 O、0、1、L"};
    const availableBatchSql=`SELECT b.id,b.shipment_id,o.id order_id,o.order_number,c.identity_code customer_identity_code,o.business_type,o.exit_port,TRIM(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city||CASE WHEN NULLIF(TRIM(o.destination_address),'') IS NOT NULL THEN ' '||o.destination_address ELSE '' END) destination_location FROM warehouse_sorting_batches b JOIN shipments s ON s.id=b.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id WHERE b.organization_id=? AND EXISTS(SELECT 1 FROM warehouse_sorting_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.batch_id=b.id AND wp.warehouse_id=?) AND b.status='verified' AND NOT EXISTS (SELECT 1 FROM warehouse_sorting_items xi JOIN warehouse_dispatch_items xdi ON xdi.package_id=xi.package_id JOIN warehouse_dispatches xd ON xd.id=xdi.dispatch_id WHERE xi.batch_id=b.id AND xd.status!='cancelled')`;
    const matches=orderNumber
      ? await env.DB.prepare(`${availableBatchSql} AND UPPER(o.order_number)=UPPER(?) AND (?='' OR UPPER(c.identity_code)=UPPER(?)) ORDER BY b.verified_at DESC LIMIT 2`).bind(user.organizationId,warehouse.id,orderNumber,customerIdentityCode,customerIdentityCode).all<Pick<Batch,"id"|"shipment_id"|"order_id"|"order_number"|"customer_identity_code"|"business_type"|"exit_port"|"destination_location">>()
      : await env.DB.prepare(`${availableBatchSql} AND b.id=? AND (?='' OR UPPER(c.identity_code)=UPPER(?)) LIMIT 1`).bind(user.organizationId,warehouse.id,batchId,customerIdentityCode,customerIdentityCode).all<Pick<Batch,"id"|"shipment_id"|"order_id"|"order_number"|"customer_identity_code"|"business_type"|"exit_port"|"destination_location">>();
    if(matches.results.length>1)return{formError:"该订单存在多个货齐入库记录，请从列表选择具体记录"};
    const batch=matches.results[0];
    if(!batch && orderNumber){
      const existing=await env.DB.prepare(`SELECT d.dispatch_number,d.status,o.business_type FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id JOIN transport_orders o ON o.id=s.order_id WHERE d.organization_id=? AND p.warehouse_id=? AND UPPER(o.order_number)=UPPER(?) AND d.status!='cancelled' ORDER BY d.created_at DESC LIMIT 1`).bind(user.organizationId,warehouse.id,orderNumber).first<{dispatch_number:string;status:string;business_type:string}>();
      if(existing)return{formError:`${orderNumber} 已经创建装车任务 ${existing.dispatch_number}，当前状态：${existing.status==="loading"?"装车中":"已出库交接"}。请进入“装车与出库”页面继续办理，不要重复新建任务。`};
      const diagnosis=await diagnoseOutboundOrder(user.organizationId,warehouse.id,orderNumber);
      if(diagnosis)return{formError:diagnosis};
      return{formError:`未找到已确认货齐且尚未创建装车任务的订单：${orderNumber}。请确认：仓库已完成实收并勾选“货齐”；整车出境车辆将在创建任务时由仓库确认，拼车需先生成 PZ 配载单并完成整批车辆安排。`};
    }
    if(!batch)return{formError:`未找到已复核且尚未出库的批次${orderNumber?`：${orderNumber}`:""}，请核对订单号、客户识别码和分拣状态`};
    let inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,batch.order_id,batch.id);
    if(!inspection)return{formError:"当前收货清点记录已经失效，请重新检查订单"};
    const rejectCreate=(formError:string)=>({formError,inspection});
    const missing=inspection.documents.filter(document=>document.required&&!document.attachmentId);
    if(missing.length)return rejectCreate(`请先上传：${missing.map(document=>`${document.orderNumber} ${document.name}`).join("、")}`);
    const documentsToApprove=inspection.documents.filter(document=>document.attachmentId&&!["approved","archived"].includes(document.reviewStatus||""));
    if(documentsToApprove.length){
      const approvalStatements=chunkD1Values(documentsToApprove,4).map(documentChunk=>env.DB.prepare(`UPDATE order_document_metadata
        SET review_status='approved',reviewed_by_user_id=?,reviewed_at=?,updated_at=?
        WHERE organization_id=? AND attachment_id IN (${d1Placeholders(documentChunk.length)})`)
        .bind(user.userId,now,now,user.organizationId,...documentChunk.map(document=>document.attachmentId)));
      await env.DB.batch(approvalStatements);
      await writeAudit({request,action:"warehouse.outbound.documents_confirm_and_create",resourceType:"transport_order",resourceId:batch.order_id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{warehouseId:warehouse.id,orderNumbers:inspection.documentGroups.map(group=>group.orderNumber),documents:documentsToApprove.map(document=>`${document.orderNumber}:${document.code}`)}});
      inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,batch.order_id,batch.id);
      if(!inspection)return{formError:"文件确认后订单状态发生变化，请重新检查订单"};
    }
    if(!inspection.allApproved){
      const pending=inspection.documents.filter(document=>document.required&&!["approved","archived"].includes(document.reviewStatus||""));
      return rejectCreate(`请先上传、检查并确认：${pending.map(document=>`${document.orderNumber} ${document.name}`).join("、")}`);
    }
    const documentGateResults:Array<{group:(typeof inspection.documentGroups)[number];gate:Awaited<ReturnType<typeof checkOrderPreDepartureDocuments>>}>=[];
    for(const group of inspection.documentGroups){
      documentGateResults.push({group,gate:await checkOrderPreDepartureDocuments(user.organizationId,group.orderId)});
    }
    const documentGateBlockers=documentGateResults.filter(item=>!item.gate.ready).flatMap(item=>item.gate.reasons.map(reason=>`${item.group.orderNumber}：${reason}`));
    if(documentGateBlockers.length)return rejectCreate(`暂不能创建装车任务：${documentGateBlockers.join("；")}`);
    if(inspection.notesActive&&inspection.notesRequired&&!notes.trim())return rejectCreate("请填写装车交接备注");
    if(batch.business_type==="ftl"){
      const resourceError=validateFtlOutboundResourceSelection({carrierId,vehicleId,driverId,plannedDepartureAt});
      if(resourceError)return rejectCreate(resourceError);
    }
    const planned=batch.business_type==="ftl"
      ?await resolveFtlDispatchPlan(user.organizationId,{carrierId,vehicleId,driverId,plannedDepartureAt})
      :await resolveDispatchPlan(user.organizationId,batch.order_id,batch.business_type,inspection.batch.transport_batch_id,inspection.executionPolicy.batchFields);
    if("error" in planned)return rejectCreate(planned.error);
    const plate=planned.vehicle_plate?.trim().toUpperCase()||"",driver=planned.driver_name?.trim()||"",phone=planned.driver_phone?.trim()||"",carrier=planned.carrier_name?.trim()||"",destination=batch.destination_location;
    if(batch.business_type==="ftl"&&(!plate||!driver||!carrier))return rejectCreate("运输安排尚未完整：请先在运输安排中确定承运商、车辆和司机，再由仓库创建装车任务");
    const resourceDifferences=batch.business_type==="ltl"?dispatchPlanPolicyIssues(inspection.executionPolicy.batchFields,planned).differences:[];
    const resourceDifferenceConfirmed=valueOf(form,"resourceDifferenceConfirmed")==="yes";
    if(resourceDifferences.length&&!resourceDifferenceConfirmed)return rejectCreate(`以下非必填运输信息仍为空：${resourceDifferences.map(item=>`${item.label}（${item.mode==="hidden"?"已隐藏":"选填"}）`).join("、")}；请在页面二次确认后创建任务`);
    const loadReadiness=await checkOrderLoadPlan(user.organizationId,batch.order_id,planned.batch_id?plate:undefined,planned.batch_id);
    if(!loadReadiness.ready)return rejectCreate(`暂不能创建装车任务：${loadReadiness.reasons.join("；")}`);
    if(planned.batch_id){
      const readiness=await checkBatchWarehouseReadiness(user.organizationId,warehouse.id,planned.batch_id,plate);
      const blocked=readiness.orders.filter(item=>item.reasons.length>0);
      if(blocked.length)return rejectCreate(`配载单 ${readiness.batchNumber} 尚不能装车：${formatOrderBlockers(blocked)}`);
    }
    const dispatchId=crypto.randomUUID(),number=generateDispatch(),mainAssignmentId=crypto.randomUUID();
    const itemStatement=planned.batch_id
      ? env.DB.prepare(`INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status)
          SELECT lower(hex(randomblob(16))),wsi.organization_id,?,wsi.package_id,'pending'
          FROM warehouse_sorting_items wsi
          JOIN warehouse_sorting_batches wsb ON wsb.id=wsi.batch_id AND wsb.status='verified'
          JOIN warehouse_packages wp ON wp.id=wsi.package_id
          JOIN shipments s ON s.id=wp.shipment_id
          JOIN transport_batch_orders bo ON bo.order_id=s.order_id AND bo.organization_id=wsi.organization_id AND bo.batch_id=? AND bo.status!='removed'
          WHERE wsi.organization_id=? AND wp.warehouse_id=? AND wsi.status='verified'
            AND NOT EXISTS (SELECT 1 FROM warehouse_dispatch_items xdi JOIN warehouse_dispatches xd ON xd.id=xdi.dispatch_id WHERE xdi.package_id=wsi.package_id AND xd.status!='cancelled')`).bind(dispatchId,planned.batch_id,user.organizationId,warehouse.id)
      : env.DB.prepare(`INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status) SELECT lower(hex(randomblob(16))),organization_id,?,package_id,'pending' FROM warehouse_sorting_items WHERE batch_id=? AND status='verified'`).bind(dispatchId,batch.id);
    const batchStateStatements=planned.batch_id?[
      env.DB.prepare("UPDATE warehouse_packages SET status='allocated',updated_at=? WHERE organization_id=? AND status='in_stock' AND id IN (SELECT package_id FROM warehouse_dispatch_items WHERE dispatch_id=?)").bind(now,user.organizationId,dispatchId),
      env.DB.prepare("UPDATE transport_batches SET status='loading',road_status='waiting_loading',updated_at=? WHERE id=? AND organization_id=? AND status IN ('planning','loading')").bind(now,planned.batch_id,user.organizationId),
    ]:[];
    const mainAssignmentStatements=batch.business_type==="ftl"?[
      env.DB.prepare("UPDATE order_transport_assignments SET status='cancelled',updated_at=? WHERE organization_id=? AND order_id=? AND leg_type='main' AND status!='cancelled'").bind(now,user.organizationId,batch.order_id),
      env.DB.prepare(`INSERT INTO order_transport_assignments(id,organization_id,order_id,leg_type,carrier_id,carrier_name,vehicle_type,plate_number,driver_name,driver_phone,freight_amount,freight_currency,origin_location,destination_location,border_port,planned_departure_at,loading_requirements,notes,status,created_by_user_id,created_at,updated_at)
        VALUES(?,?,?,'main',?,?,?,?,?,?,0,'CNY',?,?,?,?,?,'仓库装车前确认并同步管理端','planned',?,?,?)`).bind(mainAssignmentId,user.organizationId,batch.order_id,planned.carrier_id,carrier,planned.vehicle_type,plate,driver,phone||null,warehouse.name,batch.destination_location,batch.exit_port,planned.planned_departure_at,"整车出境运输资源由仓库装车前确认",user.userId,now,now),
    ]:[];
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO warehouse_dispatches(id,organization_id,dispatch_number,sorting_batch_id,shipment_id,vehicle_plate,driver_name,driver_phone,carrier_name,seal_number,destination,status,notes,created_by_user_id,created_at,updated_at,transport_batch_id) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,'loading',?,?,?,?,?)`).bind(dispatchId,user.organizationId,number,batch.id,batch.shipment_id,plate,driver,phone||null,carrier||null,destination,inspection.notesActive?(notes||null):null,user.userId,now,now,planned.batch_id),
      itemStatement,
      ...mainAssignmentStatements,
      ...batchStateStatements,
    ]);
    const postCreateWarnings:string[]=[];
    if(planned.batch_id){
      try{await refreshLoadingManifest(user.organizationId,planned.batch_id,user.userId,now)}catch(error){console.error("dispatch manifest sync failed",error);postCreateWarnings.push("配载舱单待重试")}
    }
    for(const group of inspection.documentGroups){
      try{
        await recordWarehouseProgress({organizationId:user.organizationId,orderId:group.orderId,actorUserId:user.userId,stepCode:"loading",stepName:planned.batch_id?"按配载单统一装车":"整车装车",actionCode:"dispatch_create",actionName:planned.batch_id?"创建配载单装车任务":"创建整车装车任务",notes:`装车任务 ${number}；车辆 ${plate}`});
      }catch(error){console.error("dispatch order progress sync failed",error);postCreateWarnings.push(`${group.orderNumber} 进度待重试`)}
    }
    try{
      await writeAudit({request,action:"warehouse.dispatch.create",resourceType:"warehouse_dispatch",resourceId:dispatchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{number,batchId:batch.id,transportBatchId:planned.batch_id,orderNumbers:inspection.documentGroups.map(group=>group.orderNumber),businessType:batch.business_type,carrier,plate,driver,plannedDepartureAt:planned.planned_departure_at,resourceSource:planned.batch_id?"ltl_batch":"warehouse_ftl_confirmation",resourcePolicyDifferences:resourceDifferences,resourceDifferenceConfirmed:resourceDifferences.length>0&&resourceDifferenceConfirmed}});
    }catch(error){console.error("dispatch audit write failed",error);postCreateWarnings.push("审计记录待重试")}
    const sourceUrl=new URL(request.url),redirectParams=new URLSearchParams();
    for(const key of ["warehouseId","returnTo","orderId"]){const value=sourceUrl.searchParams.get(key);if(value)redirectParams.set(key,value);}
    redirectParams.set("view","execution");
    redirectParams.set("dispatchId",dispatchId);
    redirectParams.set("warehouseResult",`装车任务 ${number} 已创建，已同步到“装车与出库”${postCreateWarnings.length?`；${[...new Set(postCreateWarnings)].join("、")}`:""}`);
    return redirect(`/warehouse/outbound?${redirectParams.toString()}`);
  }
  const dispatchId=valueOf(form,"dispatchId");
  let dispatch=await env.DB.prepare(`SELECT d.id,d.shipment_id,s.order_id,o.business_type,d.status,d.dispatch_number,d.vehicle_plate,d.driver_name,d.driver_phone,d.carrier_name,d.destination,d.transport_batch_id FROM warehouse_dispatches d JOIN shipments s ON s.id=d.shipment_id JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=d.organization_id WHERE d.id=? AND d.organization_id=? AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.dispatch_id=d.id AND wp.warehouse_id=?)`).bind(dispatchId,user.organizationId,warehouse.id).first<{id:string;shipment_id:string;order_id:string;business_type:string;status:string;dispatch_number:string;vehicle_plate:string;driver_name:string;driver_phone:string|null;carrier_name:string|null;destination:string;transport_batch_id:string|null}>();
  if(!dispatch)return{formError:"装车任务不存在"};
  const executionPolicy=["schedule","load","dispatch"].includes(intent)
    ?await loadDispatchWorkflowPolicy(user.organizationId,dispatch.id)
    :null;
  if(intent==="schedule"){
    const plannedDepartureAt=valueOf(form,"plannedDepartureAt").trim();
    if(!dispatch.transport_batch_id)return{formError:"整车任务不使用配载单计划出境时间"};
    if(!executionPolicy?.batchFields.planned_exit_at.isActive)return{formError:"当前工作流已隐藏计划出境发车时间，不能在此登记"};
    if(!plannedDepartureAt)return{formError:"请填写计划出境发车时间"};
    const result=await env.DB.prepare("UPDATE transport_batches SET planned_departure_at=?,updated_at=? WHERE id=? AND organization_id=? AND warehouse_id=? AND status!='cancelled'").bind(plannedDepartureAt,now,dispatch.transport_batch_id,user.organizationId,warehouse.id).run();
    if(!result.meta.changes)return{formError:"配载单不存在或不属于当前仓库"};
    await writeAudit({request,action:"warehouse.dispatch.schedule",resourceType:"transport_batch",resourceId:dispatch.transport_batch_id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,plannedDepartureAt}});
    return{success:`${dispatch.dispatch_number} 的计划出境发车时间已保存`};
  }
  if((intent==="load"||intent==="dispatch")&&(!dispatch.vehicle_plate.trim()||!dispatch.driver_name.trim()||!dispatch.carrier_name?.trim())&&dispatch.transport_batch_id&&(executionPolicy?.resources.carrier.isActive||executionPolicy?.resources.vehicle.isActive||executionPolicy?.resources.driver.isActive)){
    const resources=await env.DB.prepare(`SELECT v.plate_number,v.driver_name,v.driver_phone,COALESCE(c.name,bc.name) carrier_name
      FROM transport_batch_vehicles v JOIN transport_batches b ON b.id=v.batch_id
      LEFT JOIN carriers c ON c.id=v.carrier_id LEFT JOIN carriers bc ON bc.id=b.carrier_id
      WHERE v.batch_id=? AND v.organization_id=? AND v.status!='cancelled' ORDER BY v.created_at LIMIT 2`)
      .bind(dispatch.transport_batch_id,user.organizationId).all<{plate_number:string|null;driver_name:string|null;driver_phone:string|null;carrier_name:string|null}>();
    if(resources.results.length===1){
      const resource=resources.results[0];
      const vehiclePlate=resource.plate_number?.trim().toUpperCase()||"",driverName=resource.driver_name?.trim()||"",carrierName=resource.carrier_name?.trim()||"";
      if(vehiclePlate&&driverName&&carrierName){
        await env.DB.prepare("UPDATE warehouse_dispatches SET vehicle_plate=?,driver_name=?,driver_phone=?,carrier_name=?,updated_at=? WHERE id=? AND organization_id=?")
          .bind(vehiclePlate,driverName,resource.driver_phone?.trim()||null,carrierName,now,dispatch.id,user.organizationId).run();
        dispatch={...dispatch,vehicle_plate:vehiclePlate,driver_name:driverName,driver_phone:resource.driver_phone?.trim()||null,carrier_name:carrierName};
      }
    }
  }
  if((intent==="load"||intent==="dispatch")&&dispatch.business_type==="ftl"&&(!dispatch.vehicle_plate.trim()||!dispatch.driver_name.trim()||!dispatch.carrier_name?.trim()))
    return{formError:"整车出境承运商、车辆和司机尚未由仓库确认，不能开始扫码装车"};
  let resourceDifferences:OutboundPolicyDifference[]=[];
  if((intent==="load"||intent==="dispatch")&&dispatch.business_type==="ltl"&&executionPolicy){
    const currentPlan=await resolveDispatchPlan(user.organizationId,dispatch.order_id,dispatch.business_type,dispatch.transport_batch_id,executionPolicy.batchFields);
    if("error" in currentPlan)return{formError:currentPlan.error};
    resourceDifferences=dispatchPlanPolicyIssues(executionPolicy.batchFields,currentPlan).differences;
    if(resourceDifferences.length&&valueOf(form,"resourceDifferenceConfirmed")!=="yes")return{formError:`以下非必填运输信息仍为空：${resourceDifferences.map(item=>item.label).join("、")}；请二次确认后继续`};
  }
  if(intent==="load"){
    if(dispatch.status!=="loading")return{formError:"该装车任务已完成出库交接，不能继续装车"};
    if(!executionPolicy?.scanConfirmation.isActive)return{formError:"当前工作流已隐藏逐件扫码，请直接办理出库交接"};
    const barcode=valueOf(form,"barcode").toUpperCase();
    const item=await env.DB.prepare(`SELECT di.id,di.status,p.id package_id FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id WHERE di.dispatch_id=? AND di.organization_id=? AND p.warehouse_id=? AND p.barcode=?`).bind(dispatch.id,user.organizationId,warehouse.id,barcode).first<{id:string;status:string;package_id:string}>();
    if(!item)return{formError:"该货物不属于当前装车任务"};
    if(item.status==="loaded")return{formError:"该货物已经装车，请勿重复扫描"};
    await env.DB.prepare("UPDATE warehouse_dispatch_items SET status='loaded',loaded_by_user_id=?,loaded_at=? WHERE id=?").bind(user.userId,now,item.id).run();
    if(resourceDifferences.length)await writeAudit({request,action:"warehouse.dispatch.resource_difference_confirmed",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,stage:"scan",resourcePolicyDifferences:resourceDifferences}});
    return{success:`${barcode} 已装车，请核对下方货物信息`,actionKind:"package_loaded" as const,scannedBarcode:barcode,scannedDispatchId:dispatch.id};
  }
  if(intent==="dispatch"){
    if(dispatch.status!=="loading")return{formError:"该任务已经完成发车"};
    const counts=await env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='loaded' THEN 1 ELSE 0 END) loaded FROM warehouse_dispatch_items WHERE dispatch_id=?").bind(dispatch.id).first<{total:number;loaded:number}>();
    if(!counts?.total)return{formError:"当前装车任务没有货物，不能出库交接"};
    const loadedCount=Number(counts.loaded??0),missingScanCount=Math.max(0,counts.total-loadedCount);
    if(executionPolicy?.scanConfirmation.isRequired&&missingScanCount>0)return{formError:`逐件扫码为必填：当前 ${loadedCount}/${counts.total}，不能出库交接`};
    const scanDifferenceConfirmed=valueOf(form,"scanDifferenceConfirmed")==="yes";
    if(!executionPolicy?.scanConfirmation.isRequired&&missingScanCount>0&&!scanDifferenceConfirmed)
      return{formError:`尚有 ${missingScanCount} 个货物码未扫描；请在页面再次明确确认后出库`};
    const shipments=await env.DB.prepare(`SELECT DISTINCT s.id shipment_id,s.order_id,o.order_number,s.customer_id,s.current_location
      FROM warehouse_dispatch_items di
      JOIN warehouse_packages p ON p.id=di.package_id
      JOIN shipments s ON s.id=p.shipment_id
      JOIN transport_orders o ON o.id=s.order_id
      WHERE di.dispatch_id=? AND di.organization_id=?`).bind(dispatch.id,user.organizationId).all<{shipment_id:string;order_id:string;order_number:string;customer_id:string;current_location:string|null}>();
    if(!shipments.results.length)return{formError:"关联运单不存在"};
    const departureBlockers:string[]=[];
    for(const shipment of shipments.results){
      const readiness=await checkOrderLoadPlan(user.organizationId,shipment.order_id,dispatch.transport_batch_id?dispatch.vehicle_plate:undefined,dispatch.transport_batch_id);
      if(!readiness.ready)departureBlockers.push(...readiness.reasons.map(reason=>`${shipment.order_number}：${reason}`));
    }
    if(departureBlockers.length)return{formError:`暂不能完成出库交接：${[...new Set(departureBlockers)].join("；")}`};
    const scanDifferenceNote=missingScanCount>0
      ?`；逐件扫码${executionPolicy?.scanConfirmation.mode==="hidden"?"已隐藏":"为选填"}，未扫描 ${missingScanCount}/${counts.total}，已由操作员二次确认`
      :"";
    const description=`车辆 ${dispatch.vehicle_plate} 已完成仓库装车，等待出境确认；司机：${dispatch.driver_name}${scanDifferenceNote}`;
    const statements=[
      env.DB.prepare("UPDATE warehouse_dispatches SET status='dispatched',dispatched_by_user_id=?,dispatched_at=?,updated_at=? WHERE id=?").bind(user.userId,now,now,dispatch.id),
      env.DB.prepare("UPDATE warehouse_packages SET status='dispatched',updated_at=? WHERE id IN (SELECT package_id FROM warehouse_dispatch_items WHERE dispatch_id=?) AND organization_id=?").bind(now,dispatch.id,user.organizationId),
      env.DB.prepare(`INSERT INTO warehouse_package_movements(id,organization_id,package_id,operation_type,from_location_id,to_location_id,batch_id,operator_user_id,notes,occurred_at,created_at) SELECT lower(hex(randomblob(16))),di.organization_id,di.package_id,'dispatch',p.location_id,NULL,d.sorting_batch_id,?,?,?,? FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id JOIN warehouse_dispatches d ON d.id=di.dispatch_id WHERE di.dispatch_id=?`).bind(user.userId,description,now,now,dispatch.id),
      env.DB.prepare(`INSERT INTO warehouse_operations(id,organization_id,shipment_id,operation_type,location,notes,operator_user_id,occurred_at,created_at)
        SELECT lower(hex(randomblob(16))),?,scope.shipment_id,'dispatch',scope.current_location,?,?,?,?
        FROM (
          SELECT DISTINCT s.id shipment_id,s.current_location
          FROM warehouse_dispatch_items di
          JOIN warehouse_packages p ON p.id=di.package_id
          JOIN shipments s ON s.id=p.shipment_id
          WHERE di.dispatch_id=? AND di.organization_id=?
        ) scope`).bind(user.organizationId,description,user.userId,now,now,dispatch.id,user.organizationId),
      env.DB.prepare(`INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at)
        SELECT lower(hex(randomblob(16))),scope.shipment_id,'picked_up',scope.current_location,?,?,1,?,?
        FROM (
          SELECT DISTINCT s.id shipment_id,s.current_location
          FROM warehouse_dispatch_items di
          JOIN warehouse_packages p ON p.id=di.package_id
          JOIN shipments s ON s.id=p.shipment_id
          WHERE di.dispatch_id=? AND di.organization_id=?
        ) scope`).bind(description,now,user.userId,now,dispatch.id,user.organizationId),
      env.DB.prepare(`UPDATE order_cargo_packages SET status='loaded'
        WHERE organization_id=? AND status NOT IN ('cancelled','in_transit','delivered')
          AND order_id IN (
            SELECT DISTINCT s.order_id
            FROM warehouse_dispatch_items di
            JOIN warehouse_packages p ON p.id=di.package_id
            JOIN shipments s ON s.id=p.shipment_id
            WHERE di.dispatch_id=? AND di.organization_id=?
          )`).bind(user.organizationId,dispatch.id,user.organizationId),
    ];
    const referenceOrderId=shipments.results[0].order_id;
    const linkedBatch=dispatch.transport_batch_id?{batch_id:dispatch.transport_batch_id}:null;
    if(linkedBatch?.batch_id)statements.push(
      env.DB.prepare("UPDATE transport_vehicle_loads SET loaded_at=COALESCE(loaded_at,?) WHERE batch_id=? AND organization_id=?").bind(now,linkedBatch.batch_id,user.organizationId),
      env.DB.prepare("UPDATE transport_batches SET road_status='loaded_waiting_exit',updated_at=? WHERE id=? AND organization_id=?").bind(now,linkedBatch.batch_id,user.organizationId),
    );
    await env.DB.batch(statements);
    const completionWarnings:string[]=[];
    if(linkedBatch?.batch_id){
      try{await refreshLoadingManifest(user.organizationId,linkedBatch.batch_id,user.userId,now)}catch(error){console.error("completed dispatch manifest sync failed",error);completionWarnings.push("配载舱单待重试")}
      try{await recordBatchOutboundProgress({organizationId:user.organizationId,batchId:linkedBatch.batch_id,actorUserId:user.userId,dispatchNumber:dispatch.dispatch_number,referenceOrderId})}catch(error){console.error("completed dispatch batch progress sync failed",error);completionWarnings.push("批次进度待重试")}
    }else{
      for (const item of shipments.results) {
        try{
          await recordWarehouseProgress({organizationId:user.organizationId,orderId:item.order_id,actorUserId:user.userId,stepCode:"outbound",stepName:"装车出库交接完成",actionCode:"dispatch_complete",actionName:"完成装车出库交接",notes:`装车任务 ${dispatch.dispatch_number} 完成装车出库，等待出境确认`});
        }catch(error){console.error("completed dispatch order progress sync failed",error);completionWarnings.push(`${item.order_number} 进度待重试`)}
      }
    }
    try{
      await writeAudit({request,action:"warehouse.dispatch.complete",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,packages:counts.total,scanPolicy:executionPolicy?.scanConfirmation.mode??"required",scannedPackages:loadedCount,unscannedPackages:missingScanCount,scanDifferenceConfirmed:missingScanCount>0&&scanDifferenceConfirmed,resourcePolicyDifferences:resourceDifferences,resourceDifferenceConfirmed:resourceDifferences.length>0}});
    }catch(error){console.error("completed dispatch audit write failed",error);completionWarnings.push("审计记录待重试")}
    const completionWarningText=completionWarnings.length?`；${[...new Set(completionWarnings)].join("、")}`:"";
    return{success:(dispatch.business_type==="ltl"
      ?`${dispatch.dispatch_number} 已完成装车出库交接，交接数据已同步管理端；请回 PZ 配载单执行实际出境确认，运单此时尚未进入在途`
      :`${dispatch.dispatch_number} 已完成整车装车出库交接，车辆与司机信息已同步管理端；后续由订单的报关及出境运输节点确认实际出境`)+completionWarningText,printHandoverSignal:now};
  }
  return{formError:"无效的出库操作"};
}

export default function WarehouseOutbound({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle",canOperate=loaderData.user.permissions.includes("warehouse.operate"),loading=loaderData.dispatches.filter(x=>x.status==="loading"),completed=loaderData.dispatches.filter(x=>x.status==="dispatched");
  const executionTasks=[...loaderData.dispatches].sort((left,right)=>dispatchTaskPriority(left)-dispatchTaskPriority(right)||(right.dispatched_at||right.created_at).localeCompare(left.dispatched_at||left.created_at));
  const selectedTask=loaderData.requestedDispatchId?loaderData.dispatches.find(task=>task.id===loaderData.requestedDispatchId):undefined;
  const selectedStage=selectedTask?dispatchTaskStage(selectedTask,loaderData.selectedExecutionPolicy?.scanConfirmation):undefined;
  const actionSuccess=actionData&&"success" in actionData?actionData.success:undefined;
  const actionError=actionData&&"formError" in actionData?actionData.formError:undefined;
  const scannedBarcode=actionData&&"scannedBarcode" in actionData?actionData.scannedBarcode:undefined;
  const scannedDispatchId=actionData&&"scannedDispatchId" in actionData?actionData.scannedDispatchId:undefined;
  const printHandoverSignal=actionData&&"printHandoverSignal" in actionData?actionData.printHandoverSignal:undefined;
  const inspection=actionData&&"inspection" in actionData
    ?actionData.inspection??loaderData.requestedInspection
    :loaderData.requestedInspection;
  const uploadOpenSignal=actionData&&"uploadOpenSignal" in actionData?actionData.uploadOpenSignal:undefined;
  useEffect(()=>{
    if(!printHandoverSignal)return;
    const timer=window.setTimeout(()=>window.print(),120);
    return()=>window.clearTimeout(timer);
  },[printHandoverSignal]);
  if(loaderData.view==="create"){
    const unit=loaderData.selectedLoadUnit,isLtl=unit?.business_type==="ltl"&&Boolean(unit.transport_batch_id);
    return <>
      <header className="page-header" id="warehouse-outbound-workbench"><div><p className="eyebrow">CREATE LOADING TASK</p><h1>创建装车任务</h1><p>{unit?`${isLtl?unit.batch_number:unit.order_number} · ${isLtl?`${unit.order_count} 票拼车订单`:unit.customer_name}`:"请从在仓订单列表选择要办理的订单。"}</p></div><Link className="secondary" to={loaderData.pendingHref}>返回在仓订单</Link></header>
      <ol className="outbound-create-rhythm" aria-label="创建装车任务步骤">
        <li className={unit?"complete":"current"}><span>1</span><div><strong>选择在仓订单</strong><small>{unit?"已选定":"当前步骤"}</small></div></li>
        <li className={unit?.ready?"current":"upcoming"}><span>2</span><div><strong>核验发运文件</strong><small>{unit?.ready?"当前步骤":"等待装车条件"}</small></div></li>
        <li className={inspection?.allUploaded?"current":"upcoming"}><span>3</span><div><strong>{isLtl?"确认创建任务":"确认出境车辆并创建"}</strong><small>{inspection?.allUploaded?(isLtl?"文件已齐":"仓库确认车辆、司机与计划时间"):"文件齐全后开放"}</small></div></li>
      </ol>
      {!unit&&<div className="alert error" role="alert">未找到对应的在仓订单，该订单可能已创建装车任务或已离仓。<Link to={loaderData.pendingHref}>返回列表重新选择</Link></div>}
      {unit&&!unit.ready&&<section className="panel outbound-create-blocked"><div className="panel-header"><div><h2>暂不能创建装车任务</h2><p>订单仍保留在仓，补齐以下条件后即可返回列表继续办理。</p></div><span className="status-pill warning">待补条件</span></div><ul>{unit.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul><div className="panel-footer"><Link className="secondary" to={loaderData.pendingHref}>返回在仓订单</Link></div></section>}
      {unit?.ready&&<section className="panel outbound-create-section"><div className="panel-header"><div><h2>核验发运文件</h2><p>已有文件自动沿用；只需补齐或替换问题文件，确认总览后创建任务。</p></div><span className="status-pill success">装车条件已满足</span></div>{canOperate?<CreateDispatchWorkbench warehouseId={loaderData.warehouse.id} inspection={inspection} outboundResources={loaderData.outboundResources} busy={busy} actionSuccess={actionSuccess} actionError={actionError} uploadOpenSignal={uploadOpenSignal}/>:<div className="alert warning">当前账户可查看装车条件，但不能创建任务。</div>}</section>}
    </>;
  }
  if(loaderData.view==="pending")return <>
    <header className="page-header" id="warehouse-outbound-workbench"><div><p className="eyebrow">IN-WAREHOUSE ORDERS</p><h1>在仓订单</h1><p>先筛选并选定订单，再进入独立页面核验文件、创建装车任务。拼车订单仍按 PZ 配载单整批办理。</p></div><Link className="secondary" to={loaderData.executionHref}>查看装车与出库</Link></header>
    <section className="panel outbound-pending-orders">
      <div className="panel-header"><div><h2>在仓订单列表</h2><p>点击订单号或 PZ 配载单号进入“创建装车任务”；暂不满足条件的订单会直接标明原因。</p></div><span>{loaderData.loadUnits.length} / {loaderData.loadUnitCounts.all} 个装车单位</span></div>
      <Form method="get" className="outbound-order-filter-form" role="search">
        <input type="hidden" name="view" value="pending"/><input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/>{loaderData.orderId&&<input type="hidden" name="orderId" value={loaderData.orderId}/>} {loaderData.returnTo&&<input type="hidden" name="returnTo" value={loaderData.returnTo}/>}
        <label><span>搜索</span><input name="q" defaultValue={loaderData.filters.query} placeholder="订单号、PZ 单号、客户或目的地" autoComplete="off"/></label>
        <label><span>运输类型</span><select name="type" defaultValue={loaderData.filters.businessType}><option value="all">全部类型</option><option value="ftl">整车</option><option value="ltl">拼车</option></select></label>
        <label><span>装车条件</span><select name="readiness" defaultValue={loaderData.filters.readiness}><option value="all">全部状态</option><option value="ready">可创建任务</option><option value="blocked">待补条件</option></select></label>
        <div className="outbound-order-filter-actions"><button className="primary warehouse-primary">查询</button><Link className="secondary" to={clearOutboundFiltersHref(loaderData.pendingHref)}>重置</Link></div>
      </Form>
      <div className="outbound-list-summary" aria-live="polite"><span>全部 <strong>{loaderData.loadUnitCounts.all}</strong></span><span>可创建 <strong>{loaderData.loadUnitCounts.ready}</strong></span><span>待补条件 <strong>{loaderData.loadUnitCounts.blocked}</strong></span></div>
      <div className="table-wrap"><table className="outbound-load-units-table"><thead><tr><th>订单 / PZ 配载单</th><th>客户</th><th>类型</th><th>入仓 / 库位</th><th>待装货物</th><th>目的地</th><th>装车条件</th><th>操作</th></tr></thead><tbody>{loaderData.loadUnits.map(unit=>{const unitIsLtl=unit.business_type==="ltl"&&Boolean(unit.transport_batch_id),createHref=createLoadUnitHref(loaderData.pendingHref,unit.id);return <tr key={unit.transport_batch_id||unit.id} className={unit.ready?"":"blocked-row"}><td><Link className="outbound-order-number-link" to={createHref}><strong>{unitIsLtl?unit.batch_number:unit.order_number}</strong><small>{unitIsLtl?unit.order_numbers:unit.batch_number}</small></Link></td><td><strong>{unitIsLtl?`${unit.order_count} 票 · ${unit.customer_names.split("、").filter(Boolean).length} 个客户`:unit.customer_name}</strong><small title={unitIsLtl?unit.customer_names:unit.customer_identity_code}>{unitIsLtl?unit.customer_names:unit.customer_identity_code}</small></td><td><span className={`status-pill ${unitIsLtl?"":"off"}`}>{unitIsLtl?"拼车配载":"整车订单"}</span></td><td><strong>{formatWarehouseTime(unit.received_at||unit.verified_at)}</strong><small title={unit.storage_locations}>{unit.storage_locations||"待分配库位"}</small></td><td><strong>{unit.item_count} 个货物码 · {unit.total_pieces} 件</strong><small>{Number(unit.total_weight_kg).toFixed(2)} KG · {Number(unit.total_volume_cbm).toFixed(3)} CBM</small></td><td>{unit.destination_location}</td><td><span className={`status-pill ${unit.ready?"success":"warning"}`}>{unit.ready?"可创建任务":"待补条件"}</span><small className="outbound-block-reason" title={unit.reasons.join("；")}>{unit.ready?"点击订单号继续":unit.reasons[0]}</small></td><td><Link className={unit.ready?"primary warehouse-primary":"secondary"} to={createHref}>{unit.ready?"创建装车任务":"查看阻断"}</Link></td></tr>})}{!loaderData.loadUnits.length&&<tr><td colSpan={8} className="empty-state">没有符合当前筛选条件的在仓订单。请调整筛选条件或重置查询。</td></tr>}</tbody></table></div>
    </section>
  </>;
  return <>
    <header className="page-header" id="warehouse-outbound-workbench"><div><p className="eyebrow">LOAD · SCAN · DISPATCH</p><h1>{selectedTask?"装车出库任务详情":"装车与出库任务中心"}</h1><p>{selectedTask?"按任务完成扫码装车、出库交接，并查看进入境外运输前的后续节点。":"集中查看已有装车出库任务、当前节点和办理进度；点击任务后进入操作详情。"}</p></div><div className="button-row">{selectedTask&&<Link className="secondary" to={loaderData.executionHref}>返回任务中心</Link>}<Link className="secondary" to={loaderData.pendingHref}>返回在仓订单</Link></div></header>
    {(actionSuccess||actionError)&&<div className={`alert ${actionError?"error":"success"}`}><span>{actionError??actionSuccess}</span></div>}
    {selectedTask?<section className="outbound-task-detail-workbench">
      <DispatchNodeStrip task={selectedTask} scanPolicy={loaderData.selectedExecutionPolicy?.scanConfirmation}/>
      {selectedTask.business_type==="ftl"&&!selectedTask.outbound_resource_confirmed&&<div className="alert warning" role="alert"><strong>历史整车任务提示：</strong>该任务创建于仓库出境资源确认上线之前，当前显示的车辆可能来自旧版国内运输安排，只保留为审计记录。新建整车任务将强制由仓库选择境外承运商、车辆和司机，不再沿用此逻辑。</div>}
      {selectedTask.status==="loading"?<DispatchCard key={selectedTask.id} warehouseId={loaderData.warehouse.id} task={selectedTask} items={loaderData.items.filter(x=>x.dispatch_id===selectedTask.id)} manifest={loaderData.manifestsByOrder[selectedTask.order_id]} busy={busy} workflowPolicy={loaderData.selectedExecutionPolicy} resourceDifferences={loaderData.selectedResourceDifferences} resourcePolicyError={loaderData.selectedResourcePolicyError} highlightedBarcode={scannedDispatchId===selectedTask.id?scannedBarcode:undefined}/>:<>
        <section className="panel outbound-completed-task"><div className="panel-header"><div><h2>{selectedStage?.code==="overseas_transit"?"境外运输进行中":selectedStage?.code==="overseas_arrived"?"货物已到境外":"出库交接已完成"}</h2><p>{selectedStage?.code==="overseas_transit"?"实际出境已经确认，订单当前处于境外运输中。":selectedStage?.code==="overseas_arrived"?"境外运输节点已经完成，等待或正在办理境外仓作业。":"装车模块已经推进完成，当前进入“已装车待出境”；实际出境确认后才进入境外运输中。"}</p></div><span className="status-pill success">{selectedStage?.label}</span></div>{selectedStage?.code==="handover_done"?<div className="outbound-next-node-action"><div><strong>下一节点：实际出境确认</strong><span>{isConsolidatedOutboundTask(selectedTask.business_type,selectedTask.transport_batch_id)?"拼车按 PZ 配载单统一确认出境并同步全部订单。":selectedTask.outbound_resource_confirmed?"整车车辆与司机已经由仓库确认并同步管理端，后续直接在订单的报关及出境运输节点办理。":"该历史整车任务未经过新版仓库资源确认；请在管理端核实车辆后，直接在订单的报关及出境运输节点办理。"}</span></div>{isConsolidatedOutboundTask(selectedTask.business_type,selectedTask.transport_batch_id)?<Link className="primary warehouse-primary" to={`/admin/loading/${selectedTask.transport_batch_id}?tab=outbound`}>进入 PZ 配载单确认实际出境</Link>:<span className="status-pill success">整车无需进入配载页</span>}</div>:<div className="outbound-next-node-action"><div><strong>{selectedStage?.next}</strong><span>当前节点状态已同步到管理端。</span></div>{isConsolidatedOutboundTask(selectedTask.business_type,selectedTask.transport_batch_id)&&<Link className="secondary" to={`/admin/loading/${selectedTask.transport_batch_id}`}>查看 PZ 配载单</Link>}</div>}</section>
        <section className="panel handover-section"><div className="panel-header no-print"><div><h2>仓库装车出库交接单</h2><p>本交接单记录仓库装车结果，不等同于车辆已实际出境。</p></div><button className="secondary" type="button" onClick={()=>window.print()}>打印交接单</button></div><Handover warehouseId={loaderData.warehouse.id} task={selectedTask} items={loaderData.items.filter(x=>x.dispatch_id===selectedTask.id)} manifest={loaderData.manifestsByOrder[selectedTask.order_id]}/></section>
      </>}
    </section>:<>
      <section className="panel outbound-execution-summary"><div className="table-wrap"><table><thead><tr><th>全部任务</th><th>待扫码 / 装车中</th><th>待出库交接</th><th>已完成出库交接</th><th>下一业务节点</th></tr></thead><tbody><tr><td>{loaderData.dispatches.length} 个</td><td>{loading.filter(task=>task.loaded_count<task.item_count).length} 个</td><td>{loading.filter(task=>task.item_count>0&&task.loaded_count===task.item_count).length} 个</td><td>{completed.length} 个</td><td>实际出境确认 → 境外运输中</td></tr></tbody></table></div></section>
      <section className="panel outbound-task-center"><div className="panel-header"><div><h2>装车出库任务</h2><p>拼车以 PZ 配载单为一个任务统一累计扫码进度；整车仍按订单独立办理。</p></div><span>{loaderData.dispatches.length} 个任务</span></div><div className="table-wrap"><table><thead><tr><th>装车任务</th><th>订单 / PZ 配载单</th><th>当前节点</th><th>装车进度</th><th>车辆 / 司机</th><th>目的地</th><th>创建 / 交接时间</th><th>操作</th></tr></thead><tbody>{executionTasks.map(task=>{const stage=dispatchTaskStage(task),subject=dispatchTaskSubject(task);return <tr key={task.id} className={stage.code==="handover_ready"?"task-attention":""}><td><strong>{task.dispatch_number}</strong><small>{subject.typeLabel}</small></td><td><strong>{subject.primary}</strong><small title={subject.secondary}>{subject.secondary}</small></td><td><span className={`status-pill ${stage.tone}`}>{stage.label}</span><small>{stage.next}</small></td><td><strong>{task.loaded_count}/{task.item_count}</strong><small>{task.item_count?`${Math.round(task.loaded_count/task.item_count*100)}%`:"无货物"}</small></td><td>{task.vehicle_plate}<small>{task.driver_name}</small></td><td>{task.destination}</td><td>{new Date(task.dispatched_at||task.created_at).toLocaleString("zh-CN",{hour12:false})}</td><td><Link className={stage.code==="handover_ready"?"primary warehouse-primary":"secondary"} to={executionTaskHref(loaderData.executionHref,task.id)}>{stage.action}</Link></td></tr>})}{!loaderData.dispatches.length&&<tr><td colSpan={8} className="empty-state">暂无装车出库任务，请先从“在仓待装”选择订单创建。</td></tr>}</tbody></table></div></section>
    </>}
  </>;
}

function executionTaskHref(executionHref:string,dispatchId:string){return`${executionHref}${executionHref.includes("?")?"&":"?"}dispatchId=${encodeURIComponent(dispatchId)}`;}
function createLoadUnitHref(pendingHref:string,batchId:string){const [path,query=""]=pendingHref.split("?"),params=new URLSearchParams(query);params.set("view","create");params.set("batchId",batchId);return`${path}?${params.toString()}`;}
function clearOutboundFiltersHref(pendingHref:string){const [path,query=""]=pendingHref.split("?"),params=new URLSearchParams(query);params.delete("q");params.delete("type");params.delete("readiness");params.set("view","pending");return`${path}?${params.toString()}`;}
function formatWarehouseTime(value:string|null){return value?new Date(value).toLocaleString("zh-CN",{hour12:false}):"入仓时间待补";}
function dispatchTaskSubject(task:Dispatch){const isBatch=isConsolidatedOutboundTask(task.business_type,task.transport_batch_id);const orderNumbers=task.order_numbers||task.order_number,customerNames=task.customer_names||task.customer_name;return isBatch?{primary:task.batch_number,secondary:`${orderNumbers} · ${customerNames}`,typeLabel:`PZ 配载单 · ${orderNumbers.split(",").filter(Boolean).length} 票订单`}:{primary:task.order_number,secondary:task.customer_name,typeLabel:"整车订单"};}
function dispatchTaskPriority(task:Dispatch){const code=dispatchTaskStage(task).code;return code==="handover_ready"?0:code==="loading"?1:code==="waiting_scan"?2:code==="handover_done"?3:4;}
function dispatchTaskStage(task:Dispatch,scanPolicy?:WarehouseOutboundWorkflowPolicy["scanConfirmation"]){
  if(["overseas_arrived","waiting_pickup","pickup_completed"].includes(task.road_status||""))return{code:"overseas_arrived",label:"已到境外",next:"等待境外仓办理",action:"查看任务",tone:"success"};
  if(task.road_status==="outbound_in_transit"||task.actual_departure_at)return{code:"overseas_transit",label:"境外运输中",next:"下一节点：到达境外仓",action:"查看任务",tone:"success"};
  if(task.status==="dispatched")return{code:"handover_done",label:"出库交接完成",next:"下一节点：实际出境确认",action:"查看交接与下一节点",tone:"success"};
  if(scanPolicy&&!scanPolicy.isRequired)return{code:"handover_ready",label:"待出库交接",next:scanPolicy.mode==="hidden"?"逐件扫码已隐藏":"逐件扫码为选填",action:"办理出库交接",tone:"warning"};
  if(task.item_count>0&&task.loaded_count===task.item_count)return{code:"handover_ready",label:"待出库交接",next:"货物已全部扫码",action:"办理出库交接",tone:"warning"};
  if(task.loaded_count>0)return{code:"loading",label:"装车中",next:`还需扫描 ${Math.max(0,task.item_count-task.loaded_count)} 个货号`,action:"继续扫码装车",tone:""};
  return{code:"waiting_scan",label:"待扫码装车",next:`共 ${task.item_count} 个货号`,action:"装车出库",tone:"off"};
}
function DispatchNodeStrip({task,scanPolicy}:{task:Dispatch;scanPolicy?:WarehouseOutboundWorkflowPolicy["scanConfirmation"]}){
  const loaded=task.item_count>0&&task.loaded_count===task.item_count,scanGateSatisfied=!scanPolicy?.isRequired||loaded,handedOver=task.status==="dispatched",inTransit=task.road_status==="outbound_in_transit"||Boolean(task.actual_departure_at),arrived=["overseas_arrived","waiting_pickup","pickup_completed"].includes(task.road_status||"");
  const nodes=[
    {label:"任务已创建",hint:task.dispatch_number,state:"complete"},
    {label:scanPolicy?.mode==="hidden"?"逐件扫码（已隐藏）":"扫码装车",hint:scanPolicy?.mode==="hidden"?"工作流不显示扫码区":loaded?`${task.loaded_count}/${task.item_count} 已完成`:scanPolicy?.mode==="optional"?`${task.loaded_count}/${task.item_count} 已扫描（选填）`:`${task.loaded_count}/${task.item_count} 已扫描`,state:scanGateSatisfied?"complete":task.status==="loading"?"current":"complete"},
    {label:"出库交接",hint:handedOver?"仓库交接已完成":scanGateSatisfied?"当前待办理":"完成必填扫码后开放",state:handedOver?"complete":scanGateSatisfied?"current":"upcoming"},
    {label:"境外运输",hint:arrived?"已到达境外":inTransit?"运输进行中":handedOver?"待实际出境确认":"完成交接后进入",state:arrived?"complete":inTransit?"current":"upcoming"},
  ];
  return <section className="outbound-node-table" aria-label="装车出库任务节点"><div className="table-wrap"><table><thead><tr>{nodes.map((node,index)=><th key={node.label}>{index+1}. {node.label}</th>)}</tr></thead><tbody><tr>{nodes.map(node=><td key={node.label} className={node.state}><span className={`status-pill ${node.state==="complete"?"success":node.state==="current"?"":"off"}`}>{node.state==="complete"?"已完成":node.state==="current"?"当前节点":"未开始"}</span><small>{node.hint}</small></td>)}</tr></tbody></table></div></section>;
}

function CreateDispatchWorkbench({warehouseId,inspection,outboundResources,busy,actionSuccess,actionError,uploadOpenSignal}:{warehouseId:string;inspection:OutboundInspection|null;outboundResources:OutboundResources;busy:boolean;actionSuccess?:string;actionError?:string;uploadOpenSignal?:unknown}){
  const [reviewOpenSignal,setReviewOpenSignal]=useState<number>();
  const [carrierId,setCarrierId]=useState("");
  const [vehicleId,setVehicleId]=useState("");
  const [driverId,setDriverId]=useState("");
  const [resourceDifferenceAcknowledged,setResourceDifferenceAcknowledged]=useState(false);
  const isFtl=inspection?.batch.business_type==="ftl";
  const taskLabel=isFtl?inspection?.batch.order_number:inspection?.batch.batch_number;
  const uploadedCount=inspection?.documents.filter(document=>document.required&&document.attachmentId).length??0;
  const requiredCount=inspection?.documents.filter(document=>document.required).length??0;
  const carrierVehicles=outboundResources.vehicles.filter(vehicle=>vehicle.carrier_id===carrierId);
  const carrierDrivers=outboundResources.drivers.filter(driver=>driver.carrier_id===carrierId);
  const outboundMasterDataReady=outboundResources.carriers.length>0&&outboundResources.vehicles.length>0&&outboundResources.drivers.length>0;
  return <div className="outbound-create-workbench">
    {!inspection&&<div className="alert error" role="alert">无法读取该订单的装车文件清单，请返回在仓订单列表重新进入。</div>}
    {(actionSuccess||actionError)&&<div className={`alert ${actionError?"error":"success"}`} role={actionError?"alert":"status"} aria-live="polite">{actionError??actionSuccess}</div>}
    {inspection&&<>
      <div className="outbound-inspection-summary">
        <span>{isFtl?"订单":"PZ 配载单"}<strong>{taskLabel}</strong></span>
        <span>{isFtl?"客户":"批次范围"}<strong>{isFtl?inspection.batch.customer_name:`${inspection.documentGroups.length} 票订单 · ${new Set(inspection.documentGroups.map(group=>group.customerName)).size} 个客户`}</strong></span>
        <span>运输类型<strong>{isFtl?"整车":"拼车"}</strong></span>
        <span>文件进度<strong>{uploadedCount}/{requiredCount} 已上传</strong></span>
      </div>
      <div className="outbound-create-entry-actions">
        <Modal title={`上传装车任务文件 · ${taskLabel}`} triggerLabel="继续上传文件" triggerClassName="primary warehouse-primary" size="xwide" openSignal={uploadOpenSignal}>
          {({close})=><div className="outbound-upload-modal">
            <div className="outbound-upload-modal-intro"><strong>创建任务前补齐仍缺失的必需文件</strong><span>系统会沿用“配载文件”中的现有版本；这里只补缺或纠正文件。报关单/预录报关单可选，正式海关放行仍在后续报关作业登记。</span></div>
            {inspection.documentGroups.map(group=><section className="outbound-upload-order" key={group.orderId}>
              <header><strong>{group.orderNumber} · {group.customerName}</strong><span>{group.documents.filter(document=>document.attachmentId).length}/{group.documents.length} 已上传</span></header>
              <div className="table-wrap outbound-document-table"><table><thead><tr><th>文件类型</th><th>当前状态</th><th>文件名</th><th>选择文件即上传</th></tr></thead><tbody>{group.documents.map(document=><tr className={document.attachmentId?"completed-row":""} key={`${document.orderId}:${document.code}`}>
                <td><strong>{document.name}</strong></td><td><span className="status-pill">{outboundDocumentStatus(document)}</span></td><td title={document.fileName??undefined}>{document.fileName||"尚未上传"}</td>
                <td><Form method="post" encType="multipart/form-data" className="outbound-document-upload-form">
                  <input type="hidden" name="intent" value="loading_document_upload"/><input type="hidden" name="inspectionOrderId" value={inspection.batch.order_id}/><input type="hidden" name="orderId" value={document.orderId}/><input type="hidden" name="batchId" value={inspection.batch.id}/><input type="hidden" name="documentCategory" value={document.code}/>
                  <label className="document-upload-button"><input className="document-upload-input" name="attachment" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required disabled={busy} onChange={(event)=>submitForm(event.currentTarget.form)}/><span>{document.attachmentId?"选择替换文件":"选择文件"}</span></label>
                </Form></td>
              </tr>)}</tbody></table></div>
            </section>)}
            <div className="outbound-upload-modal-actions"><span>{inspection.allUploaded?"必需文件已收齐，可以进入总览确认。":`还需上传 ${Math.max(0,requiredCount-uploadedCount)} 份必需文件。`}</span><button type="button" className="primary warehouse-primary" disabled={!inspection.allUploaded||busy} onClick={()=>{close();setReviewOpenSignal(Date.now());}}>完成上传</button></div>
          </div>}
        </Modal>
      </div>
      {inspection.allUploaded&&<Modal title={`文件总览 · ${taskLabel}`} triggerLabel="查看文件总览" triggerClassName="secondary" size="xwide" openSignal={reviewOpenSignal}>
        <Form method="post" className="outbound-review-create-form" onKeyDown={event=>{if(event.key==="Enter")event.preventDefault();}}>
          <input type="hidden" name="intent" value="create"/><input type="hidden" name="batchId" value={inspection.batch.id}/><input type="hidden" name="orderNumber" value={isFtl?inspection.batch.order_number:""}/><input type="hidden" name="customerIdentityCode" value={isFtl?inspection.batch.customer_identity_code:""}/>
          <div className="outbound-document-review-grid">{inspection.documents.filter(document=>document.attachmentId).map(document=><OutboundDocumentPreview key={`${document.orderId}:${document.code}`} warehouseId={warehouseId} document={document}/>)}</div>
          {isFtl&&<section className="ftl-outbound-resource-confirmation">
            <header><div><strong>仓库确认整车出境运输资源</strong><span>这里确认的是离开国内仓后的出境运输车辆，不会沿用国内提货车辆；创建后自动同步管理端。</span></div><span className="status-pill warning">装车前必填</span></header>
            {!outboundMasterDataReady&&<div className="alert error" role="alert">境外承运商、车辆或司机主数据不完整，暂不能创建整车装车任务。请先在管理端承运商台账补齐。</div>}
            <div className="ftl-outbound-resource-grid">
              <label className="field"><span>境外承运商 *</span><select name="outboundCarrierId" value={carrierId} required onChange={event=>{setCarrierId(event.target.value);setVehicleId("");setDriverId("");}}><option value="">请选择境外承运商</option>{outboundResources.carriers.map(carrier=><option key={carrier.id} value={carrier.id}>{carrier.name}</option>)}</select></label>
              <label className="field"><span>出境车辆 *</span><select name="outboundVehicleId" value={vehicleId} required disabled={!carrierId} onChange={event=>setVehicleId(event.target.value)}><option value="">{carrierId?"请选择该承运商车辆":"请先选择承运商"}</option>{carrierVehicles.map(vehicle=><option key={vehicle.id} value={vehicle.id}>{vehicle.plate_number} · {vehicle.vehicle_type||"车型未登记"}</option>)}</select></label>
              <label className="field"><span>出境司机 *</span><select name="outboundDriverId" value={driverId} required disabled={!carrierId} onChange={event=>setDriverId(event.target.value)}><option value="">{carrierId?"请选择该承运商司机":"请先选择承运商"}</option>{carrierDrivers.map(driver=><option key={driver.id} value={driver.id}>{driver.name} · {driver.phone||"电话未登记"}</option>)}</select></label>
              <label className="field"><span>计划出境发车时间 *</span><input type="datetime-local" name="plannedDepartureAt" required/></label>
            </div>
          </section>}
          {!isFtl&&inspection.resourcePolicyError&&<div className="alert error" role="alert">{inspection.resourcePolicyError}</div>}
          {!isFtl&&inspection.resourceDifferences.length>0&&<div className="alert warning" role="status"><strong>非必填运输信息未登记：</strong>{inspection.resourceDifferences.map(item=>`${item.label}（${item.mode==="hidden"?"工作流已隐藏":"选填"}）`).join("、")}。可以继续创建装车任务，但系统会记录本次差异与确认人。</div>}
          {inspection.notesActive&&<label className="field outbound-handover-notes"><span>交接备注{inspection.notesRequired?" *":""}</span><textarea name="notes" rows={3} required={inspection.notesRequired} placeholder="填写装车交接、装载要求或出库注意事项"/></label>}
          {resourceDifferenceAcknowledged&&<input type="hidden" name="resourceDifferenceConfirmed" value="yes"/>}
          <div className="outbound-review-confirm"><p>{isFtl?"确认文件与出境车辆信息后，系统创建整车装车任务，并把承运商、车辆、司机和计划时间同步到管理端。":inspection.resourceDifferences.length&&!resourceDifferenceAcknowledged?"请先明确确认非必填运输信息为空；确认后还需再次点击最终创建按钮。":"确认文件清晰、归属正确后，系统按 PZ 配载单创建装车任务。"}</p>{!isFtl&&inspection.resourceDifferences.length>0&&!resourceDifferenceAcknowledged?<button type="button" className="secondary" disabled={busy||Boolean(inspection.resourcePolicyError)} onClick={()=>setResourceDifferenceAcknowledged(true)}>我已核对缺失信息，继续</button>:<button type="submit" className="primary warehouse-primary" disabled={busy||(isFtl&&!outboundMasterDataReady)||Boolean(inspection.resourcePolicyError)}>确认无误并创建装车任务</button>}</div>
        </Form>
      </Modal>}
    </>}
  </div>;
}

function OutboundDocumentPreview({document,warehouseId}:{document:OutboundDocument;warehouseId:string}){
  const isImage=document.contentType?.startsWith("image/")??false,isPdf=document.contentType==="application/pdf";
  const fileHref=document.attachmentId?warehouseOrderDocumentHref(document.attachmentId,warehouseId):"";
  return <article className="outbound-document-preview"><header><div><strong>{document.orderNumber} · {document.name}</strong><span>{document.customerName} · {document.fileName} · {formatBytes(document.sizeBytes)}</span></div><span className="status-pill">{outboundDocumentStatus(document)}</span></header><div className={`outbound-document-canvas ${!isImage&&!isPdf?"unsupported":""}`}>{isImage&&fileHref&&<img loading="lazy" src={fileHref} alt={document.fileName||document.name}/>} {isPdf&&fileHref&&<object data={fileHref} type="application/pdf" aria-label={document.fileName||document.name}><p>当前浏览器无法页内预览 PDF。</p></object>} {!isImage&&!isPdf&&<p>该格式不支持页内预览，请打开原文件检查。</p>}</div>{fileHref&&<a className="secondary" href={fileHref} target="_blank" rel="noreferrer">打开原文件</a>}</article>;
}

function outboundDocumentStatus(document:OutboundDocument){if(!document.attachmentId)return document.required?"待上传":"选填";if(["approved","archived"].includes(document.reviewStatus||""))return"已确认";if(document.reviewStatus==="rejected")return"已退回";return"待检查";}
function formatBytes(value:number|null){if(!value)return"—";return value>=1024*1024?`${(value/1024/1024).toFixed(2)} MB`:`${(value/1024).toFixed(1)} KB`;}
function packageTypeLabel(value:string|null){return({carton:"纸箱",pallet:"托盘",wooden_case:"木箱",bag:"袋装",drum:"桶装",bundle:"捆装",other:"其他",mixed:"混合包装"} as Record<string,string>)[value||"other"]||value||"其他";}
function cargoDimensions(item:Item){return item.length_cm!==null&&item.width_cm!==null&&item.height_cm!==null?`${item.length_cm} × ${item.width_cm} × ${item.height_cm} cm`:"—";}
function cargoLoadedAt(value:string|null){return value?new Date(value).toLocaleString("zh-CN",{hour12:false}):"—";}
function DispatchCard({warehouseId,task,items,manifest,busy,workflowPolicy,resourceDifferences,resourcePolicyError,highlightedBarcode}:{warehouseId:string;task:Dispatch;items:Item[];manifest?:ManifestDoc;busy:boolean;workflowPolicy:OutboundExecutionPolicy|null;resourceDifferences:OutboundPolicyDifference[];resourcePolicyError:string|null;highlightedBarcode?:string}){
  const [resourceDifferenceAcknowledged,setResourceDifferenceAcknowledged]=useState(false);
  const allLoaded=task.item_count>0&&task.loaded_count===task.item_count;
  const scanPolicy=workflowPolicy?.scanConfirmation??resolveWarehouseOutboundWorkflowPolicy([]).scanConfirmation;
  const plannedExitPolicy=workflowPolicy?.batchFields.planned_exit_at??{isActive:true,isRequired:true,mode:"required" as const};
  const missingScanCount=Math.max(0,task.item_count-task.loaded_count);
  const canDispatch=task.item_count>0&&(!scanPolicy.isRequired||allLoaded);
  const resourceDifferenceConfirmed=!resourceDifferences.length||resourceDifferenceAcknowledged;
  const subject=dispatchTaskSubject(task);
  return <section className="panel dispatch-sheet">
    <div className="panel-header"><div><h2>{task.dispatch_number}</h2><p><strong>{subject.primary}</strong> · {subject.secondary}</p></div><div className="dispatch-progress"><strong>{task.loaded_count}/{task.item_count}</strong><span>整单已装车</span></div></div>
    <div className="table-wrap dispatch-meta-table"><table><thead><tr><th>车辆</th><th>司机</th><th>目的地</th><th>计划出境</th></tr></thead><tbody><tr><td><strong>{task.vehicle_plate}</strong></td><td>{task.driver_name}</td><td>{task.destination}</td><td>{task.planned_departure_at?new Date(task.planned_departure_at).toLocaleString("zh-CN"):"未填写"}</td></tr></tbody></table></div>
    {task.transport_batch_id&&!task.planned_departure_at&&plannedExitPolicy.isActive&&<Form method="post" className="scan-inline outbound-schedule-inline"><input type="hidden" name="intent" value="schedule"/><input type="hidden" name="dispatchId" value={task.id}/><label className="field"><span>计划出境发车时间{plannedExitPolicy.isRequired?" *":"（选填）"}</span><input type="datetime-local" name="plannedDepartureAt" required/></label><button className="primary warehouse-primary" disabled={busy}>保存计划时间</button></Form>}
    {manifest&&<div className="table-wrap dispatch-manifest-table"><table><thead><tr><th>配载单</th><th>数据来源</th></tr></thead><tbody><tr><td><a href={warehouseBatchDocumentHref(manifest.id,warehouseId)} target="_blank" rel="noreferrer">{manifest.file_name}</a></td><td>工作台自动生成，点击打开对照装车</td></tr></tbody></table></div>}
    {resourcePolicyError&&<div className="alert error" role="alert">{resourcePolicyError}</div>}
    {!resourcePolicyError&&resourceDifferences.length>0&&!resourceDifferenceAcknowledged&&<section className="outbound-handover-action ready"><div><p className="eyebrow">RESOURCE DIFFERENCE</p><h3>非必填运输信息为空</h3><p>{resourceDifferences.map(item=>`${item.label}（${item.mode==="hidden"?"已隐藏":"选填"}）`).join("、")}。确认后才开放扫码或出库，系统会记录确认人和差异。</p></div><button type="button" className="secondary" disabled={busy} onClick={()=>setResourceDifferenceAcknowledged(true)}>我已核对运输信息，继续</button></section>}
    {scanPolicy.isActive&&resourceDifferenceConfirmed&&!resourcePolicyError&&<Form key={task.loaded_count} method="post" className="scan-inline outbound-loading-scan"><input type="hidden" name="intent" value="load"/><input type="hidden" name="dispatchId" value={task.id}/>{resourceDifferences.length>0&&<input type="hidden" name="resourceDifferenceConfirmed" value="yes"/>}<label className="field"><span>扫描货物码{scanPolicy.isRequired?" *":"（选填）"}</span><input name="barcode" placeholder="扫描或输入本任务中的货物标签条码" autoComplete="off" autoFocus required/></label><button className="primary warehouse-primary" disabled={busy||allLoaded}>确认装车</button></Form>}
    {!scanPolicy.isActive&&<div className="alert warning" role="status">当前工作流已隐藏逐件扫码。系统不会以扫描数量阻断出库，但会在出库审计中记录全部未扫描差异。</div>}
    <section className="dispatch-cargo-list"><header><div><h3>订单货物列表</h3><p>{scanPolicy.isActive?"扫描成功后，对应货物状态会由“待装车”更新为“已装车”。":"逐件扫码已隐藏，货物清单仍完整保留用于交接与审计。"}</p></div><span>{task.loaded_count}/{task.item_count} 已扫描</span></header><div className="table-wrap"><table><thead><tr><th>状态</th><th>货物名称</th><th>标签号 / 条码</th><th>订单</th><th>包装 / 件数</th><th>重量 KG</th><th>体积 CBM</th><th>长 × 宽 × 高</th><th>装车时间</th></tr></thead><tbody aria-live="polite">{items.map(item=><tr key={item.id} className={item.barcode===highlightedBarcode?"current-scan":""}><td><span className={`status-pill ${item.status!=="loaded"?"off":"success"}`}>{item.status==="loaded"?"已扫描":"未扫描"}</span></td><td><strong>{item.cargo_name_cn||"未关联货物明细"}</strong></td><td><strong>{item.package_number}</strong><small>{item.barcode}</small></td><td>{item.order_number}</td><td>{packageTypeLabel(item.package_type)} · {item.pieces} 件</td><td>{item.weight_kg?.toFixed(3)??"—"}</td><td>{item.volume_cbm?.toFixed(4)??"—"}</td><td>{cargoDimensions(item)}</td><td>{cargoLoadedAt(item.loaded_at)}</td></tr>)}</tbody></table></div></section>
    {canDispatch&&resourceDifferenceConfirmed&&!resourcePolicyError&&<DispatchConfirmation task={task} busy={busy} scanPolicy={scanPolicy} missingScanCount={missingScanCount} resourceDifferenceConfirmed={resourceDifferences.length>0}/>}
  </section>;
}

function DispatchConfirmation({task,busy,scanPolicy,missingScanCount,resourceDifferenceConfirmed}:{task:Dispatch;busy:boolean;scanPolicy:WarehouseOutboundWorkflowPolicy["scanConfirmation"];missingScanCount:number;resourceDifferenceConfirmed:boolean}){
  const [differenceAcknowledged,setDifferenceAcknowledged]=useState(false);
  const hasDifference=missingScanCount>0;
  if(hasDifference&&!differenceAcknowledged)return <section className="outbound-handover-action ready" id="outbound-handover-action">
    <div><p className="eyebrow">WAREHOUSE HANDOVER</p><h3>{scanPolicy.mode==="hidden"?"逐件扫码已隐藏":"仍有货物未扫码"}</h3><p>当前有 {missingScanCount}/{task.item_count} 个货物码未扫描。确认继续后，还需再次点击最终出库按钮；差异将永久写入审计记录。</p></div>
    <button type="button" className="secondary" disabled={busy} onClick={()=>setDifferenceAcknowledged(true)}>我已核对，继续办理出库</button>
  </section>;
  return <section className="outbound-handover-action ready" id="outbound-handover-action">
    <div><p className="eyebrow">WAREHOUSE HANDOVER</p><h3>{hasDifference?"二次确认未扫码差异":"全部货物已扫码"}</h3><p>{hasDifference?`将按当前工作流${scanPolicy.mode==="hidden"?"隐藏":"选填"}策略出库，并审计 ${missingScanCount} 个未扫描货物码。`:"确认后将出库结果、交接数据和操作记录同步到管理端，并打开交接单打印窗口。"}</p></div>
    <Form method="post" className="dispatch-confirm" onKeyDown={event=>{if(event.key==="Enter")event.preventDefault();}}><input type="hidden" name="intent" value="dispatch"/><input type="hidden" name="dispatchId" value={task.id}/>{hasDifference&&<input type="hidden" name="scanDifferenceConfirmed" value="yes"/>}{resourceDifferenceConfirmed&&<input type="hidden" name="resourceDifferenceConfirmed" value="yes"/>}<button type="submit" className="primary warehouse-primary" disabled={busy}>{hasDifference?"确认差异并出库":"确认出库并打印交接单"}</button></Form>
  </section>;
}
function Handover({warehouseId,task,items,manifest}:{warehouseId:string;task:Dispatch;items:Item[];manifest?:ManifestDoc}){const subject=dispatchTaskSubject(task),isBatch=isConsolidatedOutboundTask(task.business_type,task.transport_batch_id);return <article className="handover-sheet"><header><div><strong>欧凌国际物流</strong><h2>仓库装车交接单</h2></div><b>{task.dispatch_number}</b></header>{manifest&&<p className="handover-manifest-link no-print">配载单：<a href={warehouseBatchDocumentHref(manifest.id,warehouseId)} target="_blank" rel="noreferrer">{manifest.file_name}</a>（点击打开核对装载顺序）</p>}<div className="handover-grid"><span>{isBatch?"PZ 配载单":"订单"}：<strong>{subject.primary}</strong></span><span>订单范围：<strong>{task.order_numbers||task.order_number}</strong></span><span>客户范围：<strong>{task.customer_names||task.customer_name}</strong></span><span>目的地：<strong>{task.destination}</strong></span><span>车牌：<strong>{task.vehicle_plate}</strong></span><span>司机：<strong>{task.driver_name}</strong></span><span>电话：<strong>{task.driver_phone||"—"}</strong></span><span>承运商：<strong>{task.carrier_name||"—"}</strong></span><span>发车时间：<strong>{task.dispatched_at?new Date(task.dispatched_at).toLocaleString("zh-CN"):"—"}</strong></span><span className="wide">交接备注：<strong>{task.notes||"—"}</strong></span></div><table><thead><tr><th>序号</th><th>订单</th><th>货物条码</th><th>件数</th><th>重量 KG</th><th>体积 CBM</th></tr></thead><tbody>{items.map((item,index)=><tr key={item.id}><td>{index+1}</td><td>{item.order_number}</td><td><strong className="handover-cargo-barcode">{item.barcode}</strong></td><td>{item.pieces}</td><td>{item.weight_kg??"—"}</td><td>{item.volume_cbm??"—"}</td></tr>)}</tbody><tfoot><tr><td colSpan={3}>合计</td><td>{task.pieces}</td><td>{task.weight_kg}</td><td>{task.volume_cbm}</td></tr></tfoot></table><footer><span>仓库交接人签字：________________</span><span>司机签字：________________</span><span>交接时间：________________</span></footer></article>}

function warehouseOrderDocumentHref(attachmentId:string,warehouseId:string){return `/warehouse/document-files/order/${attachmentId}?warehouseId=${encodeURIComponent(warehouseId)}&mode=view`;}
function warehouseBatchDocumentHref(fileId:string,warehouseId:string){return `/warehouse/document-files/batch/${fileId}?warehouseId=${encodeURIComponent(warehouseId)}&mode=view`;}
type WarehouseOrderBlocker = { orderId: string; orderNumber: string; reasons: string[] };
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
          EXISTS(SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=o.organization_id AND s.order_id=o.id AND r.warehouse_id=? AND r.status='completed' AND r.cargo_complete=1) cargo_ready,
          (SELECT COUNT(*) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status!='dispatched') package_count,
          (SELECT COUNT(DISTINCT p.id) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id JOIN warehouse_sorting_items si ON si.package_id=p.id AND si.status='verified' JOIN warehouse_sorting_batches sb ON sb.id=si.batch_id AND sb.status='verified' WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status!='dispatched') verified_package_count
        FROM transport_orders o WHERE o.organization_id=? AND o.id=?`)
        .bind(warehouseId,warehouseId,warehouseId,organizationId,order.order_id)
        .first<{cargo_ready:number;package_count:number;verified_package_count:number}>(),
    ]);
    const reasons=[...loadPlan.reasons];
    if(!warehouseState?.cargo_ready)reasons.push("未在当前仓库完成实收并确认‘货齐’");
    if(!warehouseState?.package_count)reasons.push("当前仓库没有可装车货号");
    else if((warehouseState.verified_package_count??0)!==warehouseState.package_count)
      reasons.push(`货号核验不完整（已核验 ${warehouseState.verified_package_count??0}/${warehouseState.package_count}）`);
    results.push({orderId:order.order_id,orderNumber:order.order_number,reasons:[...new Set(reasons)]});
  }
  return results;
}
async function checkBatchWarehouseReadiness(organizationId:string,warehouseId:string,batchId:string,vehiclePlate?:string){
  const [batch,orders]=await Promise.all([
    env.DB.prepare("SELECT batch_number FROM transport_batches WHERE id=? AND organization_id=?").bind(batchId,organizationId).first<{batch_number:string}>(),
    env.DB.prepare(`SELECT bo.order_id,o.order_number FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(organizationId,batchId).all<{order_id:string;order_number:string}>(),
  ]);
  return{batchNumber:batch?.batch_number||batchId,orders:await checkWarehouseOrders(organizationId,warehouseId,orders.results,vehiclePlate,batchId)};
}
function formatOrderBlockers(items:WarehouseOrderBlocker[]){
  return items.map(item=>`${item.orderNumber}：${item.reasons.join("、")}`).join("；");
}
async function findAvailableOutboundBatches(organizationId:string,warehouseId:string,input:{batchId?:string;orderNumber?:string;customerIdentityCode?:string}){
  const baseSql=`SELECT b.id,b.batch_number,b.shipment_id,s.shipment_number,o.id order_id,o.order_number,o.customer_id,c.name customer_name,c.identity_code customer_identity_code,o.business_type,o.exit_port,TRIM(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city||CASE WHEN NULLIF(TRIM(o.destination_address),'') IS NOT NULL THEN ' '||o.destination_address ELSE '' END) destination_location,COUNT(i.id) item_count,
      (SELECT tb.id FROM transport_batch_orders bo JOIN transport_batches tb ON tb.id=bo.batch_id AND tb.organization_id=bo.organization_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND tb.batch_number LIKE 'PZ-%' AND tb.status IN ('planning','loading') ORDER BY tb.updated_at DESC LIMIT 1) transport_batch_id,
      (SELECT tb.batch_number FROM transport_batch_orders bo JOIN transport_batches tb ON tb.id=bo.batch_id AND tb.organization_id=bo.organization_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND tb.batch_number LIKE 'PZ-%' AND tb.status IN ('planning','loading') ORDER BY tb.updated_at DESC LIMIT 1) transport_batch_number
    FROM warehouse_sorting_batches b
    JOIN shipments s ON s.id=b.shipment_id
    JOIN transport_orders o ON o.id=s.order_id
    JOIN customers c ON c.id=s.customer_id
    JOIN warehouse_sorting_items i ON i.batch_id=b.id
    JOIN warehouse_packages p ON p.id=i.package_id AND p.warehouse_id=?
    WHERE b.organization_id=? AND b.status='verified'
      AND NOT EXISTS(SELECT 1 FROM warehouse_sorting_items xi JOIN warehouse_dispatch_items xdi ON xdi.package_id=xi.package_id JOIN warehouse_dispatches xd ON xd.id=xdi.dispatch_id WHERE xi.batch_id=b.id AND xd.status!='cancelled')`;
  if(input.batchId){
    const result=await env.DB.prepare(`${baseSql} AND b.id=? AND (?='' OR UPPER(c.identity_code)=UPPER(?)) GROUP BY b.id LIMIT 1`)
      .bind(warehouseId,organizationId,input.batchId,input.customerIdentityCode||"",input.customerIdentityCode||"").all<Batch>();
    return result.results;
  }
  if(input.orderNumber){
    const result=await env.DB.prepare(`${baseSql} AND UPPER(o.order_number)=UPPER(?) AND (?='' OR UPPER(c.identity_code)=UPPER(?)) GROUP BY b.id ORDER BY b.verified_at DESC LIMIT 2`)
      .bind(warehouseId,organizationId,input.orderNumber,input.customerIdentityCode||"",input.customerIdentityCode||"").all<Batch>();
    return result.results;
  }
  return[];
}
async function findExistingDispatch(organizationId:string,warehouseId:string,orderNumber:string){
  return env.DB.prepare(`SELECT d.dispatch_number,d.status FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id JOIN transport_orders o ON o.id=s.order_id WHERE d.organization_id=? AND p.warehouse_id=? AND UPPER(o.order_number)=UPPER(?) AND d.status!='cancelled' ORDER BY d.created_at DESC LIMIT 1`)
    .bind(organizationId,warehouseId,orderNumber).first<{dispatch_number:string;status:string}>();
}
async function loadDispatchWorkflowPolicy(organizationId:string,dispatchId:string):Promise<OutboundExecutionPolicy>{
  const orders=await env.DB.prepare(`SELECT DISTINCT s.order_id
    FROM warehouse_dispatch_items di
    JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
    JOIN shipments s ON s.id=p.shipment_id
    WHERE di.organization_id=? AND di.dispatch_id=?
    ORDER BY s.order_id`).bind(organizationId,dispatchId).all<{order_id:string}>();
  const workflowOrders=await loadLoadingBatchWorkflowOrders(organizationId,orders.results.map(order=>order.order_id));
  const applicableFields=workflowOrders.filter(order=>order.appliesToCurrentOrFuture).map(order=>order.fields);
  const batchFields=resolveLoadingBatchFieldPolicies(workflowOrders);
  return{
    ...resolveWarehouseOutboundWorkflowPolicy(applicableFields),
    batchFields,
    resources:loadingBatchResourcePolicy(batchFields),
  };
}
async function loadOutboundInspectionByIds(organizationId:string,warehouseId:string,orderId:string,batchId:string){
  const matches=await findAvailableOutboundBatches(organizationId,warehouseId,{batchId});
  const batch=matches.find(item=>item.order_id===orderId);
  return batch?loadOutboundInspection(organizationId,warehouseId,batch):null;
}
async function loadOutboundInspection(organizationId:string,warehouseId:string,batch:Batch):Promise<OutboundInspection>{
  const scopeOrders=batch.business_type==="ltl"
    ?await env.DB.prepare(`SELECT DISTINCT o.id order_id,o.order_number,o.customer_id,c.name customer_name
      FROM transport_batch_orders selected
      JOIN transport_batches tb ON tb.id=selected.batch_id AND tb.organization_id=selected.organization_id AND tb.status IN ('planning','loading')
      JOIN transport_batch_orders bo ON bo.batch_id=selected.batch_id AND bo.organization_id=selected.organization_id AND bo.status!='removed'
      JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
      JOIN customers c ON c.id=o.customer_id
      WHERE selected.organization_id=? AND selected.order_id=? AND selected.status!='removed'
        AND (? IS NULL OR selected.batch_id=?)
      ORDER BY bo.sequence_no`).bind(organizationId,batch.order_id,batch.transport_batch_id,batch.transport_batch_id).all<{order_id:string;order_number:string;customer_id:string;customer_name:string}>()
    :{results:[{order_id:batch.order_id,order_number:batch.order_number,customer_id:batch.customer_id,customer_name:batch.customer_name}]};
  const orderRows=scopeOrders.results.length?scopeOrders.results:[{order_id:batch.order_id,order_number:batch.order_number,customer_id:batch.customer_id,customer_name:batch.customer_name}];
  type DocumentRow={order_id:string;attachment_id:string;document_category:LoadingDocumentCode;file_name:string;content_type:string;size_bytes:number;review_status:string;created_at:string};
  const documentRows:DocumentRow[]=[];
  const documentRowsPromise=(async()=>{
    for(const orderChunk of chunkD1Values(orderRows,1+LOADING_DOCUMENTS.length)){
      const result=await env.DB.prepare(`WITH ranked AS (
      SELECT m.order_id,m.attachment_id,m.document_category,a.file_name,a.content_type,a.size_bytes,m.review_status,a.created_at,
        ROW_NUMBER() OVER(PARTITION BY m.order_id,m.document_category ORDER BY a.created_at DESC,a.id DESC) row_no
      FROM order_document_metadata m JOIN order_attachments a ON a.id=m.attachment_id
      WHERE m.organization_id=? AND m.order_id IN (${d1Placeholders(orderChunk.length)}) AND m.document_category IN (${LOADING_DOCUMENT_PLACEHOLDERS})
      ) SELECT order_id,attachment_id,document_category,file_name,content_type,size_bytes,review_status,created_at
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
    const documents=(requirements?.documents??[]).filter(type=>type.isActive).map(type=>{
      const row=latestByOrderCode.get(`${order.order_id}:${type.code}`);
      const required=type.isRequired;
      return{orderId:order.order_id,orderNumber:order.order_number,customerId:order.customer_id,customerName:order.customer_name,required,attachmentId:row?.attachment_id??null,code:type.code,name:type.name,fileName:row?.file_name??null,contentType:row?.content_type??null,sizeBytes:row?.size_bytes??null,reviewStatus:row?.review_status??null};
    });
    return{orderId:order.order_id,orderNumber:order.order_number,customerId:order.customer_id,customerName:order.customer_name,documents,allUploaded:documents.filter(document=>document.required).every(document=>Boolean(document.attachmentId)),allApproved:documents.filter(document=>document.required).every(document=>["approved","archived"].includes(document.reviewStatus||""))};
  });
  const documents=documentGroups.flatMap(group=>group.documents);
  const applicableFields=workflowOrders.filter(order=>order.appliesToCurrentOrFuture).map(order=>order.fields);
  const workflowPolicy=resolveWarehouseOutboundWorkflowPolicy(applicableFields);
  const batchFields=resolveLoadingBatchFieldPolicies(workflowOrders);
  const executionPolicy={...workflowPolicy,batchFields,resources:loadingBatchResourcePolicy(batchFields)};
  let resourceDifferences:OutboundPolicyDifference[]=[],resourcePolicyError:string|null=null;
  if(batch.business_type==="ltl"){
    const plan=await resolveDispatchPlan(organizationId,batch.order_id,batch.business_type,batch.transport_batch_id,batchFields);
    if("error" in plan)resourcePolicyError=plan.error;
    else resourceDifferences=dispatchPlanPolicyIssues(batchFields,plan).differences;
  }
  const inspectionBatch={...batch,batch_number:batch.transport_batch_number||batch.batch_number,related_order_ids:documentGroups.map(group=>group.orderId).join(","),order_count:documentGroups.length,order_numbers:documentGroups.map(group=>group.orderNumber).join("、"),customer_names:[...new Set(documentGroups.map(group=>group.customerName))].join("、"),customer_identity_codes:batch.customer_identity_code};
  return{batch:inspectionBatch,documentGroups,documents,allUploaded:documentGroups.every(group=>group.allUploaded),allApproved:documentGroups.every(group=>group.allApproved),notesActive:workflowPolicy.handoverNotes.isActive,notesRequired:workflowPolicy.handoverNotes.isRequired,scanActive:workflowPolicy.scanConfirmation.isActive,scanRequired:workflowPolicy.scanConfirmation.isRequired,executionPolicy,resourceDifferences,resourcePolicyError};
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
  const order=await env.DB.prepare(`SELECT o.id order_id,o.order_number,o.business_type,(SELECT bo.batch_id FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.status!='cancelled' AND b.batch_number LIKE 'PZ-%' WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' ORDER BY b.updated_at DESC LIMIT 1) batch_id FROM transport_orders o WHERE o.organization_id=? AND UPPER(o.order_number)=UPPER(?)`).bind(organizationId,orderNumber).first<{order_id:string;order_number:string;business_type:string;batch_id:string|null}>();
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
const dispatchPlanPolicyFields=[
  ["main_carrier_id","出境承运商","carrier_name"],
  ["main_vehicle_type","出境车型","vehicle_type"],
  ["main_plate_number","出境车牌号","vehicle_plate"],
  ["main_driver_name","出境司机姓名","driver_name"],
  ["main_driver_phone","出境司机电话","driver_phone"],
  ["planned_exit_at","计划出境发车时间","planned_departure_at"],
] as const;
function dispatchPlanPolicyIssues(policies:LoadingBatchFieldPolicies,plan:DispatchPlan){
  const requiredMissing:string[]=[],differences:OutboundPolicyDifference[]=[];
  for(const[fieldKey,label,valueKey]of dispatchPlanPolicyFields){
    if(String(plan[valueKey]??"").trim())continue;
    const policy=policies[fieldKey];
    if(policy.isRequired)requiredMissing.push(label);
    else differences.push({fieldKey,label,mode:policy.mode==="hidden"?"hidden":"optional"});
  }
  return{requiredMissing,differences};
}
async function resolveDispatchPlan(organizationId:string,orderId:string,businessType:string,transportBatchId?:string|null,policies?:LoadingBatchFieldPolicies):Promise<DispatchPlan|{error:string}>{
  if(businessType==="ltl"){
    const rows=await env.DB.prepare(`SELECT b.id batch_id,COALESCE(v.carrier_id,b.carrier_id) carrier_id,v.id vehicle_id,v.vehicle_type,v.vehicle_master_id,v.driver_master_id driver_id,v.plate_number vehicle_plate,v.driver_name,v.driver_phone,COALESCE(vc.name,bc.name) carrier_name,b.planned_departure_at
      FROM transport_batch_orders bo
      JOIN transport_batches b ON b.id=bo.batch_id AND b.status IN ('planning','loading')
      LEFT JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled'
      LEFT JOIN carriers vc ON vc.id=v.carrier_id
      LEFT JOIN carriers bc ON bc.id=b.carrier_id
      WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND (?='' OR b.id=?)
      ORDER BY v.created_at LIMIT 2`).bind(organizationId,orderId,transportBatchId||"",transportBatchId||"").all<DispatchPlan&{id:string}>();
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
async function resolveFtlDispatchPlan(organizationId:string,input:{carrierId:string;vehicleId:string;driverId:string;plannedDepartureAt:string}):Promise<DispatchPlan|{error:string}>{
  const resource=await env.DB.prepare(`SELECT NULL batch_id,c.id carrier_id,v.id vehicle_id,v.vehicle_type,d.id driver_id,v.plate_number vehicle_plate,d.name driver_name,d.phone driver_phone,c.name carrier_name,? planned_departure_at
    FROM carriers c
    JOIN carrier_vehicles v ON v.carrier_id=c.id AND v.organization_id=c.organization_id AND v.status='active'
    JOIN carrier_drivers d ON d.carrier_id=c.id AND d.organization_id=c.organization_id AND d.status='active'
    WHERE c.organization_id=? AND c.id=? AND v.id=? AND d.id=? AND c.status='active' AND c.carrier_scope='overseas'
    LIMIT 1`).bind(input.plannedDepartureAt,organizationId,input.carrierId,input.vehicleId,input.driverId).first<DispatchPlan>();
  return resource??{error:"所选境外承运商、车辆或司机已失效，或不属于同一承运商；请刷新后重新选择"};
}
export function meta(){return[{title:"在仓待装 / 装车与出库 | International TMS"}]}
