import { listActiveOrganizationAssigneeCandidates } from "./organization-assignee.server";
import { policyPositions, type BusinessProcessPolicy } from "./business-process-policy";
import { normalizeBusinessPlanTime } from "./business-time";
import { intakeOperationFields, intakeOperationFieldKey, intakeOperationFormName, intakeOperationPresent, intakeServiceOptions, readIntakeOperations, type IntakeOperations, type IntakePerson } from "./intake-operations";
import type { IntakeFieldPolicy } from "./intake-route-fields";

export async function listIntakePeople(organizationId:string, policy:BusinessProcessPolicy) {
  const groups={quoteCommercials:policyPositions(policy,"order.quote_commercial_positions"),businessAssistant:policyPositions(policy,"order.business_assistant_positions"),customerService:policyPositions(policy,"order.customer_service_positions")};
  const members=await listActiveOrganizationAssigneeCandidates({organizationId,positionCodes:[...new Set(Object.values(groups).flat())]});
  const options=(positions:string[])=>[...new Map(members.filter(member=>positions.includes(member.position_code!)).map(member=>[member.id,{id:member.id,display_name:member.display_name}])).values()];
  return {quoteCommercials:options(groups.quoteCommercials),businessAssistant:options(groups.businessAssistant),customerService:options(groups.customerService)};
}

export async function resolveIntakeOperations(input:{organizationId:string;form:FormData;direct:boolean;policy:(key:string)=>IntakeFieldPolicy;processPolicy:BusinessProcessPolicy;existing?:unknown}) {
  const previous=readIntakeOperations(input.existing), next={...previous} as IntakeOperations, errors:string[]=[];
  let people:Awaited<ReturnType<typeof listIntakePeople>>|undefined;
  for(const field of intakeOperationFields) {
    const rule=input.policy(intakeOperationFieldKey(field.key)), name=intakeOperationFormName(field.key);
    if(!input.direct && !rule.isActive) continue;
    if(!input.direct&&!input.form.has(name)&&!input.form.has(`${name}_included`))continue;
    if(input.existing && !input.form.has(name) && !(field.kind==="services" && input.form.has(`${name}_included`))) continue;
    const entries=input.form.getAll(name);
    if(entries.some(entry=>typeof entry!=="string")){errors.push(`${field.label}不能用文件代替`);continue;}
    const raw=String(entries[0]??"").trim();
    const required=input.direct||rule.isRequired;
    try {
      if(field.kind==="services") {
        const values=[...new Set(entries.map(entry=>String(entry).trim()).filter(Boolean))];
        if(required&&!values.length) throw new Error("请至少选择一项委托服务");
        if(values.some(code=>!intakeServiceOptions.some(option=>option[0]===code))) throw new Error("委托服务包含无效选项");
        next.entrustedServices=values;
      } else if(field.kind==="person") {
        const old=previous[field.key];
        if(old?.id===raw&&intakeOperationPresent(field.key,previous)) {next[field.key]=old;continue;}
        if(!raw){if(required)throw new Error(`请选择${field.label}`);next[field.key]=null;continue;}
        people??=await listIntakePeople(input.organizationId,input.processPolicy);
        const person: IntakePerson|undefined=people[field.key].find(person=>person.id===raw);
        if(!person)throw new Error(`请选择当前组织启用且符合配置岗位的${field.label}`);
        next[field.key]=person;
      } else if(field.kind==="integer") {
        if(!raw&&!required){next[field.key]=null;continue;}
        const value=Number(raw);
        if(!raw||!Number.isSafeInteger(value)||value<=0||value>10000)throw new Error(`${field.label}须为 1 至 10000 的整数`);
        next[field.key]=value;
      } else if(field.kind==="datetime") {
        if(!raw&&required)throw new Error(`请填写${field.label}`);
        next[field.key]=normalizeBusinessPlanTime(raw);
      } else {
        // Only a new intake receives the configured default; never invent a legacy plan.
        const value=raw || (field.key==="tailCarrier"&&!input.existing?input.processPolicy["order.default_tail_carrier"]:"");
        if(required&&!value)throw new Error(`请填写${field.label}`);
        if(value.length>200||/[\u0000-\u001f\u007f]/.test(value))throw new Error(`${field.label}最多 200 字且不能含控制字符`);
        next[field.key]=value;
      }
    } catch(error) {errors.push(error instanceof Error?error.message:String(error));}
  }
  if(next.plannedDeparture&&next.plannedArrival&&Date.parse(next.plannedArrival)<Date.parse(next.plannedDeparture))errors.push("预计到达不得早于预计发车");
  if(errors.length)throw new Error(errors.join("；"));
  return Object.keys(next).length?JSON.stringify(next):null;
}
