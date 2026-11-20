import {env} from "cloudflare:workers";
import type {SessionUser} from "./auth.server";
import {loadOrderIntakeContext} from "./order-intake-context.server";
import {defaultBusinessProcessPolicy,policyPositions,type BusinessProcessPolicyKey} from "./business-process-policy";
import {intakeOperationDisplay,intakeOperationFields,intakeOperationFormName,intakeOperationPresent,readIntakeOperations} from "./intake-operations";
import {resolveIntakeOperations} from "./intake-operations.server";
import {intakeRouteFields} from "./intake-route-fields";
import {resolveIntakeRouteFields} from "./intake-route-fields.server";
import {inspectIntakeRuleBinding} from "./order-intake-rule";
import {activePositionProfilePredicate,loadActivePositionAccessProfile} from "./position-access-profile.server";
import {activeOrganizationAssigneeSelectionPredicate} from "./organization-assignee.server";
import {changedRowGuard,guardedBatch,predicateGuard} from "./mutation-guard.server";
import {querySnapshotGuards} from "./query-snapshot-guard.server";
import {valueOf} from "./validation";
import {prepareOrderCargoEdit,type OrderCargoEditInput} from "./order-cargo-editor.server";
import type {CargoEditorRecord,CargoEditorWorkflowField} from "./order-cargo-editor";

type Context=Awaited<ReturnType<typeof loadOrderIntakeContext>>;
const fields=intakeOperationFields.filter(field=>field.kind!=="services");
const optional=()=>({isActive:true,isRequired:false});
const policyKeys:BusinessProcessPolicyKey[]=["order.supplement_positions","order.approve_positions","order.business_assistant_positions","order.customer_service_positions"];
const sourceColumns=["intake_operations_json",...intakeRouteFields.map(field=>field.column)] as const;
const responsibility=`(o.salesperson_user_id=? OR o.created_by_user_id=? OR o.operation_supervisor_user_id=? OR o.current_assignee_user_id=? OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=o.organization_id AND m.order_id=o.id AND m.enabled=1 AND m.assignee_user_id=?))`;
const reviewAuthority=(state:Context)=>(state.boss||(
  Boolean(state.order.is_responsible)&&policyPositions(state.policy,"order.approve_positions").includes(state.profile.positionCode)&&
  (state.actor.permissions.includes("order.manage")||state.actor.permissions.includes("order.intake.manage"))));
