import { env } from "cloudflare:workers";
import { requireSessionUser,type SessionUser } from "./auth.server";
import { requirePortalCustomer } from "./portal.server";
import { orderVisibilitySql } from "./order-access";
import { warehouseRelatedOrderSql } from "./warehouse-related-order";
import { loadWarehouseContext } from "./warehouse-context.server";
import { requireWarehouseAssignment } from "./warehouse-access.server";
import { loadActivePositionAccessProfile,activePositionProfilePredicate } from "./position-access-profile.server";
import { predicateGuard,guardedBatch } from "./mutation-guard.server";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { sitePhotoStages } from "./business-process-policy";
import { listOrderSitePhotos,prepareSitePhotoStatements,sitePhotoLimits,type SitePhotoStage } from "./order-site-photos.server";
import { storedDataUrlResponse } from "./stored-file-response.server";
import {isBossBusinessActor} from "./permission-blocks";

export type PhotoSite="admin"|"warehouse"|"portal";
export async function sitePhotoScope(request:Request,site:PhotoSite){
  if(site==="portal"){
    const {user,customer}=await requirePortalCustomer(request);
    return{current:user as SessionUser,scope:{sql:"o.customer_id=?",values:[customer.id]},warehouse:null};
  }
  const current=await requireSessionUser(request,site==="warehouse"?"warehouse.view":"order.view",site==="warehouse"?"warehouse":"admin");
  if(site==="warehouse"){
    const {selected:warehouse}=await loadWarehouseContext(request,current);
    await requireWarehouseAssignment(current,warehouse.id,"viewer");
    return{current,scope:warehouseRelatedOrderSql(warehouse.id,warehouse.warehouse_role),warehouse};
  }
  return{current,scope:orderVisibilitySql(current,"o"),warehouse:null};
}
function uploadPermission(current:SessionUser,stage:SitePhotoStage,warehouse:boolean){
  if(warehouse)return current.permissions.includes("warehouse.operate")?"warehouse.operate":null;
  if(current.permissions.includes("order.module.documents.manage"))return "order.module.documents.manage";
  const candidates=stage==="pickup"?["tracking.daily.manage","order.module.transport.manage"]:stage==="domestic_receipt"?["order.module.warehouse.manage"]:stage==="overseas_receipt"||stage==="delivery"?["order.module.overseas_warehouse.manage"]:["order.module.transport.manage"];
  return candidates.find(permission=>current.permissions.includes(permission))??null;
}
/** A company-wide read scope is not permission to add evidence to every order. */
function photoDuty(current:SessionUser,stage:SitePhotoStage,warehouse:boolean){
  if(warehouse||isBossBusinessActor(current))return{sql:"1=1",values:[] as string[]};
  const modules=stage==="domestic_receipt"?["warehouse","documents"]:stage==="delivery"||stage==="overseas_receipt"?["overseas_warehouse","documents"]:["transport","tracking","documents"];
  const codes=modules.map(code=>`'${code}'`).join(",");
  return{sql:`(o.current_assignee_user_id=? OR EXISTS(SELECT 1 FROM order_module_instances duty_m WHERE duty_m.organization_id=o.organization_id AND duty_m.order_id=o.id AND duty_m.enabled=1 AND duty_m.module_code IN (${codes})
    AND (duty_m.assignee_user_id=? OR (duty_m.assignee_user_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM order_tasks personal_t WHERE personal_t.organization_id=o.organization_id AND personal_t.order_id=o.id AND personal_t.module_code=duty_m.module_code AND personal_t.status IN ('pending','in_progress') AND personal_t.assignee_user_id IS NOT NULL)
      AND EXISTS(SELECT 1 FROM workflow_instance_step_states duty_s JOIN workflow_instance_module_states duty_ms ON duty_ms.instance_step_state_id=duty_s.id WHERE duty_s.instance_id=o.workflow_instance_id AND duty_ms.module_code=duty_m.module_code AND duty_ms.responsibility_position_code=?))))
    OR EXISTS(SELECT 1 FROM order_tasks duty_t WHERE duty_t.organization_id=o.organization_id AND duty_t.order_id=o.id AND duty_t.module_code IN (${codes}) AND duty_t.status IN ('pending','in_progress') AND duty_t.assignee_user_id=?))`,values:[current.userId,current.userId,current.positionCode??"",current.userId]};
}
export async function loadSitePhotoPanel(request:Request,site:Exclude<PhotoSite,"portal">,orderId:string){
  const {current,scope,warehouse}=await sitePhotoScope(request,site);
  const duties=Object.keys(sitePhotoStages).map(stage=>({stage:stage as SitePhotoStage,...photoDuty(current,stage as SitePhotoStage,Boolean(warehouse))}));
  const order=await env.DB.prepare(`SELECT o.status,${duties.map((d,i)=>`CASE WHEN ${d.sql} THEN 1 ELSE 0 END duty_${i}`).join(",")} FROM transport_orders o WHERE o.organization_id=? AND o.id=? AND ${scope.sql}`).bind(...duties.flatMap(d=>d.values),current.organizationId,orderId,...scope.values).first<{status:string}&Record<string,number>>();
  if(!order)throw new Response("订单不存在或超出授权范围",{status:404});
  const policy=await loadBusinessProcessPolicy(current.organizationId),limits=sitePhotoLimits(policy);
  const stages=limits.enabledStages.filter(stage=>uploadPermission(current,stage,Boolean(warehouse))&&order.status!=="cancelled"&&Number(order[`duty_${duties.findIndex(d=>d.stage===stage)}`])===1);
  return{...await listOrderSitePhotos(env.DB,current.organizationId,orderId,{page:Number(new URL(request.url).searchParams.get("page"))||1}),stages,limits};
}
export async function uploadSitePhotoSupplement(request:Request,site:Exclude<PhotoSite,"portal">,orderId:string){
  const {current,scope,warehouse}=await sitePhotoScope(request,site);
  const form=await request.formData(),stage=String(form.get("stage")??"");
  if(!Object.hasOwn(sitePhotoStages,stage))return{formError:"请选择现场作业节点"};
  const profile=await loadActivePositionAccessProfile(env.DB,current.organizationId,current.userId);
  if(!profile)throw new Response("账号已停用",{status:403});
  const actor={...current,...profile,roleCodes:[profile.roleCode]},permission=uploadPermission(actor,stage as SitePhotoStage,Boolean(warehouse));
  if(!permission)throw new Response("没有现场照片上传权限",{status:403});
  if(warehouse)await requireWarehouseAssignment(actor,warehouse.id,"operator");
  const freshScope=warehouse?scope:orderVisibilitySql(actor,"o");
  const duty=photoDuty(actor,stage as SitePhotoStage,Boolean(warehouse));
  const order=await env.DB.prepare(`SELECT o.customer_id,o.status FROM transport_orders o WHERE o.organization_id=? AND o.id=? AND ${freshScope.sql} AND ${duty.sql}`).bind(current.organizationId,orderId,...freshScope.values,...duty.values).first<{customer_id:string;status:string}>();
  if(!order||order.status==="cancelled")throw new Response("订单不在可上传范围",{status:404});
  try{
    const requestKey=String(form.get("photoRequestKey")??""),now=new Date().toISOString(),description=String(form.get("description")??"").trim();
    if(!form.getAll("sitePhotos").some(file=>file instanceof File&&file.size>0))throw new Error("请先选择需要保存的现场照片");
    const statements=await prepareSitePhotoStatements(env.DB,{organizationId:current.organizationId,actorUserId:current.userId,form,stage:stage as SitePhotoStage,sourceType:"supplement",sourceId:requestKey,requestKey,targets:[{orderId,customerId:order.customer_id}],warehouseId:warehouse?.id,occurredAt:now,now,description});
    const identity=activePositionProfilePredicate({organizationId:current.organizationId,userId:current.userId,profile,requiredPermissions:[site==="warehouse"?"warehouse.view":"order.view",permission]});
    const guards=[predicateGuard(env.DB,identity.sql,identity.values,now),predicateGuard(env.DB,`EXISTS(SELECT 1 FROM transport_orders o WHERE o.organization_id=? AND o.id=? AND o.status!='cancelled' AND ${freshScope.sql} AND ${duty.sql})`,[current.organizationId,orderId,...freshScope.values,...duty.values],now)];
    if(warehouse&&!actor.permissions.includes("warehouse.manage"))guards.push(predicateGuard(env.DB,"EXISTS(SELECT 1 FROM warehouse_user_access WHERE organization_id=? AND user_id=? AND warehouse_id=? AND access_level IN ('operator','manager'))",[actor.organizationId,actor.userId,warehouse.id],now));
    await guardedBatch(env.DB,[...guards,...statements],"权限、照片配置或订单归属已变化，本次未保存，请刷新核对后重试");
    return{success:"现场照片已保存，并自动同步本单客户；未改变运输或库存状态",savedKey:requestKey};
  }catch(error){return{formError:error instanceof Error?error.message:"照片未保存，请保留选择并重试"};}
}
export async function loadSitePhotoFile(request:Request,site:PhotoSite,photoId:string){
  const {current,scope}=await sitePhotoScope(request,site),thumbnail=new URL(request.url).searchParams.get("size")==="thumbnail";
  if(photoId.startsWith("exception:")){
    // Legacy evidence remains in its authoritative table; no copied originals,
    // fabricated thumbnail, changed exception, or public internal-file route.
    if(thumbnail)throw new Response("历史凭证请点击查看原图",{status:404});
    const row=await env.DB.prepare(`SELECT a.file_name,a.content_type,a.data_url FROM warehouse_exception_attachments a
      JOIN warehouse_exceptions e ON e.id=a.exception_id AND e.organization_id=a.organization_id
      JOIN shipments s ON s.id=e.shipment_id AND s.organization_id=e.organization_id
      JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id AND o.customer_id=s.customer_id
      WHERE a.id=? AND a.organization_id=? AND a.content_type IN ('image/jpeg','image/png','image/webp') AND ${scope.sql}`)
      .bind(photoId.slice(10),current.organizationId,...scope.values).first<{file_name:string;content_type:string;data_url:string}>();
    if(!row)throw new Response("图片不存在或超出授权范围",{status:404});
    return storedDataUrlResponse({dataUrl:row.data_url,fileName:row.file_name,contentType:row.content_type,disposition:"inline"});
  }
  const row=await env.DB.prepare(`SELECT a.file_name,${thumbnail?"p.thumbnail_content_type content_type,p.thumbnail_data_url data_url":"a.content_type,a.data_url"}
    FROM order_site_photos p JOIN transport_orders o ON o.id=p.order_id AND o.organization_id=p.organization_id
    JOIN order_attachments a ON a.id=p.attachment_id AND a.order_id=p.order_id AND a.organization_id=p.organization_id AND a.customer_id=o.customer_id
    WHERE p.id=? AND p.organization_id=? AND ${scope.sql}`).bind(photoId,current.organizationId,...scope.values).first<{file_name:string;content_type:string;data_url:string}>();
  if(!row)throw new Response("图片不存在或超出授权范围",{status:404});
  return storedDataUrlResponse({dataUrl:row.data_url,fileName:row.file_name,contentType:row.content_type,disposition:"inline"});
}
