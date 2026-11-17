import {env} from "cloudflare:workers";
import {syncOrderWorkflowSnapshot} from "./order-modules.server";
import {prepareOrderIntakeAdvance,intakeGateCommitStatements} from "./order-intake-gate.server";
export async function ensureVerifiedReceivingBatch(input:{organizationId:string;warehouseId:string;shipmentId:string;locationId:string;actorUserId:string;now:string}) {
  const existing=await env.DB.prepare("SELECT b.id FROM warehouse_sorting_batches b JOIN warehouse_locations l ON l.id=b.target_location_id AND l.organization_id=b.organization_id WHERE b.organization_id=? AND b.shipment_id=? AND l.warehouse_id=? AND b.status!='cancelled' ORDER BY b.created_at DESC LIMIT 1").bind(input.organizationId,input.shipmentId,input.warehouseId).first<{id:string}>();
  const batchId=existing?.id??crypto.randomUUID();const statements:D1PreparedStatement[]=[];
  if(existing) statements.push(env.DB.prepare("UPDATE warehouse_sorting_batches SET target_location_id=?,status='verified',verified_by_user_id=?,verified_at=COALESCE(verified_at,?),updated_at=? WHERE id=? AND organization_id=?").bind(input.locationId,input.actorUserId,input.now,input.now,batchId,input.organizationId));
  else statements.push(env.DB.prepare("INSERT INTO warehouse_sorting_batches(id,organization_id,batch_number,shipment_id,target_location_id,status,notes,created_by_user_id,verified_by_user_id,created_at,updated_at,verified_at) VALUES(?,?,?,?,?,'verified',?,?,?,?,?,?)").bind(batchId,input.organizationId,generateCode("SORT"),input.shipmentId,input.locationId,"系统根据验收确认货齐自动生成",input.actorUserId,input.actorUserId,input.now,input.now,input.now));
  const packages=await env.DB.prepare("SELECT id FROM warehouse_packages WHERE organization_id=? AND shipment_id=? AND warehouse_id=? AND label_kind='inbound_mark' AND lifecycle_status='active' AND status='in_stock'").bind(input.organizationId,input.shipmentId,input.warehouseId).all<{id:string}>();
  for(const item of packages.results) statements.push(env.DB.prepare("INSERT OR IGNORE INTO warehouse_sorting_items(id,organization_id,batch_id,package_id,status,sorted_by_user_id,verified_by_user_id,sorted_at,verified_at,notes) VALUES(?,?,?,?,'verified',?,?,?,?,?)").bind(crypto.randomUUID(),input.organizationId,batchId,item.id,input.actorUserId,input.actorUserId,input.now,input.now,"验收确认货齐，自动纳入装车范围"));
  const order=await env.DB.prepare("SELECT order_id FROM shipments WHERE id=? AND organization_id=?").bind(input.shipmentId,input.organizationId).first<{order_id:string}>();
  if(!order)throw new Error("运单不存在，无法同步");
  await env.DB.batch([...intakeGateCommitStatements(await prepareOrderIntakeAdvance(input.organizationId,order.order_id),input.now),...statements]);
}

export async function completeDomesticTransport(organizationId:string,orderId:string,shipmentId:string,actorUserId:string,receiptNumber:string,now:string) {
  const [module,assignment]=await Promise.all([
    env.DB.prepare("SELECT id,status,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='transport' AND enabled=1").bind(organizationId,orderId).first<{id:string;status:string;current_step_code:string|null}>(),
    env.DB.prepare("SELECT id FROM order_transport_assignments WHERE organization_id=? AND order_id=? AND leg_type='first_mile' AND status!='cancelled' AND created_at<=? ORDER BY created_at DESC LIMIT 1").bind(organizationId,orderId,now).first<{id:string}>(),
  ]);
  const statements:D1PreparedStatement[]=[
    env.DB.prepare("UPDATE order_transport_assignments SET status='arrived',actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE organization_id=? AND id=? AND leg_type='first_mile' AND status!='cancelled'").bind(now,now,organizationId,assignment?.id??""),
    env.DB.prepare("UPDATE shipments SET actual_delivery_at=COALESCE(actual_delivery_at,?),updated_at=? WHERE id=? AND organization_id=?").bind(now,now,shipmentId,organizationId),
  ];
  if(assignment) statements.push(env.DB.prepare("UPDATE domestic_waybill_vehicles SET status='arrived',actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE organization_id=? AND assignment_id=?").bind(now,now,organizationId,assignment.id));
  if(module&&module.status!=="completed") statements.push(env.DB.prepare("UPDATE order_module_instances SET status='completed',current_step_code='warehouse_arrived',current_step_name='货物已到国内仓',progress_percent=100,completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=? WHERE id=? AND status!='completed'").bind(now,now,module.id),env.DB.prepare("INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(`receipt-transport:${shipmentId}:${receiptNumber}`,organizationId,orderId,module.id,"warehouse_acceptance_ready","验收确认货齐",module.current_step_code,"warehouse_arrived","货物已到国内仓",actorUserId,`入库单 ${receiptNumber} 已确认货齐`,now));
  await env.DB.batch([...intakeGateCommitStatements(await prepareOrderIntakeAdvance(organizationId,orderId),now),...statements]);
  await syncOrderWorkflowSnapshot(organizationId,orderId);
}

function generateCode(prefix:string){return `${prefix}-${crypto.randomUUID()}`;}