const editingAuthority=(state:Context)=>(state.boss||(Boolean(state.order.is_responsible)&&policyPositions(state.policy,"order.supplement_positions").includes(state.profile.positionCode)&&(state.actor.permissions.includes("order.manage")||state.actor.permissions.includes("order.intake.manage"))));
const canReview=(state:Context)=>!["completed","cancelled"].includes(state.order.status)&&reviewAuthority(state);
type Difference={label:string;before:string;after:string};
type RequestRow=Record<string,unknown>&{id:string;order_id:string;kind:'plan'|'cargo';request_hash:string;source_hash:string;before_json:string;proposed_json:string;changes_json:string;reason:string;status:string;requested_by_user_id:string};
const requestSql="SELECT * FROM order_intake_change_requests WHERE organization_id=? AND order_id=? AND id=?";
const source=(order:Record<string,unknown>)=>Object.fromEntries(sourceColumns.map(key=>[key,order[key]??null]));
async function hash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))].map(byte=>byte.toString(16).padStart(2,"0")).join("");}
function reason(form:FormData,key:string){const text=valueOf(form,key);if(text.length<2||text.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw new Error("请填写 2 至 1000 字的更正或复核依据");return text;}
function changes(before:Record<string,unknown>,after:Record<string,unknown>):Difference[]{
  const previous=readIntakeOperations(before.intake_operations_json),next=readIntakeOperations(after.intake_operations_json);
  return [
    ...fields.filter(field=>JSON.stringify(previous[field.key]??null)!==JSON.stringify(next[field.key]??null)).map(field=>({label:field.label,before:intakeOperationDisplay(field.key,previous[field.key])||"未记录",after:intakeOperationDisplay(field.key,next[field.key])||"未记录"})),
    ...intakeRouteFields.filter(field=>(before[field.column]??null)!==(after[field.column]??null)).map(field=>({label:field.label,before:String(before[field.column]??"未记录"),after:String(after[field.column]??"未记录")})),
  ];
}
async function resolveCandidate(current:SessionUser,state:Context,form:FormData){
  if(form.has("intake_entrustedServices")||form.has("intake_entrustedServices_included")||form.has("quoteCommercialUserId"))throw new Error("委托服务和报价归属有独立受控入口，不能夹带在计划更正中");
  if(inspectIntakeRuleBinding(state.order.intake_operations_json).error)throw new Error("请先由老板或流程管理员核对并修复损坏的录单规则，再提交更正");
  const raw=await resolveIntakeOperations({organizationId:current.organizationId,form,direct:false,policy:optional,processPolicy:state.policy,existing:state.order.intake_operations_json??"{}"});
  const parsed=readIntakeOperations(raw),previous=readIntakeOperations(state.order.intake_operations_json),next={...previous};
  for(const field of fields){
    if(intakeOperationPresent(field.key,parsed))Object.assign(next,{[field.key]:parsed[field.key]});
    else if(intakeOperationPresent(field.key,previous))throw new Error(`${field.label}更正后不能留空或无效`);
    // Blank optional controls do not invent an empty historical fact.
  }
  const routes=await resolveIntakeRouteFields({organizationId:current.organizationId,form,direct:false,policy:optional,existing:state.order});
  for(const field of intakeRouteFields)if(state.order[field.column]&&!routes[field.column])throw new Error(`${field.label}不能通过更正清空`);
  return{...source(state.order),intake_operations_json:JSON.stringify(next),...routes};
}
function candidateForm(candidate:Record<string,unknown>){
  const form=new FormData(),operations=readIntakeOperations(candidate.intake_operations_json);
  for(const field of fields){const value=operations[field.key];if(value!==undefined)form.set(intakeOperationFormName(field.key),field.kind==="person"?String(value&&typeof value==="object"&&"id"in value?value.id:""):String(value??""));}
  for(const field of intakeRouteFields)form.set(field.formName,String(candidate[field.column]??""));
  return form;
}
/** Do not silently change a shared PZ route or rewrite an already executed transport plan. */
async function executionWindow(current:SessionUser,orderId:string,before:Record<string,unknown>,after:Record<string,unknown>){
  const previous=readIntakeOperations(before.intake_operations_json),next=readIntakeOperations(after.intake_operations_json);
  const routeChanged=intakeRouteFields.some(field=>field.column!=="domestic_agent"&&before[field.column]!==after[field.column]);
  const planChanged=fields.some(field=>!["businessMajor","businessKind","businessAssistant","customerService"].includes(field.key)&&JSON.stringify(previous[field.key])!==JSON.stringify(next[field.key]));
  const queries:Array<{sql:string;values:string[];rows:Record<string,unknown>[]}>=[];
  if(routeChanged){
    const sql="SELECT batch_id FROM transport_batch_order_claims WHERE organization_id=? AND order_id=?",values=[current.organizationId,orderId];
    const rows=(await env.DB.prepare(sql).bind(...values).all<Record<string,unknown>>()).results;
    if(rows.length)throw new Error("本单已挂载配载单；请先在配载单按现有流程解除或调整，再更正线路，不能只改单票口岸");
    queries.push({sql,values,rows});
  }
  if(routeChanged||planChanged){
    const sql="SELECT id,status,actual_departure_at,actual_arrival_at FROM order_transport_assignments WHERE organization_id=? AND order_id=? AND status!='cancelled'",values=[current.organizationId,orderId];
    const rows=(await env.DB.prepare(sql).bind(...values).all<Record<string,unknown>>()).results;
    if(rows.length)throw new Error("本单已有实际运输安排；请先在运输模块按原流程调整或撤销安排，再更正相应计划，不覆盖已执行事实");
    queries.push({sql,values,rows});
  }
  return queries;
}
function authorityGuards(current:SessionUser,state:Context,now:string,review=false,allowClosed=false){
  const access=activePositionProfilePredicate({organizationId:current.organizationId,userId:current.userId,profile:state.profile,requiredPermissions:["order.view",...(!state.boss?[state.actor.permissions.includes("order.intake.manage")?"order.intake.manage":"order.manage"]:[])]});
  if(review&&!reviewAuthority(state))throw new Error("仅本单配置的审核岗位责任人或老板可复核此更正");
  return[
    predicateGuard(env.DB,access.sql,access.values,now),
    ...policyKeys.map(key=>predicateGuard(env.DB,"COALESCE((SELECT policy_value FROM business_process_policies WHERE organization_id=? AND policy_key=?),?)=?",[current.organizationId,key,defaultBusinessProcessPolicy[key],state.policy[key]],now)),
    predicateGuard(env.DB,`EXISTS(SELECT 1 FROM transport_orders o WHERE o.organization_id=? AND o.id=? AND ${allowClosed?'1=1':"o.status NOT IN ('completed','cancelled')"} AND (?=1 OR ${responsibility}))`,[current.organizationId,state.order.id,state.boss?1:0,...Array(5).fill(current.userId)],now),
  ];
}
async function selectionGuards(current:SessionUser,state:Context,candidate:Record<string,unknown>,now:string){
  const statements:D1PreparedStatement[]=[],previous=readIntakeOperations(state.order.intake_operations_json),next=readIntakeOperations(candidate.intake_operations_json);
  for(const key of["businessAssistant","customerService"]as const){const person=next[key];if(!person||JSON.stringify(previous[key])===JSON.stringify(person))continue;
    const predicate=activeOrganizationAssigneeSelectionPredicate({organizationId:current.organizationId,userId:person.id,displayName:person.display_name,positionCodes:policyPositions(state.policy,key==="businessAssistant"?"order.business_assistant_positions":"order.customer_service_positions")});
    statements.push(predicateGuard(env.DB,predicate.sql,predicate.values,now));
  }
  for(const field of intakeRouteFields)if(field.category&&candidate[field.column]!==state.order[field.column])statements.push(predicateGuard(env.DB,"EXISTS(SELECT 1 FROM reference_data WHERE organization_id=? AND category=? AND code=? AND status='active')",[current.organizationId,field.category,String(candidate[field.column])],now));
  return statements;
}
function sourceGuards(current:SessionUser,state:Context,now:string){
  const sql=`SELECT id,status,updated_at,${sourceColumns.join(",")} FROM transport_orders WHERE organization_id=? AND id=?`;
  const row=Object.fromEntries(["id","status","updated_at",...sourceColumns].map(key=>[key,state.order[key]??null]));
  return querySnapshotGuards(env.DB,sql,[current.organizationId,state.order.id],[row],now);
}
function audit(current:SessionUser,orderId:string,action:string,metadata:unknown,now:string){return env.DB.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,?,'transport_order',?,'success',?,?)").bind(crypto.randomUUID(),current.organizationId,current.userId,action,orderId,JSON.stringify(metadata),now);}
function notification(current:SessionUser,orderId:string,userId:string,title:string,message:string,now:string){return env.DB.prepare("INSERT INTO internal_notifications(id,organization_id,user_id,category,severity,title,message,link,requires_ack,is_read,created_by_user_id,created_at) VALUES(?,?,?,'order_intake_change','warning',?,?,?,0,0,?,?)").bind(crypto.randomUUID(),current.organizationId,userId,title,message,`/admin/orders/${encodeURIComponent(orderId)}?drawer=supplements`,current.userId,now);}
export async function loadOrderIntakeChanges(current:SessionUser,orderId:string,state?:Context){
  state??=await loadOrderIntakeContext(current,orderId);
  const rows=(await env.DB.prepare(`SELECT r.id,r.kind,r.status,r.reason,r.changes_json,r.requested_by_user_id,r.created_at,r.review_notes,r.reviewed_at,u.display_name requester_name,v.display_name reviewer_name FROM order_intake_change_requests r
    JOIN users u ON u.id=r.requested_by_user_id LEFT JOIN users v ON v.id=r.reviewed_by_user_id WHERE r.organization_id=? AND r.order_id=? ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC LIMIT 20`).bind(current.organizationId,orderId).all<{id:string;kind:'plan'|'cargo';status:string;reason:string;changes_json:string;requested_by_user_id:string;created_at:string;review_notes:string|null;reviewed_at:string|null;requester_name:string;reviewer_name:string|null}>()).results;
  return{canReview:canReview(state),canReject:reviewAuthority(state),requestKey:crypto.randomUUID(),requests:rows.map(row=>({...row,canWithdraw:row.status==="pending"&&editingAuthority(state)&&(state.boss||row.requested_by_user_id===current.userId),differences:JSON.parse(row.changes_json) as Difference[]}))};
}
async function requestQueueGuards(current:SessionUser,state:Context,now:string){
  const orderId=state.order.id;
  const peopleSql=`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
    JOIN transport_orders o ON o.organization_id=m.organization_id AND o.id=?
    WHERE m.organization_id=? AND m.status='active' AND p.code IN (${policyPositions(state.policy,"order.approve_positions").map(()=>"?").join(",")||"NULL"})
      AND (o.operation_supervisor_user_id=m.user_id OR o.current_assignee_user_id=m.user_id OR EXISTS(SELECT 1 FROM order_module_instances mi WHERE mi.organization_id=o.organization_id AND mi.order_id=o.id AND mi.enabled=1 AND mi.assignee_user_id=m.user_id))`;
  const peopleValues=[orderId,current.organizationId,...policyPositions(state.policy,"order.approve_positions")];
  const people=(await env.DB.prepare(peopleSql).bind(...peopleValues).all<{user_id:string}>()).results;
  const reviewerGuards:D1PreparedStatement[]=[],recipients:string[]=[];
  for(const person of people){
    const profile=await loadActivePositionAccessProfile(env.DB,current.organizationId,person.user_id);
    if(!profile||!profile.permissions.includes("order.view")||!policyPositions(state.policy,"order.approve_positions").includes(profile.positionCode))continue;
    const permission=profile.permissions.includes("order.intake.manage")?"order.intake.manage":"order.manage";
    if(!profile.permissions.includes(permission))continue;
    recipients.push(person.user_id);
    const access=activePositionProfilePredicate({organizationId:current.organizationId,userId:person.user_id,profile,requiredPermissions:["order.view",permission]});
    reviewerGuards.push(predicateGuard(env.DB,access.sql,access.values,now));
  }
  if(!recipients.length&&state.boss)recipients.push(current.userId);
  if(!recipients.length)throw new Error("本单尚无配置的审核岗位责任人，请先由主管或老板分配审核人，避免申请无人办理");
  const pendingSql="SELECT id FROM order_intake_change_requests WHERE organization_id=? AND order_id=? AND status='pending'",values=[current.organizationId,orderId];
  if((await env.DB.prepare(pendingSql).bind(...values).all()).results.length)throw new Error("本单已有待复核更正，请先审核或撤回，不重复叠加申请");
  return{recipients,guards:[...querySnapshotGuards(env.DB,pendingSql,values,[],now),...querySnapshotGuards(env.DB,peopleSql,peopleValues,people,now),...reviewerGuards]};
}
export async function requestOrderIntakeChange(current:SessionUser,orderId:string,form:FormData){
  const state=await loadOrderIntakeContext(current,orderId);
  if(!state.canEdit)throw new Error("当前账号不能申请本单资料更正，或订单已终结");
  const requestKey=valueOf(form,"requestKey");if(!/^[a-zA-Z0-9_-]{16,160}$/.test(requestKey))throw new Error("更正请求标识无效，请重新打开本单更正区");
  const requestHash=await hash([...form.entries()].filter(([key])=>key!=="intent"&&key!=="requestKey").map(([key,value])=>[key,typeof value==="string"?value:"[file]"]).sort((a,b)=>a[0].localeCompare(b[0])));
  const repeated=await env.DB.prepare("SELECT id,request_hash FROM order_intake_change_requests WHERE organization_id=? AND requested_by_user_id=? AND request_key=?").bind(current.organizationId,current.userId,requestKey).first<{id:string;request_hash:string}>();
  if(repeated){if(repeated.request_hash!==requestHash)throw new Error("同一请求的内容已改变，请刷新后重新申请");return{success:"此更正申请已保存，无需重复提交"};}
  if(valueOf(form,"version")!==state.order.updated_at)throw new Error("资料已变化，请刷新后对照原资料申请更正");
  const explanation=reason(form,"changeReason"),before=source(state.order),candidate=await resolveCandidate(current,state,form),differences=changes(before,candidate);
  if(!differences.length)throw new Error("本次没有资料变化，无需申请更正");
  const window=await executionWindow(current,orderId,before,candidate),now=new Date().toISOString(),id=crypto.randomUUID(),queue=await requestQueueGuards(current,state,now);
  await guardedBatch(env.DB,[
    ...authorityGuards(current,state,now),...sourceGuards(current,state,now),...await selectionGuards(current,state,candidate,now),
    ...queue.guards,
    ...window.flatMap(row=>querySnapshotGuards(env.DB,row.sql,row.values,row.rows,now)),
    env.DB.prepare("INSERT INTO order_intake_change_requests(id,organization_id,order_id,request_key,request_hash,source_hash,before_json,proposed_json,changes_json,reason,requested_by_user_id,status,pending_order_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)").bind(id,current.organizationId,orderId,requestKey,requestHash,await hash(before),JSON.stringify(before),JSON.stringify(candidate),JSON.stringify(differences),explanation,current.userId,orderId,now),
    audit(current,orderId,"order.intake.change.request",{id,reason:explanation,changes:differences,orderFactsUnchanged:true},now),
    ...queue.recipients.map(userId=>notification(current,orderId,userId,`开单资料更正待复核：${state.order.order_number}`,`${explanation}；请在订单内“查看 / 补齐开单资料”核对更正前后内容。未通过前仍沿用原资料。`,now)),
  ],"申请期间订单、权限、审核人或资料已变化，本次未保存，请刷新核对");
  return{success:"更正申请已保存，待本单审核岗位复核；原资料与已完成事实尚未改动"};
}

type StoredCargoEntry=[string,string|{name:string;type:string;base64:string}];
async function serializeCargoForm(form:FormData):Promise<StoredCargoEntry[]>{
  const entries=[...form.entries()];
  if(entries.length>100||entries.filter(([,value])=>value instanceof File&&value.size>0).length>5||entries.some(([key,value])=>typeof value==='string'?value.length>4000:key!=='images'||value.size>600*1024))throw new Error("货物表单或图片超过限制，请检查后重试");
  return Promise.all(entries.filter(([key,value])=>key!=='intent'&&key!=='cargoOrderVersion'&&!(value instanceof File&&value.size===0)).map(async([key,value])=>{
    if(typeof value==='string')return[key,value] as StoredCargoEntry;
    let binary='';const bytes=new Uint8Array(await value.arrayBuffer());for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
    return[key,{name:value.name,type:value.type,base64:btoa(binary)}] as StoredCargoEntry;
  }));
}
function restoreCargoForm(entries:StoredCargoEntry[]){
  if(!Array.isArray(entries)||entries.length>100)throw new Error("货物更正内容损坏，请驳回后重新申请");
  const form=new FormData();
  for(const [key,value]of entries){
    if(typeof key!=='string'||key.length>100)throw new Error("货物更正字段无效");
    if(typeof value==='string'){if(value.length>4000)throw new Error("货物更正内容过长");form.append(key,value);}
    else{if(key!=='images'||!value||typeof value.base64!=='string'||value.base64.length>820000)throw new Error("货物更正图片无效");const binary=atob(value.base64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));form.append(key,new File([bytes],value.name,{type:value.type}));}
  }
  return form;
}
const cargoLabels:Record<keyof CargoEditorRecord,string>={cargoName:'中文品名',cargoNameEn:'英文品名',hsCode:'国内 HS Code',overseasHsCode:'境外 HS Code',packageType:'包装类型',packageCount:'计划包装数',piecesPerPackage:'每包装件数',weight:'单包装毛重 KG',netWeight:'单包装净重 KG',length:'长 CM',width:'宽 CM',height:'高 CM',volume:'单包装体积 CBM',declaredValue:'申报货值',currency:'币种',originCountry:'原产国',brandModel:'品牌型号',marks:'唛头说明',specialAttributes:'货物属性',notes:'货物备注'};
function cargoDifferences(before:CargoEditorRecord|null,after:CargoEditorRecord){return(Object.keys(cargoLabels)as Array<keyof CargoEditorRecord>).filter(key=>before?.[key]!==after[key]).map(key=>({label:cargoLabels[key],before:before?String(before[key]):'新增货物',after:String(after[key])}));}

