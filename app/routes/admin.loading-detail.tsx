import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.loading-detail";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import { syncCostsModuleStatus, syncOrderWorkflowSnapshot } from "../lib/order-modules.server";
import { checkOrderDeparture, checkOrderLoadPlan } from "../lib/order-readiness.server";
import { recordWorkflowEvent } from "../lib/business-workflow.server";
import { roadStatusLabels } from "../lib/warehouse-actual";
import { recordWarehouseProgress } from "../lib/warehouse-progress.server";
import { allocationMethodLabel, type AllocationMethod } from "../lib/cost-allocation";
import { confirmCostAllocation, createCostAllocation, loadCostAllocations, updateCostAllocation } from "../lib/cost-allocation.server";
import { confirmOverseasBatchArrival } from "../lib/overseas-warehouse.server";
import { canManageOrderModule } from "../lib/position-portal";
import { maxInlineOrderDocumentBytes, orderDocumentTypeCodes, orderDocumentTypeLabel } from "../lib/order-documents";
import { syncCustomsModuleFromRecords } from "../lib/customs-status.server";
import { Modal } from "../components/Modal";

type Batch={id:string;batch_number:string;batch_name:string;origin_location:string;destination_location:string;planned_departure_at:string|null;planned_arrival_at:string|null;status:string;road_status:string;carrier_id:string|null;warehouse_id:string|null;carrier_name:string|null;warehouse_name:string|null;border_port:string|null;transit_location:string|null;route_notes:string|null;notes:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null};
type BatchOrder={order_id:string;order_number:string;business_type:string|null;work_number:string;customer_name:string;cargo_description:string|null;cargo_names:string|null;pieces:number;gross_weight_kg:number;volume_cbm:number;declared_weight_kg:number;declared_volume_cbm:number;package_count:number;assigned_count:number;vehicle_names:string|null;overseas_status:string|null;overseas_arrival_at:string|null};
type Vehicle={id:string;vehicle_no:string;vehicle_type:string|null;plate_number:string|null;driver_name:string|null;driver_phone:string|null;capacity_weight_kg:number;capacity_volume_cbm:number;used_weight:number;used_volume:number;loaded_orders:number;status:string};
type Option={id:string;name:string};
type ReferenceOption={code:string;name:string};
type BatchDocument={id:string;document_category:string;file_name:string;content_type:string;size_bytes:number;data_url:string;description:string|null;review_status:string;created_at:string};
type OrderDocument={id:string;order_id:string;document_category:string;file_name:string;content_type:string;size_bytes:number;data_url:string;description:string|null;review_status:string;created_at:string};
type CustomsSummary={order_id:string;total:number;released:number};
type BatchCustomsDeclaration={id:string;order_id:string;customs_record_id:string;clearance_stage:string;declaration_number:string;declaration_type:string;declaration_title:string;declaring_company:string;declared_at:string;declared_amount:number;currency:string;gross_weight_kg:number;released_at:string|null;status:string;is_deleted:number;is_redeclared:number;is_amended:number;is_inspected:number;change_reason:string|null;updated_at:string};
type BatchOutboundStatus={order_id:string;dispatched:number};
type DepartureGateStatus={order_id:string;ready:boolean;reasons:string[]};

