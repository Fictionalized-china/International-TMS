import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { parseIntakeDraftPayload, type IntakeDraftPayload } from "./intake-drafts";
import { writeAudit } from "./audit.server";
import { changedRowGuard,guardedBatch,predicateGuard } from "./mutation-guard.server";
import { directIntakeQuotationId } from "./intake-submission.server";

export type IntakeDraftSummary={id:string;revision:number;title:string;updated_at:string};
function assertAccess(current:SessionUser) {
  if(current.site!=="admin"||!current.permissions.includes("order.intake.manage"))throw new Error("当前账号没有录单草稿权限");
}
export async function listIntakeDrafts(current:SessionUser):Promise<IntakeDraftSummary[]> {
  assertAccess(current);
  return (await env.DB.prepare("SELECT id,revision,title,updated_at FROM order_intake_drafts WHERE organization_id=? AND created_by_user_id=? AND status='draft' ORDER BY updated_at DESC,id LIMIT 30").bind(current.organizationId,current.userId).all<IntakeDraftSummary>()).results;
}
export async function loadIntakeDraft(current:SessionUser,id:string) {
  assertAccess(current);
  const row=await env.DB.prepare("SELECT id,revision,payload_json FROM order_intake_drafts WHERE id=? AND organization_id=? AND created_by_user_id=? AND status='draft'").bind(id,current.organizationId,current.userId).first<{id:string;revision:number;payload_json:string}>();
  if(!row)throw new Error("草稿不存在、已转单或不属于当前账号");
  return {id:row.id,revision:Number(row.revision),payload:parseIntakeDraftPayload(row.payload_json)};
}
export async function saveIntakeDraft(input:{current:SessionUser;id:string;revision:number;payload:string;request:Request}) {
  assertAccess(input.current);
  if(!/^[A-Za-z0-9_-]{10,160}$/.test(input.id)||!Number.isSafeInteger(input.revision)||input.revision<0)throw new Error("草稿身份或版本无效");
  const payload=parseIntakeDraftPayload(input.payload);
  if(payload.fields.find(([key])=>key==="intakeRequestId")?.[1]!==input.id)throw new Error("草稿与录单身份不一致");
  const now=new Date().toISOString(),next=input.revision+1;
  const title=payload.fields.find(([key])=>key==="cargoDescription")?.[1].trim().slice(0,100)||"未完成录单";
  const statement=input.revision===0
    ?env.DB.prepare("INSERT INTO order_intake_drafts(id,organization_id,created_by_user_id,title,payload_json,revision,status,created_at,updated_at) VALUES(?,?,?,?,?,1,'draft',?,?)").bind(input.id,input.current.organizationId,input.current.userId,title,JSON.stringify(payload),now,now)
    :env.DB.prepare("UPDATE order_intake_drafts SET title=?,payload_json=?,revision=revision+1,updated_at=? WHERE id=? AND organization_id=? AND created_by_user_id=? AND revision=? AND status='draft'").bind(title,JSON.stringify(payload),now,input.id,input.current.organizationId,input.current.userId,input.revision);
  const quoteId=await directIntakeQuotationId(input.current.organizationId,input.current.userId,input.id);
  try {await guardedBatch(env.DB,[predicateGuard(env.DB,"NOT EXISTS(SELECT 1 FROM quotations WHERE id=? AND organization_id=?)",[quoteId,input.current.organizationId],now),statement,changedRowGuard(env.DB,now)],"草稿已在其他窗口保存或开始转单，请刷新后继续");}
  catch(error){
    const saved=await env.DB.prepare("SELECT revision,payload_json FROM order_intake_drafts WHERE id=? AND organization_id=? AND created_by_user_id=? AND status='draft'").bind(input.id,input.current.organizationId,input.current.userId).first<{revision:number;payload_json:string}>();
    if(saved&&Number(saved.revision)===next&&saved.payload_json===JSON.stringify(payload))return {id:input.id,revision:next,payload};
    if(/unique|duplicate/i.test(String(error)))throw new Error("草稿已保存，请从草稿列表打开最新版本，避免覆盖其他窗口内容");throw error;
  }
  await writeAudit({request:input.request,organizationId:input.current.organizationId,actorUserId:input.current.userId,action:"order.intake_draft.save",resourceType:"intake_draft",resourceId:input.id,metadata:{revision:next,fieldCount:payload.fields.length,filesOmitted:payload.filesOmitted.length}});
  return {id:input.id,revision:next,payload};
}
export async function markIntakeDraftSubmitted(current:SessionUser,requestId:string,orderId:string) {
  assertAccess(current);
  await env.DB.prepare("UPDATE order_intake_drafts SET status='submitted',linked_order_id=?,updated_at=? WHERE id=? AND organization_id=? AND created_by_user_id=? AND status='draft' AND EXISTS(SELECT 1 FROM transport_orders WHERE id=? AND organization_id=order_intake_drafts.organization_id AND created_by_user_id=order_intake_drafts.created_by_user_id)")
    .bind(orderId,new Date().toISOString(),requestId,current.organizationId,current.userId,orderId).run();
}
export type LoadedIntakeDraft={id:string;revision:number;payload:IntakeDraftPayload};

/** Run in the same transaction as the first quotation insert, not only at page load. */
export function intakeDraftSubmissionGuard(current:SessionUser,requestId:string,revision:number,now:string) {
  assertAccess(current);
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error("草稿版本无效，请重新打开草稿");
  return predicateGuard(env.DB,`((?=0 AND NOT EXISTS(SELECT 1 FROM order_intake_drafts WHERE id=? AND organization_id=? AND created_by_user_id=?))
    OR EXISTS(SELECT 1 FROM order_intake_drafts WHERE id=? AND organization_id=? AND created_by_user_id=? AND revision=? AND status='draft'))`,
    [revision,requestId,current.organizationId,current.userId,requestId,current.organizationId,current.userId,revision],now);
}
