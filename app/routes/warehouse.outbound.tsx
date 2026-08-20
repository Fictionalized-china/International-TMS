import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.outbound";
import { Modal } from "../components/Modal";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { isValidCustomerIdentityCode } from "../lib/customer-identity";
import { checkOrderDeparture, checkOrderLoadPlan } from "../lib/order-readiness.server";
import { recordBatchOutboundProgress, recordWarehouseProgress } from "../lib/warehouse-progress.server";
import { workflowFieldPolicy } from "../lib/workflow-field-catalog";
import {
  loadOrderModuleWorkflowFields,
  type WorkflowFieldState,
} from "../lib/workflow-fields.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";

type Batch={id:string;batch_number:string;shipment_id:string;shipment_number:string;order_id:string;order_number:string;customer_name:string;customer_identity_code:string;business_type:string;destination_location:string;item_count:number};
type Dispatch={id:string;dispatch_number:string;batch_number:string;shipment_id:string;shipment_number:string;order_id:string;order_number:string;related_order_ids:string|null;customer_id:string;customer_name:string;customer_identity_code:string;vehicle_plate:string;driver_name:string;driver_phone:string|null;carrier_name:string|null;seal_number:string|null;destination:string;status:string;item_count:number;loaded_count:number;pieces:number;weight_kg:number;volume_cbm:number;created_at:string;dispatched_at:string|null;creator_name:string|null};
type Item={id:string;dispatch_id:string;barcode:string;package_number:string;pieces:number;weight_kg:number|null;volume_cbm:number|null;status:string;loaded_at:string|null};
type DispatchPlan={batch_id:string|null;vehicle_id:string|null;vehicle_plate:string|null;driver_name:string|null;driver_phone:string|null;carrier_name:string|null};
type ManifestDoc={order_id:string;file_name:string;data_url:string;review_status:string;created_at:string};

