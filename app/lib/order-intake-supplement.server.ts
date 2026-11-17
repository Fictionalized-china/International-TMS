import {env} from "cloudflare:workers";
import type {SessionUser} from "./auth.server";
import {loadBusinessProcessPolicy} from "./business-process-policy.server";
import {defaultBusinessProcessPolicy,policyPositions,type BusinessProcessPolicyKey} from "./business-process-policy";
import {orderVisibilitySql} from "./order-access";
import {isBossBusinessActor} from "./permission-blocks";
import {loadActivePositionAccessProfile} from "./position-access-profile.server";
import {intakeOperationFields,intakeOperationPresent,intakeServiceOptions,readIntakeOperations} from "./intake-operations";
import {orderModuleDefinitions} from "./order-modules";
import {querySnapshotGuards} from "./query-snapshot-guard.server";
import {listIntakePeople,resolveIntakeOperations} from "./intake-operations.server";
import {intakeRouteFields} from "./intake-route-fields";
import {listIntakeRouteReferences,resolveIntakeRouteFields} from "./intake-route-fields.server";
import {resolveQuoteCommercial} from "./quote-commercial.server";
import {changedRowGuard,guardedBatch,predicateGuard} from "./mutation-guard.server";
import {valueOf} from "./validation";
import {activeOrganizationAssigneeSelectionPredicate} from "./organization-assignee.server";
import {activePositionProfilePredicate} from "./position-access-profile.server";
import {createIntakeRuleBinding,inspectIntakeRuleBinding,intakeRulePolicyKeys} from "./order-intake-rule";
import {readIntakeGateSnapshot,intakeGateMessage,intakeGateCommitStatements} from "./order-intake-gate.server";

const supplementalOperationFields=intakeOperationFields.filter(field=>field.kind!=="services");
const optional=()=>({isActive:true,isRequired:false});
type SupplementOrder=Record<string,unknown>&{id:string;order_number:string;status:string;updated_at:string;intake_operations_json:string|null;quote_commercial_user_id:string|null;quote_commercial_name_snapshot:string|null;is_responsible:number};
async function context(current:SessionUser,orderId:string) {
  const profile=await loadActivePositionAccessProfile(env.DB,current.organizationId,current.userId);
  if(!profile)throw new Error("账号岗位或权限已停用，请重新登录");
  const actor={...current,...profile,roleCodes:[profile.roleCode]};
  if(!actor.permissions.includes("order.view"))throw new Error("当前账号没有订单查看权限");
  const scope=orderVisibilitySql(actor,"o");
  const order=await env.DB.prepare(`SELECT o.*,
    CASE WHEN o.salesperson_user_id=? OR o.created_by_user_id=? OR o.operation_supervisor_user_id=? OR o.current_assignee_user_id=?
      OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=o.organization_id AND m.order_id=o.id AND m.assignee_user_id=? AND m.enabled=1)
    THEN 1 ELSE 0 END is_responsible
    FROM transport_orders o WHERE o.id=? AND o.organization_id=? AND ${scope.sql}`)
    .bind(current.userId,current.userId,current.userId,current.userId,current.userId,orderId,current.organizationId,...scope.values).first<SupplementOrder>();
  if(!order)throw new Error("订单不存在或不在当前账号授权范围");
  const policy=await loadBusinessProcessPolicy(current.organizationId);
  const boss=isBossBusinessActor(actor);
  const canEdit=!["completed","cancelled"].includes(order.status)&&(boss||(
    Boolean(order.is_responsible)&&policyPositions(policy,"order.supplement_positions").includes(profile.positionCode)&&
    (actor.permissions.includes("order.intake.manage")||actor.permissions.includes("order.manage"))));
  return{order,actor,profile,policy,boss,canEdit};
}
export async function loadOrderIntakeSupplement(current:SessionUser,orderId:string) {
  const state=await context(current,orderId),{order}=state,operations=readIntakeOperations(order.intake_operations_json);
  const services=await env.DB.prepare("SELECT service_code,status FROM order_services WHERE organization_id=? AND order_id=?").bind(current.organizationId,orderId).all<{service_code:string;status:string}>();
  const operationKeys=supplementalOperationFields.filter(field=>!intakeOperationPresent(field.key,operations)).map(field=>field.key);
  const routeKeys=intakeRouteFields.filter(field=>!String(order[field.column]??"").trim()).map(field=>field.fieldKey);
  const missing=[...supplementalOperationFields.filter(field=>operationKeys.includes(field.key)).map(field=>field.label),...intakeRouteFields.filter(field=>routeKeys.includes(field.fieldKey)).map(field=>field.label),...(!order.quote_commercial_user_id&&!order.quote_commercial_name_snapshot?.trim()?["报价商务"]:[])];
  return{
    order:{id:order.id,number:order.order_number,status:order.status,version:order.updated_at,operations:order.intake_operations_json??"{}",routes:Object.fromEntries(intakeRouteFields.map(field=>[field.column,order[field.column]])),commercialId:order.quote_commercial_user_id,commercialName:order.quote_commercial_name_snapshot},
    operationKeys,routeKeys,missing,canEdit:state.canEdit,servicesMissing:services.results.length===0,ruleVersion:inspectIntakeRuleBinding(order.intake_operations_json).binding?.version??null,ruleError:inspectIntakeRuleBinding(order.intake_operations_json).error,
    people:state.canEdit?await listIntakePeople(current.organizationId,state.policy):{businessAssistant:[],customerService:[],quoteCommercials:[]},
    references:state.canEdit?await listIntakeRouteReferences(current.organizationId):[],
  };
}

