import type { BusinessProcessPolicy } from "./business-process-policy";
import { defaultBusinessProcessPolicy,sitePhotoStages } from "./business-process-policy";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { fileToDataUrl } from "./file-data-url";
import { sha256 } from "./crypto.server";
import { predicateGuard } from "./mutation-guard.server";
import { chunkD1Values,d1Placeholders } from "./d1-bindings";
import {sitePhotoImageHeader,assertSitePhotoDimensions} from "./site-photo-image";

export type SitePhotoStage=keyof typeof sitePhotoStages;
export type SitePhotoTarget={orderId:string;customerId:string;orderNumber?:string;eventId?:string|null;packageIds?:string[]};
export type SitePhotoSummary={id:string;file_name:string;stage_code:SitePhotoStage;description:string|null;occurred_at:string;uploaded_by_name:string|null;event_id:string|null;order_id:string;has_thumbnail?:number};
export function sitePhotoLimits(policy:BusinessProcessPolicy){return{count:Number(policy["photos.max_count"]),fileBytes:Number(policy["photos.max_file_kb"])*1024,formats:policy["photos.formats"].split(","),enabledStages:policy["photos.enabled_stages"].split(",").filter(Boolean) as SitePhotoStage[],requiredStages:policy["photos.required_stages"].split(",").filter(Boolean) as SitePhotoStage[]};}

/** Check file bytes as well as the supplied MIME. No SVG/HTML disguised as a picture. */
export async function validateSiteImage(file:File,maxBytes:number,formats:readonly string[],maxPixels=40_000_000){
  if(!file.size||file.size>maxBytes)throw new Error(`${file.name||"图片"}为空或超过 ${Math.floor(maxBytes/1024)} KB 上限`);
  if(file.name.length>240||/[\u0000-\u001f\u007f]/.test(file.name))throw new Error("图片文件名无效");
  const b=new Uint8Array(await file.arrayBuffer());
  const header=sitePhotoImageHeader(b),format=header?.format;
  if(!format||!formats.includes(format)||file.type!==`image/${format}`)throw new Error(`${file.name}不是允许的真实 JPEG、PNG 或 WebP 图片`);
  assertSitePhotoDimensions(header,maxPixels);
  return fileToDataUrl({type:`image/${format}`,arrayBuffer:async()=>b.buffer as ArrayBuffer});
}

/** Server-authorized job targets only. Include these statements in the SAME
 * transaction after its events/packages have been inserted. Nothing is saved
 * during validation, so cancellation/failure cannot leave orphan files. */
