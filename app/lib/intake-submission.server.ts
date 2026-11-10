import { sha256 } from './crypto.server';
import { policyEnabled,policyPositions,type BusinessProcessPolicy } from './business-process-policy';
import { isBossBusinessActor } from './permission-blocks';
export function assertDirectIntakeAuthority(input:{policy:BusinessProcessPolicy;positionCode:string|null;roleCodes:readonly string[];customerCsEnabled:number;emergencyReason:string}) {
  const {policy,positionCode,roleCodes,customerCsEnabled,emergencyReason}=input;
  const boss=isBossBusinessActor({positionCode,roleCodes});
  if(!policyPositions(policy,'order.submit_positions').includes(positionCode??'')&&!boss&&!roleCodes.includes('developer'))throw new Error('当前岗位未配置直接录单职责');
  if(boss)return;
  if(positionCode==='HR_ADMIN'&&(!policyEnabled(policy,'order.hr_emergency_enabled')||!emergencyReason.trim()))throw new Error('人事仅可在配置允许时紧急协助录单，请填写协助原因');
  if(positionCode==='CS'&&policyEnabled(policy,'order.cs_requires_customer_flag')&&!customerCsEnabled)throw new Error('该客户尚未配置为客服代录客户');
}
/** Scope request identity to one actor and reject changed replays, including file contents. */
export async function intakeSubmissionIdentity(form:FormData,organizationId:string,userId:string) {
  const requestId=String(form.get('intakeRequestId')??'');
  if(!/^[A-Za-z0-9_-]{10,160}$/.test(requestId))throw new Error('录单请求已失效，请重新打开录单窗口');
  const values:unknown[]=[];
  for(const [key,value] of form.entries()){
    if(key==='intakeRequestId'||key==='intakeDraftRevision')continue;
    if(typeof value==='string')values.push([key,value]);
    else {const hash=await crypto.subtle.digest('SHA-256',await value.arrayBuffer());values.push([key,value.name,value.type,value.size,Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')]);}
  }
  return {id:await directIntakeQuotationId(organizationId,userId,requestId),payloadHash:await sha256(JSON.stringify(values))};
}
export async function directIntakeQuotationId(organizationId:string,userId:string,requestId:string) {return `direct-${await sha256(JSON.stringify([organizationId,userId,requestId]))}`;}