/** Repair absent historical service rows only. Never replaces a selection or
 * activates new workflow branches; those require a real workflow amendment. */
export async function supplementMissingOrderServices(current:SessionUser,orderId:string,form:FormData){
  const {order,profile,boss,canEdit,policy}=await context(current,orderId);
  if(!canEdit)throw new Error("当前账号不能补录本单委托服务，或订单已终结");
  const reason=valueOf(form,"serviceReason"),codes=[...new Set(form.getAll("missingServiceCode").map(String))];
  if(reason.length<2||reason.length>1000)throw new Error("请填写 2 至 1000 字的原始委托依据");
  if(!codes.length||codes.some(code=>!intakeServiceOptions.some(option=>option[0]===code)))throw new Error("请选择本单实际委托的服务");
  if(valueOf(form,"version")!==order.updated_at)throw new Error("资料已变化，请刷新后核对委托服务");
  const serviceSql="SELECT id,service_code,status FROM order_services WHERE organization_id=? AND order_id=?";
  const modulesSql=`SELECT m.id,m.module_code,m.status,o.workflow_instance_id,
    CASE WHEN o.workflow_instance_id IS NULL THEN m.enabled WHEN EXISTS(
      SELECT 1 FROM workflow_instances wi JOIN workflow_instance_step_states ss ON ss.instance_id=wi.id
      JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id AND ms.module_code=m.module_code
      WHERE wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id AND wi.order_id=o.id
    ) THEN 1 ELSE 0 END enabled
    FROM order_module_instances m JOIN transport_orders o ON o.id=m.order_id AND o.organization_id=m.organization_id
    WHERE m.organization_id=? AND m.order_id=?`;
  const [services,modules]=await Promise.all([env.DB.prepare(serviceSql).bind(current.organizationId,orderId).all<Record<string,unknown>>(),env.DB.prepare(modulesSql).bind(current.organizationId,orderId).all<Record<string,unknown>>()]);
  if(services.results.length)throw new Error("本单已有委托服务，不允许从历史补录入口替换或恢复已取消的服务");
  const required=orderModuleDefinitions.filter(module=>module.services?.some(code=>codes.includes(code)));
  for(const module of required){if(!modules.results.some(row=>row.module_code===module.code&&Number(row.enabled)===1))throw new Error(`本单冻结流程未启用“${module.name}”，不能靠补录服务新增分支；请由主管办理流程调整`);}
  const now=new Date().toISOString(),authority=activePositionProfilePredicate({organizationId:current.organizationId,userId:current.userId,profile,requiredPermissions:["order.view",...(!boss?[profile.permissions.includes("order.intake.manage")?"order.intake.manage":"order.manage"]:[])]});
  const next=JSON.stringify({...readIntakeOperations(order.intake_operations_json),entrustedServices:codes,canonicalSupplementVersion:1,...(inspectIntakeRuleBinding(order.intake_operations_json).error?{intakeRule:{version:"corrupt"}}:{})});
  await guardedBatch(env.DB,[
    predicateGuard(env.DB,authority.sql,authority.values,now),
    predicateGuard(env.DB,"COALESCE((SELECT policy_value FROM business_process_policies WHERE organization_id=? AND policy_key='order.supplement_positions'),?)=?",[current.organizationId,defaultBusinessProcessPolicy["order.supplement_positions"],policy["order.supplement_positions"]],now),
    ...querySnapshotGuards(env.DB,serviceSql,[current.organizationId,orderId],services.results,now),
    ...querySnapshotGuards(env.DB,modulesSql,[current.organizationId,orderId],modules.results,now),
    env.DB.prepare(`UPDATE transport_orders SET intake_operations_json=?,updated_at=? WHERE organization_id=? AND id=? AND status=? AND updated_at=? AND HEX(COALESCE(intake_operations_json,''))=HEX(?)
      AND (?=1 OR salesperson_user_id=? OR created_by_user_id=? OR operation_supervisor_user_id=? OR current_assignee_user_id=? OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=transport_orders.organization_id AND m.order_id=transport_orders.id AND m.enabled=1 AND m.assignee_user_id=?))`)
      .bind(next,now,current.organizationId,orderId,order.status,order.updated_at,order.intake_operations_json??"",boss?1:0,current.userId,current.userId,current.userId,current.userId,current.userId),changedRowGuard(env.DB,now),
    ...codes.map(code=>env.DB.prepare("INSERT INTO order_services(id,organization_id,order_id,service_code,service_name,created_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(),current.organizationId,orderId,code,intakeServiceOptions.find(option=>option[0]===code)![1],now)),
    env.DB.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,'order.intake.services.supplement','transport_order',?,'success',?,?)").bind(crypto.randomUUID(),current.organizationId,current.userId,orderId,JSON.stringify({reason,before:[],after:codes,sourceVersion:order.updated_at,workflowUnchanged:true}),now),
  ],"委托服务、订单责任人或权限已变化，本次未保存，请刷新核对");
  return{success:"已按原始委托补录服务；未新增流程分支，运输、库存及资金事实保持不变"};
}

/** Explicit, audited upgrade of the intake rule only; never replaces the workflow or historical facts. */
export async function activateOrderIntakeRule(current:SessionUser,orderId:string,form:FormData) {
  const {order,actor,profile,policy,boss,canEdit}=await context(current,orderId);
  if(!canEdit)throw new Error("当前账号无权为本单应用录单检查规则，或订单已终结");
  const priorRule=inspectIntakeRuleBinding(order.intake_operations_json);
  if(priorRule.binding)return{success:"本单已使用当前录单检查规则，无需重复应用"};
  if(priorRule.error&&!boss&&!actor.permissions.includes("workflow.manage"))throw new Error("规则损坏不能作为旧单放行；请由老板或流程管理员核对本单资料后修复规则");
  const reason=valueOf(form,"reason");if(reason.length<2||reason.length>1000)throw new Error("请填写 2 至 1000 字的规则升级依据");
  if(valueOf(form,"version")!==order.updated_at)throw new Error("资料已被其他窗口修改，请刷新后再应用规则");
  const binding=createIntakeRuleBinding(policy),snapshot=await readIntakeGateSnapshot(current.organizationId,orderId,binding);
  if(!snapshot.result?.knownFieldsSatisfied)throw new Error(intakeGateMessage(snapshot));
  if(snapshot.facts.order.intake_operations_json!==order.intake_operations_json)throw new Error("资料已由其他窗口修改，请刷新后重新核对");
  const next=JSON.stringify({...readIntakeOperations(order.intake_operations_json),intakeRule:binding});
  const authority=activePositionProfilePredicate({organizationId:current.organizationId,userId:current.userId,profile,requiredPermissions:["order.view",...(!boss?[actor.permissions.includes("order.intake.manage")?"order.intake.manage":"order.manage"]:[])]});
  const now=new Date().toISOString();
  await guardedBatch(env.DB,[
    predicateGuard(env.DB,authority.sql,authority.values,now),
    predicateGuard(env.DB,"COALESCE((SELECT policy_value FROM business_process_policies WHERE organization_id=? AND policy_key='order.supplement_positions'),?)=?",[current.organizationId,defaultBusinessProcessPolicy["order.supplement_positions"],policy["order.supplement_positions"]],now),
    predicateGuard(env.DB,`EXISTS(SELECT 1 FROM transport_orders o WHERE o.organization_id=? AND o.id=? AND (?=1 OR o.salesperson_user_id=? OR o.created_by_user_id=? OR o.operation_supervisor_user_id=? OR o.current_assignee_user_id=? OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=o.organization_id AND m.order_id=o.id AND m.assignee_user_id=? AND m.enabled=1)))`,[current.organizationId,orderId,boss?1:0,current.userId,current.userId,current.userId,current.userId,current.userId],now),
    ...intakeRulePolicyKeys.map(key=>predicateGuard(env.DB,"COALESCE((SELECT policy_value FROM business_process_policies WHERE organization_id=? AND policy_key=?),?)=?",[current.organizationId,key,defaultBusinessProcessPolicy[key],policy[key]],now)),
    ...intakeGateCommitStatements(snapshot,now),
    env.DB.prepare("UPDATE transport_orders SET intake_operations_json=?,updated_at=? WHERE organization_id=? AND id=? AND status=? AND updated_at=?")
      .bind(next,now,current.organizationId,orderId,order.status,order.updated_at),
    changedRowGuard(env.DB,now),
    env.DB.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,'order.intake.rule.bind','transport_order',?,'success',?,?)")
      .bind(crypto.randomUUID(),current.organizationId,current.userId,orderId,JSON.stringify({reason,binding,previousVersion:null,...(priorRule.error?{repair:true,previousRaw:order.intake_operations_json}: {})}),now),
  ],"应用规则期间资料、权限或费用配置已变化，本次未保存，请刷新重试");
  return{success:"已应用录单必填检查；未替换本单工作流，未改动运输、库存、费用或资金事实"};
}