export async function loader({request}:Route.LoaderArgs){
  const user=await requireSessionUser(request,"warehouse.view","warehouse");
  const warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected,url=new URL(request.url),orderId=url.searchParams.get("orderId");
  const [batches,dispatches,items]=await Promise.all([
    env.DB.prepare(`SELECT b.id,b.batch_number,b.shipment_id,s.shipment_number,o.id order_id,o.order_number,c.name customer_name,c.identity_code customer_identity_code,o.business_type,TRIM(o.destination_country||' '||COALESCE(o.destination_state||' ','')||o.destination_city||CASE WHEN NULLIF(TRIM(o.destination_address),'') IS NOT NULL THEN ' '||o.destination_address ELSE '' END) destination_location,COUNT(i.id) item_count FROM warehouse_sorting_batches b JOIN shipments s ON s.id=b.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id JOIN warehouse_sorting_items i ON i.batch_id=b.id JOIN warehouse_packages bp ON bp.id=i.package_id AND bp.warehouse_id=? WHERE b.organization_id=? AND b.status='verified' AND NOT EXISTS (SELECT 1 FROM warehouse_sorting_items xi JOIN warehouse_dispatch_items xdi ON xdi.package_id=xi.package_id JOIN warehouse_dispatches xd ON xd.id=xdi.dispatch_id WHERE xi.batch_id=b.id AND xd.status!='cancelled') GROUP BY b.id ORDER BY b.verified_at DESC`).bind(warehouse.id,user.organizationId).all<Batch>(),
    env.DB.prepare(`SELECT d.id,d.dispatch_number,b.batch_number,d.shipment_id,s.shipment_number,o.id order_id,o.order_number,GROUP_CONCAT(DISTINCT ps.order_id) related_order_ids,c.id customer_id,c.name customer_name,c.identity_code customer_identity_code,d.vehicle_plate,d.driver_name,d.driver_phone,d.carrier_name,d.seal_number,d.destination,d.status,COUNT(di.id) item_count,SUM(CASE WHEN di.status='loaded' THEN 1 ELSE 0 END) loaded_count,COALESCE(SUM(p.pieces),0) pieces,COALESCE(SUM(p.weight_kg),0) weight_kg,COALESCE(SUM(p.volume_cbm),0) volume_cbm,d.created_at,d.dispatched_at,u.display_name creator_name FROM warehouse_dispatches d JOIN warehouse_sorting_batches b ON b.id=d.sorting_batch_id JOIN shipments s ON s.id=d.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id LEFT JOIN warehouse_packages p ON p.id=di.package_id LEFT JOIN shipments ps ON ps.id=p.shipment_id LEFT JOIN users u ON u.id=d.created_by_user_id WHERE d.organization_id=? AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.dispatch_id=d.id AND wp.warehouse_id=?) GROUP BY d.id ORDER BY CASE d.status WHEN 'loading' THEN 1 ELSE 2 END,d.updated_at DESC LIMIT 50`).bind(user.organizationId,warehouse.id).all<Dispatch>(),
    env.DB.prepare(`SELECT di.id,di.dispatch_id,p.barcode,p.package_number,p.pieces,p.weight_kg,p.volume_cbm,di.status,di.loaded_at FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id WHERE di.organization_id=? AND p.warehouse_id=? ORDER BY COALESCE(di.loaded_at,p.created_at) DESC LIMIT 1000`).bind(user.organizationId,warehouse.id).all<Item>()
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
  return{
    user,warehouse,
    batches:evaluated.filter(item=>item.readiness.ready).map(item=>item.batch),
    blockedBatches:evaluated.filter(item=>!item.readiness.ready).map(item=>({id:item.batch.id,order_number:item.batch.order_number,batch_number:item.batch.batch_number,reasons:item.readiness.reasons})),
    dispatches:visibleDispatches,
    items:orderId?items.results.filter((item)=>visibleDispatchIds.has(item.dispatch_id)):items.results,
    orderId,
    workflowFieldsByOrder:Object.fromEntries(workflowFieldEntries),
    manifestsByOrder,
  };
}

export async function action({request}:Route.ActionArgs){
  const user=await requireSessionUser(request,"warehouse.operate","warehouse"),warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected,form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  await requireWarehouseAssignment(user,warehouse.id,"operator");
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
      return{formError:`未找到已确认货齐且尚未创建装车任务的订单：${orderNumber}。请确认：仓库已完成实收并勾选“货齐”；整车已有车辆安排，拼车已生成配载单并分配车辆。`};
    }    if(!batch)return{formError:`未找到已复核且尚未出库的批次${orderNumber?`：${orderNumber}`:""}，请核对订单号、客户识别码和分拣状态`};
    const workflowFields=await loadOrderModuleWorkflowFields(user.organizationId,batch.order_id,"loading");
    const sealPolicy=workflowFieldPolicy(workflowFields,"loading_seal_number","optional");
    const notesPolicy=workflowFieldPolicy(workflowFields,"loading_handover_notes","optional");
    if(sealPolicy.isActive&&sealPolicy.isRequired&&!seal)return{formError:"请填写封签号"};
    if(notesPolicy.isActive&&notesPolicy.isRequired&&!notes.trim())return{formError:"请填写装车交接备注"};
    const planned=await resolveDispatchPlan(user.organizationId,batch.order_id,batch.business_type);
    if("error" in planned)return{formError:planned.error};
    const plate=planned.vehicle_plate?.trim().toUpperCase()||"",driver=planned.driver_name?.trim()||"",phone=planned.driver_phone?.trim()||"",carrier=planned.carrier_name?.trim()||"",destination=batch.destination_location;
    if(!plate||!driver||!carrier)return{formError:"运输安排尚未完整：请先在运输安排中确定承运商、车辆和司机，再由仓库创建装车任务"};
    const loadReadiness=await checkOrderLoadPlan(user.organizationId,batch.order_id,plate);
    if(!loadReadiness.ready)return{formError:`暂不能创建装车任务：${loadReadiness.reasons.join("；")}`};
    if(planned.batch_id&&planned.vehicle_id){
      const vehicleOrders=await env.DB.prepare(`SELECT DISTINCT bo.order_id FROM transport_batch_orders bo JOIN order_cargo_packages p ON p.order_id=bo.order_id JOIN transport_vehicle_loads l ON l.batch_id=bo.batch_id AND l.package_id=p.id WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed' AND l.vehicle_id=?`).bind(user.organizationId,planned.batch_id,planned.vehicle_id).all<{order_id:string}>();
      for(const item of vehicleOrders.results){
        const readiness=await checkOrderLoadPlan(user.organizationId,item.order_id,plate);
        if(!readiness.ready)return{formError:`同车订单尚未全部具备装车条件：${readiness.reasons.join("；")}`};
      }
    }
    const dispatchId=crypto.randomUUID(),number=generateDispatch();
    const itemStatement=planned.batch_id&&planned.vehicle_id
      ? env.DB.prepare(`INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status)
          SELECT lower(hex(randomblob(16))),wsi.organization_id,?,wsi.package_id,'pending'
          FROM warehouse_sorting_items wsi
          JOIN warehouse_sorting_batches wsb ON wsb.id=wsi.batch_id AND wsb.status='verified'
          JOIN warehouse_packages wp ON wp.id=wsi.package_id
          JOIN shipments s ON s.id=wp.shipment_id
          JOIN transport_batch_orders bo ON bo.order_id=s.order_id AND bo.organization_id=wsi.organization_id AND bo.batch_id=? AND bo.status!='removed'
          WHERE wsi.organization_id=? AND wsi.status='verified'
            AND EXISTS (SELECT 1 FROM order_cargo_packages p JOIN transport_vehicle_loads l ON l.package_id=p.id AND l.batch_id=bo.batch_id WHERE p.order_id=bo.order_id AND l.vehicle_id=?)
            AND NOT EXISTS (SELECT 1 FROM warehouse_dispatch_items xdi JOIN warehouse_dispatches xd ON xd.id=xdi.dispatch_id WHERE xdi.package_id=wsi.package_id AND xd.status!='cancelled')`).bind(dispatchId,planned.batch_id,user.organizationId,planned.vehicle_id)
      : env.DB.prepare(`INSERT INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status) SELECT lower(hex(randomblob(16))),organization_id,?,package_id,'pending' FROM warehouse_sorting_items WHERE batch_id=? AND status='verified'`).bind(dispatchId,batch.id);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO warehouse_dispatches(id,organization_id,dispatch_number,sorting_batch_id,shipment_id,vehicle_plate,driver_name,driver_phone,carrier_name,seal_number,destination,status,notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'loading',?,?,?,?)`).bind(dispatchId,user.organizationId,number,batch.id,batch.shipment_id,plate,driver,phone||null,carrier||null,sealPolicy.isActive?(seal||null):null,destination,notesPolicy.isActive?(notes||null):null,user.userId,now,now),
      itemStatement
    ]);
    await recordWarehouseProgress({organizationId:user.organizationId,orderId:batch.order_id,actorUserId:user.userId,stepCode:"loading",stepName:"按配载批次装车",actionCode:"dispatch_create",actionName:"创建批次装车任务",notes:`装车任务 ${number}；车辆 ${plate}`});
    await writeAudit({request,action:"warehouse.dispatch.create",resourceType:"warehouse_dispatch",resourceId:dispatchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{number,batchId:batch.id,orderNumber:batch.order_number,customerIdentityCode:batch.customer_identity_code,plate,driver}});
    return{success:`装车任务 ${number} 已创建`};
  }
  const dispatchId=valueOf(form,"dispatchId"),dispatch=await env.DB.prepare(`SELECT d.id,d.shipment_id,s.order_id,d.status,d.dispatch_number,d.vehicle_plate,d.driver_name,d.destination FROM warehouse_dispatches d JOIN shipments s ON s.id=d.shipment_id WHERE d.id=? AND d.organization_id=? AND EXISTS(SELECT 1 FROM warehouse_dispatch_items wi JOIN warehouse_packages wp ON wp.id=wi.package_id WHERE wi.dispatch_id=d.id AND wp.warehouse_id=?)`).bind(dispatchId,user.organizationId,warehouse.id).first<{id:string;shipment_id:string;order_id:string;status:string;dispatch_number:string;vehicle_plate:string;driver_name:string;destination:string}>();
  if(!dispatch)return{formError:"装车任务不存在"};
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
    const shipments=await env.DB.prepare(`SELECT DISTINCT s.id shipment_id,s.order_id,s.customer_id,s.current_location FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id WHERE di.dispatch_id=? AND di.organization_id=?`).bind(dispatch.id,user.organizationId).all<{shipment_id:string;order_id:string;customer_id:string;current_location:string|null}>();
    if(!shipments.results.length)return{formError:"关联运单不存在"};
    const departureBlockers:string[]=[];
    for(const shipment of shipments.results){
      const readiness=await checkOrderDeparture(user.organizationId,shipment.order_id,dispatch.vehicle_plate,{warehouseDispatchConfirmed:true});
      if(!readiness.ready)departureBlockers.push(...readiness.reasons);
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
  const selectedFields=loaderData.orderId?loaderData.workflowFieldsByOrder[loaderData.orderId]??[]:[];
  const sealPolicy=workflowFieldPolicy(selectedFields,"loading_seal_number","optional");
  const notesPolicy=workflowFieldPolicy(selectedFields,"loading_handover_notes","optional");
  const selectedBatch=loaderData.batches.find((batch)=>batch.order_id===loaderData.orderId);
  return <><header className="page-header" id="warehouse-outbound-workbench"><div><p className="eyebrow">PICK · LOAD · DISPATCH</p><h1>按运输方案装车出库</h1><p>整车读取本单车辆安排，拼车读取配载单与装载指令；运输方案完整后，仓库按车辆拣货、扫码装车并完成出库交接。</p></div>{canOperate&&<Modal title="新建装车任务" triggerLabel={loaderData.orderId?"下一步：新建本单装车任务":"＋ 新建装车任务"} closeSignal={actionData?.success}><Form method="post" className="stack"><input type="hidden" name="intent" value="create"/><label className="field scan-field"><span>订单号快速定位</span><input name="orderNumber" autoComplete="off" placeholder="扫描或输入完整订单号" defaultValue={selectedBatch?.order_number??""}/><small>整车须已确定车辆；拼车须已加入配载单并分配到具体车辆，系统会自动读取结果。</small></label><label className="field scan-field"><span>客户识别码（可选核对）</span><input name="customerIdentityCode" autoComplete="off" maxLength={5} placeholder="例如 A2B3C"/><small>填写后只允许创建该客户名下订单的装车任务。</small></label><label className="field"><span>收货清点记录（可选）</span><select name="batchId" defaultValue={selectedBatch?.id??""}><option value="">通过订单号定位时无需选择</option>{loaderData.batches.map(x=><option key={x.id} value={x.id}>[{x.customer_identity_code}] {x.order_number} · {x.batch_number} · {x.shipment_number} · {x.customer_name} · {x.item_count} 件货物</option>)}</select></label><div className="inherited-data-strip"><span>运输方案与车辆<strong>自动继承操作结果</strong><small>整车缺车辆、拼车缺配载单或装载指令时禁止创建</small></span><span>承运商与目的地<strong>自动继承运输安排</strong><small>仓库无需重复填写</small></span></div>{sealPolicy.isActive&&<label className="field"><span>封签号（仓库填写）</span><input name="sealNumber" required={sealPolicy.isRequired}/></label>}{notesPolicy.isActive&&<label className="field"><span>交接备注</span><textarea name="notes" rows={3} required={notesPolicy.isRequired}/></label>}<button className="primary warehouse-primary" disabled={busy}>校验运输方案并创建装车任务</button></Form></Modal>}</header>
    {(actionData?.success||actionData?.formError)&&<div className={`alert ${actionData.formError?"error":"success"}`}>
      <span>{actionData.formError??actionData.success}</span>
      {actionData.formError?.includes("发运前文件")&&loaderData.orderId&&<Link className="secondary" to={`/admin/orders/${loaderData.orderId}/modules/loading#module-source-documents`}>去上传并审核发运前文件</Link>}
    </div>}
    {loaderData.blockedBatches.length>0&&<section className="panel"><div className="panel-header"><div><h2>货齐但尚不可装车</h2><p>这些订单还没有完成配载成单、批次车辆安排或整票装载指令，因此不会出现在可创建装车任务列表中。</p></div><span>{loaderData.blockedBatches.length} 票</span></div><div className="simple-list">{loaderData.blockedBatches.map(item=><div key={item.id}><div><strong>{item.order_number}</strong><small>{item.batch_number}</small></div><span>{item.reasons.join("；")}</span></div>)}</div></section>}
    <section className="stats"><article><span>待装车</span><strong>{loading.length}</strong><small>正在执行装车扫描</small></article><article><span>可创建任务</span><strong>{loaderData.batches.length}</strong><small>已完成复核的批次</small></article><article><span>已装车待出境</span><strong>{completed.length}</strong><small>已生成仓库交接记录</small></article></section>
    <div className="dispatch-list">{loading.map(task=><DispatchCard key={task.id} task={task} items={loaderData.items.filter(x=>x.dispatch_id===task.id)} fields={loaderData.workflowFieldsByOrder[task.order_id]??[]} manifest={loaderData.manifestsByOrder[task.order_id]} busy={busy}/>)}</div>{!loading.length&&<p className="empty-state">暂无装车中的任务，请从已确认货齐的订单新建。</p>}
    <section className="panel handover-section"><div className="panel-header no-print"><div><h2>已装车待出境与交接单</h2><p>仓库交接完成不等于车辆已经出境；返回配载批次确认实际出境后，运单才进入在途。</p></div><button className="secondary" type="button" onClick={()=>window.print()}>打印交接单</button></div><div className="handover-list">{completed.map(task=><Handover key={task.id} task={task} items={loaderData.items.filter(x=>x.dispatch_id===task.id)} manifest={loaderData.manifestsByOrder[task.order_id]}/>)}</div>{!completed.length&&<p className="empty-state">暂无已装车交接单。</p>}</section>
  </>;
}
function DispatchCard({task,items,fields,manifest,busy}:{task:Dispatch;items:Item[];fields:WorkflowFieldState[];manifest?:ManifestDoc;busy:boolean}){const scanPolicy=workflowFieldPolicy(fields,"loading_scan_confirmation","required"),canComplete=!scanPolicy.isActive||!scanPolicy.isRequired||task.loaded_count===task.item_count;return <article className="panel dispatch-card"><div className="panel-header"><div><h2>{task.dispatch_number}</h2><p>[{task.customer_identity_code}] {task.order_number} · {task.batch_number} · {task.shipment_number} · {task.customer_name}</p></div><div className="dispatch-progress"><strong>{task.loaded_count}/{task.item_count}</strong><span>已装车</span></div></div><div className="dispatch-meta"><span>车辆 <strong>{task.vehicle_plate}</strong></span><span>司机 <strong>{task.driver_name}</strong></span><span>目的地 <strong>{task.destination}</strong></span></div>{manifest&&<div className="dispatch-meta"><span>配载单 <a href={manifest.data_url} target="_blank" rel="noreferrer">{manifest.file_name}</a><small>（工作台自动生成，点击打开对照装车）</small></span></div>}{scanPolicy.isActive&&<Form method="post" className="scan-inline"><input type="hidden" name="intent" value="load"/><input type="hidden" name="dispatchId" value={task.id}/><label className="field"><span>扫描装车标签</span><input name="barcode" placeholder="逐件扫描货物条码" autoComplete="off" required={scanPolicy.isRequired}/></label><button className="primary warehouse-primary" disabled={busy}>确认装车</button></Form>}<div className="batch-items">{items.map(item=><div key={item.id}><code>{item.barcode}</code><span>{item.pieces} 件{item.weight_kg?` · ${item.weight_kg} KG`:""}</span><span className={`status-pill ${item.status!=="loaded"?"off":""}`}>{item.status==="loaded"?"已装车":"待扫描"}</span></div>)}</div><Form method="post" className="dispatch-confirm"><input type="hidden" name="intent" value="dispatch"/><input type="hidden" name="dispatchId" value={task.id}/><button className="secondary" disabled={busy||!canComplete}>全部核对无误，完成装车出库交接</button></Form></article>}
function Handover({task,items,manifest}:{task:Dispatch;items:Item[];manifest?:ManifestDoc}){return <article className="handover-sheet"><header><div><strong>欧凌国际物流</strong><h2>仓库装车交接单</h2></div><b>{task.dispatch_number}</b></header>{manifest&&<p className="handover-manifest-link no-print">配载单：<a href={manifest.data_url} target="_blank" rel="noreferrer">{manifest.file_name}</a>（点击打开核对装载顺序）</p>}<div className="handover-grid"><span>客户识别码：<strong>{task.customer_identity_code}</strong></span><span>运单：<strong>{task.shipment_number}</strong></span><span>订单：<strong>{task.order_number}</strong></span><span>客户：<strong>{task.customer_name}</strong></span><span>目的地：<strong>{task.destination}</strong></span><span>车牌：<strong>{task.vehicle_plate}</strong></span><span>司机：<strong>{task.driver_name}</strong></span><span>电话：<strong>{task.driver_phone||"—"}</strong></span><span>承运商：<strong>{task.carrier_name||"—"}</strong></span><span>封签号：<strong>{task.seal_number||"—"}</strong></span><span>发车时间：<strong>{task.dispatched_at?new Date(task.dispatched_at).toLocaleString("zh-CN"):"—"}</strong></span></div><table><thead><tr><th>序号</th><th>货物条码</th><th>件数</th><th>重量 KG</th><th>体积 CBM</th></tr></thead><tbody>{items.map((item,index)=><tr key={item.id}><td>{index+1}</td><td>{item.barcode}</td><td>{item.pieces}</td><td>{item.weight_kg??"—"}</td><td>{item.volume_cbm??"—"}</td></tr>)}</tbody><tfoot><tr><td colSpan={2}>合计</td><td>{task.pieces}</td><td>{task.weight_kg}</td><td>{task.volume_cbm}</td></tr></tfoot></table><footer><span>仓库交接人签字：________________</span><span>司机签字：________________</span><span>交接时间：________________</span></footer></article>}
function generateDispatch(){return `OUT-${new Date().toISOString().slice(2,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,5).toUpperCase()}`}
async function resolveDispatchPlan(organizationId:string,orderId:string,businessType:string):Promise<DispatchPlan|{error:string}>{
  if(businessType==="ltl"){
    const rows=await env.DB.prepare(`SELECT DISTINCT b.id batch_id,v.id vehicle_id,v.plate_number vehicle_plate,v.driver_name,v.driver_phone,COALESCE(vc.name,bc.name) carrier_name
      FROM transport_batch_orders bo
      JOIN transport_batches b ON b.id=bo.batch_id AND b.status='loading'
      JOIN order_cargo_packages p ON p.order_id=bo.order_id AND p.status!='cancelled'
      JOIN transport_vehicle_loads l ON l.batch_id=b.id AND l.package_id=p.id
      JOIN transport_batch_vehicles v ON v.id=l.vehicle_id AND v.status!='cancelled'
      LEFT JOIN carriers vc ON vc.id=v.carrier_id
      LEFT JOIN carriers bc ON bc.id=b.carrier_id
      WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
      ORDER BY v.created_at LIMIT 2`).bind(organizationId,orderId).all<DispatchPlan&{id:string}>();
    if(!rows.results.length)return{error:"尚未找到该订单的配载车辆；请先生成配载批次并完成批次运输安排"};
    if(rows.results.length>1)return{error:"该订单被分配到多辆车，当前仓库装车任务要求整票订单使用同一辆车，请先调整配载"};
    return rows.results[0];
  }
  const row=await env.DB.prepare(`SELECT NULL batch_id,NULL vehicle_id,a.plate_number vehicle_plate,a.driver_name,a.driver_phone,COALESCE(c.name,a.carrier_name) carrier_name
    FROM order_transport_assignments a LEFT JOIN carriers c ON c.id=a.carrier_id
    WHERE a.organization_id=? AND a.order_id=? AND a.status!='cancelled'
    ORDER BY CASE a.leg_type WHEN 'main' THEN 0 WHEN 'first_mile' THEN 1 ELSE 2 END,a.created_at DESC LIMIT 1`).bind(organizationId,orderId).first<DispatchPlan>();
  return row??{error:"尚未找到订单运输安排；请先确定承运商、车辆和司机"};
}
export function meta(){return[{title:"装车出库 | International TMS"}]}