export async function prepareSitePhotoStatements(db:D1Database,input:{
  organizationId:string;actorUserId:string;form:FormData;stage:SitePhotoStage;sourceType:string;sourceId:string;
  targets:SitePhotoTarget[];warehouseId?:string|null;occurredAt:string;now:string;requestKey?:string;description?:string;policy?:BusinessProcessPolicy;originalOnly?:boolean;
}){
  const policy=input.policy??await loadBusinessProcessPolicy(input.organizationId,db),limits=sitePhotoLimits(policy);
  const files=input.form.getAll("sitePhotos").filter((value):value is File=>value instanceof File&&value.size>0);
  const thumbs=input.form.getAll("sitePhotoThumbnails").filter((value):value is File=>value instanceof File&&value.size>0);
  const enabled=limits.enabledStages.includes(input.stage),required=limits.requiredStages.includes(input.stage);
  if(!enabled&&files.length)throw new Error("当前作业的现场照片上传已停用，请刷新核对配置");
  if(required&&!files.length)throw new Error(`${sitePhotoStages[input.stage]}已配置必须上传现场照片，请选择图片`);
  const policyKeys=["photos.enabled_stages","photos.required_stages","photos.formats","photos.max_count","photos.max_file_kb"] as const;
  const policyGuards=[predicateGuard(db,policyKeys.map(()=>"COALESCE((SELECT policy_value FROM business_process_policies WHERE organization_id=? AND policy_key=?),?)=?").join(" AND "),policyKeys.flatMap(key=>[input.organizationId,key,defaultBusinessProcessPolicy[key],policy[key]]),input.now)];
  if(!files.length)return policyGuards;
  if(files.length>limits.count||files.reduce((sum,file)=>sum+file.size,0)>12*1024*1024)throw new Error(`每次最多 ${limits.count} 张图片，总大小不超过 12 MB`);
  const hasThumbnails=thumbs.length===files.length;
  if(!hasThumbnails&&!(input.originalOnly&&thumbs.length===0))throw new Error("缩略图未准备好，请等待图片预览完成后提交；失败时重新选择图片即可重试");
  if(!input.targets.length||input.targets.length>200||new Set(input.targets.map(t=>t.orderId)).size!==input.targets.length)throw new Error("现场照片订单范围无效");
  const scopes=sitePhotoScopes(input.form,input.targets.map(t=>t.orderId),files.length);
  if(files.reduce((sum,file,i)=>sum+file.size*scopes[i].length,0)>48*1024*1024)throw new Error("本批照片覆盖的订单较多，请压缩照片后提交，或完成收货后在各订单内补传；当前没有写入照片或库存");
  const description=(input.description??"").trim();if(description.length>500)throw new Error("图片说明不能超过 500 字");
  const prepared=await Promise.all(files.map(async(file,i)=>{
    const original=await validateSiteImage(file,limits.fileBytes,limits.formats);
    const thumbnail=hasThumbnails?await validateSiteImage(thumbs[i],96*1024,["jpeg","png","webp"],512*512):"";
    return{file,original,thumbnail,thumbnailType:hasThumbnails?thumbs[i].type:"",hash:await sha256(original),orderIds:scopes[i]};
  }));
  if(new Set(prepared.map(p=>p.hash)).size!==prepared.length)throw new Error("同一次选择了重复图片，请移除重复项后提交");
  const requestKey=input.requestKey??`${input.sourceType}:${input.sourceId}`;
  if(!/^[A-Za-z0-9:_-]{8,160}$/.test(requestKey))throw new Error("图片提交标识无效，请刷新后重试");
  const submissionId=await sha256(`${input.organizationId}:${input.actorUserId}:${requestKey}`);
  const hash=await sha256(JSON.stringify({stage:input.stage,sourceType:input.sourceType,sourceId:input.sourceId,targets:input.targets,warehouseId:input.warehouseId??null,description,files:prepared.map(p=>({hash:p.hash,name:p.file.name,orderIds:p.orderIds}))}));
  const statements:D1PreparedStatement[]=[
    ...policyGuards,
    db.prepare("INSERT OR IGNORE INTO order_site_photo_submissions(id,organization_id,actor_user_id,request_key,payload_hash,created_at) VALUES(?,?,?,?,?,?)").bind(submissionId,input.organizationId,input.actorUserId,requestKey,hash,input.now),
    predicateGuard(db,"EXISTS(SELECT 1 FROM order_site_photo_submissions WHERE id=? AND organization_id=? AND actor_user_id=? AND HEX(payload_hash)=HEX(?))",[submissionId,input.organizationId,input.actorUserId,hash],input.now),
  ];
  for(const target of input.targets){
    statements.push(predicateGuard(db,"EXISTS(SELECT 1 FROM transport_orders WHERE id=? AND organization_id=? AND customer_id=?)",[target.orderId,input.organizationId,target.customerId],input.now));
    if(target.eventId)statements.push(predicateGuard(db,"EXISTS(SELECT 1 FROM shipment_events e JOIN shipments s ON s.id=e.shipment_id WHERE e.id=? AND s.organization_id=? AND s.order_id=?)",[target.eventId,input.organizationId,target.orderId],input.now));
    for(const ids of chunkD1Values(target.packageIds??[],4))statements.push(predicateGuard(db,`(SELECT COUNT(*) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id WHERE p.organization_id=? AND s.order_id=? AND p.id IN (${d1Placeholders(ids.length)}))=?`,[input.organizationId,target.orderId,...ids,ids.length],input.now));
    for(const p of prepared){
      if(!p.orderIds.includes(target.orderId))continue;
      const id=await sha256(`${input.organizationId}:${target.orderId}:${input.sourceType}:${input.sourceId}:${p.hash}`);
      statements.push(db.prepare("INSERT OR IGNORE INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)").bind(id,input.organizationId,target.orderId,target.customerId,p.file.name,p.file.type,p.file.size,p.original,input.actorUserId,input.now));
      statements.push(db.prepare("INSERT OR IGNORE INTO order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,updated_at) VALUES(?,?,?,'other',?,1,'approved',?)").bind(id,input.organizationId,target.orderId,`现场照片 · ${sitePhotoStages[input.stage]}${description?` · ${description}`:""}`,input.now));
      statements.push(db.prepare(`INSERT OR IGNORE INTO order_site_photos(id,organization_id,order_id,attachment_id,submission_id,stage_code,source_type,source_id,event_id,warehouse_id,package_ids_json,content_hash,thumbnail_data_url,thumbnail_content_type,description,occurred_at,uploaded_by_user_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,input.organizationId,target.orderId,id,submissionId,input.stage,input.sourceType,input.sourceId,target.eventId??null,input.warehouseId??null,JSON.stringify(target.packageIds??[]),p.hash,p.thumbnail,p.thumbnailType,description||null,input.occurredAt,input.actorUserId,input.now));
    }
  }
  // Audit once for a repeated submission; keep financial/internal attachments
  // out of this association and out of the customer photo endpoint.
  statements.push(db.prepare("INSERT OR IGNORE INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,'order.site_photos.upload','site_photo_submission',?,'success',?,?)").bind(`site-photo:${submissionId}`,input.organizationId,input.actorUserId,submissionId,JSON.stringify({stage:input.stage,orderIds:[...new Set(prepared.flatMap(p=>p.orderIds))],photoScopes:prepared.map(p=>({contentHash:p.hash,orderIds:p.orderIds})),count:prepared.length,sourceType:input.sourceType,sourceId:input.sourceId}),input.now));
  return statements;
}

/** The client can narrow a server-authorized job's targets, never extend them.
 * Shared batch evidence requires an explicit selection, not a default leak. */
function sitePhotoScopes(form:FormData,allowed:readonly string[],fileCount:number){
  const raw=form.get("sitePhotoTargetOrderIds");
  if(!raw){if(allowed.length===1)return Array.from({length:fileCount},()=>[allowed[0]]);throw new Error("请为每张照片选择适用订单；整批共用照片需明确选择全部订单，不会默认共享给所有客户");}
  let value:unknown;try{value=JSON.parse(String(raw));}catch{throw new Error("照片适用订单数据无效，请重新选择");}
  if(!Array.isArray(value)||value.length!==fileCount)throw new Error("照片与适用订单不匹配，请重新选择");
  return value.map((scope,index)=>{
    if(!Array.isArray(scope)||!scope.length||scope.length>allowed.length||scope.some(id=>typeof id!=="string"||!allowed.includes(id))||new Set(scope).size!==scope.length)throw new Error(`第 ${index+1} 张照片适用订单为空或超出本次作业范围，请核对后重试`);
    return [...scope].sort() as string[];
  });
}

export async function listOrderSitePhotos(db:D1Database,organizationId:string,orderId:string,options:{page?:number;eventId?:string}={}){
  const requested=Number(options.page??1),page=Number.isFinite(requested)?Math.min(100000,Math.max(1,Math.floor(requested))):1,event=options.eventId?" WHERE event_id=?":"",binds=[organizationId,orderId,organizationId,orderId,...(options.eventId?[options.eventId]:[])];
  const rows=await db.prepare(`SELECT * FROM (SELECT p.id,a.file_name,p.order_id,p.stage_code,p.description,p.occurred_at,p.event_id,u.display_name uploaded_by_name,CASE WHEN p.thumbnail_content_type='' THEN 0 ELSE 1 END has_thumbnail,'site' source_kind
    FROM order_site_photos p JOIN order_attachments a ON a.id=p.attachment_id AND a.order_id=p.order_id AND a.organization_id=p.organization_id
    JOIN transport_orders o ON o.id=p.order_id AND o.organization_id=p.organization_id AND o.customer_id=a.customer_id
    LEFT JOIN users u ON u.id=p.uploaded_by_user_id WHERE p.organization_id=? AND p.order_id=?
    UNION ALL SELECT a.id,a.file_name,o.id order_id,'other' stage_code,'历史仓库现场凭证' description,a.created_at occurred_at,NULL event_id,u.display_name uploaded_by_name,0 has_thumbnail,'exception' source_kind
    FROM warehouse_exception_attachments a
    JOIN warehouse_exceptions e ON e.id=a.exception_id AND e.organization_id=a.organization_id
    JOIN shipments s ON s.id=e.shipment_id AND s.organization_id=e.organization_id
    JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id AND o.customer_id=s.customer_id
    LEFT JOIN users u ON u.id=a.uploaded_by_user_id
    WHERE a.organization_id=? AND o.id=? AND a.content_type IN ('image/jpeg','image/png','image/webp')) photos${event}
    ORDER BY occurred_at DESC,id LIMIT 25 OFFSET ?`).bind(...binds,(page-1)*24).all<SitePhotoSummary&{source_kind:string}>();
  return{photos:rows.results.slice(0,24).map(({source_kind,...row})=>({...row,id:source_kind==='exception'?`exception:${row.id}`:row.id})),hasMore:rows.results.length>24,page};
}
