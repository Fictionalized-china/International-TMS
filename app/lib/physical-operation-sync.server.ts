import {env} from "cloudflare:workers";
import {recordWarehouseProgress} from "./warehouse-progress.server";
import {ensureVerifiedReceivingBatch,completeDomesticTransport} from "./warehouse-receipt-projection.server";
import {recordWorkflowEvent} from "./business-workflow.server";
import {synchronizeOrderExceptionStatuses} from "./order-exception-status.server";
import {syncOrderWorkflowSnapshot} from "./order-modules.server";
import type {OverseasReceivingResult} from "./overseas-receipt-projection.server";

export type PhysicalSyncInput={organizationId:string;orderId:string;warehouseId:string;actorUserId:string;sourceId:string;kind:"domestic_receipt"|"overseas_pickup"|"overseas_receipt";payload:Record<string,unknown>;now:string};
export function physicalSyncJobId(kind:PhysicalSyncInput["kind"],sourceId:string){return `${kind}:${sourceId}`;}
/** Include in the physical transaction, never enqueue after committing stock. */
export function physicalSyncJobStatement(db:D1Database,input:PhysicalSyncInput){
  return db.prepare(`INSERT INTO physical_operation_sync_jobs(id,organization_id,order_id,warehouse_id,kind,source_id,payload_json,actor_user_id,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`).bind(physicalSyncJobId(input.kind,input.sourceId),input.organizationId,input.orderId,input.warehouseId,input.kind,input.sourceId,JSON.stringify(input.payload),input.actorUserId,input.now,input.now);
}
type Job={id:string;organization_id:string;order_id:string;warehouse_id:string;kind:PhysicalSyncInput["kind"];source_id:string;payload_json:string;actor_user_id:string;status:string;created_at:string};
/** Only derived workflow state is retried. No receipt, movement, package,
 * customer photo, expense or signature is created again. */
export type PhysicalSyncRunResult={syncPending:boolean;busy:boolean;arrival?:OverseasReceivingResult};
export async function runPhysicalSyncJob(db:D1Database,organizationId:string,id:string,commitGuards:readonly D1PreparedStatement[]=[]):Promise<PhysicalSyncRunResult>{
  const now=new Date().toISOString(),leaseUntil=new Date(Date.now()+120_000).toISOString(),token=crypto.randomUUID();
  const results=await db.batch([...commitGuards,db.prepare(`UPDATE physical_operation_sync_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=?
    WHERE id=? AND organization_id=? AND (status='pending' OR (status='running' AND lease_until<?))`).bind(token,leaseUntil,now,id,organizationId,now)]);
  if(Number(results.at(-1)?.meta?.changes??0)!==1){
    const current=await db.prepare("SELECT status FROM physical_operation_sync_jobs WHERE id=? AND organization_id=?").bind(id,organizationId).first<{status:string}>();
    return{syncPending:current?.status!=="completed",busy:current?.status==="running"};
  }
  try{
    const job=await db.prepare("SELECT * FROM physical_operation_sync_jobs WHERE id=? AND organization_id=? AND lease_token=?").bind(id,organizationId,token).first<Job>();
    if(!job)throw new Error("同步任务已变化");
    let arrival:OverseasReceivingResult|undefined;
    if(job.kind==="domestic_receipt")await syncDomesticReceipt(job);
    else if(job.kind==="overseas_receipt"){
      const receipt=await db.prepare("SELECT r.id FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id AND s.organization_id=r.organization_id WHERE r.id=? AND r.organization_id=? AND r.warehouse_id=? AND s.order_id=? AND r.status='completed' AND r.cargo_complete=1").bind(job.source_id,organizationId,job.warehouse_id,job.order_id).first();
      if(!receipt)throw new Error("原境外收货事实未确认货齐，不能重试推进");
      const {finalizeOverseasReceiving}=await import("./overseas-receipt-projection.server");
      arrival=await finalizeOverseasReceiving({organizationId,orderId:job.order_id,actorUserId:job.actor_user_id,actualArrivalAt:job.created_at,notes:String((JSON.parse(job.payload_json) as {notes?:string}).notes??"")});
      if(arrival.warning)throw new Error(arrival.warning);
    }else if(job.kind==="overseas_pickup"){
      const action=(JSON.parse(job.payload_json) as {action:string}).action;
      const operation=await db.prepare("SELECT batch_id FROM overseas_warehouse_operations WHERE id=? AND organization_id=? AND order_id=? AND warehouse_id=? AND status IN ('notified','picked_up')").bind(job.source_id,organizationId,job.order_id,job.warehouse_id).first<{batch_id:string}>();
      if(!operation)throw new Error("原自提签收事实不完整，请先核对，不会重复出库");
      if(action==='pickup')await db.prepare(`UPDATE transport_batches SET status='arrived',road_status='pickup_completed',updated_at=? WHERE id=? AND organization_id=?
        AND NOT EXISTS(SELECT 1 FROM overseas_warehouse_operations WHERE batch_id=? AND organization_id=? AND status NOT IN ('picked_up','cancelled'))`)
        .bind(now,operation.batch_id,organizationId,operation.batch_id,organizationId).run();
      await syncOrderWorkflowSnapshot(organizationId,job.order_id);
    }else throw new Error("同步任务类型无效");
    const complete=await db.prepare("UPDATE physical_operation_sync_jobs SET status='completed',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND organization_id=? AND lease_token=?").bind(new Date().toISOString(),id,organizationId,token).run();
    return{syncPending:Number(complete.meta.changes)!==1,busy:false,arrival};
  }catch(error){
    // A failed status write still leaves a durable leased job for later retry.
    await db.prepare("UPDATE physical_operation_sync_jobs SET status='pending',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND organization_id=? AND lease_token=?")
      .bind((error instanceof Error?error.message:"流程同步失败").slice(0,1000),new Date().toISOString(),id,organizationId,token).run();
    return{syncPending:true,busy:false};
  }
}
/** The physical caller must never report rollback after its stock committed. */
export async function tryPhysicalSyncJob(db:D1Database,organizationId:string,id:string):Promise<PhysicalSyncRunResult>{
  try{return await runPhysicalSyncJob(db,organizationId,id);}
  catch{return{syncPending:true,busy:false};}
}

