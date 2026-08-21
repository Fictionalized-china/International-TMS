import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.outbound";
import { Modal } from "../components/Modal";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { isValidCustomerIdentityCode } from "../lib/customer-identity";
import { maxInlineOrderDocumentBytes } from "../lib/order-documents";
import { checkOrderDeparture, checkOrderLoadPlan } from "../lib/order-readiness.server";
import { refreshLoadingManifest } from "../lib/loading-manifest.server";
import { recordBatchOutboundProgress, recordWarehouseProgress } from "../lib/warehouse-progress.server";
import { workflowFieldPolicy } from "../lib/workflow-field-catalog";
import {
  loadOrderModuleWorkflowFields,
  type WorkflowFieldState,
} from "../lib/workflow-fields.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";

const FTL_LOADING_DOCUMENTS=[
  {code:"commercial_invoice",name:"发票"},
  {code:"packing_list",name:"装箱单"},
  {code:"customs_document",name:"报关资料"},
] as const;
type FtlLoadingDocumentCode=(typeof FTL_LOADING_DOCUMENTS)[number]["code"];
type Batch={id:string;batch_number:string;shipment_id:string;shipment_number:string;order_id:string;order_number:string;customer_id:string;customer_name:string;customer_identity_code:string;business_type:string;destination_location:string;item_count:number};
type Dispatch={id:string;dispatch_number:string;batch_number:string;shipment_id:string;shipment_number:string;order_id:string;order_number:string;related_order_ids:string|null;customer_id:string;customer_name:string;customer_identity_code:string;vehicle_plate:string;driver_name:string;driver_phone:string|null;carrier_name:string|null;seal_number:string|null;destination:string;status:string;item_count:number;loaded_count:number;pieces:number;weight_kg:number;volume_cbm:number;created_at:string;dispatched_at:string|null;creator_name:string|null;transport_batch_id:string|null;planned_departure_at:string|null};
type Item={id:string;dispatch_id:string;order_number:string;barcode:string;package_number:string;pieces:number;weight_kg:number|null;volume_cbm:number|null;status:string;loaded_at:string|null};
type DispatchPlan={batch_id:string|null;vehicle_id:string|null;vehicle_plate:string|null;driver_name:string|null;driver_phone:string|null;carrier_name:string|null};
type ManifestDoc={order_id:string;file_name:string;data_url:string;review_status:string;created_at:string};
type OutboundDocument={attachmentId:string|null;code:FtlLoadingDocumentCode;name:string;fileName:string|null;contentType:string|null;sizeBytes:number|null;dataUrl:string|null;reviewStatus:string|null};
type OutboundInspection={batch:Batch;documents:OutboundDocument[];allUploaded:boolean;allApproved:boolean;sealActive:boolean;sealRequired:boolean;notesActive:boolean;notesRequired:boolean};

export async function loader({request}:Route.LoaderArgs){
  const user=await requireSessionUser(request,"warehouse.view","warehouse");
  const warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected,url=new URL(request.url),orderId=url.searchParams.get("orderId");
  const [batches,dispatches,items]=await Promise.all([
    env.DB.prepare(`SELECT b.id,b.batch_number,b.shipment_id,s.shipment_number,o.id order_id,o.order_number,o.customer_id,c.name customer_name,c.identity_code customer_identity_code,o.business_type,TRIM(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city||CASE WHEN NULLIF(TRIM(o.destination_address),'') IS NOT NULL THEN ' '||o.destination_address ELSE '' END) destination_location,COUNT(i.id) item_count FROM warehouse_sorting_batches b JOIN shipments s ON s.id=b.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id JOIN warehouse_sorting_items i ON i.batch_id=b.id JOIN warehouse_packages bp ON bp.id=i.package_id AND bp.warehouse_id=? WHERE b.organization_id=? AND b.status='verified' AND NOT EXISTS (SELECT 1 FROM warehouse_sorting_items xi JOIN warehouse_dispatch_items xdi ON xdi.package_id=xi.package_id JOIN warehouse_dispatches xd ON xd.id=xdi.dispatch_id WHERE xi.batch_id=b.id AND xd.status!='cancelled') GROUP BY b.id ORDER BY b.verified_at DESC`).bind(warehouse.id,user.organizationId).all<Batch>(),
    env.DB.prepare(`SELECT d.id,d.dispatch_number,COALESCE(tb.batch_number,b.batch_number) batch_number,d.shipment_id,s.shipment_number,o.id order_id,o.order_number,GROUP_CONCAT(DISTINCT ps.order_id) related_order_ids,c.id customer_id,c.name customer_name,c.identity_code customer_identity_code,d.vehicle_plate,d.driver_name,d.driver_phone,d.carrier_name,d.seal_number,d.destination,d.status,COUNT(di.id) item_count,SUM(CASE WHEN di.status='loaded' THEN 1 ELSE 0 END) loaded_count,COALESCE(SUM(p.pieces),0) pieces,COALESCE(SUM(p.weight_kg),0) weight_kg,COALESCE(SUM(p.volume_cbm),0) volume_cbm,d.created_at,d.dispatched_at,u.display_name creator_name,d.transport_batch_id,tb.planned_departure_at FROM warehouse_dispatches d JOIN warehouse_sorting_batches b ON b.id=d.sorting_batch_id LEFT JOIN transport_batches tb ON tb.id=d.transport_batch_id AND tb.organization_id=d.organization_id JOIN shipments s ON s.id=d.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id LEFT JOIN warehouse_packages p ON p.id=di.package_id LEFT JOIN shipments ps ON ps.id=p.shipment_id LEFT JOIN users u ON u.id=d.created_by_user_id WHERE d.organization_id=? AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.dispatch_id=d.id AND wp.warehouse_id=?) GROUP BY d.id ORDER BY CASE d.status WHEN 'loading' THEN 1 ELSE 2 END,d.updated_at DESC LIMIT 50`).bind(user.organizationId,warehouse.id).all<Dispatch>(),
    env.DB.prepare(`SELECT di.id,di.dispatch_id,o.order_number,p.barcode,p.package_number,p.pieces,p.weight_kg,p.volume_cbm,di.status,di.loaded_at
      FROM warehouse_dispatch_items di
      JOIN warehouse_packages p ON p.id=di.package_id
      JOIN shipments s ON s.id=p.shipment_id
      JOIN transport_orders o ON o.id=s.order_id
      WHERE di.organization_id=? AND p.warehouse_id=?
      ORDER BY o.order_number,COALESCE(di.loaded_at,p.created_at) DESC LIMIT 1000`).bind(user.organizationId,warehouse.id).all<Item>()
  ]);
  const visibleBatches=orderId?batches.results.filter((batch)=>batch.order_id===orderId):batches.results;
  const visibleDispatches=orderId?dispatches.results.filter((dispatch)=>dispatch.related_order_ids?.split(",").includes(orderId)||dispatch.order_id===orderId):dispatches.results;
  const visibleDispatchIds=new Set(visibleDispatches.map((dispatch)=>dispatch.id));
  const evaluated=await Promise.all(visibleBatches.map(async(batch)=>({batch,readiness:await checkOrderLoadPlan(user.organizationId,batch.order_id)})));
  const workflowFieldEntries=await Promise.all(
    [...new Set([...visibleBatches.map((batch)=>batch.order_id),...visibleDispatches.map((dispatch)=>dispatch.order_id)])]
      .map(async(orderIdValue)=>[orderIdValue,await loadOrderModuleWorkflowFields(user.organizationId,orderIdValue,"loading")] as const),
  );
  const manifestRows=await env.DB.prepare(`SELECT bo.order_id,d.file_name,d.data_url,d.review_status,d.created_at FROM transport_batch_documents d JOIN transport_batch_orders bo ON bo.batch_id=d.batch_id AND bo.organization_id=d.organization_id AND bo.status!='removed' WHERE d.organization_id=? AND d.document_category='loading_manifest' AND d.review_status IN ('approved','archived') ORDER BY CASE d.review_status WHEN 'approved' THEN 0 ELSE 1 END,d.created_at DESC`).bind(user.organizationId).all<ManifestDoc>();
  const visibleOrderIds=new Set(visibleBatches.map((batch)=>batch.order_id).concat(visibleDispatches.map((dispatch)=>dispatch.order_id)));
  const manifestsByOrder:Record<string,ManifestDoc>={};
  for(const row of manifestRows.results){if(visibleOrderIds.has(row.order_id)&&!manifestsByOrder[row.order_id])manifestsByOrder[row.order_id]=row;}
  const requestedBatch=visibleBatches[0]??null;
  const requestedInspection=orderId&&requestedBatch
    ?await loadOutboundInspection(user.organizationId,warehouse.id,requestedBatch)
    :null;
  return{
    user,warehouse,
    batches:evaluated.filter(item=>item.readiness.ready).map(item=>item.batch),
    blockedBatches:evaluated.filter(item=>!item.readiness.ready).map(item=>({id:item.batch.id,order_number:item.batch.order_number,batch_number:item.batch.batch_number,reasons:item.readiness.reasons})),
    dispatches:visibleDispatches,
    items:orderId?items.results.filter((item)=>visibleDispatchIds.has(item.dispatch_id)):items.results,
    orderId,
    requestedBatch,
    requestedInspection,
    workflowFieldsByOrder:Object.fromEntries(workflowFieldEntries),
    manifestsByOrder,
  };
}

