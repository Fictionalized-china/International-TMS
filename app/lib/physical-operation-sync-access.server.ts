import {env} from "cloudflare:workers";
import {sitePhotoScope} from "./order-site-photo-access.server";
import {loadActivePositionAccessProfile,activePositionProfilePredicate} from "./position-access-profile.server";
import {orderVisibilitySql} from "./order-access";
import {predicateGuard} from "./mutation-guard.server";
import {runPhysicalSyncJob} from "./physical-operation-sync.server";
import {requireWarehouseAssignment} from "./warehouse-access.server";

export type PhysicalSyncResult={jobs:{id:string;kind:string;warehouse_id:string;status:string;attempts:number;last_error:string|null;canRetry:boolean}[];success?:string};
export async function physicalSyncAccess(request:Request,site:"admin"|"warehouse",orderId:string,retry=false):Promise<PhysicalSyncResult>{
  const state=await sitePhotoScope(request,site),{current,warehouse}=state;
  const profile=await loadActivePositionAccessProfile(env.DB,current.organizationId,current.userId);
  if(!profile)throw new Response("账号已停用",{status:403});
  const actor={...current,...profile,roleCodes:[profile.roleCode]},scope=warehouse?state.scope:orderVisibilitySql(actor,"o");
  const order=await env.DB.prepare(`SELECT o.id FROM transport_orders o WHERE o.id=? AND o.organization_id=? AND ${scope.sql}`).bind(orderId,current.organizationId,...scope.values).first();
  if(!order)throw new Response("订单不在授权范围",{status:404});
  const rows=await env.DB.prepare(`SELECT id,kind,warehouse_id,status,attempts,last_error,created_at FROM physical_operation_sync_jobs
    WHERE organization_id=? AND order_id=? AND status!='completed'${warehouse?" AND warehouse_id=?":""} ORDER BY created_at LIMIT 20`).bind(current.organizationId,orderId,...(warehouse?[warehouse.id]:[])).all<{id:string;kind:string;warehouse_id:string;status:string;attempts:number;last_error:string|null}>();
  const can=(kind:string)=>warehouse?actor.permissions.includes("warehouse.operate"):actor.permissions.includes("order.manage")||actor.permissions.includes(kind==="domestic_receipt"?"order.module.warehouse.manage":"order.module.overseas_warehouse.manage");
  if(!retry)return{jobs:rows.results.map(row=>({...row,canRetry:can(row.kind)}))};
  if(request.method!=="POST")throw new Response("Method Not Allowed",{status:405});
  if(warehouse)await requireWarehouseAssignment(actor,warehouse.id,"operator");
  for(const job of rows.results){
    if(!can(job.kind))throw new Response("无权重试该作业的流程同步",{status:403});
    const permission=warehouse?"warehouse.operate":actor.permissions.includes("order.manage")?"order.manage":job.kind==="domestic_receipt"?"order.module.warehouse.manage":"order.module.overseas_warehouse.manage";
    const identity=activePositionProfilePredicate({organizationId:actor.organizationId,userId:actor.userId,profile,requiredPermissions:[permission]});
    const now=new Date().toISOString(),guards=[predicateGuard(env.DB,identity.sql,identity.values,now),predicateGuard(env.DB,`EXISTS(SELECT 1 FROM transport_orders o WHERE o.organization_id=? AND o.id=? AND ${scope.sql})`,[actor.organizationId,orderId,...scope.values],now)];
    if(warehouse&&!actor.permissions.includes("warehouse.manage"))guards.push(predicateGuard(env.DB,"EXISTS(SELECT 1 FROM warehouse_user_access WHERE organization_id=? AND user_id=? AND warehouse_id=? AND access_level IN ('operator','manager'))",[actor.organizationId,actor.userId,warehouse.id],now));
    await runPhysicalSyncJob(env.DB,actor.organizationId,job.id,guards);
  }
  return{...await physicalSyncAccess(request,site,orderId),success:"已重试流程同步；不会重复收货、出库或核销。仍有阻断时请按下方原因处理。"};
}
