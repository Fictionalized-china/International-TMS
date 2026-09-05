import { env } from "cloudflare:workers";
import { useEffect, useMemo, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.cargo-consolidation";
import { Modal } from "../components/Modal";
import { ConfirmAction } from "../components/ConfirmAction";
import { writeAudit } from "../lib/audit.server";
import { requireSessionUser } from "../lib/auth.server";
import { ensureOrderModules, syncOrderWorkflowSnapshot } from "../lib/order-modules.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { refreshLoadingManifest } from "../lib/loading-manifest.server";
import { synchronizeBatchTransport } from "../lib/batch-transport-sync.server";
import { synchronizeOrderExceptionStatuses } from "../lib/order-exception-status.server";
import {
  loadingOrderDocumentDefinitions,
  type EffectiveLoadingDocumentRequirement,
} from "../lib/loading-document-requirements";
import { loadOrderLoadingDocumentRequirements } from "../lib/loading-document-requirements.server";
import {
  loadingBatchRequiredValueError,
  loadingBatchResourcePolicy,
  resolveLoadingBatchFieldPolicies,
  type LoadingBatchFieldPolicies,
  type LoadingBatchWorkflowOrder,
} from "../lib/loading-batch-field-policy";
import { loadLoadingBatchWorkflowOrders } from "../lib/loading-batch-field-policy.server";
import { valueOf } from "../lib/validation";
import { chunkD1Rows, chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import { paginateList } from "../lib/list-pagination";

const PAGE_SIZE=10;
type ConsolidationView="stock"|"batches";

type StockRow={
  order_id:string;order_number:string;business_type:string;customer_name:string;
  cargo_names:string|null;overseas_warehouse_id:string|null;overseas_warehouse_name:string|null;
  destination_country:string;destination_state:string|null;destination_city:string;
  exit_port:string|null;customs_location:string|null;package_count:number;pieces:number;
  weight_kg:number;volume_cbm:number;location_names:string|null;cargo_ready:number;
  has_exception:number;active_dispatch:number;active_batch_id:string|null;active_batch_number:string|null;
  operation_supervisor_user_id:string|null;
};

type BatchRow={
  id:string;batch_number:string;batch_name:string;destination_location:string;
  border_port:string|null;customs_location:string|null;planned_loading_at:string|null;planned_departure_at:string|null;
  status:string;road_status:string;approval_status:string;order_count:number;order_numbers:string;
  total_weight:number;total_volume:number;has_dispatch:number;has_started:number;created_at:string;
  carrier_id:string|null;overseas_carrier_name:string|null;overseas_vehicle_plate:string|null;
  overseas_driver_name:string|null;vehicle_master_id:string|null;driver_master_id:string|null;
};
type AvailableBatch=Pick<BatchRow,"id"|"batch_number"|"destination_location">;

type BatchOrder={batch_id:string;order_id:string;order_number:string;customer_name:string;cargo_names:string|null;weight_kg:number;volume_cbm:number};
type LatestRequiredDocument={order_id:string;attachment_id:string;document_category:string;review_status:string};
type Selection={orderId:string;orderNumber:string;customerName:string;packages:number;pieces:number;weight:number;volume:number;loadingWorkflow:LoadingBatchWorkflowOrder};
type CandidateState=StockRow&{origin_country:string;origin_state:string|null;origin_city:string};
type TargetBatch={id:string;batch_number:string;warehouse_id:string;status:string;approval_status:string;operation_supervisor_user_id:string|null;destination_location:string;border_port:string|null;customs_location:string|null};
type CarrierOption={id:string;name:string};
type CarrierVehicleOption={id:string;carrier_id:string;plate_number:string;vehicle_type:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null;carrier_name:string};
type CarrierDriverOption={id:string;carrier_id:string;name:string;phone:string|null;carrier_name:string};
type BatchResource={carrierId:string|null;carrierName:string|null;vehicleMasterId:string|null;vehicleType:string|null;plateNumber:string|null;capacityWeight:number;capacityVolume:number;driverMasterId:string|null;driverName:string|null;driverPhone:string|null};
type ReferenceOption={category:"border_port"|"customs_place";code:string;name:string};

const stockCtes=`WITH stock AS (
    SELECT s.order_id,COUNT(p.id) package_count,COALESCE(SUM(p.pieces),0) pieces,
      COALESCE(SUM(p.weight_kg),0) weight_kg,COALESCE(SUM(p.volume_cbm),0) volume_cbm,
      GROUP_CONCAT(DISTINCT wl.name) location_names
    FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id
    LEFT JOIN warehouse_locations wl ON wl.id=p.location_id
    WHERE p.organization_id=? AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')
    GROUP BY s.order_id
  ), ready AS (
    SELECT DISTINCT s.order_id FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id
    WHERE r.organization_id=? AND r.warehouse_id=? AND r.status='completed' AND r.cargo_complete=1
  ), exception_orders AS (
    SELECT DISTINCT s.order_id FROM warehouse_exceptions e JOIN shipments s ON s.id=e.shipment_id
    WHERE e.organization_id=? AND e.status IN ('open','processing')
  ), dispatch_orders AS (
    SELECT DISTINCT s.order_id FROM warehouse_dispatches d
    JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id
    JOIN shipments s ON s.id=p.shipment_id
    WHERE d.organization_id=? AND p.warehouse_id=? AND d.status!='cancelled'
  ), active_batch AS (
    SELECT bo.order_id,b.id batch_id,b.batch_number,
      ROW_NUMBER() OVER(PARTITION BY bo.order_id ORDER BY b.updated_at DESC) row_no
    FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
    WHERE bo.organization_id=? AND bo.status!='removed' AND b.status!='cancelled' AND b.batch_number LIKE 'PZ-%'
  )`;
const stockFrom=` FROM stock st JOIN transport_orders o ON o.id=st.order_id
  JOIN customers c ON c.id=o.customer_id
  LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
  LEFT JOIN active_batch ab ON ab.order_id=o.id AND ab.row_no=1
  LEFT JOIN ready rr ON rr.order_id=o.id LEFT JOIN exception_orders eo ON eo.order_id=o.id
  LEFT JOIN dispatch_orders dd ON dd.order_id=o.id WHERE 1=1`;

function stockBindings(organizationId:string,warehouseId:string){return[organizationId,warehouseId,organizationId,warehouseId,organizationId,organizationId,warehouseId,organizationId]}
function rowSelectSql(){return`SELECT o.id order_id,o.order_number,o.business_type,c.name customer_name,
    (SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.organization_id=o.organization_id AND i.order_id=o.id) cargo_names,
    o.overseas_warehouse_id,ow.name overseas_warehouse_name,o.destination_country,o.destination_state,o.destination_city,o.operation_supervisor_user_id,
    o.exit_port,o.customs_location,st.package_count,st.pieces,st.weight_kg,st.volume_cbm,st.location_names,
    CASE WHEN rr.order_id IS NULL THEN 0 ELSE 1 END cargo_ready,
    CASE WHEN eo.order_id IS NULL THEN 0 ELSE 1 END has_exception,
    CASE WHEN dd.order_id IS NULL THEN 0 ELSE 1 END active_dispatch,
    ab.batch_id active_batch_id,ab.batch_number active_batch_number`}

export async function loader({request}:Route.LoaderArgs){
  const user=await requireSessionUser(request,"warehouse.view","warehouse");
  const context=await loadWarehouseContext(request,user),warehouse=context.selected;
  if(warehouse.warehouse_role==="overseas_destination")throw new Response("境外目的仓不办理货物配载",{status:403});
  const url=new URL(request.url),view:ConsolidationView=url.searchParams.get("view")==="batches"?"batches":"stock";
  const page=Math.max(1,Number(url.searchParams.get("page"))||1),batchPage=Math.max(1,Number(url.searchParams.get("batchPage"))||1),pageSize=PAGE_SIZE;
  const filters={warehouse:url.searchParams.get("destinationWarehouse")?.trim()??"",country:url.searchParams.get("country")?.trim()??"",state:url.searchParams.get("state")?.trim()??"",city:url.searchParams.get("city")?.trim()??"",customer:url.searchParams.get("customer")?.trim()??"",eligibility:url.searchParams.get("eligibility")?.trim()??"",keyword:url.searchParams.get("q")?.trim()??""};
  const batchFilters={
    keyword:url.searchParams.get("batchQ")?.trim()??"",
    approval:url.searchParams.get("batchApproval")?.trim()??"",
    loading:url.searchParams.get("batchLoading")?.trim()??"",
    destination:url.searchParams.get("batchDestination")?.trim()??"",
    carrier:url.searchParams.get("batchCarrier")?.trim()??"",
    plannedFrom:url.searchParams.get("batchPlannedFrom")?.trim()??"",
    plannedTo:url.searchParams.get("batchPlannedTo")?.trim()??"",
  };
  const clauses:string[]=[],bindings:string[]=[];
  const like=(column:string,value:string)=>{if(value){clauses.push(`${column} LIKE ?`);bindings.push(`%${value}%`)}};
  like("COALESCE(ow.name,'')",filters.warehouse);like("o.destination_country",filters.country);like("COALESCE(o.destination_state,'')",filters.state);like("o.destination_city",filters.city);like("c.name",filters.customer);
  if(filters.keyword){clauses.push("(o.order_number LIKE ? OR c.name LIKE ? OR COALESCE(o.cargo_description,'') LIKE ? OR EXISTS(SELECT 1 FROM order_cargo_items qi WHERE qi.order_id=o.id AND COALESCE(qi.cargo_name_cn,'') LIKE ?))");bindings.push(...Array(4).fill(`%${filters.keyword}%`))}
  if(filters.eligibility==="eligible")clauses.push("o.business_type='ltl' AND rr.order_id IS NOT NULL AND eo.order_id IS NULL AND dd.order_id IS NULL AND ab.batch_id IS NULL");
  if(filters.eligibility==="assigned")clauses.push("ab.batch_id IS NOT NULL");
  if(filters.eligibility==="blocked")clauses.push("ab.batch_id IS NULL AND (o.business_type!='ltl' OR rr.order_id IS NULL OR eo.order_id IS NOT NULL OR dd.order_id IS NOT NULL)");
  const filterSql=clauses.length?` AND ${clauses.join(" AND ")}`:"",baseBindings=stockBindings(user.organizationId,warehouse.id);
  const totalRow=await env.DB.prepare(`${stockCtes} SELECT COUNT(*) total ${stockFrom}${filterSql}`).bind(...baseBindings,...bindings).first<{total:number}>();
  const total=totalRow?.total??0,pages=Math.max(1,Math.ceil(total/pageSize)),safePage=Math.min(page,pages);
  const batchClauses:string[]=[],batchBindings:string[]=[];
  const batchDispatchExists="EXISTS(SELECT 1 FROM warehouse_dispatches d WHERE d.transport_batch_id=b.id AND d.status!='cancelled')";
  const batchStartedExists="EXISTS(SELECT 1 FROM warehouse_dispatches d LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id WHERE d.transport_batch_id=b.id AND d.status!='cancelled' AND (d.status='dispatched' OR di.status!='pending'))";
  if(batchFilters.keyword){
    batchClauses.push(`(b.batch_number LIKE ? OR COALESCE(b.batch_name,'') LIKE ? OR COALESCE(b.overseas_carrier_name,'') LIKE ? OR COALESCE(b.overseas_vehicle_plate,'') LIKE ? OR EXISTS(
      SELECT 1 FROM transport_batch_orders fbo JOIN transport_orders fo ON fo.id=fbo.order_id LEFT JOIN customers fc ON fc.id=fo.customer_id
      WHERE fbo.batch_id=b.id AND fbo.status!='removed' AND (fo.order_number LIKE ? OR COALESCE(fc.name,'') LIKE ?)))`);
    batchBindings.push(...Array(6).fill(`%${batchFilters.keyword}%`));
  }
  if(["draft","submitted","approved","rejected"].includes(batchFilters.approval)){batchClauses.push("b.approval_status=?");batchBindings.push(batchFilters.approval)}
  if(batchFilters.loading==="waiting")batchClauses.push(`NOT ${batchDispatchExists}`);
  if(batchFilters.loading==="task_created")batchClauses.push(`${batchDispatchExists} AND NOT ${batchStartedExists}`);
  if(batchFilters.loading==="started")batchClauses.push(batchStartedExists);
  if(batchFilters.destination){batchClauses.push("COALESCE(b.destination_location,'') LIKE ?");batchBindings.push(`%${batchFilters.destination}%`)}
  if(batchFilters.carrier){batchClauses.push("COALESCE(b.overseas_carrier_name,'') LIKE ?");batchBindings.push(`%${batchFilters.carrier}%`)}
  if(batchFilters.plannedFrom){batchClauses.push("date(b.planned_loading_at)>=date(?)");batchBindings.push(batchFilters.plannedFrom)}
  if(batchFilters.plannedTo){batchClauses.push("date(b.planned_loading_at)<=date(?)");batchBindings.push(batchFilters.plannedTo)}
  const batchFilterSql=batchClauses.length?` AND ${batchClauses.join(" AND ")}`:"";
  const batchTotalRow=await env.DB.prepare(`SELECT COUNT(*) total FROM transport_batches b
    WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled'
      AND EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.organization_id=b.organization_id AND bo.batch_id=b.id AND bo.status!='removed')${batchFilterSql}`).bind(user.organizationId,warehouse.id,...batchBindings).first<{total:number}>();
  const batchTotal=batchTotalRow?.total??0,batchPages=Math.max(1,Math.ceil(batchTotal/pageSize)),safeBatchPage=Math.min(batchPage,batchPages);
  const [rows,options,batches,batchOptions,availableBatches,batchOrders]=await Promise.all([
    env.DB.prepare(`${stockCtes} ${rowSelectSql()} ${stockFrom}${filterSql} ORDER BY CASE WHEN ab.batch_id IS NULL THEN 0 ELSE 1 END,o.updated_at DESC LIMIT ? OFFSET ?`).bind(...baseBindings,...bindings,pageSize,(safePage-1)*pageSize).all<StockRow>(),
    env.DB.prepare(`${stockCtes} SELECT DISTINCT COALESCE(ow.name,'') overseas_warehouse_name,o.destination_country,o.destination_state,o.destination_city,c.name customer_name ${stockFrom} ORDER BY overseas_warehouse_name,o.destination_country,o.destination_state,o.destination_city`).bind(...baseBindings).all<StockRow&{customer_name:string}>(),
    env.DB.prepare(`SELECT b.id,b.batch_number,b.batch_name,b.destination_location,b.border_port,b.customs_location,b.planned_loading_at,b.planned_departure_at,b.status,b.road_status,b.approval_status,b.created_at,
      b.carrier_id,b.overseas_carrier_name,b.overseas_vehicle_plate,b.overseas_driver_name,
      (SELECT v.vehicle_master_id FROM transport_batch_vehicles v WHERE v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled' ORDER BY v.created_at LIMIT 1) vehicle_master_id,
      (SELECT v.driver_master_id FROM transport_batch_vehicles v WHERE v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled' ORDER BY v.created_at LIMIT 1) driver_master_id,
      COUNT(DISTINCT bo.order_id) order_count,GROUP_CONCAT(DISTINCT o.order_number) order_numbers,
      COALESCE(SUM((SELECT SUM(p.weight_kg) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id=o.id AND p.warehouse_id=b.warehouse_id AND p.status IN ('in_stock','allocated'))),0) total_weight,
      COALESCE(SUM((SELECT SUM(p.volume_cbm) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id=o.id AND p.warehouse_id=b.warehouse_id AND p.status IN ('in_stock','allocated'))),0) total_volume,
      EXISTS(SELECT 1 FROM warehouse_dispatches d WHERE d.transport_batch_id=b.id AND d.status!='cancelled') has_dispatch,
      EXISTS(SELECT 1 FROM warehouse_dispatches d LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
        WHERE d.transport_batch_id=b.id AND d.status!='cancelled' AND (d.status='dispatched' OR di.status!='pending')) has_started
      FROM transport_batches b JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.status!='removed'
      JOIN transport_orders o ON o.id=bo.order_id WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled'
      ${batchFilterSql} GROUP BY b.id ORDER BY b.updated_at DESC LIMIT ? OFFSET ?`).bind(user.organizationId,warehouse.id,...batchBindings,pageSize,(safeBatchPage-1)*pageSize).all<BatchRow>(),
    env.DB.prepare(`SELECT DISTINCT COALESCE(b.destination_location,'') destination_location,COALESCE(b.overseas_carrier_name,'') overseas_carrier_name
      FROM transport_batches b WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled'
      ORDER BY destination_location,overseas_carrier_name`).bind(user.organizationId,warehouse.id).all<Pick<BatchRow,"destination_location"|"overseas_carrier_name">>(),
    env.DB.prepare(`SELECT b.id,b.batch_number,b.destination_location FROM transport_batches b
      WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status IN ('planning','loading')
        AND b.approval_status IN ('draft','rejected')
        AND EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.organization_id=b.organization_id AND bo.batch_id=b.id AND bo.status!='removed')
        AND NOT EXISTS(SELECT 1 FROM warehouse_dispatches d LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
          WHERE d.transport_batch_id=b.id AND d.status!='cancelled' AND (d.status='dispatched' OR di.status!='pending'))
      ORDER BY b.updated_at DESC LIMIT 100`).bind(user.organizationId,warehouse.id).all<AvailableBatch>(),
    env.DB.prepare(`SELECT bo.batch_id,o.id order_id,o.order_number,c.name customer_name,
      (SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.organization_id=o.organization_id AND i.order_id=o.id) cargo_names,
      COALESCE((SELECT SUM(p.weight_kg) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id=o.id AND p.warehouse_id=b.warehouse_id AND p.status IN ('in_stock','allocated')),0) weight_kg,
      COALESCE((SELECT SUM(p.volume_cbm) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id=o.id AND p.warehouse_id=b.warehouse_id AND p.status IN ('in_stock','allocated')),0) volume_cbm
      FROM transport_batches b JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.status!='removed'
      JOIN transport_orders o ON o.id=bo.order_id JOIN customers c ON c.id=o.customer_id
      WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled'
      ORDER BY b.updated_at DESC,bo.sequence_no LIMIT 500`).bind(user.organizationId,warehouse.id).all<BatchOrder>(),
  ]);
  const [carriers,carrierVehicles,carrierDrivers,routeOptions]=await Promise.all([
    env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND status='active' AND carrier_scope='overseas' ORDER BY name").bind(user.organizationId).all<CarrierOption>(),
    env.DB.prepare(`SELECT v.id,v.carrier_id,v.plate_number,v.vehicle_type,v.capacity_weight_kg,v.capacity_volume_cbm,c.name carrier_name FROM carrier_vehicles v JOIN carriers c ON c.id=v.carrier_id WHERE v.organization_id=? AND v.status='active' AND c.status='active' AND c.carrier_scope='overseas' ORDER BY c.name,v.plate_number`).bind(user.organizationId).all<CarrierVehicleOption>(),
    env.DB.prepare(`SELECT d.id,d.carrier_id,d.name,d.phone,c.name carrier_name FROM carrier_drivers d JOIN carriers c ON c.id=d.carrier_id WHERE d.organization_id=? AND d.status='active' AND c.status='active' AND c.carrier_scope='overseas' ORDER BY c.name,d.name`).bind(user.organizationId).all<CarrierDriverOption>(),
    env.DB.prepare("SELECT category,code,name FROM reference_data WHERE organization_id=? AND category IN ('border_port','customs_place') AND status='active' ORDER BY category,sort_order,code").bind(user.organizationId).all<ReferenceOption>(),
  ]);
  const orderIds=rows.results.map(row=>row.order_id);
  const[orderDocumentRequirements,latestRequiredDocuments,loadingWorkflowOrders]=await Promise.all([
    loadOrderLoadingDocumentRequirements(user.organizationId,orderIds),
    loadLatestRequiredDocuments(user.organizationId,orderIds),
    loadLoadingBatchWorkflowOrders(user.organizationId,orderIds),
  ]);
  return{user,warehouse,view,rows:rows.results,options:options.results,batches:batches.results,batchOptions:batchOptions.results,availableBatches:availableBatches.results,batchOrders:batchOrders.results,carriers:carriers.results,carrierVehicles:carrierVehicles.results,carrierDrivers:carrierDrivers.results,borderPorts:routeOptions.results.filter(item=>item.category==="border_port"),customsPlaces:routeOptions.results.filter(item=>item.category==="customs_place"),orderDocumentRequirements,latestRequiredDocuments,loadingWorkflowOrders,filters,batchFilters,page:safePage,pageSize,pages,total,batchPage:safeBatchPage,batchPages,batchTotal};
}

export async function action({request}:Route.ActionArgs){
  const user=await requireSessionUser(request,"warehouse.operate","warehouse");
  const context=await loadWarehouseContext(request,user),warehouse=context.selected;
  await requireWarehouseAssignment(user,warehouse.id,"operator");
  const form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  if(intent==="resubmit"){
    const batchId=valueOf(form,"batchId"),batch=await editableBatch(user.organizationId,warehouse.id,batchId);
    if(!batch)return{formError:"配载单不存在、已开始装车或当前不能重新提交"};
    const submitted=await env.DB.prepare(`UPDATE transport_batches
      SET approval_status='submitted',submitted_by_user_id=?,submitted_at=?,approval_notes=NULL,updated_at=?
      WHERE id=? AND organization_id=? AND warehouse_id=? AND batch_number LIKE 'PZ-%'
        AND approval_status='rejected' AND operation_supervisor_user_id IS NOT NULL`)
      .bind(user.userId,now,now,batchId,user.organizationId,warehouse.id).run();
    if(!Number(submitted.meta?.changes||0))return{formError:"仅已退回且仍有指定操作主管的配载单可以重新提交"};
    await writeAudit({request,action:"warehouse.consolidation.resubmit",resourceType:"transport_batch",resourceId:batchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber:batch.batch_number}});
    return{success:`配载单 ${batch.batch_number} 已重新提交操作主管审核`,batchId};
  }
  if(intent==="resource"){
    const batchId=valueOf(form,"batchId"),batch=await editableBatch(user.organizationId,warehouse.id,batchId);
    if(!batch)return{formError:"配载单不存在、已开始装车或不能修改车辆安排"};
    const plannedDepartureAt=valueOf(form,"plannedDepartureAt").trim();
    if(!plannedDepartureAt)return{formError:"请填写计划出境发车时间"};
    const resource=await resolveBatchResource(user.organizationId,form);
    if("error" in resource)return{formError:resource.error};
    const existingVehicle=await env.DB.prepare("SELECT id FROM transport_batch_vehicles WHERE batch_id=? AND organization_id=? AND status!='cancelled' ORDER BY created_at LIMIT 1").bind(batchId,user.organizationId).first<{id:string}>();
    const vehicleId=existingVehicle?.id??crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE transport_batches SET carrier_id=?,overseas_carrier_name=?,overseas_vehicle_type=?,overseas_vehicle_count=1,overseas_vehicle_plate=?,overseas_driver_name=?,overseas_driver_phone=?,planned_departure_at=?,updated_at=? WHERE id=? AND organization_id=?").bind(resource.carrierId,resource.carrierName,resource.vehicleType,resource.plateNumber,resource.driverName,resource.driverPhone,plannedDepartureAt,now,batchId,user.organizationId),
      existingVehicle
        ?env.DB.prepare("UPDATE transport_batch_vehicles SET carrier_id=?,vehicle_master_id=?,driver_master_id=?,vehicle_type=?,plate_number=?,driver_name=?,driver_phone=?,capacity_weight_kg=?,capacity_volume_cbm=?,status='planned',updated_at=? WHERE id=? AND organization_id=?").bind(resource.carrierId,resource.vehicleMasterId,resource.driverMasterId,resource.vehicleType,resource.plateNumber,resource.driverName,resource.driverPhone,resource.capacityWeight,resource.capacityVolume,now,vehicleId,user.organizationId)
        :env.DB.prepare("INSERT INTO transport_batch_vehicles(id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,carrier_id,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at,vehicle_master_id,driver_master_id) VALUES(?,?,?,'MAIN-1',?,?,?,?,?,?,?,'planned',?,?,?,?)").bind(vehicleId,user.organizationId,batchId,resource.vehicleType,resource.plateNumber,resource.carrierId,resource.driverName,resource.driverPhone,resource.capacityWeight,resource.capacityVolume,now,now,resource.vehicleMasterId,resource.driverMasterId),
      env.DB.prepare("UPDATE transport_batch_vehicles SET status='cancelled',updated_at=? WHERE organization_id=? AND batch_id=? AND id!=? AND status!='cancelled'").bind(now,user.organizationId,batchId,vehicleId),
      env.DB.prepare("UPDATE warehouse_dispatches SET vehicle_plate=?,driver_name=?,driver_phone=?,carrier_name=?,updated_at=? WHERE organization_id=? AND transport_batch_id=? AND status='loading'").bind(resource.plateNumber,resource.driverName,resource.driverPhone,resource.carrierName,now,user.organizationId,batchId),
    ]);
    await synchronizeBatchTransport(user.organizationId,batchId,now);
    await refreshLoadingManifest(user.organizationId,batchId,user.userId,now);
    await writeAudit({request,action:"warehouse.consolidation.resource",resourceType:"transport_batch",resourceId:batchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber:batch.batch_number,carrierId:resource.carrierId,vehicleMasterId:resource.vehicleMasterId,driverMasterId:resource.driverMasterId}});
    return{success:`${batch.batch_number} 的承运商、车辆和司机已确认`,batchId};
  }
  if(intent==="create"||intent==="add"){
    const orderIds=[...new Set(form.getAll("orderId").map(String).filter(Boolean))];
    if(intent==="create"&&orderIds.length<2)return{formError:"拼车配载至少需要选择 2 张完整订单"};
    if(intent==="add"&&!orderIds.length)return{formError:"请先选择需要加入配载单的订单"};
    const states=await loadCandidateStates(user.organizationId,warehouse.id,orderIds);
    const blockers=states.flatMap((row)=>candidateBlockers(row).map(reason=>`${row.order_number}：${reason}`));
    if(states.length!==orderIds.length)blockers.push("部分所选订单已不在当前仓库或已经出库");
    if(blockers.length)return{formError:`暂不能配载：${[...new Set(blockers)].join("；")}`};
    const supervisorIds=[...new Set(states.map(row=>row.operation_supervisor_user_id).filter((id):id is string=>Boolean(id)))];
    if(supervisorIds.length===0)return{formError:"所选订单尚未完成操作主管指派，请先由业务主管审批并指定操作主管"};
    if(supervisorIds.length>1)return{formError:"所选订单分属不同操作主管，请按操作主管拆分配载单"};
    if(states.some(row=>!row.operation_supervisor_user_id))return{formError:"部分所选订单缺少操作主管，请先完成订单审批与指派"};
    const operationSupervisorUserId=supervisorIds[0];
    const workflowOrders=await loadLoadingBatchWorkflowOrders(user.organizationId,states.map(row=>row.order_id));
    const fieldPolicies=resolveLoadingBatchFieldPolicies(workflowOrders);
    const plannedDepartureAt=valueOf(form,"plannedDepartureAt").trim();
    const plannedArrivalAt=valueOf(form,"plannedArrivalAt").trim();
    const plannedLoadingAt=valueOf(form,"plannedLoadingAt").trim();
    const borderPort=valueOf(form,"borderPort").trim(),customsLocation=valueOf(form,"customsLocation").trim();
    const routeNotes=valueOf(form,"routeNotes").trim(),notes=valueOf(form,"notes").trim();
    if(intent==="create"){
      const requiredError=loadingBatchRequiredValueError(fieldPolicies,{
        exit_port:borderPort,
        customs_location:customsLocation,
        planned_exit_at:plannedDepartureAt,
        planned_arrival_at:plannedArrivalAt,
        planned_loading_at:plannedLoadingAt,
        route_code:routeNotes,
        loading_notes:notes,
      });
      if(requiredError)return{formError:requiredError};
      if(borderPort||customsLocation){
        const references=await env.DB.prepare(`SELECT category,code FROM reference_data WHERE organization_id=? AND status='active' AND ((category='border_port' AND code=?) OR (category='customs_place' AND code=?))`).bind(user.organizationId,borderPort,customsLocation).all<{category:string;code:string}>();
        if(borderPort&&!references.results.some(item=>item.category==="border_port"&&item.code===borderPort))return{formError:"请选择基础数据中启用的出境口岸"};
        if(customsLocation&&!references.results.some(item=>item.category==="customs_place"&&item.code===customsLocation))return{formError:"请选择基础数据中启用的清关地"};
      }
    }
    const resource=intent==="create"?await resolveBatchResource(user.organizationId,form,fieldPolicies):null;
    if(resource&&"error" in resource)return{formError:resource.error};
    const targetBatchId=intent==="add"?valueOf(form,"batchId"):"";
    let comparison=states;
    let targetBatch:TargetBatch|null=null;
    if(targetBatchId){
      targetBatch=await env.DB.prepare("SELECT id,batch_number,warehouse_id,status,approval_status,operation_supervisor_user_id,destination_location,border_port,customs_location FROM transport_batches WHERE id=? AND organization_id=? AND batch_number LIKE 'PZ-%' AND status IN ('planning','loading') AND approval_status IN ('draft','rejected')").bind(targetBatchId,user.organizationId).first<TargetBatch>();
      if(!targetBatch||targetBatch.warehouse_id!==warehouse.id)return{formError:"目标配载单不存在或不属于当前仓库"};
      if(targetBatch.operation_supervisor_user_id&&targetBatch.operation_supervisor_user_id!==operationSupervisorUserId)return{formError:"目标配载单与所选订单的操作主管不一致，请另建配载单"};
      if(await batchHasStarted(user.organizationId,targetBatch.id))return{formError:`${targetBatch.batch_number} 已开始装车，不能再增加订单`};
      const existingOrders=await env.DB.prepare("SELECT order_id FROM transport_batch_orders WHERE batch_id=? AND organization_id=? AND status!='removed'").bind(targetBatch.id,user.organizationId).all<{order_id:string}>();
      const combinedPolicies=resolveLoadingBatchFieldPolicies(await loadLoadingBatchWorkflowOrders(user.organizationId,[...new Set([...existingOrders.results.map(row=>row.order_id),...states.map(row=>row.order_id)])]));
      if(combinedPolicies.exit_port.isRequired&&!targetBatch.border_port)return{formError:`${targetBatch.batch_number} 缺少当前订单工作流要求的出境口岸，请先补齐后再加入订单`};
      if(combinedPolicies.customs_location.isRequired&&!targetBatch.customs_location)return{formError:`${targetBatch.batch_number} 缺少当前订单工作流要求的清关地，请先补齐后再加入订单`};
      const firstOrder=await env.DB.prepare("SELECT o.id order_id,o.order_number,o.business_type,o.origin_country,o.origin_state,o.origin_city,o.destination_country,o.destination_state,o.destination_city,o.exit_port,o.customs_location,o.overseas_warehouse_id,o.operation_supervisor_user_id,ow.name overseas_warehouse_name,'' customer_name,'' cargo_names,0 package_count,0 pieces,0 weight_kg,0 volume_cbm,'' location_names,1 cargo_ready,0 has_exception,0 active_dispatch,NULL active_batch_id,NULL active_batch_number FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id WHERE bo.batch_id=? AND bo.status!='removed' ORDER BY bo.sequence_no LIMIT 1").bind(targetBatch.id).first<CandidateState>();
      if(firstOrder)comparison=[firstOrder,...states];
    }
    const compatibility=checkCompatibility(comparison);
    if(compatibility)return{formError:compatibility};
    if(targetBatch){
      const sequence=await env.DB.prepare("SELECT COALESCE(MAX(sequence_no),0) next FROM transport_batch_orders WHERE batch_id=? AND organization_id=?").bind(targetBatch.id,user.organizationId).first<{next:number}>();
      const statements=prepareBatchOrderStatements(states,user.organizationId,targetBatch.id,(sequence?.next??0)+1,user.userId,now,true);
      for(const orderChunk of chunkD1Values(states.map(row=>row.order_id),4))statements.push(env.DB.prepare(`UPDATE transport_orders SET exit_port=COALESCE(?,exit_port),customs_location=COALESCE(?,customs_location),updated_at=? WHERE organization_id=? AND id IN (${d1Placeholders(orderChunk.length)})`).bind(targetBatch.border_port,targetBatch.customs_location,now,user.organizationId,...orderChunk));
      await env.DB.batch(statements);
      await addOrdersToPendingDispatch(user.organizationId,warehouse.id,targetBatch.id,states.map(row=>row.order_id),now);
      await activateLoadingModules(user.organizationId,states.map(row=>row.order_id),targetBatch.batch_number,user.userId,now,"加入已有配载单");
      await synchronizeBatchTransport(user.organizationId,targetBatch.id,now);
      await refreshLoadingManifest(user.organizationId,targetBatch.id,user.userId,now);
      await writeAudit({request,action:"warehouse.consolidation.add",resourceType:"transport_batch",resourceId:targetBatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber:targetBatch.batch_number,orderIds}});
      return{success:`已将 ${states.length} 票订单加入 ${targetBatch.batch_number}`,batchId:targetBatch.id};
    }
    const first=states[0],dateKey=now.slice(0,10).replaceAll("-","");
    const seq=await env.DB.prepare("SELECT COALESCE(MAX(CAST(substr(batch_number,13) AS INTEGER)),0)+1 next FROM transport_batches WHERE organization_id=? AND batch_number LIKE ?").bind(user.organizationId,`PZ-${dateKey}-%`).first<{next:number}>();
    const batchId=crypto.randomUUID(),batchNumber=`PZ-${dateKey}-${String(seq?.next??1).padStart(3,"0")}`;
    const destination=[first.overseas_warehouse_name,[first.destination_country,first.destination_state,first.destination_city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
    const routeKey=[warehouse.id,first.overseas_warehouse_id,first.destination_country,first.destination_state,first.destination_city].map(value=>(value??"").trim().toLowerCase()).join("|");
    const batchName=valueOf(form,"batchName").trim()||`${warehouse.name} → ${first.overseas_warehouse_name||first.destination_city}`;
    const selectedResource=resource as BatchResource;
    const statements:D1PreparedStatement[]=[
      env.DB.prepare(`INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,planned_departure_at,planned_arrival_at,status,notes,route_key,warehouse_id,carrier_id,created_by_user_id,created_at,updated_at,border_port,customs_location,transit_location,route_notes,planned_loading_at,overseas_carrier_name,overseas_vehicle_type,overseas_vehicle_count,overseas_vehicle_plate,overseas_driver_name,overseas_driver_phone,approval_status,operation_supervisor_user_id,submitted_by_user_id,submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(batchId,user.organizationId,first.order_id,batchNumber,batchName,warehouse.name,destination,plannedDepartureAt||null,plannedArrivalAt||null,"planning",notes||null,routeKey,warehouse.id,selectedResource.carrierId,user.userId,now,now,borderPort||null,customsLocation||null,null,routeNotes||null,plannedLoadingAt||null,selectedResource.carrierName,selectedResource.vehicleType,selectedResource.vehicleMasterId||selectedResource.driverMasterId?1:0,selectedResource.plateNumber,selectedResource.driverName,selectedResource.driverPhone,"submitted",operationSupervisorUserId,user.userId,now),
    ];
    if(selectedResource.vehicleMasterId||selectedResource.driverMasterId){
      const vehicleId=crypto.randomUUID();
      statements.push(env.DB.prepare("INSERT INTO transport_batch_vehicles(id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,carrier_id,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at,vehicle_master_id,driver_master_id) VALUES(?,?,?,'MAIN-1',?,?,?,?,?,?,?,'planned',?,?,?,?)").bind(vehicleId,user.organizationId,batchId,selectedResource.vehicleType,selectedResource.plateNumber,selectedResource.carrierId,selectedResource.driverName,selectedResource.driverPhone,selectedResource.capacityWeight,selectedResource.capacityVolume,now,now,selectedResource.vehicleMasterId,selectedResource.driverMasterId));
    }
    statements.push(...prepareBatchOrderStatements(states,user.organizationId,batchId,1,user.userId,now,false));
    for(const orderChunk of chunkD1Values(states.map(row=>row.order_id),6))statements.push(env.DB.prepare(`UPDATE transport_orders SET exit_port=CASE WHEN ?<>'' THEN ? ELSE exit_port END,customs_location=CASE WHEN ?<>'' THEN ? ELSE customs_location END,updated_at=? WHERE organization_id=? AND id IN (${d1Placeholders(orderChunk.length)})`).bind(borderPort,borderPort,customsLocation,customsLocation,now,user.organizationId,...orderChunk));
    try{await env.DB.batch(statements)}catch{return{formError:"配载单编号冲突或数据已被其他操作占用，请刷新后重试"}}
    await activateLoadingModules(user.organizationId,states.map(row=>row.order_id),batchNumber,user.userId,now,"仓库货物配载");
    await synchronizeBatchTransport(user.organizationId,batchId,now);
    await refreshLoadingManifest(user.organizationId,batchId,user.userId,now);
    await writeAudit({request,action:"warehouse.consolidation.submit",resourceType:"transport_batch",resourceId:batchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber,orderIds,operationSupervisorUserId,totalWeight:states.reduce((sum,row)=>sum+row.weight_kg,0),totalVolume:states.reduce((sum,row)=>sum+row.volume_cbm,0)}});
    return{success:`配载单 ${batchNumber} 已生成并提交操作主管审核，共 ${states.length} 票完整订单`,batchId};
  }
  if(intent==="remove"){
    const batchId=valueOf(form,"batchId"),orderId=valueOf(form,"orderId");
    const batch=await editableBatch(user.organizationId,warehouse.id,batchId);
    if(!batch)return{formError:"配载单不存在、已开始装车或不能修改"};
    const count=await env.DB.prepare("SELECT COUNT(*) total FROM transport_batch_orders WHERE batch_id=? AND organization_id=? AND status!='removed'").bind(batchId,user.organizationId).first<{total:number}>();
    if((count?.total??0)<=2)return{formError:"配载单至少保留 2 票订单；如需全部重配，请取消该配载单"};
    const membership=await env.DB.prepare("SELECT 1 ok FROM transport_batch_orders WHERE batch_id=? AND order_id=? AND organization_id=? AND status!='removed'").bind(batchId,orderId,user.organizationId).first();
    if(!membership)return{formError:"该订单不在当前配载单中"};
    const removed=await env.DB.prepare(
      `UPDATE transport_batch_orders SET status='removed',updated_at=?
       WHERE batch_id=? AND order_id=? AND organization_id=? AND status!='removed'
         AND EXISTS(
           SELECT 1 FROM transport_batches b
           WHERE b.id=transport_batch_orders.batch_id AND b.organization_id=transport_batch_orders.organization_id
             AND b.warehouse_id=? AND b.status IN ('planning','loading')
         )
         AND 2 < (
           SELECT COUNT(*) FROM transport_batch_orders active
           WHERE active.batch_id=transport_batch_orders.batch_id
             AND active.organization_id=transport_batch_orders.organization_id
             AND active.status!='removed'
         )`,
    ).bind(now,batchId,orderId,user.organizationId,warehouse.id).run();
    if(!Number(removed.meta?.changes||0))return{formError:"配载单状态已变化、订单已移出或当前仅剩 2 票，请刷新后查看"};
    await removeOrdersFromPendingDispatch(user.organizationId,warehouse.id,batchId,[orderId],now);
    await resetLoadingModules(user.organizationId,[orderId],user.userId,now,`从配载单 ${batch.batch_number} 移除`);
    await synchronizeBatchTransport(user.organizationId,batchId,now);
    await synchronizeOrderExceptionStatuses(user.organizationId,[orderId],now);
    await refreshLoadingManifest(user.organizationId,batchId,user.userId,now);
    await writeAudit({request,action:"warehouse.consolidation.remove",resourceType:"transport_batch",resourceId:batchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber:batch.batch_number,orderId}});
    return{success:`订单已从 ${batch.batch_number} 移除`,batchId};
  }
  if(intent==="cancel"){
    const batchId=valueOf(form,"batchId"),batch=await editableBatch(user.organizationId,warehouse.id,batchId);
    if(!batch)return{formError:"配载单不存在、已开始装车或不能取消"};
    const orders=await env.DB.prepare("SELECT order_id FROM transport_batch_orders WHERE batch_id=? AND organization_id=? AND status!='removed'").bind(batchId,user.organizationId).all<{order_id:string}>();
    const [,cancelled]=await env.DB.batch([
      env.DB.prepare(
        `UPDATE transport_batch_orders SET status='removed',updated_at=?
         WHERE batch_id=? AND organization_id=? AND status!='removed'
           AND EXISTS(
             SELECT 1 FROM transport_batches b
             WHERE b.id=transport_batch_orders.batch_id AND b.organization_id=transport_batch_orders.organization_id
               AND b.warehouse_id=? AND b.status IN ('planning','loading')
           )`,
      ).bind(now,batchId,user.organizationId,warehouse.id),
      env.DB.prepare("UPDATE transport_batches SET status='cancelled',updated_at=? WHERE id=? AND organization_id=? AND warehouse_id=? AND status IN ('planning','loading')").bind(now,batchId,user.organizationId,warehouse.id),
    ]);
    if(!Number(cancelled.meta?.changes||0))return{formError:"配载单已被其他人取消或状态已经变化，请刷新后查看"};
    await cancelPendingDispatch(user.organizationId,batchId,now);
    await resetLoadingModules(user.organizationId,orders.results.map(row=>row.order_id),user.userId,now,`取消配载单 ${batch.batch_number}`);
    await synchronizeOrderExceptionStatuses(user.organizationId,orders.results.map(row=>row.order_id),now);
    await writeAudit({request,action:"warehouse.consolidation.cancel",resourceType:"transport_batch",resourceId:batchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber:batch.batch_number,orderIds:orders.results.map(row=>row.order_id)}});
    return{success:`配载单 ${batch.batch_number} 已取消，订单已释放`};
  }
  return{formError:"未知操作"};
}

export default function CargoConsolidation({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle",storageKey=`warehouse-consolidation:${loaderData.warehouse.id}`;
  const[selected,setSelected]=useState<Selection[]>([]);
  useEffect(()=>{try{const cached:unknown=JSON.parse(localStorage.getItem(storageKey)||"[]");setSelected(Array.isArray(cached)?cached.filter(isSelection):[])}catch{setSelected([])}},[storageKey]);
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(selected))}catch{/* Selection still works for this tab when browser storage is unavailable. */}},[storageKey,selected]);
  useEffect(()=>{if(actionData?.success)setSelected([])},[actionData]);
  const totals=useMemo(()=>selected.reduce((sum,row)=>({packages:sum.packages+row.packages,pieces:sum.pieces+row.pieces,weight:sum.weight+row.weight,volume:sum.volume+row.volume}),{packages:0,pieces:0,weight:0,volume:0}),[selected]);
  const fieldPolicies=useMemo(()=>resolveLoadingBatchFieldPolicies(selected.map(row=>row.loadingWorkflow)),[selected]);
  const selectedIds=new Set(selected.map(row=>row.orderId));
  const toggle=(row:StockRow,checked:boolean)=>setSelected(current=>checked?[...current.filter(item=>item.orderId!==row.order_id),toSelection(row,loaderData.loadingWorkflowOrders.find(item=>item.orderId===row.order_id)??{orderId:row.order_id,appliesToCurrentOrFuture:true,fields:[]})]:current.filter(item=>item.orderId!==row.order_id));
  const values=<K extends keyof (typeof loaderData.options)[number]>(key:K)=>[...new Set(loaderData.options.map(row=>row[key]).filter(Boolean) as string[])];
  const batchValues=<K extends keyof (typeof loaderData.batchOptions)[number]>(key:K)=>[...new Set(loaderData.batchOptions.map(row=>row[key]).filter(Boolean) as string[])];
  const activeView:ConsolidationView=loaderData.view;
  return <div className="warehouse-consolidation-page">
    <header className="warehouse-page-header ltl-loading-header">
      <div><p className="eyebrow">CARGO CONSOLIDATION</p><h1>货物配载</h1><p>勾选完整拼车订单并生成正式 PZ 配载单；本页仅查看文件齐套状态，不再上传订单文件。</p></div>
      <Link className="secondary" to={`/warehouse/loading-documents?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}`}>进入配载文件</Link>
    </header>
    {actionData?.formError&&<div className="alert error">{actionData.formError}</div>}{actionData?.success&&<div className="alert success">{actionData.success}{actionData.batchId&&<> · <Link to={`/admin/loading/${actionData.batchId}`}>打开配载单</Link></>}</div>}
    <section className="panel consolidation-view-panel">
      <nav className="consolidation-view-tabs" aria-label="货物配载页面">
        <Link className={activeView==="stock"?"active":""} aria-current={activeView==="stock"?"page":undefined} to={consolidationViewHref(loaderData,"stock")} viewTransition>在库货物 <span>{loaderData.total}</span></Link>
        <Link className={activeView==="batches"?"active":""} aria-current={activeView==="batches"?"page":undefined} to={consolidationViewHref(loaderData,"batches")} viewTransition>当前配载单 <span>{loaderData.batchTotal}</span></Link>
      </nav>
      <div className={`consolidation-view-content ${activeView}`}>
      {activeView==="stock"?<>
      <section className="ltl-filter-panel consolidation-tab-filter"><FilterForm loaderData={loaderData} values={values}/></section>
      <section className="consolidation-tab-panel consolidation-stock-panel">
      <div className="panel-header">
        <div>
          <h2>当前仓库全部在库货物</h2>
          <p>本页只校验货物、目的地与车辆配载条件；文件状态只读且不阻断配载，生成配载单后到“配载文件”集中管理。</p>
        </div>
        <div className="consolidation-selection-actions">
          <span className="status-pill">已选 {selected.length} / 在库 {loaderData.total} 票</span>
          <button type="button" className="secondary" disabled={!selected.length} onClick={()=>setSelected([])}>清空</button>
          {selected.length>0&&loaderData.availableBatches.length>0&&<Modal title="加入已有配载单" triggerLabel="加入已有" triggerClassName="secondary" size="xwide" closeSignal={actionData?.success}><AddToBatchForm selected={selected} batches={loaderData.availableBatches} busy={busy}/></Modal>}
          <Modal title="生成配载单" triggerLabel={`生成配载（${selected.length}）`} size="xwide" closeSignal={actionData?.success}><ConsolidationForm selected={selected} totals={totals} warehouseName={loaderData.warehouse.name} policies={fieldPolicies} carriers={loaderData.carriers} vehicles={loaderData.carrierVehicles} drivers={loaderData.carrierDrivers} borderPorts={loaderData.borderPorts} customsPlaces={loaderData.customsPlaces} busy={busy}/></Modal>
        </div>
      </div>
      <div className="table-wrap ltl-loading-table consolidation-stock-table">
        <table>
          <colgroup>
            <col className="consolidation-col-select" />
            <col className="consolidation-col-status" />
            <col className="consolidation-col-order" />
            <col className="consolidation-col-receipt" />
            <col className="consolidation-col-origin" />
            <col className="consolidation-col-destination" />
            <col className="consolidation-col-location" />
            <col className="consolidation-col-documents" />
          </colgroup>
          <thead>
            <tr>
              <th>选择</th>
              <th>配载状态</th>
              <th>订单 / 客户 / 货物</th>
              <th>实收数据</th>
              <th>国内起点仓</th>
              <th>境外目的地</th>
              <th>库位</th>
              <th>文件准备</th>
            </tr>
          </thead>
          <tbody>
            {loaderData.rows.map(row=>{
              const assigned=Boolean(row.active_batch_id),blockers=candidateBlockers(row),checked=selectedIds.has(row.order_id);
              const requirements=loaderData.orderDocumentRequirements.find(group=>group.orderId===row.order_id)?.documents??[];
              const documents=loaderData.latestRequiredDocuments.filter(document=>document.order_id===row.order_id);
              return <tr key={row.order_id} className={checked?"selected-row":""}>
                <td><input type="checkbox" checked={checked} disabled={assigned||blockers.length>0} onChange={event=>toggle(row,event.target.checked)} aria-label={`选择订单 ${row.order_number}`}/></td>
                <td>{assigned?<span className="status-pill" title={row.active_batch_number??"已加入配载单"}>已配载 · {row.active_batch_number}</span>:<span className={`status-pill ${blockers.length?"off":"success"}`} title={blockers.join("；")}>{blockers.length?"不可配载":"可配载"}</span>}</td>
                <td className="consolidation-order-cell" title={`${row.order_number} · ${row.customer_name} · ${row.cargo_names||"未填写货名"}`}><strong>{row.order_number}</strong><span>· {row.customer_name}</span><small>· {row.cargo_names||"未填写货名"}</small></td>
                <td className="consolidation-receipt-cell" title={`${row.package_count} 包装 / ${row.pieces} 件 · ${row.weight_kg.toFixed(2)} KG · ${row.volume_cbm.toFixed(3)} CBM`}><strong>{row.package_count} 包装 / {row.pieces} 件</strong><span>· {row.weight_kg.toFixed(2)} KG · {row.volume_cbm.toFixed(3)} CBM</span></td>
                <td className="consolidation-origin-warehouse-cell" title={loaderData.warehouse.name}>{loaderData.warehouse.name}</td>
                <td className="consolidation-destination-cell" title={`${row.overseas_warehouse_name||"目的仓未设置"} · ${[row.destination_country,row.destination_state,row.destination_city].filter(Boolean).join(" ")||"地区未填写"}`}><strong>{row.overseas_warehouse_name||"目的仓未设置"}</strong><span>· {[row.destination_country,row.destination_state,row.destination_city].filter(Boolean).join(" ")||"地区未填写"}</span></td>
                <td className="consolidation-location-cell" title={row.location_names||"未分配库位"}>{row.location_names||"—"}</td>
                <td><DocumentStatusCell row={row} warehouseId={loaderData.warehouse.id} requirements={requirements} documents={documents}/></td>
              </tr>
            })}
          </tbody>
        </table>
      </div>
      {!loaderData.rows.length&&<p className="empty-state">当前仓库没有符合筛选条件的在库货物。</p>}
      <Pagination loaderData={loaderData} view="stock"/>
    </section>
    </>:<>
      <section className="ltl-filter-panel consolidation-tab-filter"><BatchFilterForm loaderData={loaderData} values={batchValues}/></section>
      <section className="consolidation-tab-panel consolidation-batch-panel">
      <div className="panel-header"><div><h2>当前仓库配载单</h2><p>配载单已包含口岸与清关地；请直接从对应行进入下一步，不再返回页面顶部寻找入口。</p></div></div>
      <div className="table-wrap consolidation-batch-table"><table><thead><tr><th>配载单</th><th>订单</th><th>实收汇总</th><th>承运商 / 车辆 / 司机</th><th>境外目的地</th><th>计划装车 / 出境</th><th>状态</th><th>操作</th></tr></thead><tbody>{loaderData.batches.map(batch=>{const approved=batch.approval_status==="approved";return <tr key={batch.id}>
        <td><strong>{batch.batch_number}</strong><small>{batch.batch_name}</small></td>
        <td><strong>{batch.order_count} 票</strong><small>{batch.order_numbers}</small></td>
        <td>{batch.total_weight.toFixed(2)} KG<small>{batch.total_volume.toFixed(3)} CBM</small></td>
        <td>{batch.overseas_carrier_name||"待安排承运商"}<small>{batch.overseas_vehicle_plate||"待安排车辆"} · {batch.overseas_driver_name||"待安排司机"}</small></td>
        <td>{batch.destination_location}<small>{batch.border_port||"口岸未填"} · {batch.customs_location||"清关地未填"}</small></td>
        <td>{batch.planned_loading_at?new Date(batch.planned_loading_at).toLocaleString("zh-CN"):"装车待定"}<small>出境：{batch.planned_departure_at?new Date(batch.planned_departure_at).toLocaleString("zh-CN"):"未填写"}</small></td>
        <td><span className={`status-pill ${approved?"success":batch.approval_status==="rejected"?"danger":""}`}>{batch.has_started?"已开始装车":batch.has_dispatch?"装车任务已生成":approved?"审核通过，待装车":batch.approval_status==="rejected"?"审核退回":"待操作主管审核"}</span></td>
        <td><div className="button-row consolidation-batch-actions"><Link className="text-button" to={`/admin/loading/${batch.id}`}>查看配载单</Link>{approved?<Link className="primary warehouse-primary" to={`/warehouse/outbound?warehouseId=${loaderData.warehouse.id}&view=${batch.has_dispatch?"execution":"pending"}`}>{batch.has_dispatch?"进入装车与出库":"创建装车任务"}</Link>:<span className="status-pill">审核通过后开放装车</span>}{approved&&!batch.has_started&&<Modal title={`车辆安排 · ${batch.batch_number}`} triggerLabel={batch.carrier_id&&batch.vehicle_master_id&&batch.driver_master_id?"修改车辆":"补充车辆"} triggerClassName="text-button" closeSignal={actionData?.success}><BatchResourceForm batch={batch} carriers={loaderData.carriers} vehicles={loaderData.carrierVehicles} drivers={loaderData.carrierDrivers} busy={busy}/></Modal>}{batch.approval_status!=="submitted"&&!batch.has_started&&<Modal title={`调整 ${batch.batch_number}`} triggerLabel="调整订单" triggerClassName="text-button" closeSignal={actionData?.success}><BatchAdjustment batch={batch} orders={loaderData.batchOrders.filter(row=>row.batch_id===batch.id)} busy={busy}/></Modal>}{batch.approval_status==="rejected"&&!batch.has_started&&<Form method="post"><input type="hidden" name="intent" value="resubmit"/><input type="hidden" name="batchId" value={batch.id}/><button className="primary" disabled={busy}>重新提交审核</button></Form>}</div></td>
      </tr>})}</tbody></table></div>
      {!loaderData.batches.length&&<p className="empty-state">{Object.values(loaderData.batchFilters).some(Boolean)?"当前筛选条件下没有配载单。":"当前仓库尚未生成配载单。"}</p>}
      <Pagination loaderData={loaderData} view="batches"/>
    </section></>}
      </div>
    </section>
  </div>;
}

function ConsolidationForm({selected,totals,warehouseName,policies,carriers,vehicles,drivers,borderPorts,customsPlaces,busy}:{selected:Selection[];totals:{packages:number;pieces:number;weight:number;volume:number};warehouseName:string;policies:LoadingBatchFieldPolicies;carriers:CarrierOption[];vehicles:CarrierVehicleOption[];drivers:CarrierDriverOption[];borderPorts:ReferenceOption[];customsPlaces:ReferenceOption[];busy:boolean}){
  return <Form method="post" className="stack ltl-task-form consolidation-create-form">
    <input type="hidden" name="intent" value="create"/>
    {selected.map(row=><input key={row.orderId} type="hidden" name="orderId" value={row.orderId}/>)}
    <div className="ltl-selection-summary"><div><span>完整订单</span><strong>{selected.length} 票</strong></div><div><span>包装 / 件数</span><strong>{totals.packages} 包装 · {totals.pieces} 件</strong></div><div><span>实收重量</span><strong>{totals.weight.toFixed(2)} KG</strong></div><div><span>实收体积</span><strong>{totals.volume.toFixed(3)} CBM</strong></div></div>
    <BatchResourceFields carriers={carriers} vehicles={vehicles} drivers={drivers} policies={policies}/>
    <div className="form-grid compact consolidation-create-grid">
      {policies.consolidation_warehouse.isActive&&<label className="field"><span>集货仓库{requiredMark(policies.consolidation_warehouse)}</span><input value={warehouseName} readOnly/></label>}
      {policies.exit_port.isActive&&<label className="field"><span>出境口岸{requiredMark(policies.exit_port)}</span><select name="borderPort" required={policies.exit_port.isRequired}><option value="">请选择出境口岸</option>{borderPorts.map(item=><option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}</select></label>}
      {policies.customs_location.isActive&&<label className="field"><span>清关地{requiredMark(policies.customs_location)}</span><select name="customsLocation" required={policies.customs_location.isRequired}><option value="">请选择清关地</option>{customsPlaces.map(item=><option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}</select></label>}
      {policies.loading_batch.isActive&&<label className="field"><span>配载单名称{requiredMark(policies.loading_batch)}</span><input name="batchName" placeholder="留空时系统自动生成"/></label>}
      {policies.planned_loading_at.isActive&&<label className="field"><span>计划装车时间{requiredMark(policies.planned_loading_at)}</span><input name="plannedLoadingAt" type="datetime-local" required={policies.planned_loading_at.isRequired}/></label>}
      {policies.planned_exit_at.isActive&&<label className="field"><span>计划出境发车时间{requiredMark(policies.planned_exit_at)}</span><input name="plannedDepartureAt" type="datetime-local" required={policies.planned_exit_at.isRequired}/></label>}
      {policies.planned_arrival_at.isActive&&<label className="field"><span>计划境外到仓时间{requiredMark(policies.planned_arrival_at)}</span><input name="plannedArrivalAt" type="datetime-local" required={policies.planned_arrival_at.isRequired}/></label>}
      {policies.route_code.isActive&&<label className="field"><span>运输线路{requiredMark(policies.route_code)}</span><input name="routeNotes" placeholder={policies.route_code.isRequired?"请填写运输线路":"选填"} required={policies.route_code.isRequired}/></label>}
      {policies.loading_notes.isActive&&<label className="field span-2"><span>备注{requiredMark(policies.loading_notes)}</span><input name="notes" placeholder={policies.loading_notes.isRequired?"请填写配载备注":"选填"} required={policies.loading_notes.isRequired}/></label>}
    </div>
    <div className="alert info compact-alert">口岸与清关地将同步到配载单全部订单；生成装车任务前仍可修改。海关放行仍在装车出库前单独校验。</div>
    <button className="primary" disabled={busy||selected.length<2}>确认配载信息，生成 PZ 配载单</button>
  </Form>
}

function BatchResourceForm({batch,carriers,vehicles,drivers,busy}:{batch:BatchRow;carriers:CarrierOption[];vehicles:CarrierVehicleOption[];drivers:CarrierDriverOption[];busy:boolean}){
  return <Form method="post" className="stack">
    <input type="hidden" name="intent" value="resource"/>
    <input type="hidden" name="batchId" value={batch.id}/>
    <BatchResourceFields carriers={carriers} vehicles={vehicles} drivers={drivers} carrierId={batch.carrier_id??""} vehicleMasterId={batch.vehicle_master_id??""} driverMasterId={batch.driver_master_id??""}/>
    <label className="field"><span>计划出境发车时间 *</span><input name="plannedDepartureAt" type="datetime-local" defaultValue={batch.planned_departure_at?.slice(0,16)??""} required/></label>
    <div className="alert info">保存后同步到管理后台配载单和已生成但尚未开始扫描的仓库装车任务。</div>
    <button className="primary" disabled={busy}>确认承运商、车辆和司机</button>
  </Form>
}

function BatchResourceFields({carriers,vehicles,drivers,policies,carrierId:initialCarrierId="",vehicleMasterId:initialVehicleId="",driverMasterId:initialDriverId=""}:{carriers:CarrierOption[];vehicles:CarrierVehicleOption[];drivers:CarrierDriverOption[];policies?:LoadingBatchFieldPolicies;carrierId?:string;vehicleMasterId?:string;driverMasterId?:string}){
  const[carrierId,setCarrierId]=useState(initialCarrierId),[vehicleId,setVehicleId]=useState(initialVehicleId),[driverId,setDriverId]=useState(initialDriverId);
  const carrierVehicles=vehicles.filter(item=>item.carrier_id===carrierId),carrierDrivers=drivers.filter(item=>item.carrier_id===carrierId);
  const resourcePolicy=policies?loadingBatchResourcePolicy(policies):{carrier:{isActive:true,isRequired:true},vehicle:{isActive:true,isRequired:true},driver:{isActive:true,isRequired:true}};
  const vehicleOption=(item:CarrierVehicleOption)=>[
    !policies||policies.main_plate_number.isActive?item.plate_number:null,
    !policies||policies.main_vehicle_type.isActive?(item.vehicle_type||"车型未填"):null,
  ].filter(Boolean).join(" · ")||"车辆记录";
  const driverOption=(item:CarrierDriverOption)=>[
    !policies||policies.main_driver_name.isActive?item.name:null,
    !policies||policies.main_driver_phone.isActive?(item.phone||"电话未填"):null,
  ].filter(Boolean).join(" · ")||"司机记录";
  if(!resourcePolicy.carrier.isActive&&!resourcePolicy.vehicle.isActive&&!resourcePolicy.driver.isActive)return null;
  return <section className="batch-resource-fields">
    <header><div><strong>境外运输资源</strong><small>一张拼车配载单对应一辆出境车辆；下拉数据来自承运商管理。</small></div></header>
    <div className="form-grid compact batch-resource-grid">
      {resourcePolicy.carrier.isActive&&<label className="field"><span>境外承运商{requiredMark(resourcePolicy.carrier)}</span><select name="carrierId" value={carrierId} onChange={event=>{setCarrierId(event.target.value);setVehicleId("");setDriverId("")}} required={resourcePolicy.carrier.isRequired}><option value="">请选择境外承运商</option>{carriers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {resourcePolicy.vehicle.isActive&&<label className="field"><span>出境车辆{requiredMark(resourcePolicy.vehicle)}</span><select name="vehicleMasterId" value={vehicleId} onChange={event=>setVehicleId(event.target.value)} required={resourcePolicy.vehicle.isRequired} disabled={!carrierId}><option value="">请选择车辆</option>{carrierVehicles.map(item=><option key={item.id} value={item.id}>{vehicleOption(item)}</option>)}</select></label>}
      {resourcePolicy.driver.isActive&&<label className="field"><span>出境司机{requiredMark(resourcePolicy.driver)}</span><select name="driverMasterId" value={driverId} onChange={event=>setDriverId(event.target.value)} required={resourcePolicy.driver.isRequired} disabled={!carrierId}><option value="">请选择司机</option>{carrierDrivers.map(item=><option key={item.id} value={item.id}>{driverOption(item)}</option>)}</select></label>}
    </div>
    {carrierId&&(!carrierVehicles.length||!carrierDrivers.length)&&<div className="alert warning">当前承运商缺少可用车辆或司机，请先到承运商管理补充主数据。</div>}
  </section>
}

function AddToBatchForm({selected,batches,busy}:{selected:Selection[];batches:AvailableBatch[];busy:boolean}){
  return <Form method="post" className="stack ltl-task-form">
    <input type="hidden" name="intent" value="add"/>
    {selected.map(row=><input key={row.orderId} type="hidden" name="orderId" value={row.orderId}/>)}
    <label className="field"><span>目标配载单 *</span><select name="batchId" required><option value="">请选择</option>{batches.map(batch=><option key={batch.id} value={batch.id}>{batch.batch_number} · {batch.destination_location}</option>)}</select></label>
    <div className="alert info">系统会再次校验境外目的仓和目的地区；新加入订单自动继承该配载单的口岸与清关地。</div>
    <button className="primary" disabled={busy}>确认订单，加入配载单</button>
  </Form>
}

function BatchAdjustment({batch,orders,busy}:{batch:BatchRow;orders:BatchOrder[];busy:boolean}){
  const[page,setPage]=useState(1);
  const pagination=paginateList(orders,page,PAGE_SIZE);
  return <div className="stack">
    <div className="table-wrap"><table><thead><tr><th>订单</th><th>客户 / 货物</th><th>实收数据</th><th>操作</th></tr></thead><tbody>{pagination.items.map(row=><tr key={row.order_id}><td>{row.order_number}</td><td>{row.customer_name}<small>{row.cargo_names||"—"}</small></td><td>{row.weight_kg.toFixed(2)} KG<small>{row.volume_cbm.toFixed(3)} CBM</small></td><td><Form method="post"><input type="hidden" name="intent" value="remove"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="orderId" value={row.order_id}/><ConfirmAction title="从配载单移除订单" description={`将 ${row.order_number} 从 ${batch.batch_number} 移出，并释放其待装车任务；订单历史与资料不会删除。`} triggerLabel="移除" confirmLabel="确认移出配载单" pending={busy} disabled={orders.length<=2}/></Form></td></tr>)}</tbody></table></div>
    {pagination.pageCount>1&&<footer className="pagination consolidation-pagination" aria-label="配载单挂载订单分页"><span>每页 {PAGE_SIZE} 票 · 第 {pagination.page} / {pagination.pageCount} 页 · 共 {pagination.total} 票</span><div><button type="button" className="secondary" disabled={pagination.page<=1} onClick={()=>setPage(pagination.page-1)}>上一页</button><span className="consolidation-pagination-current" aria-current="page">{pagination.page}</span><button type="button" className="secondary" disabled={pagination.page>=pagination.pageCount} onClick={()=>setPage(pagination.page+1)}>下一页</button></div></footer>}
    <div className="alert info">需要增加订单时，请关闭弹窗，在上方在库货物列表勾选订单后点击“加入已有配载单”。</div>
    <Form method="post"><input type="hidden" name="intent" value="cancel"/><input type="hidden" name="batchId" value={batch.id}/><ConfirmAction className="secondary danger" title="取消整张配载单" description={`将取消 ${batch.batch_number}，释放其中 ${orders.length} 票订单及待装车任务；已产生的配载记录和审计痕迹永久保留。`} triggerLabel="取消整张配载单并释放订单" confirmLabel="确认取消并释放" confirmationKeyword={batch.batch_number} pending={busy}/></Form>
  </div>;
}
function FilterForm({loaderData,values}:{loaderData:Route.ComponentProps["loaderData"];values:<K extends keyof (typeof loaderData.options)[number]>(key:K)=>string[]}){
  const hasAdvanced=Boolean(loaderData.filters.country||loaderData.filters.state||loaderData.filters.city||loaderData.filters.customer);
  return <Form method="get" action="." className="consolidation-filter-form">
    <input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/>
    <input type="hidden" name="view" value="stock"/>
    <input type="hidden" name="batchPage" value={loaderData.batchPage}/>
    <div className="consolidation-filter-primary">
      <label className="consolidation-filter-search"><span>订单 / 客户 / 货物</span><input name="q" defaultValue={loaderData.filters.keyword} placeholder="输入订单号、客户或货物名称"/></label>
      <Select label="境外目的仓" name="destinationWarehouse" current={loaderData.filters.warehouse} values={values("overseas_warehouse_name")}/>
      <label><span>配载状态</span><select name="eligibility" defaultValue={loaderData.filters.eligibility}><option value="">全部</option><option value="eligible">仅可配载</option><option value="assigned">仅已配载</option><option value="blocked">仅不可配载</option></select></label>
      <div className="consolidation-filter-actions"><button className="primary">筛选</button><Link className="secondary" to={`/warehouse/consolidation?warehouseId=${loaderData.warehouse.id}&view=stock&batchPage=${loaderData.batchPage}`}>重置</Link></div>
    </div>
    <details className="consolidation-advanced-filters" open={hasAdvanced||undefined}>
      <summary>更多筛选条件</summary>
      <div>
        <Select label="国家" name="country" current={loaderData.filters.country} values={values("destination_country")}/>
        <Select label="省 / 州" name="state" current={loaderData.filters.state} values={values("destination_state")}/>
        <Select label="城市" name="city" current={loaderData.filters.city} values={values("destination_city")}/>
        <Select label="客户" name="customer" current={loaderData.filters.customer} values={values("customer_name")}/>
      </div>
    </details>
  </Form>
}

function BatchFilterForm({loaderData,values}:{loaderData:Route.ComponentProps["loaderData"];values:<K extends keyof (typeof loaderData.batchOptions)[number]>(key:K)=>string[]}){
  const hasAdvanced=Boolean(loaderData.batchFilters.destination||loaderData.batchFilters.carrier||loaderData.batchFilters.plannedFrom||loaderData.batchFilters.plannedTo);
  return <Form method="get" action="." className="consolidation-filter-form consolidation-batch-filter-form">
    <input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/>
    <input type="hidden" name="view" value="batches"/>
    <input type="hidden" name="page" value={loaderData.page}/>
    <div className="consolidation-filter-primary">
      <label className="consolidation-filter-search"><span>配载单 / 订单 / 客户 / 车辆</span><input name="batchQ" defaultValue={loaderData.batchFilters.keyword} placeholder="输入配载单号、订单号、客户、承运商或车牌"/></label>
      <label><span>审批状态</span><select name="batchApproval" defaultValue={loaderData.batchFilters.approval}><option value="">全部</option><option value="submitted">待主管审核</option><option value="rejected">审核退回</option><option value="approved">审核通过</option><option value="draft">草稿</option></select></label>
      <label><span>装车状态</span><select name="batchLoading" defaultValue={loaderData.batchFilters.loading}><option value="">全部</option><option value="waiting">未创建装车任务</option><option value="task_created">已创建任务，待装车</option><option value="started">已开始装车</option></select></label>
      <div className="consolidation-filter-actions"><button className="primary">筛选</button><Link className="secondary" to={`/warehouse/consolidation?warehouseId=${loaderData.warehouse.id}&view=batches&page=${loaderData.page}`}>重置</Link></div>
    </div>
    <details className="consolidation-advanced-filters" open={hasAdvanced||undefined}>
      <summary>更多筛选条件</summary>
      <div>
        <Select label="境外目的地" name="batchDestination" current={loaderData.batchFilters.destination} values={values("destination_location")}/>
        <Select label="境外承运商" name="batchCarrier" current={loaderData.batchFilters.carrier} values={values("overseas_carrier_name")}/>
        <label><span>计划装车开始</span><input type="date" name="batchPlannedFrom" defaultValue={loaderData.batchFilters.plannedFrom}/></label>
        <label><span>计划装车结束</span><input type="date" name="batchPlannedTo" defaultValue={loaderData.batchFilters.plannedTo}/></label>
      </div>
    </details>
  </Form>
}

function DocumentStatusCell({row,warehouseId,requirements,documents}:{row:StockRow;warehouseId:string;requirements:readonly EffectiveLoadingDocumentRequirement[];documents:readonly LatestRequiredDocument[]}){
  const activeRequirements=requirements.filter(requirement=>requirement.isActive);
  const uploadedCodes=new Set(documents.map(document=>document.document_category));
  const uploadedCount=activeRequirements.filter(requirement=>uploadedCodes.has(requirement.code)).length;
  const missingRequiredCount=activeRequirements.filter(requirement=>requirement.isRequired&&!uploadedCodes.has(requirement.code)).length;
  const triggerLabel=!activeRequirements.length?"无文件要求":missingRequiredCount?`${uploadedCount}/${activeRequirements.length} 已传 · 缺 ${missingRequiredCount} 必传`:`${uploadedCount}/${activeRequirements.length} 已传 · 必传已齐`;
  const triggerState=!activeRequirements.length?"empty":missingRequiredCount?"missing":"ready";
  return <div className="consolidation-document-status" title={triggerLabel}><Modal title={`文件齐套状态 · ${row.order_number}`} triggerLabel={triggerLabel} triggerClassName={`consolidation-document-trigger ${triggerState}`}>
    <div className="consolidation-document-dialog">
      <div className="consolidation-document-summary">
        <span>{uploadedCount}/{activeRequirements.length} 已上传</span>
        <strong className={missingRequiredCount?"missing":"ready"}>{missingRequiredCount?`缺 ${missingRequiredCount} 项必传`:"必传已齐"}</strong>
      </div>
      {activeRequirements.length?<div className="consolidation-document-list">
        {activeRequirements.map(requirement=>{
          const uploaded=uploadedCodes.has(requirement.code);
          const className=uploaded?"confirmed":requirement.isRequired?"missing":"optional";
          const stateLabel=uploaded?"已上传":requirement.isRequired?"缺少":"选填未传";
          return <span key={requirement.code} className={`document-state ${className}`} title={`${requirement.name}：${stateLabel}`}><strong>{requirement.name}</strong><small>{stateLabel}</small></span>;
        })}
      </div>:<span className="consolidation-document-empty">当前工作流无生效文件。</span>}
      <div className="consolidation-document-next">{row.active_batch_id?<Link className="text-button" to={`/warehouse/loading-documents?warehouseId=${encodeURIComponent(warehouseId)}&batchId=${encodeURIComponent(row.active_batch_id)}`}>进入配载文件</Link>:<small>文件状态只读且不阻断配载；生成配载单后统一补传。</small>}</div>
    </div>
  </Modal></div>
}

function Select({label,name,current,values}:{label:string;name:string;current:string;values:string[]}){return<label><span>{label}</span><select name={name} defaultValue={current}><option value="">全部</option>{values.map(value=><option key={value}>{value}</option>)}</select></label>}
function consolidationViewHref(loaderData:Route.ComponentProps["loaderData"],view:ConsolidationView,nextPage?:number){
  const params=new URLSearchParams({
    warehouseId:loaderData.warehouse.id,
    view,
    page:String(view==="stock"&&nextPage?nextPage:loaderData.page),
    batchPage:String(view==="batches"&&nextPage?nextPage:loaderData.batchPage),
  });
  const names:Record<string,string>={warehouse:"destinationWarehouse",keyword:"q"};
  Object.entries(loaderData.filters).forEach(([key,value])=>{if(value)params.set(names[key]||key,value)});
  const batchNames:Record<string,string>={keyword:"batchQ",approval:"batchApproval",loading:"batchLoading",destination:"batchDestination",carrier:"batchCarrier",plannedFrom:"batchPlannedFrom",plannedTo:"batchPlannedTo"};
  Object.entries(loaderData.batchFilters).forEach(([key,value])=>{const name=batchNames[key];if(value&&name)params.set(name,value)});
  return `/warehouse/consolidation?${params}`;
}

function Pagination({loaderData,view}:{loaderData:Route.ComponentProps["loaderData"];view:ConsolidationView}){
  const page=view==="stock"?loaderData.page:loaderData.batchPage;
  const pages=view==="stock"?loaderData.pages:loaderData.batchPages;
  const total=view==="stock"?loaderData.total:loaderData.batchTotal;
  const unit=view==="stock"?"票":"张";
  const previous=page-1,next=page+1,count=Math.min(5,pages),start=Math.max(1,Math.min(page-2,pages-count+1));
  const pageNumbers=Array.from({length:count},(_,index)=>start+index);
  const href=(targetPage:number)=>consolidationViewHref(loaderData,view,targetPage);
  return <footer className="pagination consolidation-pagination" aria-label={view==="stock"?"在库订单分页":"配载单分页"}>
    <span>每页 10 {unit} · 第 {page} / {pages} 页 · 共 {total} {unit}</span>
    <div>
      {previous>=1?<Link className="secondary" to={href(previous)}>上一页</Link>:<span className="secondary disabled" aria-disabled="true">上一页</span>}
      {pageNumbers.map(pageNumber=>pageNumber===page?<span key={pageNumber} className="consolidation-pagination-current" aria-current="page">{pageNumber}</span>:<Link key={pageNumber} className="secondary" to={href(pageNumber)} aria-label={`第 ${pageNumber} 页`}>{pageNumber}</Link>)}
      {next<=pages?<Link className="secondary" to={href(next)}>下一页</Link>:<span className="secondary disabled" aria-disabled="true">下一页</span>}
    </div>
  </footer>;
}

function toSelection(row:StockRow,loadingWorkflow:LoadingBatchWorkflowOrder):Selection{return{orderId:row.order_id,orderNumber:row.order_number,customerName:row.customer_name,packages:row.package_count,pieces:row.pieces,weight:row.weight_kg,volume:row.volume_cbm,loadingWorkflow}}
function isSelection(value:unknown):value is Selection{
  if(!value||typeof value!=="object")return false;
  const row=value as Partial<Selection>;
  return typeof row.orderId==="string"&&typeof row.orderNumber==="string"&&typeof row.customerName==="string"&&
    [row.packages,row.pieces,row.weight,row.volume].every(item=>typeof item==="number"&&Number.isFinite(item))&&
    Boolean(row.loadingWorkflow&&row.loadingWorkflow.orderId===row.orderId&&typeof row.loadingWorkflow.appliesToCurrentOrFuture==="boolean"&&Array.isArray(row.loadingWorkflow.fields));
}
function requiredMark(policy:{isRequired:boolean}){return policy.isRequired?" *":""}
async function resolveBatchResource(organizationId:string,form:FormData,policies?:LoadingBatchFieldPolicies):Promise<BatchResource|{error:string}>{
  const resourcePolicy=policies?loadingBatchResourcePolicy(policies):{carrier:{isActive:true,isRequired:true},vehicle:{isActive:true,isRequired:true},driver:{isActive:true,isRequired:true}};
  const carrierId=resourcePolicy.carrier.isActive?valueOf(form,"carrierId"):"";
  const vehicleMasterId=resourcePolicy.vehicle.isActive?valueOf(form,"vehicleMasterId"):"";
  const driverMasterId=resourcePolicy.driver.isActive?valueOf(form,"driverMasterId"):"";
  if(resourcePolicy.carrier.isRequired&&!carrierId)return{error:"请选择境外承运商"};
  if(resourcePolicy.vehicle.isRequired&&!vehicleMasterId)return{error:"请选择出境车辆"};
  if(resourcePolicy.driver.isRequired&&!driverMasterId)return{error:"请选择出境司机"};
  if(!carrierId&&(vehicleMasterId||driverMasterId))return{error:"选择车辆或司机前必须先选择境外承运商"};
  if(!carrierId)return{carrierId:null,carrierName:null,vehicleMasterId:null,vehicleType:null,plateNumber:null,capacityWeight:0,capacityVolume:0,driverMasterId:null,driverName:null,driverPhone:null};
  const[carrier,vehicle,driver]=await Promise.all([
    env.DB.prepare("SELECT id,name FROM carriers WHERE id=? AND organization_id=? AND status='active' AND carrier_scope='overseas'").bind(carrierId,organizationId).first<CarrierOption>(),
    vehicleMasterId?env.DB.prepare("SELECT id,carrier_id,plate_number,vehicle_type,capacity_weight_kg,capacity_volume_cbm,'' carrier_name FROM carrier_vehicles WHERE id=? AND organization_id=? AND status='active'").bind(vehicleMasterId,organizationId).first<CarrierVehicleOption>():Promise.resolve(null),
    driverMasterId?env.DB.prepare("SELECT id,carrier_id,name,phone,'' carrier_name FROM carrier_drivers WHERE id=? AND organization_id=? AND status='active'").bind(driverMasterId,organizationId).first<CarrierDriverOption>():Promise.resolve(null),
  ]);
  if(!carrier)return{error:"所选境外承运商不存在或已停用"};
  if(vehicleMasterId&&(!vehicle||vehicle.carrier_id!==carrier.id))return{error:"所选车辆不属于当前境外承运商或已停用"};
  if(driverMasterId&&(!driver||driver.carrier_id!==carrier.id))return{error:"所选司机不属于当前境外承运商或已停用"};
  if(policies?.main_vehicle_type.isRequired&&!vehicle?.vehicle_type?.trim())return{error:"所选车辆缺少车型，请先到承运商管理补充"};
  if(policies?.main_plate_number.isRequired&&!vehicle?.plate_number?.trim())return{error:"所选车辆缺少车牌号，请先到承运商管理补充"};
  if(policies?.main_driver_name.isRequired&&!driver?.name?.trim())return{error:"所选司机缺少姓名，请先到承运商管理补充"};
  if(policies?.main_driver_phone.isRequired&&!driver?.phone?.trim())return{error:"所选司机缺少联系电话，请先到承运商管理补充"};
  if(!policies&&(!vehicle?.vehicle_type?.trim()||!driver?.phone?.trim()))return{error:!vehicle?.vehicle_type?.trim()?"所选车辆缺少车型，请先到承运商管理补充":"所选司机缺少联系电话，请先到承运商管理补充"};
  return{carrierId:carrier.id,carrierName:carrier.name,vehicleMasterId:vehicle?.id??null,vehicleType:vehicle?.vehicle_type?.trim()||null,plateNumber:vehicle?.plate_number?.trim().toUpperCase()||null,capacityWeight:vehicle?.capacity_weight_kg??0,capacityVolume:vehicle?.capacity_volume_cbm??0,driverMasterId:driver?.id??null,driverName:driver?.name.trim()||null,driverPhone:driver?.phone?.trim()||null};
}
function candidateBlockers(row:StockRow){const reasons:string[]=[];if(row.business_type!=="ltl")reasons.push("整车订单");if(!row.package_count)reasons.push("当前仓无在库货物");if(!row.cargo_ready)reasons.push("未确认货齐");if(row.has_exception)reasons.push("存在未结异常");if(row.active_batch_id)reasons.push(`已加入 ${row.active_batch_number}`);if(row.active_dispatch)reasons.push("已生成装车任务");if(!row.overseas_warehouse_id)reasons.push("未设置境外目的仓");return reasons}
function checkCompatibility(rows:CandidateState[]){if(!rows.length)return"没有可配载订单";const first=rows[0],same=(pick:(row:CandidateState)=>string|null)=>rows.every(row=>(pick(row)||"").trim()===(pick(first)||"").trim());if(!first.overseas_warehouse_id)return"所选订单必须设置境外目的仓";if(!same(row=>row.overseas_warehouse_id))return"所选订单的境外目的仓不一致";if(!same(row=>row.destination_country)||!same(row=>row.destination_state)||!same(row=>row.destination_city))return"所选订单的目的国家、省州或城市不一致";return""}
async function loadCandidateStates(organizationId:string,warehouseId:string,orderIds:string[]){if(!orderIds.length)return[];const rows:CandidateState[]=[];for(const orderChunk of chunkD1Values([...new Set(orderIds)],7)){const result=await env.DB.prepare(`SELECT o.id order_id,o.order_number,o.business_type,o.origin_country,o.origin_state,o.origin_city,o.destination_country,o.destination_state,o.destination_city,o.exit_port,o.customs_location,o.overseas_warehouse_id,o.operation_supervisor_user_id,ow.name overseas_warehouse_name,c.name customer_name,
    (SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.organization_id=o.organization_id AND i.order_id=o.id) cargo_names,
    (SELECT COUNT(*) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')) package_count,
    COALESCE((SELECT SUM(p.pieces) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')),0) pieces,
    COALESCE((SELECT SUM(p.weight_kg) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')),0) weight_kg,
    COALESCE((SELECT SUM(p.volume_cbm) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')),0) volume_cbm,'' location_names,
    EXISTS(SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=o.organization_id AND s.order_id=o.id AND r.warehouse_id=? AND r.status='completed' AND r.cargo_complete=1) cargo_ready,
    EXISTS(SELECT 1 FROM warehouse_exceptions e JOIN shipments s ON s.id=e.shipment_id WHERE e.organization_id=o.organization_id AND s.order_id=o.id AND e.status IN ('open','processing')) has_exception,
    EXISTS(SELECT 1 FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id WHERE d.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND d.status!='cancelled') active_dispatch,
    (SELECT b.id FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.status!='cancelled' AND b.batch_number LIKE 'PZ-%' ORDER BY b.updated_at DESC LIMIT 1) active_batch_id,
    (SELECT b.batch_number FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.status!='cancelled' AND b.batch_number LIKE 'PZ-%' ORDER BY b.updated_at DESC LIMIT 1) active_batch_number
    FROM transport_orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id WHERE o.organization_id=? AND o.id IN (${d1Placeholders(orderChunk.length)})`).bind(warehouseId,warehouseId,warehouseId,warehouseId,warehouseId,warehouseId,organizationId,...orderChunk).all<CandidateState>();rows.push(...result.results)}
  const byId=new Map(rows.map(row=>[row.order_id,row]));
  return orderIds.map(orderId=>byId.get(orderId)).filter((row):row is CandidateState=>Boolean(row));
}
async function loadLatestRequiredDocuments(organizationId:string,orderIds:string[]){
  if(!orderIds.length)return[] as LatestRequiredDocument[];
  const documentCodes=loadingOrderDocumentDefinitions.map(document=>document.code);
  const rows:LatestRequiredDocument[]=[];
  for(const orderChunk of chunkD1Values([...new Set(orderIds)],1+documentCodes.length)){
    const result=await env.DB.prepare(`SELECT m.order_id,m.attachment_id,m.document_category,m.review_status FROM order_document_metadata m
      JOIN order_attachments a ON a.id=m.attachment_id AND a.organization_id=m.organization_id
      WHERE m.organization_id=? AND m.order_id IN (${d1Placeholders(orderChunk.length)})
        AND m.document_category IN (${d1Placeholders(documentCodes.length)})
      ORDER BY a.created_at DESC,a.id DESC`).bind(organizationId,...orderChunk,...documentCodes).all<LatestRequiredDocument>();
    rows.push(...result.results);
  }
  const seen=new Set<string>();
  return rows.filter(document=>{const key=`${document.order_id}:${document.document_category}`;if(seen.has(key))return false;seen.add(key);return true});
}
type LoadingModuleRow={id:string;order_id:string;current_step_code:string|null};
async function loadLoadingModules(organizationId:string,orderIds:string[]){const modules:LoadingModuleRow[]=[];for(const orderChunk of chunkD1Values([...new Set(orderIds)],1)){const result=await env.DB.prepare(`SELECT id,order_id,current_step_code FROM order_module_instances WHERE organization_id=? AND module_code='loading' AND enabled=1 AND order_id IN (${d1Placeholders(orderChunk.length)})`).bind(organizationId,...orderChunk).all<LoadingModuleRow>();modules.push(...result.results)}return modules}
async function activateLoadingModules(organizationId:string,orderIds:string[],batchNumber:string,userId:string,now:string,actionName:string){for(const orderId of orderIds)await ensureOrderModules(organizationId,orderId);const modules=await loadLoadingModules(organizationId,orderIds);const statements:D1PreparedStatement[]=[];for(const moduleChunk of chunkD1Values(modules,2))statements.push(env.DB.prepare(`UPDATE order_module_instances SET status='in_progress',current_step_code='planned',current_step_name='配载成单',progress_percent=75,started_at=COALESCE(started_at,?),completed_at=NULL,blocking_reason=NULL,updated_at=? WHERE id IN (${d1Placeholders(moduleChunk.length)})`).bind(now,now,...moduleChunk.map(module=>module.id)));for(const moduleChunk of chunkD1Rows(modules,12))statements.push(env.DB.prepare(`INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES ${moduleChunk.map(()=>"(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}`).bind(...moduleChunk.flatMap(module=>[crypto.randomUUID(),organizationId,module.order_id,module.id,"batch_create",actionName,module.current_step_code,"planned","配载成单",userId,`加入配载单 ${batchNumber}`,now])));if(statements.length)await env.DB.batch(statements);for(const orderId of orderIds)await syncOrderWorkflowSnapshot(organizationId,orderId)}
async function resetLoadingModules(organizationId:string,orderIds:string[],userId:string,now:string,notes:string){if(!orderIds.length)return;const modules=await loadLoadingModules(organizationId,orderIds),statements:D1PreparedStatement[]=[];for(const moduleChunk of chunkD1Values(modules,1))statements.push(env.DB.prepare(`UPDATE order_module_instances SET status='ready',current_step_code='warehouse_ready',current_step_name='仓库已货齐，待配载',progress_percent=50,completed_at=NULL,blocking_reason=NULL,updated_at=? WHERE id IN (${d1Placeholders(moduleChunk.length)})`).bind(now,...moduleChunk.map(module=>module.id)));for(const moduleChunk of chunkD1Rows(modules,12))statements.push(env.DB.prepare(`INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES ${moduleChunk.map(()=>"(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}`).bind(...moduleChunk.flatMap(module=>[crypto.randomUUID(),organizationId,module.order_id,module.id,"batch_release","释放配载订单",module.current_step_code,"warehouse_ready","仓库已货齐，待配载",userId,notes,now])));if(statements.length)await env.DB.batch(statements);for(const orderId of orderIds)await syncOrderWorkflowSnapshot(organizationId,orderId)}
async function addOrdersToPendingDispatch(organizationId:string,warehouseId:string,batchId:string,orderIds:string[],now:string){
  if(!orderIds.length)return;
  const dispatch=await env.DB.prepare("SELECT id FROM warehouse_dispatches WHERE organization_id=? AND transport_batch_id=? AND status='loading' ORDER BY updated_at DESC LIMIT 1").bind(organizationId,batchId).first<{id:string}>();
  if(!dispatch)return;
  const statements:D1PreparedStatement[]=[];
  for(const orderChunk of chunkD1Values([...new Set(orderIds)],4))statements.push(
    env.DB.prepare(`INSERT OR IGNORE INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status)
      SELECT lower(hex(randomblob(16))),p.organization_id,?,p.id,'pending' FROM warehouse_packages p
      JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
      WHERE p.organization_id=? AND p.warehouse_id=? AND p.status IN ('in_stock','allocated') AND s.order_id IN (${d1Placeholders(orderChunk.length)})`).bind(dispatch.id,organizationId,warehouseId,...orderChunk),
    env.DB.prepare(`UPDATE warehouse_packages SET status='allocated',updated_at=? WHERE organization_id=? AND warehouse_id=? AND status='in_stock'
      AND shipment_id IN (SELECT id FROM shipments WHERE organization_id=? AND order_id IN (${d1Placeholders(orderChunk.length)}))`).bind(now,organizationId,warehouseId,organizationId,...orderChunk),
  );
  await env.DB.batch(statements);
}
async function removeOrdersFromPendingDispatch(organizationId:string,warehouseId:string,batchId:string,orderIds:string[],now:string){
  if(!orderIds.length)return;
  const dispatch=await env.DB.prepare("SELECT id FROM warehouse_dispatches WHERE organization_id=? AND transport_batch_id=? AND status='loading' ORDER BY updated_at DESC LIMIT 1").bind(organizationId,batchId).first<{id:string}>();
  if(!dispatch)return;
  const statements:D1PreparedStatement[]=[];
  for(const orderChunk of chunkD1Values([...new Set(orderIds)],4))statements.push(
    env.DB.prepare(`UPDATE warehouse_packages SET status='in_stock',updated_at=? WHERE organization_id=? AND warehouse_id=? AND status='allocated' AND id IN (
      SELECT di.package_id FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id
      WHERE di.dispatch_id=? AND s.order_id IN (${d1Placeholders(orderChunk.length)}))`).bind(now,organizationId,warehouseId,dispatch.id,...orderChunk),
    env.DB.prepare(`DELETE FROM warehouse_dispatch_items WHERE dispatch_id=? AND package_id IN (
      SELECT p.id FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id IN (${d1Placeholders(orderChunk.length)}))`).bind(dispatch.id,...orderChunk),
  );
  await env.DB.batch(statements);
}
async function cancelPendingDispatch(organizationId:string,batchId:string,now:string){
  const dispatch=await env.DB.prepare("SELECT id FROM warehouse_dispatches WHERE organization_id=? AND transport_batch_id=? AND status='loading' ORDER BY updated_at DESC LIMIT 1").bind(organizationId,batchId).first<{id:string}>();
  if(!dispatch)return;
  await env.DB.batch([
    env.DB.prepare("UPDATE warehouse_packages SET status='in_stock',updated_at=? WHERE organization_id=? AND status='allocated' AND id IN (SELECT package_id FROM warehouse_dispatch_items WHERE dispatch_id=?)").bind(now,organizationId,dispatch.id),
    env.DB.prepare("UPDATE warehouse_dispatches SET status='cancelled',updated_at=? WHERE id=? AND organization_id=?").bind(now,dispatch.id,organizationId),
  ]);
}
function prepareBatchOrderStatements(rows:CandidateState[],organizationId:string,batchId:string,startSequence:number,userId:string,now:string,upsert:boolean){
  return chunkD1Rows(rows,8).map((rowChunk)=>{
    const values=rowChunk.map(()=>"(?,?,?,?,?,'planned',?,?,?)").join(",");
    const conflict=upsert?" ON CONFLICT(batch_id,order_id) DO UPDATE SET sequence_no=excluded.sequence_no,status='planned',added_by_user_id=excluded.added_by_user_id,updated_at=excluded.updated_at":"";
    const firstIndex=rows.indexOf(rowChunk[0]);
    return env.DB.prepare(`INSERT INTO transport_batch_orders(id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at) VALUES ${values}${conflict}`).bind(...rowChunk.flatMap((row,index)=>[crypto.randomUUID(),organizationId,batchId,row.order_id,startSequence+firstIndex+index,userId,now,now]));
  });
}
async function batchHasStarted(organizationId:string,batchId:string){const row=await env.DB.prepare(`SELECT EXISTS(SELECT 1 FROM warehouse_dispatches d LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id WHERE d.organization_id=? AND d.transport_batch_id=? AND d.status!='cancelled' AND (d.status='dispatched' OR di.status!='pending')) started`).bind(organizationId,batchId).first<{started:number}>();return Boolean(row?.started)}
async function editableBatch(organizationId:string,warehouseId:string,batchId:string){const batch=await env.DB.prepare("SELECT id,batch_number FROM transport_batches WHERE id=? AND organization_id=? AND warehouse_id=? AND batch_number LIKE 'PZ-%' AND status IN ('planning','loading') AND approval_status IN ('draft','rejected')").bind(batchId,organizationId,warehouseId).first<{id:string;batch_number:string}>();if(!batch||await batchHasStarted(organizationId,batchId))return null;return batch}
export function meta(){return[{title:"货物配载 | International TMS"}]}
