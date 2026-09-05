import { env } from "cloudflare:workers";
import { synchronizeOrderExceptionStatuses } from "./order-exception-status.server";

export const batchExceptionScopes=["batch","order","package"] as const;
export const batchExceptionTypes=["cargo_damage","cargo_shortage","document","customs","vehicle","delay","route","warehouse","other"] as const;
export const batchExceptionSeverities=["low","medium","high","critical"] as const;

export type BatchExceptionScope=(typeof batchExceptionScopes)[number];
export type BatchExceptionType=(typeof batchExceptionTypes)[number];
export type BatchExceptionSeverity=(typeof batchExceptionSeverities)[number];

export type BatchException={
  id:string;
  exception_number:string;
  scope:BatchExceptionScope;
  order_id:string|null;
  order_number:string|null;
  package_id:string|null;
  package_barcode:string|null;
  exception_type:BatchExceptionType;
  severity:BatchExceptionSeverity;
  blocks_progress:number;
  status:"open"|"processing"|"resolved"|"cancelled";
  description:string;
  resolution:string|null;
  reporter_name:string|null;
  assignee_name:string|null;
  resolved_by_name:string|null;
  reported_at:string;
  resolved_at:string|null;
  updated_at:string;
};

export type BatchExceptionPackage={
  id:string;
  barcode:string;
  package_number:string;
  order_id:string;
  order_number:string;
  cargo_item_id:string|null;
  cargo_name:string|null;
  pieces:number;
  weight_kg:number|null;
  volume_cbm:number|null;
  status:string;
  warehouse_name:string|null;
  location_name:string|null;
};

export async function listBatchExceptions(organizationId:string,batchId:string){
  return (await env.DB.prepare(
    `SELECT e.id,e.exception_number,e.scope,e.order_id,o.order_number,e.package_id,p.barcode package_barcode,
      e.exception_type,e.severity,e.blocks_progress,e.status,e.description,e.resolution,
      reporter.display_name reporter_name,assignee.display_name assignee_name,resolver.display_name resolved_by_name,
      e.reported_at,e.resolved_at,e.updated_at
     FROM transport_batch_exceptions e
     LEFT JOIN transport_orders o ON o.id=e.order_id
     LEFT JOIN warehouse_packages p ON p.id=e.package_id
     LEFT JOIN users reporter ON reporter.id=e.reported_by_user_id
     LEFT JOIN users assignee ON assignee.id=e.assigned_to_user_id
     LEFT JOIN users resolver ON resolver.id=e.resolved_by_user_id
     WHERE e.organization_id=? AND e.batch_id=?
     ORDER BY CASE e.status WHEN 'open' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
       CASE e.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       e.updated_at DESC`,
  ).bind(organizationId,batchId).all<BatchException>()).results;
}

export async function listBatchExceptionPackages(organizationId:string,batchId:string){
  return (await env.DB.prepare(
    `SELECT DISTINCT p.id,p.barcode,p.package_number,o.id order_id,o.order_number,
       p.cargo_item_id,i.cargo_name_cn cargo_name,p.pieces,p.weight_kg,p.volume_cbm,p.status,
       w.name warehouse_name,l.name location_name
     FROM transport_batch_orders bo
     JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     JOIN shipments s ON s.order_id=o.id AND s.organization_id=o.organization_id
     JOIN warehouse_packages p ON p.shipment_id=s.id AND p.organization_id=s.organization_id
     LEFT JOIN order_cargo_items i ON i.id=p.cargo_item_id AND i.organization_id=p.organization_id
     LEFT JOIN warehouses w ON w.id=p.warehouse_id AND w.organization_id=p.organization_id
     LEFT JOIN warehouse_locations l ON l.id=p.location_id AND l.organization_id=p.organization_id
     WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
     ORDER BY o.order_number,p.barcode`,
  ).bind(organizationId,batchId).all<BatchExceptionPackage>()).results;
}