export async function action({request}:Route.ActionArgs){
  const user=await requireSessionUser(request,"warehouse.operate","warehouse"),warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected,form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  await requireWarehouseAssignment(user,warehouse.id,"operator");
  if(intent==="inspect_ftl_documents"){
    const batchId=valueOf(form,"batchId"),orderNumber=valueOf(form,"orderNumber").trim(),customerIdentityCode=valueOf(form,"customerIdentityCode").trim().toUpperCase();
    if(!batchId&&!orderNumber)return{formError:"请输入整车订单号或选择收货清点记录"};
    if(customerIdentityCode&&!isValidCustomerIdentityCode(customerIdentityCode))return{formError:"客户识别码应为5位字母与数字混合，且不包含 O、0、1、L"};
    const matches=await findAvailableOutboundBatches(user.organizationId,warehouse.id,{batchId,orderNumber,customerIdentityCode});
    if(matches.length>1)return{formError:"该订单存在多个货齐入库记录，请从列表选择具体记录"};
    const batch=matches[0];
    if(!batch){
      const existing=orderNumber?await findExistingDispatch(user.organizationId,warehouse.id,orderNumber):null;
      if(existing)return{formError:`${orderNumber} 已经创建装车任务 ${existing.dispatch_number}，当前状态：${existing.status==="loading"?"装车中":"已出库交接"}。请直接在本页下方继续办理。`};
      const diagnosis=orderNumber?await diagnoseOutboundOrder(user.organizationId,warehouse.id,orderNumber):null;
      return{formError:diagnosis||`未找到已确认货齐且尚未创建装车任务的订单${orderNumber?`：${orderNumber}`:""}`};
    }
    const inspection=await loadOutboundInspection(user.organizationId,warehouse.id,batch);
    return{actionKind:"ftl_inspected" as const,inspection};
  }
  if(intent==="ftl_document_upload"){
    const orderId=valueOf(form,"orderId"),batchId=valueOf(form,"batchId"),documentCategory=valueOf(form,"documentCategory") as FtlLoadingDocumentCode;
    const inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,orderId,batchId);
    if(!inspection)return{formError:"该整车订单已不在当前仓库、尚未货齐，或已经创建装车任务"};
    if(inspection.batch.business_type!=="ftl")return{formError:"拼车订单文件在货物配载时统一确认",inspection};
    const documentType=FTL_LOADING_DOCUMENTS.find(item=>item.code===documentCategory);
    if(!documentType)return{formError:"请选择发票、装箱单或报关资料",inspection};
    const file=form.get("attachment");
    if(!(file instanceof File)||file.size<=0)return{formError:`请选择要上传的${documentType.name}`,inspection};
    const fileError=validateOutboundDocumentFile(file);
    if(fileError)return{formError:fileError,inspection};
    const attachmentId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)")
        .bind(attachmentId,user.organizationId,orderId,inspection.batch.customer_id,file.name,file.type,file.size,await toDataUrl(file),user.userId,now),
      env.DB.prepare("INSERT INTO order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,updated_at) VALUES(?,?,?,?,?,0,'pending',?)")
        .bind(attachmentId,user.organizationId,orderId,documentCategory,documentType.name,now),
    ]);
    await writeAudit({request,action:"warehouse.outbound.document_upload",resourceType:"order_attachment",resourceId:attachmentId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{warehouseId:warehouse.id,orderId,orderNumber:inspection.batch.order_number,documentCategory,fileName:file.name}});
    return{success:`${documentType.name}已上传，请补齐资料后点击“检查已上传文件”`,actionKind:"ftl_document_uploaded" as const,inspection:await loadOutboundInspectionByIds(user.organizationId,warehouse.id,orderId,batchId)};
  }
  if(intent==="ftl_documents_approve"){
    const orderId=valueOf(form,"orderId"),batchId=valueOf(form,"batchId");
    const inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,orderId,batchId);
    if(!inspection)return{formError:"该整车订单已不在当前仓库、尚未货齐，或已经创建装车任务"};
    if(inspection.batch.business_type!=="ftl")return{formError:"拼车订单文件在货物配载时统一确认",inspection};
    const missing=inspection.documents.filter(document=>!document.attachmentId);
    if(missing.length)return{formError:`请先上传：${missing.map(document=>document.name).join("、")}`,inspection};
    await env.DB.batch(inspection.documents.map(document=>env.DB.prepare("UPDATE order_document_metadata SET review_status=CASE WHEN review_status='archived' THEN 'archived' ELSE 'approved' END,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE attachment_id=? AND order_id=? AND organization_id=?")
      .bind(user.userId,now,now,document.attachmentId,orderId,user.organizationId)));
    await writeAudit({request,action:"warehouse.outbound.documents_approve",resourceType:"transport_order",resourceId:orderId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{warehouseId:warehouse.id,orderNumber:inspection.batch.order_number,documents:inspection.documents.map(document=>document.code)}});
    return{success:"发票、装箱单和报关资料已检查并审核通过，现在可以创建装车任务",actionKind:"ftl_documents_approved" as const,reviewCloseSignal:now,inspection:await loadOutboundInspectionByIds(user.organizationId,warehouse.id,orderId,batchId)};
  }
  if(intent==="create"){
    const batchId=valueOf(form,"batchId"),orderNumber=valueOf(form,"orderNumber").trim(),customerIdentityCode=valueOf(form,"customerIdentityCode").trim().toUpperCase(),seal=valueOf(form,"sealNumber").toUpperCase(),notes=valueOf(form,"notes");
    if(!batchId&&!orderNumber)return{formError:"请输入订单号或选择货齐入库记录"};
    if(customerIdentityCode&&!isValidCustomerIdentityCode(customerIdentityCode))return{formError:"客户识别码应为5位字母与数字混合，且不包含 O、0、1、L"};
    const availableBatchSql=`SELECT b.id,b.shipment_id,o.id order_id,o.order_number,c.identity_code customer_identity_code,o.business_type,TRIM(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city||CASE WHEN NULLIF(TRIM(o.destination_address),'') IS NOT NULL THEN ' '||o.destination_address ELSE '' END) destination_location FROM warehouse_sorting_batches b JOIN shipments s ON s.id=b.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id WHERE b.organization_id=? AND EXISTS(SELECT 1 FROM warehouse_sorting_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.batch_id=b.id AND wp.warehouse_id=?) AND b.status='verified' AND NOT EXISTS (SELECT 1 FROM warehouse_sorting_items xi JOIN warehouse_dispatch_items xdi ON xdi.package_id=xi.package_id JOIN warehouse_dispatches xd ON xd.id=xdi.dispatch_id WHERE xi.batch_id=b.id AND xd.status!='cancelled')`;
    const matches=orderNumber
      ? await env.DB.prepare(`${availableBatchSql} AND UPPER(o.order_number)=UPPER(?) AND (?='' OR UPPER(c.identity_code)=UPPER(?)) ORDER BY b.verified_at DESC LIMIT 2`).bind(user.organizationId,warehouse.id,orderNumber,customerIdentityCode,customerIdentityCode).all<Pick<Batch,"id"|"shipment_id"|"order_id"|"order_number"|"customer_identity_code"|"business_type"|"destination_location">>()
      : await env.DB.prepare(`${availableBatchSql} AND b.id=? AND (?='' OR UPPER(c.identity_code)=UPPER(?)) LIMIT 1`).bind(user.organizationId,warehouse.id,batchId,customerIdentityCode,customerIdentityCode).all<Pick<Batch,"id"|"shipment_id"|"order_id"|"order_number"|"customer_identity_code"|"business_type"|"destination_location">>();
    if(matches.results.length>1)return{formError:"该订单存在多个货齐入库记录，请从列表选择具体记录"};
    const batch=matches.results[0];
    if(!batch && orderNumber){
      const existing=await env.DB.prepare(`SELECT d.dispatch_number,d.status,o.business_type FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id JOIN transport_orders o ON o.id=s.order_id WHERE d.organization_id=? AND p.warehouse_id=? AND UPPER(o.order_number)=UPPER(?) AND d.status!='cancelled' ORDER BY d.created_at DESC LIMIT 1`).bind(user.organizationId,warehouse.id,orderNumber).first<{dispatch_number:string;status:string;business_type:string}>();
      if(existing)return{formError:`${orderNumber} 已经创建装车任务 ${existing.dispatch_number}，当前状态：${existing.status==="loading"?"装车中":"已出库交接"}。请直接在本页下方继续扫码装车或完成出库，不要重复新建任务。`};
      const diagnosis=await diagnoseOutboundOrder(user.organizationId,warehouse.id,orderNumber);
      if(diagnosis)return{formError:diagnosis};
      return{formError:`未找到已确认货齐且尚未创建装车任务的订单：${orderNumber}。请确认：仓库已完成实收并勾选“货齐”；整车已有车辆安排，拼车已生成配载单并完成整批车辆安排。`};
    }
    if(!batch)return{formError:`未找到已复核且尚未出库的批次${orderNumber?`：${orderNumber}`:""}，请核对订单号、客户识别码和分拣状态`};
    const inspection=await loadOutboundInspectionByIds(user.organizationId,warehouse.id,batch.order_id,batch.id);
    if(!inspection)return{formError:"当前收货清点记录已经失效，请重新检查订单"};
    const rejectCreate=(formError:string)=>({formError,inspection});
    if(batch.business_type==="ftl"&&!inspection.allApproved){
      const pending=inspection.documents.filter(document=>!["approved","archived"].includes(document.reviewStatus||""));
      return rejectCreate(`请先上传、检查并确认：${pending.map(document=>document.name).join("、")}`);
    }
    const workflowFields=await loadOrderModuleWorkflowFields(user.organizationId,batch.order_id,"loading");
    const sealPolicy=workflowFieldPolicy(workflowFields,"loading_seal_number","optional");
    const notesPolicy=workflowFieldPolicy(workflowFields,"loading_handover_notes","optional");
    if(sealPolicy.isActive&&sealPolicy.isRequired&&!seal)return rejectCreate("请填写封签号");
    if(notesPolicy.isActive&&notesPolicy.isRequired&&!notes.trim())return rejectCreate("请填写装车交接备注");
    const planned=await resolveDispatchPlan(user.organizationId,batch.order_id,batch.business_type);
    if("error" in planned)return rejectCreate(planned.error);
    const plate=planned.vehicle_plate?.trim().toUpperCase()||"",driver=planned.driver_name?.trim()||"",phone=planned.driver_phone?.trim()||"",carrier=planned.carrier_name?.trim()||"",destination=batch.destination_location;
    if(!plate||!driver||!carrier)return rejectCreate("运输安排尚未完整：请先在运输安排中确定承运商、车辆和司机，再由仓库创建装车任务");
    const loadReadiness=await checkOrderLoadPlan(user.organizationId,batch.order_id,plate);
    if(!loadReadiness.ready)return rejectCreate(`暂不能创建装车任务：${loadReadiness.reasons.join("；")}`);
    if(planned.batch_id){
      const readiness=await checkBatchWarehouseReadiness(user.organizationId,warehouse.id,planned.batch_id,plate);
      const blocked=readiness.orders.filter(item=>item.reasons.length>0);
      if(blocked.length)return rejectCreate(`配载单 ${readiness.batchNumber} 尚不能装车：${formatOrderBlockers(blocked)}`);
    }
    const dispatchId=crypto.randomUUID(),number=generateDispatch();
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
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO warehouse_dispatches(id,organization_id,dispatch_number,sorting_batch_id,shipment_id,vehicle_plate,driver_name,driver_phone,carrier_name,seal_number,destination,status,notes,created_by_user_id,created_at,updated_at,transport_batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,'loading',?,?,?,?,?)`).bind(dispatchId,user.organizationId,number,batch.id,batch.shipment_id,plate,driver,phone||null,carrier||null,sealPolicy.isActive?(seal||null):null,destination,notesPolicy.isActive?(notes||null):null,user.userId,now,now,planned.batch_id),
      itemStatement
    ]);
    if(planned.batch_id)await refreshLoadingManifest(user.organizationId,planned.batch_id,user.userId,now);
    await recordWarehouseProgress({organizationId:user.organizationId,orderId:batch.order_id,actorUserId:user.userId,stepCode:"loading",stepName:"按配载批次装车",actionCode:"dispatch_create",actionName:"创建批次装车任务",notes:`装车任务 ${number}；车辆 ${plate}`});
    await writeAudit({request,action:"warehouse.dispatch.create",resourceType:"warehouse_dispatch",resourceId:dispatchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{number,batchId:batch.id,orderNumber:batch.order_number,customerIdentityCode:batch.customer_identity_code,plate,driver}});
    return{success:`装车任务 ${number} 已创建`,actionKind:"dispatch_created" as const};
  }
  const dispatchId=valueOf(form,"dispatchId");
  let dispatch=await env.DB.prepare(`SELECT d.id,d.shipment_id,s.order_id,d.status,d.dispatch_number,d.vehicle_plate,d.driver_name,d.driver_phone,d.carrier_name,d.destination,d.transport_batch_id FROM warehouse_dispatches d JOIN shipments s ON s.id=d.shipment_id WHERE d.id=? AND d.organization_id=? AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.dispatch_id=d.id AND wp.warehouse_id=?)`).bind(dispatchId,user.organizationId,warehouse.id).first<{id:string;shipment_id:string;order_id:string;status:string;dispatch_number:string;vehicle_plate:string;driver_name:string;driver_phone:string|null;carrier_name:string|null;destination:string;transport_batch_id:string|null}>();
  if(!dispatch)return{formError:"装车任务不存在"};
  if(intent==="schedule"){
    const plannedDepartureAt=valueOf(form,"plannedDepartureAt").trim();
    if(!dispatch.transport_batch_id)return{formError:"整车任务不使用配载单计划出境时间"};
    if(!plannedDepartureAt)return{formError:"请填写计划出境发车时间"};
    const result=await env.DB.prepare("UPDATE transport_batches SET planned_departure_at=?,updated_at=? WHERE id=? AND organization_id=? AND warehouse_id=? AND status!='cancelled'").bind(plannedDepartureAt,now,dispatch.transport_batch_id,user.organizationId,warehouse.id).run();
    if(!result.meta.changes)return{formError:"配载单不存在或不属于当前仓库"};
    await writeAudit({request,action:"warehouse.dispatch.schedule",resourceType:"transport_batch",resourceId:dispatch.transport_batch_id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,plannedDepartureAt}});
    return{success:`${dispatch.dispatch_number} 的计划出境发车时间已保存`};
  }
  if((intent==="load"||intent==="dispatch")&&(!dispatch.vehicle_plate.trim()||!dispatch.driver_name.trim()||!dispatch.carrier_name?.trim())&&dispatch.transport_batch_id){
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
  if((intent==="load"||intent==="dispatch")&&(!dispatch.vehicle_plate.trim()||!dispatch.driver_name.trim()||!dispatch.carrier_name?.trim()))
    return{formError:"尚未补齐承运商、车辆和司机；请先在对应 PZ 配载单中完成车辆安排，再开始扫码装车"};
  const dispatchWorkflowFields=await loadOrderModuleWorkflowFields(user.organizationId,dispatch.order_id,"loading");
  const scanPolicy=workflowFieldPolicy(dispatchWorkflowFields,"loading_scan_confirmation","required");
  if(intent==="load"){
    if(!scanPolicy.isActive)return{formError:"当前工作流未启用逐件扫码装车，请直接完成装车出库交接"};
    if(dispatch.status!=="loading")return{formError:"该装车任务已完成出库交接，不能继续装车"};
    const barcode=valueOf(form,"barcode").toUpperCase();
    const item=await env.DB.prepare(`SELECT di.id,di.status,p.id package_id FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id WHERE di.dispatch_id=? AND di.organization_id=? AND p.warehouse_id=? AND p.barcode=?`).bind(dispatch.id,user.organizationId,warehouse.id,barcode).first<{id:string;status:string;package_id:string}>();
    if(!item)return{formError:"该货物不属于当前装车任务"};
    if(item.status==="loaded")return{formError:"该货物已经装车，请勿重复扫描"};
    await env.DB.prepare("UPDATE warehouse_dispatch_items SET status='loaded',loaded_by_user_id=?,loaded_at=? WHERE id=?").bind(user.userId,now,item.id).run();
    return{success:`${barcode} 已装车`};
  }
  if(intent==="dispatch"){
    if(dispatch.status!=="loading")return{formError:"该任务已经完成发车"};
    if(!scanPolicy.isActive||!scanPolicy.isRequired)
      await env.DB.prepare("UPDATE warehouse_dispatch_items SET status='loaded',loaded_by_user_id=COALESCE(loaded_by_user_id,?),loaded_at=COALESCE(loaded_at,?) WHERE dispatch_id=? AND status!='loaded'").bind(user.userId,now,dispatch.id).run();
    const counts=await env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='loaded' THEN 1 ELSE 0 END) loaded FROM warehouse_dispatch_items WHERE dispatch_id=?").bind(dispatch.id).first<{total:number;loaded:number}>();
    if(!counts?.total||counts.loaded!==counts.total)return{formError:`装车尚未完成：${counts?.loaded??0}/${counts?.total??0}，不能出库交接`};
    const shipments=await env.DB.prepare(`SELECT DISTINCT s.id shipment_id,s.order_id,o.order_number,s.customer_id,s.current_location
      FROM warehouse_dispatch_items di
      JOIN warehouse_packages p ON p.id=di.package_id
      JOIN shipments s ON s.id=p.shipment_id
      JOIN transport_orders o ON o.id=s.order_id
      WHERE di.dispatch_id=? AND di.organization_id=?`).bind(dispatch.id,user.organizationId).all<{shipment_id:string;order_id:string;order_number:string;customer_id:string;current_location:string|null}>();
    if(!shipments.results.length)return{formError:"关联运单不存在"};
    const departureBlockers:string[]=[];
    for(const shipment of shipments.results){
      const readiness=await checkOrderDeparture(user.organizationId,shipment.order_id,dispatch.vehicle_plate,{warehouseDispatchConfirmed:true});
      if(!readiness.ready)departureBlockers.push(...readiness.reasons.map(reason=>`${shipment.order_number}：${reason}`));
    }
    if(departureBlockers.length)return{formError:`暂不能完成出库交接：${[...new Set(departureBlockers)].join("；")}`};
    const description=`车辆 ${dispatch.vehicle_plate} 已完成仓库装车，等待出境确认；司机：${dispatch.driver_name}`;
    const statements=[
      env.DB.prepare("UPDATE warehouse_dispatches SET status='dispatched',dispatched_by_user_id=?,dispatched_at=?,updated_at=? WHERE id=?").bind(user.userId,now,now,dispatch.id),
      env.DB.prepare("UPDATE warehouse_packages SET status='dispatched',updated_at=? WHERE id IN (SELECT package_id FROM warehouse_dispatch_items WHERE dispatch_id=?) AND organization_id=?").bind(now,dispatch.id,user.organizationId),
      env.DB.prepare(`INSERT INTO warehouse_package_movements(id,organization_id,package_id,operation_type,from_location_id,to_location_id,batch_id,operator_user_id,notes,occurred_at,created_at) SELECT lower(hex(randomblob(16))),di.organization_id,di.package_id,'dispatch',p.location_id,NULL,d.sorting_batch_id,?,?,?,? FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id JOIN warehouse_dispatches d ON d.id=di.dispatch_id WHERE di.dispatch_id=?`).bind(user.userId,description,now,now,dispatch.id),
    ];
    for(const shipment of shipments.results){
      statements.push(
        env.DB.prepare(`INSERT INTO warehouse_operations(id,organization_id,shipment_id,operation_type,location,notes,operator_user_id,occurred_at,created_at) VALUES(?,?,?,'dispatch',?,?,?,?,?)`).bind(crypto.randomUUID(),user.organizationId,shipment.shipment_id,shipment.current_location,description,user.userId,now,now),
        env.DB.prepare(`INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at) VALUES(?,?,'picked_up',?,?,?,1,?,?)`).bind(crypto.randomUUID(),shipment.shipment_id,shipment.current_location,description,now,user.userId,now),
        env.DB.prepare("UPDATE order_cargo_packages SET status='loaded' WHERE order_id=? AND organization_id=? AND status NOT IN ('cancelled','in_transit','delivered')").bind(shipment.order_id,user.organizationId),
      );
    }
    const referenceOrderId=shipments.results[0].order_id;
    const transportBatch=await env.DB.prepare("SELECT batch_id FROM transport_batch_orders WHERE organization_id=? AND order_id=? AND status!='removed' ORDER BY updated_at DESC LIMIT 1").bind(user.organizationId,referenceOrderId).first<{batch_id:string}>();
    statements.push(
      env.DB.prepare("UPDATE transport_vehicle_loads SET loaded_at=COALESCE(loaded_at,?) WHERE batch_id IN (SELECT batch_id FROM transport_batch_orders WHERE order_id=? AND status!='removed')").bind(now,referenceOrderId),
      env.DB.prepare("UPDATE transport_batches SET road_status='loaded_waiting_exit',updated_at=? WHERE id IN (SELECT batch_id FROM transport_batch_orders WHERE order_id=? AND status!='removed') AND organization_id=?").bind(now,referenceOrderId,user.organizationId),
    );
    await env.DB.batch(statements);
    if(transportBatch?.batch_id){
      await refreshLoadingManifest(user.organizationId,transportBatch.batch_id,user.userId,now);
      await recordBatchOutboundProgress({organizationId:user.organizationId,batchId:transportBatch.batch_id,actorUserId:user.userId,dispatchNumber:dispatch.dispatch_number,referenceOrderId});
    }else{
      for (const item of shipments.results) {
        await recordWarehouseProgress({organizationId:user.organizationId,orderId:item.order_id,actorUserId:user.userId,stepCode:"outbound",stepName:"装车出库交接完成",actionCode:"dispatch_complete",actionName:"完成装车出库交接",notes:`装车任务 ${dispatch.dispatch_number} 完成装车出库，等待出境确认`});
      }
    }
    await writeAudit({request,action:"warehouse.dispatch.complete",resourceType:"warehouse_dispatch",resourceId:dispatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{dispatchNumber:dispatch.dispatch_number,packages:counts.total}});
    return{success:`${dispatch.dispatch_number} 已完成装车出库交接；请回配载批次执行出境确认，运单此时尚未进入在途`};
  }
  return{formError:"无效的出库操作"};
}

export default function WarehouseOutbound({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle",canOperate=loaderData.user.permissions.includes("warehouse.operate"),loading=loaderData.dispatches.filter(x=>x.status==="loading"),completed=loaderData.dispatches.filter(x=>x.status==="dispatched");
  const [selectedDispatchId,setSelectedDispatchId]=useState("");
  const activeLoadingTask=loading.find(task=>task.id===selectedDispatchId)??loading[0];
  const actionSuccess=actionData&&"success" in actionData?actionData.success:undefined;
  const actionError=actionData&&"formError" in actionData?actionData.formError:undefined;
  const actionKind=actionData&&"actionKind" in actionData?actionData.actionKind:undefined;
  const inspection=actionData&&"inspection" in actionData
    ?actionData.inspection??loaderData.requestedInspection
    :loaderData.requestedInspection;
  const reviewCloseSignal=actionData&&"reviewCloseSignal" in actionData?actionData.reviewCloseSignal:undefined;
  return <><header className="page-header" id="warehouse-outbound-workbench"><div><p className="eyebrow">PICK · LOAD · DISPATCH</p><h1>按运输方案装车出库</h1><p>整车读取本单车辆安排，拼车读取整张配载单；运输方案完整后，仓库按配载单拣货、扫码装车并完成整批出库交接。</p></div>{canOperate&&<Modal title="新建装车任务" triggerLabel={loaderData.orderId?"下一步：新建本单装车任务":"＋ 新建装车任务"} closeSignal={actionKind==="dispatch_created"?actionSuccess:undefined} size="xwide"><CreateDispatchWorkbench batches={loaderData.batches} requestedBatch={loaderData.requestedBatch} inspection={inspection} busy={busy} actionSuccess={actionSuccess} actionError={actionError} reviewCloseSignal={reviewCloseSignal}/></Modal>}</header>
    {(actionSuccess||actionError)&&<div className={`alert ${actionError?"error":"success"}`}><span>{actionError??actionSuccess}</span></div>}
    <section className="outbound-operation-workbench">
      <div className="outbound-operation-heading">
        <div><p className="eyebrow">CURRENT LOADING</p><h2>待装车</h2><p>先选择配载单或整车任务，然后直接扫描货物标签装车。</p></div>
        <label className="field outbound-task-selector"><span>选择配载单 / 整车任务</span><select value={activeLoadingTask?.id??""} onChange={event=>setSelectedDispatchId(event.target.value)} disabled={!loading.length}><option value="">{loading.length?"请选择待装车任务":"暂无待装车任务"}</option>{loading.map(task=><option key={task.id} value={task.id}>{task.batch_number} · {task.dispatch_number} · {task.vehicle_plate}</option>)}</select></label>
      </div>
      {activeLoadingTask?<DispatchCard key={activeLoadingTask.id} task={activeLoadingTask} items={loaderData.items.filter(x=>x.dispatch_id===activeLoadingTask.id)} fields={loaderData.workflowFieldsByOrder[activeLoadingTask.order_id]??[]} manifest={loaderData.manifestsByOrder[activeLoadingTask.order_id]} busy={busy}/>:<div className="empty-state outbound-empty-state">暂无装车中的任务，请点击页面右上角“新建装车任务”。</div>}
    </section>
    {loaderData.blockedBatches.length>0&&<section className="panel"><div className="panel-header"><div><h2>货齐但尚不可装车</h2><p>这些订单还没有完成配载成单或整批车辆安排，因此不会出现在可创建装车任务列表中。</p></div><span>{loaderData.blockedBatches.length} 票</span></div><div className="simple-list">{loaderData.blockedBatches.map(item=><div key={item.id}><div><strong>{item.order_number}</strong><small>{item.batch_number}</small></div><span>{item.reasons.join("；")}</span></div>)}</div></section>}
    <section className="stats"><article><span>待装车</span><strong>{loading.length}</strong><small>正在执行装车扫描</small></article><article><span>可创建任务</span><strong>{loaderData.batches.length}</strong><small>已完成复核的批次</small></article><article><span>已装车待出境</span><strong>{completed.length}</strong><small>已生成仓库交接记录</small></article></section>
    <section className="panel handover-section"><div className="panel-header no-print"><div><h2>已装车待出境与交接单</h2><p>仓库交接完成不等于车辆已经出境；返回配载批次确认实际出境后，运单才进入在途。</p></div><button className="secondary" type="button" onClick={()=>window.print()}>打印交接单</button></div><div className="handover-list">{completed.map(task=><Handover key={task.id} task={task} items={loaderData.items.filter(x=>x.dispatch_id===task.id)} manifest={loaderData.manifestsByOrder[task.order_id]}/>)}</div>{!completed.length&&<p className="empty-state">暂无已装车交接单。</p>}</section>
  </>;
}

function CreateDispatchWorkbench({batches,requestedBatch,inspection,busy,actionSuccess,actionError,reviewCloseSignal}:{batches:Batch[];requestedBatch:Batch|null;inspection:OutboundInspection|null;busy:boolean;actionSuccess?:string;actionError?:string;reviewCloseSignal?:unknown}){
  const batch=inspection?.batch??requestedBatch;
  const isFtl=inspection?.batch.business_type==="ftl";
  const canCreate=Boolean(inspection&&(inspection.batch.business_type!=="ftl"||inspection.allApproved));
  return <div className="outbound-create-workbench">
    {inspection?<details className="inline-details outbound-order-switch"><summary>切换订单或重新检查</summary><OutboundInspectionForm batches={batches} batch={batch} busy={busy}/></details>:<OutboundInspectionForm batches={batches} batch={batch} busy={busy}/>}
    {(actionSuccess||actionError)&&<div className={`alert ${actionError?"error":"success"}`}>{actionError??actionSuccess}</div>}
    {inspection&&<>
      <div className="outbound-inspection-summary">
        <span>订单<strong>{inspection.batch.order_number}</strong></span>
        <span>客户<strong>{inspection.batch.customer_name}</strong></span>
        <span>运输类型<strong>{isFtl?"整车":"拼车"}</strong></span>
        <span>收货清点<strong>{inspection.batch.batch_number} · {inspection.batch.item_count} 件货物</strong></span>
      </div>
      {isFtl?<section className="outbound-document-section">
        <header><div><h3>整车发运文件</h3><p>在仓库端上传并检查三类文件。管理后台只读同步，不再参与上传或审核。</p></div><span className={`status-pill ${inspection.allApproved?"success":""}`}>{inspection.allApproved?"已检查通过":`${inspection.documents.filter(document=>document.attachmentId).length}/3 已上传`}</span></header>
        <div className="outbound-document-grid">{inspection.documents.map(document=><article className={`outbound-document-card ${["approved","archived"].includes(document.reviewStatus||"")?"ready":""}`} key={document.code}>
          <div><strong>{document.name}</strong><span className="status-pill">{outboundDocumentStatus(document)}</span></div>
          <p title={document.fileName??undefined}>{document.fileName||"尚未上传"}</p>
          <Form method="post" encType="multipart/form-data" className="outbound-document-upload-form">
            <input type="hidden" name="intent" value="ftl_document_upload"/><input type="hidden" name="orderId" value={inspection.batch.order_id}/><input type="hidden" name="batchId" value={inspection.batch.id}/><input type="hidden" name="documentCategory" value={document.code}/>
            <label className="document-upload-button"><input className="document-upload-input" name="attachment" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required disabled={busy}/><span>{document.attachmentId?"选择替换文件":"选择文件"}</span></label>
            <button className="secondary" disabled={busy}>{document.attachmentId?"上传替换":"确认上传"}</button>
          </Form>
        </article>)}</div>
        {inspection.allUploaded?<Modal title="检查整车发运文件" triggerLabel={inspection.allApproved?"查看已确认文件":"检查已上传文件"} triggerClassName={inspection.allApproved?"secondary":"primary warehouse-primary"} size="xwide" closeSignal={reviewCloseSignal}>
          <div className="outbound-document-review-grid">{inspection.documents.map(document=><OutboundDocumentPreview key={document.code} document={document}/>)}</div>
          {!inspection.allApproved&&<Form method="post" className="outbound-review-confirm"><input type="hidden" name="intent" value="ftl_documents_approve"/><input type="hidden" name="orderId" value={inspection.batch.order_id}/><input type="hidden" name="batchId" value={inspection.batch.id}/><p>确认以上三份文件内容与本订单一致后，系统将标记审核通过并开放装车任务。</p><button className="primary warehouse-primary" disabled={busy}>确认文件无误并通过审核</button></Form>}
        </Modal>:<p className="outbound-document-hint">请先上传发票、装箱单和报关资料，补齐后才能检查并创建装车任务。</p>}
      </section>:<div className="alert success">该订单属于拼车，发运文件已在货物配载时按整张配载单确认；这里直接读取配载单车辆与司机。</div>}
      {canCreate&&<Form method="post" className="outbound-create-form"><input type="hidden" name="intent" value="create"/><input type="hidden" name="batchId" value={inspection.batch.id}/><input type="hidden" name="orderNumber" value={inspection.batch.order_number}/><input type="hidden" name="customerIdentityCode" value={inspection.batch.customer_identity_code}/><div className="inherited-data-strip"><span>运输方案与车辆<strong>自动继承操作结果</strong><small>整车读取订单运输安排，拼车读取配载单唯一主车</small></span><span>承运商与目的地<strong>自动继承运输安排</strong><small>仓库无需重复填写</small></span></div>{inspection.sealActive&&<label className="field"><span>封签号{inspection.sealRequired?" *":""}</span><input name="sealNumber" required={inspection.sealRequired}/></label>}{inspection.notesActive&&<label className="field"><span>交接备注{inspection.notesRequired?" *":""}</span><textarea name="notes" rows={2} required={inspection.notesRequired}/></label>}<button className="primary warehouse-primary" disabled={busy}>创建装车任务</button></Form>}
    </>}
  </div>;
}

function OutboundInspectionForm({batches,batch,busy}:{batches:Batch[];batch:Batch|null;busy:boolean}){
  return <Form method="post" className="outbound-inspection-form">
    <input type="hidden" name="intent" value="inspect_ftl_documents"/>
    <label className="field scan-field"><span>订单号 *</span><input name="orderNumber" autoComplete="off" placeholder="扫描或输入完整订单号" defaultValue={batch?.order_number??""}/><small>整车先检查发运文件；拼车输入配载单内任一订单号读取整批运输方案。</small></label>
    <label className="field"><span>收货清点记录（可选）</span><select name="batchId" defaultValue={batch?.id??""}><option value="">通过订单号定位</option>{batches.map(item=><option key={item.id} value={item.id}>[{item.customer_identity_code}] {item.order_number} · {item.batch_number} · {item.customer_name}</option>)}</select></label>
    <label className="field"><span>客户识别码（可选核对）</span><input name="customerIdentityCode" autoComplete="off" maxLength={5} placeholder="例如 A2B3C"/></label>
    <button className="primary warehouse-primary" disabled={busy}>检查订单与文件</button>
  </Form>;
}

function OutboundDocumentPreview({document}:{document:OutboundDocument}){
  const isImage=document.contentType?.startsWith("image/")??false,isPdf=document.contentType==="application/pdf";
  return <article className="outbound-document-preview"><header><div><strong>{document.name}</strong><span>{document.fileName} · {formatBytes(document.sizeBytes)}</span></div><span className="status-pill">{outboundDocumentStatus(document)}</span></header><div className={`outbound-document-canvas ${!isImage&&!isPdf?"unsupported":""}`}>{isImage&&document.dataUrl&&<img src={document.dataUrl} alt={document.fileName||document.name}/>} {isPdf&&document.dataUrl&&<object data={document.dataUrl} type="application/pdf" aria-label={document.fileName||document.name}><p>当前浏览器无法页内预览 PDF。</p></object>} {!isImage&&!isPdf&&<p>该格式不支持页内预览，请打开原文件检查。</p>}</div>{document.dataUrl&&<a className="secondary" href={document.dataUrl} target="_blank" rel="noreferrer">打开原文件</a>}</article>;
}

function outboundDocumentStatus(document:OutboundDocument){if(!document.attachmentId)return"待上传";if(["approved","archived"].includes(document.reviewStatus||""))return"已确认";if(document.reviewStatus==="rejected")return"已退回";return"待检查";}
function formatBytes(value:number|null){if(!value)return"—";return value>=1024*1024?`${(value/1024/1024).toFixed(2)} MB`:`${(value/1024).toFixed(1)} KB`;}
function DispatchCard({task,items,fields,manifest,busy}:{task:Dispatch;items:Item[];fields:WorkflowFieldState[];manifest?:ManifestDoc;busy:boolean}){const scanPolicy=workflowFieldPolicy(fields,"loading_scan_confirmation","required"),canComplete=!scanPolicy.isActive||!scanPolicy.isRequired||task.loaded_count===task.item_count;return <article className="panel dispatch-card"><div className="panel-header"><div><h2>{task.dispatch_number}</h2><p>[{task.customer_identity_code}] {task.order_number} · {task.batch_number} · {task.shipment_number} · {task.customer_name}</p></div><div className="dispatch-progress"><strong>{task.loaded_count}/{task.item_count}</strong><span>已装车</span></div></div><div className="dispatch-meta"><span>车辆 <strong>{task.vehicle_plate}</strong></span><span>司机 <strong>{task.driver_name}</strong></span><span>目的地 <strong>{task.destination}</strong></span><span>计划出境 <strong>{task.planned_departure_at?new Date(task.planned_departure_at).toLocaleString("zh-CN"):"未填写"}</strong></span></div>{task.transport_batch_id&&!task.planned_departure_at&&<Form method="post" className="scan-inline outbound-schedule-inline"><input type="hidden" name="intent" value="schedule"/><input type="hidden" name="dispatchId" value={task.id}/><label className="field"><span>计划出境发车时间 *</span><input type="datetime-local" name="plannedDepartureAt" required/></label><button className="primary warehouse-primary" disabled={busy}>保存计划时间</button></Form>}{manifest&&<div className="dispatch-meta"><span>配载单 <a href={manifest.data_url} target="_blank" rel="noreferrer">{manifest.file_name}</a><small>（工作台自动生成，点击打开对照装车）</small></span></div>}{scanPolicy.isActive&&<Form method="post" className="scan-inline"><input type="hidden" name="intent" value="load"/><input type="hidden" name="dispatchId" value={task.id}/><label className="field"><span>扫描装车标签</span><input name="barcode" placeholder="扫描配载单内任一订单的货物条码" autoComplete="off" required={scanPolicy.isRequired}/></label><button className="primary warehouse-primary" disabled={busy}>确认装车</button></Form>}<div className="batch-items">{items.map(item=><div key={item.id}><code>{item.barcode}</code><span><strong>{item.order_number}</strong> · {item.pieces} 件{item.weight_kg?` · ${item.weight_kg} KG`:""}</span><span className={`status-pill ${item.status!=="loaded"?"off":""}`}>{item.status==="loaded"?"已装车":"待扫描"}</span></div>)}</div><Form method="post" className="dispatch-confirm"><input type="hidden" name="intent" value="dispatch"/><input type="hidden" name="dispatchId" value={task.id}/><button className="secondary" disabled={busy||!canComplete}>整批货号全部核对无误，完成装车出库交接</button></Form></article>}
function Handover({task,items,manifest}:{task:Dispatch;items:Item[];manifest?:ManifestDoc}){return <article className="handover-sheet"><header><div><strong>欧凌国际物流</strong><h2>仓库装车交接单</h2></div><b>{task.dispatch_number}</b></header>{manifest&&<p className="handover-manifest-link no-print">配载单：<a href={manifest.data_url} target="_blank" rel="noreferrer">{manifest.file_name}</a>（点击打开核对装载顺序）</p>}<div className="handover-grid"><span>客户识别码：<strong>{task.customer_identity_code}</strong></span><span>运单：<strong>{task.shipment_number}</strong></span><span>订单：<strong>{task.order_number}</strong></span><span>客户：<strong>{task.customer_name}</strong></span><span>目的地：<strong>{task.destination}</strong></span><span>车牌：<strong>{task.vehicle_plate}</strong></span><span>司机：<strong>{task.driver_name}</strong></span><span>电话：<strong>{task.driver_phone||"—"}</strong></span><span>承运商：<strong>{task.carrier_name||"—"}</strong></span><span>封签号：<strong>{task.seal_number||"—"}</strong></span><span>发车时间：<strong>{task.dispatched_at?new Date(task.dispatched_at).toLocaleString("zh-CN"):"—"}</strong></span></div><table><thead><tr><th>序号</th><th>货物条码</th><th>件数</th><th>重量 KG</th><th>体积 CBM</th></tr></thead><tbody>{items.map((item,index)=><tr key={item.id}><td>{index+1}</td><td>{item.barcode}</td><td>{item.pieces}</td><td>{item.weight_kg??"—"}</td><td>{item.volume_cbm??"—"}</td></tr>)}</tbody><tfoot><tr><td colSpan={2}>合计</td><td>{task.pieces}</td><td>{task.weight_kg}</td><td>{task.volume_cbm}</td></tr></tfoot></table><footer><span>仓库交接人签字：________________</span><span>司机签字：________________</span><span>交接时间：________________</span></footer></article>}
type WarehouseOrderBlocker = { orderId: string; orderNumber: string; reasons: string[] };
async function checkWarehouseOrders(
  organizationId:string,
  warehouseId:string,
  orders:Array<{order_id:string;order_number:string}>,
  vehiclePlate?:string,
):Promise<WarehouseOrderBlocker[]> {
  return Promise.all(orders.map(async order=>{
    const [loadPlan,warehouseState]=await Promise.all([
      checkOrderLoadPlan(organizationId,order.order_id,vehiclePlate),
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
    return{orderId:order.order_id,orderNumber:order.order_number,reasons:[...new Set(reasons)]};
  }));
}
async function checkBatchWarehouseReadiness(organizationId:string,warehouseId:string,batchId:string,vehiclePlate?:string){
  const [batch,orders]=await Promise.all([
    env.DB.prepare("SELECT batch_number FROM transport_batches WHERE id=? AND organization_id=?").bind(batchId,organizationId).first<{batch_number:string}>(),
    env.DB.prepare(`SELECT bo.order_id,o.order_number FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(organizationId,batchId).all<{order_id:string;order_number:string}>(),
  ]);
  return{batchNumber:batch?.batch_number||batchId,orders:await checkWarehouseOrders(organizationId,warehouseId,orders.results,vehiclePlate)};
}
function formatOrderBlockers(items:WarehouseOrderBlocker[]){
  return items.map(item=>`${item.orderNumber}：${item.reasons.join("、")}`).join("；");
}
async function findAvailableOutboundBatches(organizationId:string,warehouseId:string,input:{batchId?:string;orderNumber?:string;customerIdentityCode?:string}){
  const baseSql=`SELECT b.id,b.batch_number,b.shipment_id,s.shipment_number,o.id order_id,o.order_number,o.customer_id,c.name customer_name,c.identity_code customer_identity_code,o.business_type,TRIM(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city||CASE WHEN NULLIF(TRIM(o.destination_address),'') IS NOT NULL THEN ' '||o.destination_address ELSE '' END) destination_location,COUNT(i.id) item_count
    FROM warehouse_sorting_batches b
    JOIN shipments s ON s.id=b.shipment_id
    JOIN transport_orders o ON o.id=s.order_id
    JOIN customers c ON c.id=s.customer_id
    JOIN warehouse_sorting_items i ON i.batch_id=b.id
    JOIN warehouse_packages p ON p.id=i.package_id AND p.warehouse_id=?
    WHERE b.organization_id=? AND b.status='verified'
      AND NOT EXISTS(SELECT 1 FROM warehouse_sorting_items xi JOIN warehouse_dispatch_items xdi ON xdi.package_id=xi.package_id JOIN warehouse_dispatches xd ON xd.id=xdi.dispatch_id WHERE xi.batch_id=b.id AND xd.status!='cancelled')`;
  if(input.orderNumber){
    const result=await env.DB.prepare(`${baseSql} AND UPPER(o.order_number)=UPPER(?) AND (?='' OR UPPER(c.identity_code)=UPPER(?)) GROUP BY b.id ORDER BY b.verified_at DESC LIMIT 2`)
      .bind(warehouseId,organizationId,input.orderNumber,input.customerIdentityCode||"",input.customerIdentityCode||"").all<Batch>();
    return result.results;
  }
  if(input.batchId){
    const result=await env.DB.prepare(`${baseSql} AND b.id=? AND (?='' OR UPPER(c.identity_code)=UPPER(?)) GROUP BY b.id LIMIT 1`)
      .bind(warehouseId,organizationId,input.batchId,input.customerIdentityCode||"",input.customerIdentityCode||"").all<Batch>();
    return result.results;
  }
  return[];
}
async function findExistingDispatch(organizationId:string,warehouseId:string,orderNumber:string){
  return env.DB.prepare(`SELECT d.dispatch_number,d.status FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id JOIN transport_orders o ON o.id=s.order_id WHERE d.organization_id=? AND p.warehouse_id=? AND UPPER(o.order_number)=UPPER(?) AND d.status!='cancelled' ORDER BY d.created_at DESC LIMIT 1`)
    .bind(organizationId,warehouseId,orderNumber).first<{dispatch_number:string;status:string}>();
}
async function loadOutboundInspectionByIds(organizationId:string,warehouseId:string,orderId:string,batchId:string){
  const matches=await findAvailableOutboundBatches(organizationId,warehouseId,{batchId});
  const batch=matches.find(item=>item.order_id===orderId);
  return batch?loadOutboundInspection(organizationId,warehouseId,batch):null;
}
async function loadOutboundInspection(organizationId:string,warehouseId:string,batch:Batch):Promise<OutboundInspection>{
  const [documentRows,workflowFields]=await Promise.all([
    env.DB.prepare(`SELECT m.attachment_id,m.document_category,a.file_name,a.content_type,a.size_bytes,a.data_url,m.review_status,a.created_at
      FROM order_document_metadata m JOIN order_attachments a ON a.id=m.attachment_id
      WHERE m.organization_id=? AND m.order_id=? AND m.document_category IN ('commercial_invoice','packing_list','customs_document')
      ORDER BY a.created_at DESC,a.id DESC`).bind(organizationId,batch.order_id).all<{attachment_id:string;document_category:FtlLoadingDocumentCode;file_name:string;content_type:string;size_bytes:number;data_url:string;review_status:string;created_at:string}>(),
    loadOrderModuleWorkflowFields(organizationId,batch.order_id,"loading"),
  ]);
  const latestByCode=new Map<FtlLoadingDocumentCode,(typeof documentRows.results)[number]>();
  for(const row of documentRows.results){if(!latestByCode.has(row.document_category))latestByCode.set(row.document_category,row);}
  const documents=FTL_LOADING_DOCUMENTS.map(type=>{
    const row=latestByCode.get(type.code);
    return{attachmentId:row?.attachment_id??null,code:type.code,name:type.name,fileName:row?.file_name??null,contentType:row?.content_type??null,sizeBytes:row?.size_bytes??null,dataUrl:row?.data_url??null,reviewStatus:row?.review_status??null};
  });
  const sealPolicy=workflowFieldPolicy(workflowFields,"loading_seal_number","optional"),notesPolicy=workflowFieldPolicy(workflowFields,"loading_handover_notes","optional");
  return{batch,documents,allUploaded:documents.every(document=>Boolean(document.attachmentId)),allApproved:documents.every(document=>["approved","archived"].includes(document.reviewStatus||"")),sealActive:sealPolicy.isActive,sealRequired:sealPolicy.isRequired,notesActive:notesPolicy.isActive,notesRequired:notesPolicy.isRequired};
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
  const order=await env.DB.prepare(`SELECT o.id order_id,o.order_number,(SELECT bo.batch_id FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.status!='cancelled' WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' ORDER BY b.updated_at DESC LIMIT 1) batch_id FROM transport_orders o WHERE o.organization_id=? AND UPPER(o.order_number)=UPPER(?)`).bind(organizationId,orderNumber).first<{order_id:string;order_number:string;batch_id:string|null}>();
  if(!order)return null;
  if(order.batch_id){
    const readiness=await checkBatchWarehouseReadiness(organizationId,warehouseId,order.batch_id);
    const blocked=readiness.orders.filter(item=>item.reasons.length>0);
    return blocked.length?`配载单 ${readiness.batchNumber} 尚不能创建装车任务：${formatOrderBlockers(blocked)}`:`配载单 ${readiness.batchNumber} 在当前仓库没有可创建的装车任务，请检查是否已经生成过出库任务。`;
  }
  const [readiness]=await checkWarehouseOrders(organizationId,warehouseId,[order]);
  return readiness.reasons.length?`${order.order_number} 尚不能创建装车任务：${readiness.reasons.join("、")}`:null;
}
function generateDispatch(){return `OUT-${new Date().toISOString().slice(2,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,5).toUpperCase()}`}
async function resolveDispatchPlan(organizationId:string,orderId:string,businessType:string):Promise<DispatchPlan|{error:string}>{
  if(businessType==="ltl"){
    const rows=await env.DB.prepare(`SELECT b.id batch_id,v.id vehicle_id,v.plate_number vehicle_plate,v.driver_name,v.driver_phone,COALESCE(vc.name,bc.name) carrier_name
      FROM transport_batch_orders bo
      JOIN transport_batches b ON b.id=bo.batch_id AND b.status='loading'
      JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled'
      LEFT JOIN carriers vc ON vc.id=v.carrier_id
      LEFT JOIN carriers bc ON bc.id=b.carrier_id
      WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
      ORDER BY v.created_at LIMIT 2`).bind(organizationId,orderId).all<DispatchPlan&{id:string}>();
    if(!rows.results.length)return{error:"尚未找到该配载单的运输车辆；请先完成配载单车辆安排"};
    if(rows.results.length>1)return{error:"当前配载单存在多辆有效车辆；请保留本批次实际使用的一辆主车"};
    return rows.results[0];
  }
  const row=await env.DB.prepare(`SELECT NULL batch_id,NULL vehicle_id,a.plate_number vehicle_plate,a.driver_name,a.driver_phone,COALESCE(c.name,a.carrier_name) carrier_name
    FROM order_transport_assignments a LEFT JOIN carriers c ON c.id=a.carrier_id
    WHERE a.organization_id=? AND a.order_id=? AND a.status!='cancelled'
    ORDER BY CASE a.leg_type WHEN 'main' THEN 0 WHEN 'first_mile' THEN 1 ELSE 2 END,a.created_at DESC LIMIT 1`).bind(organizationId,orderId).first<DispatchPlan>();
  return row??{error:"尚未找到订单运输安排；请先确定承运商、车辆和司机"};
}
export function meta(){return[{title:"装车出库 | International TMS"}]}