/** Missing-only remediation. No workflow, stock, money or entrusted-service mutations. */
export async function correctOrderQuoteCommercial(current:SessionUser,orderId:string,form:FormData) {
  const {order,profile,policy,boss,canEdit}=await context(current,orderId);
  if(!canEdit)throw new Error("当前账号不能更正本单报价归属，或订单已经终结");
  const reason=valueOf(form,"correctionReason");
  if(reason.length<2||reason.length>1000)throw new Error("请填写 2 至 1000 字的归属更正依据");
  if(valueOf(form,"version")!==order.updated_at)throw new Error("订单已由其他窗口修改，请刷新后重试；未覆盖原归属");
  const person=await resolveQuoteCommercial({organizationId:current.organizationId,userId:valueOf(form,"quoteCommercialCorrectionId"),required:true,policy});
  if(!person)throw new Error("请选择实际报价商务");
  if(person.id===order.quote_commercial_user_id&&person.display_name===order.quote_commercial_name_snapshot)return{success:"报价归属未变化，无需重复更正"};
  const now=new Date().toISOString();
  const authority=activePositionProfilePredicate({organizationId:current.organizationId,userId:current.userId,profile,requiredPermissions:["order.view",...(!boss?[profile.permissions.includes("order.intake.manage")?"order.intake.manage":"order.manage"]:[])]});
  const target=activeOrganizationAssigneeSelectionPredicate({organizationId:current.organizationId,userId:person.id,displayName:person.display_name,positionCodes:policyPositions(policy,"order.quote_commercial_positions")});
  await guardedBatch(env.DB,[
    predicateGuard(env.DB,authority.sql,authority.values,now),
    predicateGuard(env.DB,target.sql,target.values,now),
    ...(["order.supplement_positions","order.quote_commercial_positions"] as const).map(key=>predicateGuard(env.DB,"COALESCE((SELECT policy_value FROM business_process_policies WHERE organization_id=? AND policy_key=?),?)=?",[current.organizationId,key,defaultBusinessProcessPolicy[key],policy[key]],now)),
    predicateGuard(env.DB,`EXISTS(SELECT 1 FROM transport_orders o WHERE o.organization_id=? AND o.id=? AND (?=1 OR o.salesperson_user_id=? OR o.created_by_user_id=? OR o.operation_supervisor_user_id=? OR o.current_assignee_user_id=? OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=o.organization_id AND m.order_id=o.id AND m.assignee_user_id=? AND m.enabled=1)))`,[current.organizationId,orderId,boss?1:0,current.userId,current.userId,current.userId,current.userId,current.userId],now),
    env.DB.prepare(`UPDATE transport_orders SET quote_commercial_user_id=?,quote_commercial_name_snapshot=?,intake_operations_json=?,updated_at=? WHERE organization_id=? AND id=? AND status=? AND updated_at=? AND COALESCE(quote_commercial_user_id,'')=? AND COALESCE(quote_commercial_name_snapshot,'')=? AND HEX(COALESCE(intake_operations_json,''))=HEX(?)`).bind(person.id,person.display_name,JSON.stringify({...readIntakeOperations(order.intake_operations_json),canonicalSupplementVersion:1,...(inspectIntakeRuleBinding(order.intake_operations_json).error?{intakeRule:{version:"corrupt"}}:{})}),now,current.organizationId,orderId,order.status,order.updated_at,order.quote_commercial_user_id??"",order.quote_commercial_name_snapshot??"",order.intake_operations_json??""),
    changedRowGuard(env.DB,now),
    env.DB.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,'order.quote_commercial.correct','transport_order',?,'success',?,?)").bind(crypto.randomUUID(),current.organizationId,current.userId,orderId,JSON.stringify({reason,before:{id:order.quote_commercial_user_id,name:order.quote_commercial_name_snapshot},after:person,sourceQuoteUnchanged:true,financialFactsUnchanged:true}),now),
  ],"订单、报价人员资格或更正权限已变化，本次未保存，请刷新重试");
  return{success:"报价商务归属已更正并留痕；原始报价、费用、流水及已完成运输事实未改写"};
}