export async function listBlockingBatchExceptions(organizationId:string,batchId:string){
  return (await env.DB.prepare(
    `SELECT exception_number,description FROM transport_batch_exceptions
     WHERE organization_id=? AND batch_id=? AND status IN ('open','processing') AND blocks_progress=1
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,reported_at`,
  ).bind(organizationId,batchId).all<{exception_number:string;description:string}>()).results;
}

export async function createBatchException(input:{
  organizationId:string;
  batchId:string;
  scope:string;
  orderId:string|null;
  packageId:string|null;
  exceptionType:string;
  severity:string;
  blocksProgress:boolean;
  description:string;
  actorUserId:string;
  now?:string;
}){
  if(!batchExceptionScopes.includes(input.scope as BatchExceptionScope))throw new Error("异常范围无效");
  if(!batchExceptionTypes.includes(input.exceptionType as BatchExceptionType))throw new Error("异常类型无效");
  if(!batchExceptionSeverities.includes(input.severity as BatchExceptionSeverity))throw new Error("异常等级无效");
  const description=input.description.trim();
  if(description.length<4||description.length>500)throw new Error("异常说明需填写 4–500 个字");
  const scope=input.scope as BatchExceptionScope;
  let orderId:string|null=null;
  let packageId:string|null=null;
  if(scope==="order"){
    const order=await env.DB.prepare(
      `SELECT bo.order_id FROM transport_batch_orders bo
       WHERE bo.organization_id=? AND bo.batch_id=? AND bo.order_id=? AND bo.status!='removed'`,
    ).bind(input.organizationId,input.batchId,input.orderId).first<{order_id:string}>();
    if(!order)throw new Error("所选订单不属于当前配载单");
    orderId=order.order_id;
  }else if(scope==="package"){
    const pkg=await env.DB.prepare(
      `SELECT p.id,o.id order_id FROM warehouse_packages p
       JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
       JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
       JOIN transport_batch_orders bo ON bo.order_id=o.id AND bo.organization_id=o.organization_id
       WHERE p.id=? AND p.organization_id=? AND bo.batch_id=? AND bo.status!='removed'`,
    ).bind(input.packageId,input.organizationId,input.batchId).first<{id:string;order_id:string}>();
    if(!pkg)throw new Error("所选 OUL 货物不属于当前配载单");
    orderId=pkg.order_id;
    packageId=pkg.id;
  }
  const duplicate=await env.DB.prepare(
    `SELECT 1 FROM transport_batch_exceptions
     WHERE organization_id=? AND batch_id=? AND scope=?
       AND COALESCE(order_id,'')=COALESCE(?,'') AND COALESCE(package_id,'')=COALESCE(?,'')
       AND exception_type=? AND status IN ('open','processing')`,
  ).bind(input.organizationId,input.batchId,scope,orderId,packageId,input.exceptionType).first();
  if(duplicate)throw new Error("同一对象已有相同类型的未关闭异常");
  const now=input.now??new Date().toISOString();
  const id=crypto.randomUUID();
  const exceptionNumber=`PZX-${now.slice(0,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
  try{
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transport_batch_exceptions(
          id,organization_id,batch_id,exception_number,scope,order_id,package_id,exception_type,
          severity,blocks_progress,status,description,reported_by_user_id,reported_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?)`,
      ).bind(id,input.organizationId,input.batchId,exceptionNumber,scope,orderId,packageId,input.exceptionType,input.severity,input.blocksProgress?1:0,description,input.actorUserId,now,now,now),
      env.DB.prepare(
        `INSERT INTO transport_batch_exception_events(id,organization_id,exception_id,event_type,notes,actor_user_id,created_at)
         VALUES(?,?,?,'created',?,?,?)`,
      ).bind(crypto.randomUUID(),input.organizationId,id,description,input.actorUserId,now),
    ]);
  }catch(error){
    const concurrentDuplicate=await env.DB.prepare(
      `SELECT 1 FROM transport_batch_exceptions
       WHERE organization_id=? AND batch_id=? AND scope=?
         AND COALESCE(order_id,'')=COALESCE(?,'') AND COALESCE(package_id,'')=COALESCE(?,'')
         AND exception_type=? AND status IN ('open','processing')`,
    ).bind(input.organizationId,input.batchId,scope,orderId,packageId,input.exceptionType).first();
    if(concurrentDuplicate)throw new Error("同一对象已有相同类型的未关闭异常");
    throw error;
  }
  const affectedOrderIds=scope==="batch"
    ? (await env.DB.prepare("SELECT order_id FROM transport_batch_orders WHERE organization_id=? AND batch_id=? AND status!='removed'").bind(input.organizationId,input.batchId).all<{order_id:string}>()).results.map(item=>item.order_id)
    : orderId?[orderId]:[];
  await synchronizeOrderExceptionStatuses(input.organizationId,affectedOrderIds,now);
  return{id,exceptionNumber,scope,orderId,packageId,affectedOrderIds,description,severity:input.severity as BatchExceptionSeverity,blocksProgress:input.blocksProgress};
}