async function syncDomesticReceipt(job:Job){
  const fact=await env.DB.prepare(`SELECT r.shipment_id,r.location_id,r.receipt_number,r.cargo_complete,s.customer_id
    FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id AND s.organization_id=r.organization_id
    WHERE r.id=? AND r.organization_id=? AND r.warehouse_id=? AND s.order_id=? AND r.status='completed'`)
    .bind(job.source_id,job.organization_id,job.warehouse_id,job.order_id).first<{shipment_id:string;location_id:string;receipt_number:string;cargo_complete:number;customer_id:string}>();
  if(!fact)throw new Error("原收货事实不完整，请核对；不会重复入库");
  const payload=JSON.parse(job.payload_json) as {result:string;packageCount:number;exceptionNotes?:string;createdShipmentNumber?:string};
  const ready=payload.result==="ready"&&Number(fact.cargo_complete)===1,exception=payload.result==="exception";
  if(exception)await synchronizeOrderExceptionStatuses(job.organization_id,[job.order_id],job.created_at);
  if(ready)await ensureVerifiedReceivingBatch({organizationId:job.organization_id,warehouseId:job.warehouse_id,shipmentId:fact.shipment_id,locationId:fact.location_id,actorUserId:job.actor_user_id,now:job.created_at});
  await recordWarehouseProgress({organizationId:job.organization_id,orderId:job.order_id,actorUserId:job.actor_user_id,
    stepCode:ready?"ready":"receiving",stepName:ready?"货齐，等待装车/配载":exception?"验收异常处理中":"累计收货中",
    actionCode:ready?"acceptance_ready":exception?"acceptance_exception":"acceptance_partial",actionName:ready?"验收并确认货齐":exception?"异常验收入库":"分批验收入库",
    notes:`入库单 ${fact.receipt_number}，生成 ${payload.packageCount} 张仓库标签${payload.exceptionNotes?`；${payload.exceptionNotes}`:""}`});
  if(ready)await completeDomesticTransport(job.organization_id,job.order_id,fact.shipment_id,job.actor_user_id,fact.receipt_number,job.created_at);
  if(payload.createdShipmentNumber)await recordWorkflowEvent({organizationId:job.organization_id,event:"shipment.created",customerId:fact.customer_id,orderId:job.order_id,shipmentId:fact.shipment_id,actorUserId:job.actor_user_id,source:"admin",metadata:{number:payload.createdShipmentNumber,createdFromOrder:true,warehouse:true}});
  await recordWorkflowEvent({organizationId:job.organization_id,event:"shipment.picked_up",customerId:fact.customer_id,orderId:job.order_id,shipmentId:fact.shipment_id,actorUserId:job.actor_user_id,source:"admin",metadata:{warehouse:true,acceptance:true,receiptNumber:fact.receipt_number,locationId:fact.location_id,result:payload.result,packages:payload.packageCount}});
}