/** Missing-only remediation. No workflow, stock, money or entrusted-service mutations. */
export async function saveOrderIntakeSupplement(current:SessionUser,orderId:string,form:FormData) {
  const {order,profile,policy,boss,canEdit}=await context(current,orderId);
  if(!canEdit)throw new Error("当前账号不是本单允许补录的责任人，或订单已经终结");
  const reason=valueOf(form,"reason");if(reason.length<2||reason.length>1000)throw new Error("请填写 2 至 1000 字的补录原因");
  if(form.has("intake_entrustedServices")||form.has("intake_entrustedServices_included"))throw new Error("委托服务涉及流程分支，请通过受控服务变更办理，不能在补录入口修改");
  const previous=readIntakeOperations(order.intake_operations_json);
  const parsed=readIntakeOperations(await resolveIntakeOperations({organizationId:current.organizationId,form,direct:false,policy:optional,processPolicy:policy,existing:JSON.stringify(previous)}));
  const next={...previous};
  for(const field of supplementalOperationFields) {
    if(intakeOperationPresent(field.key,previous)&&JSON.stringify(previous[field.key])!==JSON.stringify(parsed[field.key]))throw new Error(`${field.label}已填写；此处只补缺项，更正已有资料请走受控变更`);
    // Empty controls are not new facts and must not be counted as supplemented.
    if(intakeOperationPresent(field.key,parsed))Object.assign(next,{[field.key]:parsed[field.key]});
  }
  const routes=await resolveIntakeRouteFields({organizationId:current.organizationId,form,direct:false,policy:optional,existing:order});
  for(const field of intakeRouteFields) {
    if(String(order[field.column]??"").trim()&&routes[field.column]!==order[field.column])throw new Error(`${field.label}已填写；不能通过补录覆盖已有资料`);
    if(!routes[field.column])routes[field.column]=order[field.column]as string|null;
  }
  let commercialId=order.quote_commercial_user_id,commercialName=order.quote_commercial_name_snapshot;
  if(form.has("quoteCommercialUserId")) {
    if(typeof form.get("quoteCommercialUserId")!=="string")throw new Error("报价商务必须选择人员，不能用文件代替");
    const requested=valueOf(form,"quoteCommercialUserId");
    if((commercialId||commercialName?.trim())&&requested!==(commercialId??""))throw new Error("报价商务已有归属，请通过带原因的归属更正办理");
    if(!commercialId&&!commercialName?.trim()&&requested){const person=await resolveQuoteCommercial({organizationId:current.organizationId,userId:requested,required:true,policy});commercialId=person!.id;commercialName=person!.display_name;}
  }
  const changes=[...supplementalOperationFields.filter(field=>JSON.stringify(previous[field.key])!==JSON.stringify(next[field.key])).map(field=>({field:field.label,before:previous[field.key]??null,after:next[field.key]??null})),...intakeRouteFields.filter(field=>routes[field.column]!==order[field.column]).map(field=>({field:field.label,before:order[field.column]??null,after:routes[field.column]})),...(commercialId!==order.quote_commercial_user_id?[{field:"报价商务",before:null,after:{id:commercialId,name:commercialName}}]:[])];
  if(!changes.length)return{success:"所填资料已经存在，无需重复补录"};
  if(valueOf(form,"version")!==order.updated_at)throw new Error("订单资料已由其他窗口修改，请刷新补录区后再保存；本次未覆盖任何资料");
  next.canonicalSupplementVersion=1;
  const nextRaw=JSON.stringify({...next,...(inspectIntakeRuleBinding(order.intake_operations_json).error?{intakeRule:{version:"corrupt"}}:{})});
  const now=new Date().toISOString();
  const usedPolicies=new Set<BusinessProcessPolicyKey>(["order.supplement_positions"]);
  const selectionGuards:D1PreparedStatement[]=[];
  const guardPerson=(id:string,name:string,key:BusinessProcessPolicyKey)=>{
    usedPolicies.add(key);
    const predicate=activeOrganizationAssigneeSelectionPredicate({organizationId:current.organizationId,userId:id,displayName:name,positionCodes:policyPositions(policy,key)});
    selectionGuards.push(predicateGuard(env.DB,predicate.sql,predicate.values,now));
  };
  for(const key of["businessAssistant","customerService"]as const) {
    const person=next[key];if(person&&JSON.stringify(person)!==JSON.stringify(previous[key]))guardPerson(person.id,person.display_name,key==="businessAssistant"?"order.business_assistant_positions":"order.customer_service_positions");
  }
  if(commercialId&&commercialName&&commercialId!==order.quote_commercial_user_id)guardPerson(commercialId,commercialName,"order.quote_commercial_positions");
  for(const field of intakeRouteFields)if(field.category&&routes[field.column]&&routes[field.column]!==order[field.column])selectionGuards.push(predicateGuard(env.DB,"EXISTS(SELECT 1 FROM reference_data WHERE organization_id=? AND category=? AND code=? AND status='active')",[current.organizationId,field.category,routes[field.column]],now));
  // Recheck the exact active membership, role authority and responsible order
  // in the write transaction. Role configuration is never supplied by a form.
  const authorization=`EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
    JOIN departments d ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.code=p.department_code AND d.status='active'
    JOIN roles r ON r.organization_id=m.organization_id AND r.code=? AND r.status='active'
    WHERE m.id=? AND m.organization_id=? AND m.user_id=? AND m.position_id=? AND p.code=? AND m.status='active'
      AND (?=1 OR (EXISTS(SELECT 1 FROM role_permissions rp WHERE rp.role_id=r.id AND rp.permission_code='order.view')
        AND EXISTS(SELECT 1 FROM role_permissions rp WHERE rp.role_id=r.id AND rp.permission_code IN ('order.intake.manage','order.manage')))))`;
  await guardedBatch(env.DB,[
    predicateGuard(env.DB,authorization,[profile.roleCode,profile.membershipId,current.organizationId,current.userId,profile.positionId,profile.positionCode,boss?1:0],now),
    ...[...usedPolicies].map(key=>predicateGuard(env.DB,"COALESCE((SELECT policy_value FROM business_process_policies WHERE organization_id=? AND policy_key=?),?)=?",[current.organizationId,key,defaultBusinessProcessPolicy[key],policy[key]],now)),
    ...selectionGuards,
    env.DB.prepare(`UPDATE transport_orders SET intake_operations_json=?,exit_port=?,transit_locations=?,customs_location=?,domestic_agent=?,quote_commercial_user_id=?,quote_commercial_name_snapshot=?,updated_at=?
      WHERE id=? AND organization_id=? AND status=? AND updated_at=? AND (?=1 OR salesperson_user_id=? OR created_by_user_id=? OR operation_supervisor_user_id=? OR current_assignee_user_id=?
        OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=transport_orders.organization_id AND m.order_id=transport_orders.id AND m.assignee_user_id=? AND m.enabled=1))`)
      .bind(nextRaw,routes.exit_port,routes.transit_locations,routes.customs_location,routes.domestic_agent,commercialId,commercialName,now,orderId,current.organizationId,order.status,order.updated_at,boss?1:0,current.userId,current.userId,current.userId,current.userId,current.userId),
    changedRowGuard(env.DB,now),
    env.DB.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,'order.intake.supplement','transport_order',?,'success',?,?)")
      .bind(crypto.randomUUID(),current.organizationId,current.userId,orderId,JSON.stringify({reason,changes,sourceVersion:order.updated_at}),now),
    env.DB.prepare("INSERT INTO order_workflow_history(id,organization_id,order_id,action_code,action_name,from_status,to_status,from_step_code,to_step_code,actor_user_id,notes,occurred_at) VALUES(?,?,?,'intake_supplement','补录开单资料',?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(),current.organizationId,orderId,order.status,order.status,order.current_step_code??null,order.current_step_code??null,current.userId,`${reason}；补录：${changes.map(change=>change.field).join('、')}`,now),
  ],"补录期间订单状态、责任人、权限或配置已变化，本次未保存；请刷新后重试");
  return{success:`已补录 ${changes.length} 项开单资料；原有节点、费用与库存保持不变`};
}