export async function progressBatchException(input:{organizationId:string;batchId:string;exceptionId:string;actorUserId:string;now?:string}){
  const now=input.now??new Date().toISOString();
  const result=await env.DB.prepare(
    `UPDATE transport_batch_exceptions SET status='processing',assigned_to_user_id=COALESCE(assigned_to_user_id,?),updated_at=?
     WHERE id=? AND organization_id=? AND batch_id=? AND status='open'`,
  ).bind(input.actorUserId,now,input.exceptionId,input.organizationId,input.batchId).run();
  if(!Number(result.meta?.changes||0))throw new Error("异常不存在或已被其他人处理");
  await env.DB.prepare(
    `INSERT INTO transport_batch_exception_events(id,organization_id,exception_id,event_type,notes,actor_user_id,created_at)
     VALUES(?,?,?,'processing','开始处理',?,?)`,
  ).bind(crypto.randomUUID(),input.organizationId,input.exceptionId,input.actorUserId,now).run();
}

export async function resolveBatchException(input:{organizationId:string;batchId:string;exceptionId:string;actorUserId:string;resolution:string;now?:string}){
  const resolution=input.resolution.trim();
  if(resolution.length<4||resolution.length>500)throw new Error("处理结果需填写 4–500 个字");
  const exception=await env.DB.prepare(
    `SELECT scope,order_id FROM transport_batch_exceptions
     WHERE id=? AND organization_id=? AND batch_id=? AND status IN ('open','processing')`,
  ).bind(input.exceptionId,input.organizationId,input.batchId).first<{scope:BatchExceptionScope;order_id:string|null}>();
  if(!exception)throw new Error("异常不存在或已经结案");
  const now=input.now??new Date().toISOString();
  const result=await env.DB.prepare(
    `UPDATE transport_batch_exceptions SET status='resolved',resolution=?,resolved_by_user_id=?,resolved_at=?,updated_at=?
     WHERE id=? AND organization_id=? AND batch_id=? AND status IN ('open','processing')`,
  ).bind(resolution,input.actorUserId,now,now,input.exceptionId,input.organizationId,input.batchId).run();
  if(!Number(result.meta?.changes||0))throw new Error("异常已被其他人结案，请刷新后查看");
  await env.DB.prepare(
    `INSERT INTO transport_batch_exception_events(id,organization_id,exception_id,event_type,notes,actor_user_id,created_at)
     VALUES(?,?,?,'resolved',?,?,?)`,
  ).bind(crypto.randomUUID(),input.organizationId,input.exceptionId,resolution,input.actorUserId,now).run();
  const affectedOrderIds=exception.scope==="batch"
    ? (await env.DB.prepare("SELECT order_id FROM transport_batch_orders WHERE organization_id=? AND batch_id=? AND status!='removed'").bind(input.organizationId,input.batchId).all<{order_id:string}>()).results.map(item=>item.order_id)
    : exception.order_id?[exception.order_id]:[];
  await synchronizeOrderExceptionStatuses(input.organizationId,affectedOrderIds,now);
  return{resolution,affectedOrderIds};
}