const BATCH_DOCUMENT_TYPES=[
  {code:"loading_manifest",name:"配载清单",hint:"本配载单的整票订单、货物与车辆汇总",required:true},
  {code:"vehicle_manifest",name:"装车清单",hint:"按车辆形成的装载与包装清单",required:false},
  {code:"batch_waybill",name:"批次运单",hint:"本批次共用的国际运输运单",required:false},
  {code:"border_handover",name:"口岸交接文件",hint:"口岸换装、过境或交接凭证",required:false},
  {code:"transshipment_order",name:"换装单",hint:"发生换装时上传的批次共用凭证",required:false},
] as const;
const ORDER_BATCH_DOCUMENT_CODES=["consignment_letter","contract","commercial_invoice","packing_list","customs_document"] as const;

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
  const batch=await env.DB.prepare(`SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.planned_departure_at,b.planned_arrival_at,b.status,b.road_status,b.carrier_id,b.warehouse_id,b.border_port,b.transit_location,b.route_notes,b.notes,b.overseas_carrier_name,b.overseas_vehicle_type,b.overseas_vehicle_count,b.overseas_vehicle_plate,b.overseas_driver_name,b.overseas_driver_phone,c.name carrier_name,w.name warehouse_name FROM transport_batches b LEFT JOIN carriers c ON c.id=b.carrier_id LEFT JOIN warehouses w ON w.id=b.warehouse_id WHERE b.id=? AND b.organization_id=?`).bind(batchId,current.organizationId).first<Batch>();
  if(!batch)throw new Response("配载批次不存在",{status:404});
  await synchronizeBatchTransport(current.organizationId,batchId,new Date().toISOString());
  const [orders,vehicles,carriers,warehouses,borderPorts,costAllocations,batchDocuments,orderDocuments,customsSummaries,customsDeclarations]=await Promise.all([
    env.DB.prepare(`SELECT bo.order_id,o.order_number,o.business_type,COALESCE((SELECT s.shipment_number FROM shipments s WHERE s.order_id=o.id ORDER BY s.created_at DESC LIMIT 1),o.order_number) work_number,c.name customer_name,o.cargo_description,
        COALESCE((SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.order_id=o.id AND i.organization_id=o.organization_id),o.cargo_description) cargo_names,
        COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.pieces) pieces,
        COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg) gross_weight_kg,
        COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm) volume_cbm,
        o.gross_weight_kg declared_weight_kg,o.volume_cbm declared_volume_cbm,
        COUNT(DISTINCT p.id) package_count,COUNT(DISTINCT l.package_id) assigned_count,GROUP_CONCAT(DISTINCT v.vehicle_no) vehicle_names,
        op.status overseas_status,op.actual_arrival_at overseas_arrival_at
      FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id JOIN customers c ON c.id=o.customer_id LEFT JOIN order_cargo_packages p ON p.order_id=o.id AND p.status!='cancelled' LEFT JOIN transport_vehicle_loads l ON l.batch_id=bo.batch_id AND l.package_id=p.id LEFT JOIN transport_batch_vehicles v ON v.id=l.vehicle_id LEFT JOIN overseas_warehouse_operations op ON op.batch_id=bo.batch_id AND op.order_id=bo.order_id AND op.organization_id=bo.organization_id
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
  return{current,batch,orders:orders.results,vehicles:vehicles.results,carriers:carriers.results,warehouses:warehouses.results,borderPorts:borderPorts.results,costAllocations,batchDocuments:batchDocuments.results,orderDocuments:orderDocuments.results,customsSummaries:customsSummaries.results,customsDeclarations:customsDeclarations.results,outboundStatuses:outboundStatuses.results,departureGateStatuses,returnOrderId};
}

export async function action({request,params}:Route.ActionArgs){
  const current=await requireSessionUser(request,"order.view"),batchId=params.batchId,form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  if(!canManageOrderModule(current,"loading"))throw new Response("无权办理拼车配载",{status:403});
  const batch=await env.DB.prepare("SELECT id,batch_number,status,road_status,border_port,overseas_carrier_name,overseas_vehicle_type,overseas_vehicle_count,overseas_vehicle_plate,overseas_driver_name,overseas_driver_phone FROM transport_batches WHERE id=? AND organization_id=? AND status!='cancelled'").bind(batchId,current.organizationId).first<{id:string;batch_number:string;status:string;road_status:string;border_port:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null}>();
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
      const customsDocument=await env.DB.prepare("SELECT 1 FROM order_document_metadata WHERE organization_id=? AND order_id=? AND document_category='customs_document' LIMIT 1").bind(current.organizationId,orderId).first();
      if(!customsDocument)return{formError:"确认放行前请先在当前弹窗上传该票报关资料"};
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
        await syncCostsModuleStatus(current.organizationId,item.order_id,now);
        await syncOrderWorkflowSnapshot(current.organizationId,item.order_id);
      }));
      await writeAudit({request,action:"transport.batch.cost_allocation.confirm",resourceType:"transport_cost_allocation",resourceId:allocationId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId}});
      return{success:"成本分摊已人工确认，并为各订单生成正式应付费用；该结果只影响内部应付和毛利，不会改客户应收。下一步请到订单费用模块确认、审核并锁定应付"};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="arrangement"){
    const carrierId=valueOf(form,"carrierId"),warehouseId=valueOf(form,"warehouseId"),borderPort=valueOf(form,"borderPort"),plannedDeparture=valueOf(form,"plannedDeparture"),plannedArrival=valueOf(form,"plannedArrival");
    const overseasCarrierName=valueOf(form,"overseasCarrierName"),overseasVehicleType=valueOf(form,"overseasVehicleType"),overseasVehicleCount=Math.max(1,Number(valueOf(form,"overseasVehicleCount")||1)),overseasVehiclePlate=valueOf(form,"overseasVehiclePlate").toUpperCase(),overseasDriverName=valueOf(form,"overseasDriverName"),overseasDriverPhone=valueOf(form,"overseasDriverPhone");
    if(!carrierId||!borderPort||!plannedDeparture||!plannedArrival)return{formError:"请先确定承运商、出境口岸、计划发车和计划到达时间"};
    if(!overseasCarrierName||!overseasVehicleType||!overseasVehiclePlate||!overseasDriverName||!overseasDriverPhone)return{formError:"请完整填写境外承运方、车型、车辆数、车牌号、司机姓名和电话"};
    if(carrierId&&!(await env.DB.prepare("SELECT 1 FROM carriers WHERE id=? AND organization_id=? AND status='active'").bind(carrierId,current.organizationId).first()))return{formError:"承运商无效"};
    if(warehouseId&&!(await env.DB.prepare("SELECT 1 FROM warehouses WHERE id=? AND organization_id=? AND status='active' AND warehouse_role IN ('domestic_collection','port')").bind(warehouseId,current.organizationId).first()))return{formError:"集货仓库无效，只能选择国内集货仓或口岸仓"};
    if(!(await env.DB.prepare("SELECT 1 FROM reference_data WHERE organization_id=? AND category='border_port' AND code=? AND status='active'").bind(current.organizationId,borderPort).first()))return{formError:"出境口岸无效"};
    await env.DB.prepare("UPDATE transport_batches SET carrier_id=?,warehouse_id=COALESCE(?,warehouse_id),planned_departure_at=?,planned_arrival_at=?,border_port=?,transit_location=?,route_notes=?,notes=?,overseas_carrier_name=?,overseas_vehicle_type=?,overseas_vehicle_count=?,overseas_vehicle_plate=?,overseas_driver_name=?,overseas_driver_phone=?,updated_at=? WHERE id=? AND organization_id=?").bind(carrierId,warehouseId||null,plannedDeparture,plannedArrival,borderPort,valueOf(form,"transitLocation")||null,valueOf(form,"routeNotes")||null,valueOf(form,"notes")||null,overseasCarrierName,overseasVehicleType,overseasVehicleCount,overseasVehiclePlate,overseasDriverName,overseasDriverPhone,now,batchId,current.organizationId).run();
    await synchronizeBatchTransport(current.organizationId,batchId,now);
    await synchronizeBatchWarehouseProgress(current.organizationId,batchId,current.userId);
    await writeAudit({request,action:"transport.batch.arrangement.update",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{carrierId:carrierId||null,warehouseId:warehouseId||null}});
    return{success:"批次运输安排已保存；订单线路和货物数据已自动继承"};
  }
  if(intent==="vehicle"){
    const vehicleNo=valueOf(form,"vehicleNo"),plateNumber=valueOf(form,"plateNumber").toUpperCase(),driverName=valueOf(form,"driverName");if(!vehicleNo||!plateNumber||!driverName)return{formError:"请填写车辆序号、车牌号和司机"};
    const id=crypto.randomUUID();
    try{await env.DB.prepare("INSERT INTO transport_batch_vehicles(id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,current.organizationId,batchId,vehicleNo,valueOf(form,"vehicleType")||null,plateNumber,driverName,valueOf(form,"driverPhone")||null,numberOf(form,"capacityWeight"),numberOf(form,"capacityVolume"),now,now).run()}catch{return{formError:"车辆序号重复或车辆信息无效"}}
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
    const packageIds=packages.results.map(item=>item.id),placeholders=packageIds.map(()=>"?").join(",");
    const [used,actual]=await Promise.all([
      env.DB.prepare(`SELECT COALESCE(SUM(x.weight),0) weight,COALESCE(SUM(x.volume),0) volume FROM (SELECT p.order_id,COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=p.order_id AND r.status='completed'),SUM(i.gross_weight_per_package_kg)) weight,COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=p.order_id AND r.status='completed'),SUM(i.volume_per_package_cbm)) volume FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id JOIN order_cargo_items i ON i.id=p.cargo_item_id WHERE l.vehicle_id=? AND l.package_id NOT IN (${placeholders}) GROUP BY p.order_id) x`).bind(vehicleId,...packageIds).first<{weight:number;volume:number}>(),
      env.DB.prepare("SELECT SUM(r.total_weight_kg) weight,SUM(r.total_volume_cbm) volume FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=? AND s.order_id=? AND r.status='completed'").bind(current.organizationId,orderId).first<{weight:number|null;volume:number|null}>(),
    ]);
    const orderWeight=actual?.weight??packages.results.reduce((sum,item)=>sum+item.weight,0),orderVolume=actual?.volume??packages.results.reduce((sum,item)=>sum+item.volume,0);
    if(vehicle.capacity_weight_kg>0&&(used?.weight??0)+orderWeight>vehicle.capacity_weight_kg)return{formError:"整票订单装入后将超过车辆重量上限"};
    if(vehicle.capacity_volume_cbm>0&&(used?.volume??0)+orderVolume>vehicle.capacity_volume_cbm)return{formError:"整票订单装入后将超过车辆体积上限"};
    const statements=[
      env.DB.prepare(`DELETE FROM transport_vehicle_loads WHERE batch_id=? AND package_id IN (${placeholders})`).bind(batchId,...packageIds),
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
    const orders=await env.DB.prepare(`SELECT bo.order_id,s.id shipment_id,s.customer_id,s.current_location FROM transport_batch_orders bo LEFT JOIN shipments s ON s.id=(SELECT id FROM shipments WHERE order_id=bo.order_id ORDER BY created_at DESC LIMIT 1) WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<{order_id:string;shipment_id:string|null;customer_id:string|null;current_location:string|null}>();
    if(!orders.results.length)return{formError:"当前批次没有有效订单"};
    const blockers:string[]=[];
    const sharedDocumentGate=await env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN review_status IN ('approved','archived') THEN 1 ELSE 0 END) approved FROM transport_batch_documents WHERE organization_id=? AND batch_id=? AND document_category='loading_manifest'").bind(current.organizationId,batchId).first<{total:number;approved:number|null}>();
    if(!(sharedDocumentGate?.total??0))blockers.push("配载清单尚未上传");
    else if((sharedDocumentGate?.approved??0)<(sharedDocumentGate?.total??0))blockers.push("配载清单尚未全部审核通过");
    for(const item of orders.results){
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
      await syncOrderWorkflowSnapshot(current.organizationId,item.order_id);
      if(item.shipment_id&&item.customer_id)await recordWorkflowEvent({organizationId:current.organizationId,event:"shipment.in_transit",customerId:item.customer_id,orderId:item.order_id,shipmentId:item.shipment_id,actorUserId:current.userId,source:"admin",metadata:{batchId,batchNumber:batch.batch_number,exitPort,exitVehiclePlate,overseasVehiclePlate:overseasVehiclePlate||null,overseasCarrierName:overseasCarrierName||null,overseasDriverName:overseasDriverName||null}});
    }));
    await writeAudit({request,action:"transport.batch.exit.confirm",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{actualExitAt,exitPort,exitVehiclePlate,orders:orders.results.length}});
    return{success:"出境确认完成；批次内运单已统一进入出境运输中，轨迹已同步"};
  }
  if(intent==="overseas_arrival"){
    const actualArrivalAt=valueOf(form,"actualArrivalAt"),notes=valueOf(form,"arrivalNotes");
    if(!actualArrivalAt)return{formError:"请填写实际到达境外仓时间"};
    try{
      const result=await confirmOverseasBatchArrival({organizationId:current.organizationId,batchId,actualArrivalAt,actorUserId:current.userId,notes});
      await writeAudit({request,action:"transport.batch.overseas_arrival.confirm",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{actualArrivalAt,orders:result.orderCount}});
      return{success:`配载单 ${result.batchNumber} 已确认到境外仓；${result.orderCount} 票订单已同步进入境外仓自提`};
    }catch(error){return{formError:errorMessage(error)}}
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
  const dispatchedCount=loaderData.outboundStatuses.filter(item=>item.dispatched===1).length;
  const allDispatched=loaderData.orders.length>0&&dispatchedCount===loaderData.orders.length;
  const sharedDocumentsReady=BATCH_DOCUMENT_TYPES.filter(item=>item.required).every(type=>loaderData.batchDocuments.some(document=>document.document_category===type.code&&["approved","archived"].includes(document.review_status)));
  const orderDepartureReady=loaderData.departureGateStatuses.every(item=>item.ready);
  const transportResourceReady=Boolean(loaderData.batch.overseas_carrier_name&&loaderData.batch.overseas_vehicle_type&&loaderData.batch.overseas_vehicle_count>0&&loaderData.batch.overseas_vehicle_plate&&loaderData.batch.overseas_driver_name&&loaderData.batch.overseas_driver_phone);
  const canConfirmExit=allDispatched&&sharedDocumentsReady&&orderDepartureReady&&transportResourceReady;
  const exitBlockers=[
    ...(!allDispatched?[`仓库装车出库交接未完成（${dispatchedCount}/${loaderData.orders.length} 票）`]:[]),
    ...(!transportResourceReady?["境外承运方、车型、车牌、司机姓名或司机电话尚未补齐"]:[]),
    ...(!sharedDocumentsReady?["配载清单尚未上传并审核通过"]:[]),
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
        <label className="field"><span>出境口岸</span><select name="borderPort" defaultValue={loaderData.batch.border_port||""} required><option value="">请选择出境口岸</option>{loaderData.borderPorts.map(item=><option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}</select></label>
        <Field name="transitLocation" label="中转地" defaultValue={loaderData.batch.transit_location||""}/>
        <Field name="plannedDeparture" label="计划发车" type="datetime-local" required defaultValue={dateTimeLocal(loaderData.batch.planned_departure_at)}/>
        <Field name="plannedArrival" label="计划到达" type="datetime-local" required defaultValue={dateTimeLocal(loaderData.batch.planned_arrival_at)}/>
        <label className="field span-2"><span>装载要求 / 实际路线</span><input name="routeNotes" defaultValue={loaderData.batch.route_notes||""} placeholder="例如口岸、换装点、装载要求和行驶路线"/></label>
        <label className="field span-2"><span>业务备注</span><input name="notes" defaultValue={loaderData.batch.notes||""}/></label>
        <div className="form-section-title span-2"><strong>境外运输资源</strong><small>确定整车/拼车方案后立即登记；出境确认将直接继承。</small></div>
        <label className="field"><span>境外承运方 *</span><select name="overseasCarrierName" defaultValue={loaderData.batch.overseas_carrier_name||""} required><option value="">请选择承运方</option>{loaderData.carriers.map(item=><option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
        <Field name="overseasVehicleType" label="境外车型 *" required defaultValue={loaderData.batch.overseas_vehicle_type||""}/>
        <Field name="overseasVehicleCount" label="车辆数目 *" type="number" required defaultValue={String(loaderData.batch.overseas_vehicle_count||1)}/>
        <Field name="overseasVehiclePlate" label="境外车牌号 *" required defaultValue={loaderData.batch.overseas_vehicle_plate||""}/>
        <Field name="overseasDriverName" label="司机姓名 *" required defaultValue={loaderData.batch.overseas_driver_name||""}/>
        <Field name="overseasDriverPhone" label="司机电话 *" required defaultValue={loaderData.batch.overseas_driver_phone||""}/>
        <button className="primary" disabled={busy||!loaderData.carriers.length}>保存配载单信息</button>
      </Form>}
      <aside className="loading-sheet-tools">
        {manage&&<details className="loading-tool-card" open={!loaderData.vehicles.length}><summary>新增车辆</summary><Form method="post" className="compact-tool-form"><input type="hidden" name="intent" value="vehicle"/><Field name="vehicleNo" label="车辆序号" required/><label className="field"><span>车型</span><select name="vehicleType" defaultValue=""><option value="">请选择车型</option>{VEHICLE_TYPE_OPTIONS.map(item=><option key={item} value={item}>{item}</option>)}</select></label><Field name="plateNumber" label="车牌号" required/><Field name="driverName" label="司机" required/><Field name="driverPhone" label="司机电话"/><Field name="capacityWeight" label="载重上限 KG" type="number"/><Field name="capacityVolume" label="体积上限 CBM" type="number"/><button className="secondary" disabled={busy}>添加车辆</button></Form></details>}
        {manage&&<details className="loading-tool-card" open={loaderData.vehicles.length>0&&unassignedOrders>0}><summary>分配整票订单到车辆</summary><Form method="post" className="compact-tool-form"><input type="hidden" name="intent" value="assign_order"/><Select name="orderId" label="订单" items={loaderData.orders.map(item=>[item.order_id,`${item.order_number} · ${item.customer_name} · ${item.package_count} 包装`])}/><Select name="vehicleId" label="车辆" items={loaderData.vehicles.map(item=>[item.id,`${item.vehicle_no} · ${item.plate_number||"未录车牌"}`])}/>{!loaderData.vehicles.length&&<small className="field-error">请先添加至少一辆车。</small>}<button className="secondary" disabled={busy||!loaderData.vehicles.length||!loaderData.orders.length}>确认装载指令</button></Form>{actionData?.success?.startsWith("装载指令已确认")&&<div className="alert success loading-assignment-feedback">{actionData.success}</div>}<div className="loading-assignment-records"><header><strong>分配记录</strong><span>{assignedOrders.length}/{loaderData.orders.length} 票已分配</span></header>{assignedOrders.map(item=><div className="loading-assignment-record" key={item.order_id}><div><strong>{item.order_number}</strong><small>{item.customer_name}</small></div><div><span>装载车辆</span><strong>{item.vehicle_names||"未记录"}</strong></div><div><span>包装</span><strong>{item.assigned_count}/{item.package_count}</strong></div><span className={`status-pill ${item.assigned_count>=item.package_count?"success":""}`}>{item.assigned_count>=item.package_count?"已确认":"部分分配"}</span></div>)}{!assignedOrders.length&&<p className="empty-state">尚无分配记录；确认装载指令后将显示在这里。</p>}{assignedOrders.length>0&&<WarehouseOutboundAction orderId={assignedOrders[0].order_id} batchId={loaderData.batch.id}/>}</div></details>}
      </aside>
    </div>
    <LoadingTotals totals={totals}/>
    <div className="loading-sheet-columns">
      <section className="loading-sheet-section"><header><h3>挂载订单</h3><span>货物名称按每票货物明细完整汇总；这些订单跟随本配载单批量推进</span></header><div className="table-wrap loading-sheet-table"><table><thead><tr><th>订单号</th><th>工作号</th><th>委托人</th><th>起运地</th><th>目的地</th><th>货物名称</th><th>件数</th><th>报关重量</th><th>报关体积</th><th>进仓重量</th><th>进仓体积</th><th>车辆</th><th>境外仓</th><th>操作</th></tr></thead><tbody>{loaderData.orders.map(item=><tr key={item.order_id}><td><Link to={`/admin/orders/${item.order_id}/modules/loading`}><strong>{item.order_number}</strong></Link></td><td>{item.work_number}</td><td>{item.customer_name}</td><td>{loaderData.batch.origin_location}</td><td>{loaderData.batch.destination_location}</td><td><strong className="loading-cargo-names">{item.cargo_names||item.cargo_description||"未填写"}</strong></td><td>{item.pieces}</td><td>{item.declared_weight_kg.toFixed(2)}</td><td>{item.declared_volume_cbm.toFixed(3)}</td><td>{item.gross_weight_kg.toFixed(2)}</td><td>{item.volume_cbm.toFixed(3)}</td><td>{item.vehicle_names||"待分配"}</td><td>{item.overseas_status==="arrived"||item.overseas_status==="notified"||item.overseas_status==="appointment"||item.overseas_status==="picked_up"?<span className="status-pill success">{item.overseas_arrival_at?`已到仓 ${formatShortDateTime(item.overseas_arrival_at)}`:"已到仓"}</span>:<span className="status-pill off">未到仓</span>}</td><td><div className="loading-row-actions"><Link className="text-button" to={`/admin/orders/${item.order_id}`}>订单中心</Link><a className="text-button" href="#batch-files">处理文件</a></div></td></tr>)}</tbody></table></div></section>
      <section className="loading-sheet-section"><header><h3>车辆容量</h3><span>分配时自动校验重量和体积</span></header><div className="loading-vehicle-grid compact">{loaderData.vehicles.map(vehicle=><article key={vehicle.id}><header><strong>{vehicle.vehicle_no}</strong><span>{vehicle.plate_number||"车牌待录"}</span></header><p>{vehicle.vehicle_type||"车型待录"} · {vehicle.driver_name||"司机待定"} · {vehicle.driver_phone||"电话待录"}</p><div><span>重量 {vehicle.used_weight.toFixed(2)} / {vehicle.capacity_weight_kg||"不限"} KG</span><span>体积 {vehicle.used_volume.toFixed(3)} / {vehicle.capacity_volume_cbm||"不限"} CBM</span><span>{vehicle.loaded_orders} 票订单</span></div></article>)}</div>{!loaderData.vehicles.length&&<p className="empty-state">当前批次还没有车辆。</p>}</section>
    </div>
  </section>
  <BatchDocumentWorkbench batchId={loaderData.batch.id} orders={loaderData.orders} batchDocuments={loaderData.batchDocuments} orderDocuments={loaderData.orderDocuments} customsSummaries={loaderData.customsSummaries} customsDeclarations={loaderData.customsDeclarations} busy={busy} manage={manage}/>
  <CostAllocationSection allocations={loaderData.costAllocations} busy={busy} manage={manage}/>
  <section className="panel" id="batch-exit-gate"><div className="panel-header"><div><h2>5. 出境门禁与确认</h2><p>这里逐项核对整批订单；全部通过后，才能统一确认出境并同步所有挂载订单。</p></div><span className="status-pill">{roadStatusLabels[loaderData.batch.road_status]||loaderData.batch.road_status}</span></div>
    <div className="batch-exit-gates">
      <div className={`batch-exit-gate ${allDispatched?"ready":"blocked"}`}><span>仓库装车出库</span><strong>{allDispatched?"全部订单已完成交接":`${dispatchedCount}/${loaderData.orders.length} 票已完成`}</strong></div>
      <div className={`batch-exit-gate ${transportResourceReady?"ready":"blocked"}`}><span>境外运输资源</span><strong>{transportResourceReady?`${loaderData.batch.overseas_carrier_name} · ${loaderData.batch.overseas_vehicle_plate}`:"承运方、车辆或司机资料未齐"}</strong></div>
      <div className={`batch-exit-gate ${sharedDocumentsReady?"ready":"blocked"}`}><span>配载单文件</span><strong>{sharedDocumentsReady?"配载清单已审核":"配载清单待上传或审核"}</strong></div>
      <div className={`batch-exit-gate ${orderDepartureReady?"ready":"blocked"}`}><span>逐票资料与报关</span><strong>{orderDepartureReady?"全部订单门禁已通过":`${loaderData.departureGateStatuses.filter(item=>!item.ready).length} 票待处理`}</strong></div>
    </div>
    {loaderData.batch.road_status==="outbound_in_transit"?<div className="alert success">本配载单已出境；现在可以在下方继续确认到境外仓。</div>:["overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status)?<div className="alert success">本配载单已完成出境确认。</div>:canConfirmExit&&manage?<Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="exit_confirm"/><Field name="actualExitAt" label="实际出境时间" type="datetime-local" required/><label className="field"><span>实际出境口岸</span><select name="exitPort" defaultValue={loaderData.batch.border_port||""} required><option value="">请选择</option>{loaderData.borderPorts.map(item=><option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}</select></label><Field name="exitVehiclePlate" label="实际出境车辆车牌" required defaultValue={loaderData.batch.overseas_vehicle_plate||loaderData.vehicles.map(item=>item.plate_number).filter(Boolean).join("、")}/><Field name="proofReference" label="出境凭证 / 图片编号"/><Field name="exitNotes" label="出境备注"/><button className="primary" disabled={busy}>确认本配载单已出境并同步订单</button></Form>:<div className="batch-gate-blocker"><div><strong>当前还不能确认出境</strong><p>完成下面的未通过项目后，系统会自动开放“确认出境”。</p>{exitBlockers.length?<ul>{Array.from(new Set(exitBlockers)).map(reason=><li key={reason}>{reason}</li>)}</ul>:<p>当前账号只能查看门禁状态。</p>}</div><div className="batch-gate-actions">{!allDispatched&&assignedOrders[0]&&<WarehouseOutboundAction orderId={assignedOrders[0].order_id} batchId={loaderData.batch.id}/>}<a className="secondary" href="#batch-files">处理配载单文件与逐票报关</a>{!loadPlanReady&&<a className="secondary" href="#batch-arrangement">完善配载和车辆安排</a>}</div></div>}
  </section>
  <section className="panel"><div className="panel-header"><div><h2>6. 出境后批量推进</h2><p>货到境外目的仓后，在这里一次确认本配载单全部挂载订单到仓；后续通知、预约、自提再回到各订单境外仓模块办理。</p></div><span className="status-pill">{loaderData.orders.filter(item=>item.overseas_status&&item.overseas_status!=="waiting_arrival").length}/{loaderData.orders.length} 票到仓</span></div>{loaderData.batch.road_status==="outbound_in_transit"&&manage?<Form method="post" className="batch-arrival-form"><input type="hidden" name="intent" value="overseas_arrival"/><Field name="actualArrivalAt" label="实际到达境外仓时间" type="datetime-local" required/><label className="field span-2"><span>到仓备注</span><input name="arrivalNotes" placeholder="例如境外仓签收人、到仓异常、卸货说明"/></label><button className="primary" disabled={busy}>确认本配载单已到境外仓并同步订单</button></Form>:["overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status)?<div className="alert success">本配载单已确认到境外仓；挂载订单已进入境外仓自提流程。</div>:<div className="alert warning">当前步骤尚未开放：请先在上方完成全部出境门禁并确认出境，之后才能登记到达境外仓。</div>}</section>
  </>}

function BatchDocumentWorkbench({batchId,orders,batchDocuments,orderDocuments,customsSummaries,customsDeclarations,busy,manage}:{batchId:string;orders:BatchOrder[];batchDocuments:BatchDocument[];orderDocuments:OrderDocument[];customsSummaries:CustomsSummary[];customsDeclarations:BatchCustomsDeclaration[];busy:boolean;manage:boolean}){
  const approvedShared=new Set(batchDocuments.filter(item=>["approved","archived"].includes(item.review_status)).map(item=>item.document_category));
  const missingShared=BATCH_DOCUMENT_TYPES.filter(item=>item.required&&!approvedShared.has(item.code));
  return <section className="panel batch-document-workbench" id="batch-files">
    <div className="panel-header"><div><h2>3. 配载单文件工作台</h2><p>在这一页处理整批共用文件和每票订单文件；上传结果仍归属原订单，出境门禁自动汇总检查。</p></div><span className={`status-pill ${missingShared.length?"":"success"}`}>{missingShared.length?`整批缺 ${missingShared.length} 项`:"整批文件已齐"}</span></div>
    <div className="batch-document-scope-note"><strong>整批共用</strong><span>配载清单、装车清单、批次运单、口岸交接文件只上传一次。</span><strong>逐票独立</strong><span>委托书、合同、发票、装箱单、报关资料和报关单按订单分别检查。</span></div>
    <section className="batch-shared-documents"><header><div><h3>整批共用文件</h3><p>“配载清单”必须上传并审核通过，其他文件按实际业务发生时补充。</p></div></header>
      <div className="batch-document-grid">{BATCH_DOCUMENT_TYPES.map(type=>{
        const current=batchDocuments.find(item=>item.document_category===type.code);
        return <article className={current&&["approved","archived"].includes(current.review_status)?"ready":""} key={type.code}>
          <div><strong>{type.name}{type.required&&<b className="required-mark"> *</b>}</strong><small>{type.hint}</small></div>
          <div className="batch-document-current">{current?<><span className={`status-pill ${current.review_status==="approved"?"success":""}`}>{documentReviewLabel(current.review_status)}</span><a href={current.data_url} target="_blank" rel="noreferrer">{current.file_name}</a></>:<span className="status-pill off">待上传</span>}</div>
          {manage&&<Form method="post" encType="multipart/form-data" className="batch-document-upload"><input type="hidden" name="intent" value="batch_document_upload"/><input type="hidden" name="documentCategory" value={type.code}/><input name="attachment" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required/><input name="documentDescription" placeholder="文件说明（选填）"/><button className="secondary" disabled={busy}>{current?"重新上传":"上传"}</button></Form>}
          {manage&&current&&current.review_status!=="approved"&&<Form method="post" className="batch-document-review"><input type="hidden" name="intent" value="batch_document_review"/><input type="hidden" name="attachmentId" value={current.id}/><input type="hidden" name="reviewStatus" value="approved"/><button className="text-button" disabled={busy}>审核通过</button></Form>}
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
    {rank:4,title:"确认到境外仓",body:"批量同步所有订单"},
  ];
  return <div className="batch-command-steps">{steps.map(step=><div key={step.rank} className={`batch-command-step ${current>step.rank?"done":current===step.rank?"current":""}`}><b>{current>step.rank?"✓":step.rank}</b><strong>{step.title}</strong><span>{step.body}</span></div>)}</div>;
}

function WarehouseOutboundAction({orderId,batchId}:{orderId:string;batchId:string}){
  const returnTo=`/admin/loading/${batchId}?fromOrderId=${encodeURIComponent(orderId)}`;
  const warehouseTo=`/warehouse/outbound?orderId=${encodeURIComponent(orderId)}&returnTo=${encodeURIComponent(returnTo)}`;
  return <div className="loading-warehouse-handoff"><div><strong>下一步由仓库办理</strong><span>仓库按已确认的配载车辆扫码拣货、装车并完成出库交接。</span></div><Form method="post" action="/switch-site"><input type="hidden" name="target" value="warehouse"/><input type="hidden" name="warehouseTo" value={warehouseTo}/><button className="primary">去仓库端拣货装车</button></Form></div>;
}

function CostAllocationSection({allocations,busy,manage}:{allocations:Awaited<ReturnType<typeof loadCostAllocations>>;busy:boolean;manage:boolean}){
  return <section className="panel cost-allocation-section"><div className="panel-header"><div><h2>4. 拼车成本分摊</h2><p>按仓库实收重量和体积生成系统建议；人工确认前不入账，确认后只生成内部应付和毛利数据，不会改客户应收。</p></div><span className="status-pill">{allocations.filter(item=>item.status==="draft").length} 个待确认</span></div>
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
  await Promise.all(orders.results.map((item)=>syncOrderWorkflowSnapshot(organizationId,item.order_id)));
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
  if(!module||module.status==="completed"){await syncOrderWorkflowSnapshot(organizationId,orderId);return;}
  const readiness=await env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN review_status NOT IN ('approved','archived') THEN 1 ELSE 0 END) pending FROM order_document_metadata WHERE organization_id=? AND order_id=?`).bind(organizationId,orderId).first<{total:number;pending:number|null}>();
  const completed=(readiness?.total??0)>0&&(readiness?.pending??0)===0;
  const nextStepCode=completed?"archived":"checking",nextStepName=completed?"文件归档":"资料检查";
  await env.DB.batch([
    env.DB.prepare(`UPDATE order_module_instances SET status=?,current_step_code=?,current_step_name=?,progress_percent=CASE WHEN ?='completed' THEN 100 ELSE MAX(progress_percent,25) END,blocking_reason=NULL,started_at=COALESCE(started_at,?),completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,updated_at=? WHERE id=?`).bind(completed?"completed":"in_progress",nextStepCode,nextStepName,completed?"completed":"in_progress",now,completed?"completed":"in_progress",now,now,module.id),
    env.DB.prepare("INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),organizationId,orderId,module.id,completed?"documents_approved":"document_uploaded",completed?"批次工作台审核完成":"批次工作台上传文件",module.current_step_code,nextStepCode,nextStepName,actorUserId,completed?"全部现有文件已审核通过":"文件已上传并进入资料检查",now),
  ]);
  await syncOrderWorkflowSnapshot(organizationId,orderId);
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