/** The same cargo form saves drafts, but proposes approved material changes instead of bypassing review. */
export async function saveOrRequestOrderCargoChange(current:SessionUser,input:OrderCargoEditInput){
  if(input.organizationId!==current.organizationId||input.actorUserId!==current.userId)throw new Error("货物保存身份不一致");
  const state=await loadOrderIntakeContext(current,input.orderId);
  const stored=await serializeCargoForm(input.form),requestKey=`cargo:${valueOf(input.form,'cargoRequestKey')}`,requestHash=await hash({mode:input.mode,entries:stored});
  const prior=await env.DB.prepare("SELECT request_hash,status FROM order_intake_change_requests WHERE organization_id=? AND order_id=? AND requested_by_user_id=? AND request_key=?").bind(current.organizationId,input.orderId,current.userId,requestKey).first<{request_hash:string;status:string}>();
  if(prior){if(prior.request_hash!==requestHash)throw new Error("同一货物更正请求内容已变化，请重新打开编辑窗口");return{ok:true as const,pendingReview:true as const,success:`此货物更正已保存（${prior.status==='pending'?'待复核':prior.status==='approved'?'已应用':'已结束'}），未重复新增货物或包装`};}
  const prepared=await prepareOrderCargoEdit(input);if(!prepared.ok)return prepared;
  if(prepared.repeated||!prepared.reviewRequired){
    if(!prepared.repeated)await guardedBatch(env.DB,prepared.statements,"保存期间订单、货物、包装状态或权限已变化，本次未保存，请刷新后重试");
    return{ok:true as const,pendingReview:false as const,itemId:prepared.itemId,created:prepared.created,packageCount:prepared.packageCount};
  }
  if(!state.canEdit)throw new Error("当前账号不能申请本单货物关键更正，请由业务、操作等允许补录的责任人办理");
  const explanation=reason(input.form,'cargoChangeReason'),now=new Date().toISOString(),queue=await requestQueueGuards(current,state,now),id=crypto.randomUUID(),differences=cargoDifferences(prepared.before,prepared.after);
  await guardedBatch(env.DB,[...authorityGuards(current,state,now),...prepared.guards,...queue.guards,
    env.DB.prepare("INSERT INTO order_intake_change_requests(id,organization_id,order_id,kind,request_key,request_hash,source_hash,before_json,proposed_json,changes_json,reason,requested_by_user_id,status,pending_order_id,created_at) VALUES(?,?,?,'cargo',?,?,?,?,?,?,?,?,'pending',?,?)")
      .bind(id,current.organizationId,input.orderId,requestKey,requestHash,prepared.sourceHash,JSON.stringify(prepared.source),JSON.stringify({mode:input.mode,form:stored,fields:input.workflowFields.map(field=>({id:field.id,stepKey:field.stepKey,fieldKey:field.fieldKey,label:field.label,isActive:field.isActive,isRequired:field.isRequired,optionsText:field.optionsText,handlerPositionCodes:field.handlerPositionCodes}))}),JSON.stringify(differences),explanation,current.userId,input.orderId,now),
    audit(current,input.orderId,'order.intake.change.request',{id,kind:'cargo',reason:explanation,changes:differences,orderFactsUnchanged:true},now),
    ...queue.recipients.map(userId=>notification(current,input.orderId,userId,`货物关键更正待复核：${state.order.order_number}`,`${explanation}；请在订单内“查看 / 补齐开单资料”核对。复核前不新增货物或包装编号。`,now)),
  ],"申请期间货物、包装状态、审核人或权限已变化，本次未保存，请刷新核对");
  return{ok:true as const,pendingReview:true as const,success:'货物更正申请已保存；请由本单审核岗位在“查看 / 补齐开单资料”复核，原货物和包装编号尚未改变'};
}
export async function reviewOrderIntakeChange(current:SessionUser,orderId:string,form:FormData){
  const state=await loadOrderIntakeContext(current,orderId),id=valueOf(form,"changeId"),decision=valueOf(form,"decision");
  if(!["approved","rejected","withdrawn"].includes(decision))throw new Error("请选择通过、驳回或撤回");
  const row=await env.DB.prepare(requestSql).bind(current.organizationId,orderId,id).first<RequestRow>();if(!row)throw new Error("更正申请不存在或不属于本单");
  if(decision==="withdrawn"){if(!editingAuthority(state)||(!state.boss&&row.requested_by_user_id!==current.userId))throw new Error("仅申请人或老板可撤回尚未复核的更正");}
  else if(!reviewAuthority(state))throw new Error("仅本单配置的审核岗位责任人或老板可复核此更正");
  if(row.status!=="pending"){if(row.status===decision)return{success:"此更正已办理，无需重复提交"};throw new Error("此更正已由其他窗口处理，请刷新核对");}
  if(decision==='approved'&&!canReview(state))throw new Error("订单已经终结，不能应用更正；仍可驳回或撤回此未应用申请，不重开订单");
  const notes=reason(form,"reviewNotes"),now=new Date().toISOString(),statements=[...authorityGuards(current,state,now,decision!=="withdrawn",decision!=='approved'),...querySnapshotGuards(env.DB,requestSql,[current.organizationId,orderId,id],[row],now)];
  if(decision==="approved"&&row.kind==='cargo'){
    const proposed=JSON.parse(row.proposed_json) as {mode:'create'|'update';form:StoredCargoEntry[];fields:CargoEditorWorkflowField[]};
    if(!['create','update'].includes(proposed.mode)||!Array.isArray(proposed.fields))throw new Error("货物更正内容损坏，请驳回后重新申请");
    const body=restoreCargoForm(proposed.form);body.set('cargoOrderVersion',state.order.updated_at);body.set('cargoRequestKey',await hash(`${row.id}:apply`));
    const prepared=await prepareOrderCargoEdit({db:env.DB,organizationId:current.organizationId,orderId,orderNumber:state.order.order_number,actorUserId:current.userId,mode:proposed.mode,form:body,workflowFields:proposed.fields,now});
    if(!prepared.ok)throw new Error(prepared.error);
    if(prepared.repeated||prepared.sourceHash!==row.source_hash)throw new Error("货物、包装或流程资料已在申请后变化，不能覆盖新事实；请驳回后重新核对申请");
    if(JSON.stringify(cargoDifferences(prepared.before,prepared.after))!==row.changes_json)throw new Error("货物更正内容已变化，请驳回后重新申请");
    statements.push(...prepared.statements);
  }else if(decision==="approved"){
    if(await hash(source(state.order))!==row.source_hash)throw new Error("原资料已在申请后变化，此申请不能覆盖新资料；请驳回或撤回后重新核对申请");
    const proposed:unknown=JSON.parse(row.proposed_json);if(!proposed||typeof proposed!=="object"||Array.isArray(proposed))throw new Error("更正内容损坏，请驳回后重新申请");
    const candidate=await resolveCandidate(current,state,candidateForm(proposed as Record<string,unknown>));
    if(JSON.stringify(changes(source(state.order),candidate))!==row.changes_json)throw new Error("更正内容或人员资料已变化，请驳回后重新核对");
    const window=await executionWindow(current,orderId,source(state.order),candidate);
    statements.push(...sourceGuards(current,state,now),...await selectionGuards(current,state,candidate,now),...window.flatMap(item=>querySnapshotGuards(env.DB,item.sql,item.values,item.rows,now)),
      env.DB.prepare("UPDATE transport_orders SET intake_operations_json=?,exit_port=?,transit_locations=?,customs_location=?,domestic_agent=?,updated_at=? WHERE organization_id=? AND id=? AND status=? AND updated_at=?")
        .bind(candidate.intake_operations_json,candidate.exit_port,candidate.transit_locations,candidate.customs_location,candidate.domestic_agent,now,current.organizationId,orderId,state.order.status,state.order.updated_at),changedRowGuard(env.DB,now));
  }
  statements.push(env.DB.prepare("UPDATE order_intake_change_requests SET status=?,pending_order_id=NULL,reviewed_by_user_id=?,review_notes=?,reviewed_at=? WHERE organization_id=? AND order_id=? AND id=? AND status='pending'").bind(decision,current.userId,notes,now,current.organizationId,orderId,id),changedRowGuard(env.DB,now),
    audit(current,orderId,`order.intake.change.${decision}`,{id,notes,reason:row.reason,changes:JSON.parse(row.changes_json),physicalAndFinancialFactsUnchanged:true},now),
    notification(current,orderId,row.requested_by_user_id,`开单资料更正${decision==="approved"?"已通过":decision==="rejected"?"已驳回":"已撤回"}：${state.order.order_number}`,notes,now));
  await guardedBatch(env.DB,statements,"复核期间资料、作业状态或权限已变化，本次未应用，请刷新核对");
  return{success:decision==="approved"?"更正已复核并应用；原审批后的变更已独立留痕，未回退流程或改写库存、运输、费用和资金事实":decision==="rejected"?"更正已驳回，原资料不变":"更正已撤回，原资料不变"};
}
