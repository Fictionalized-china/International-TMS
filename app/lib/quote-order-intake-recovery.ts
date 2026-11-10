import {intakeOperationFields,readIntakeOperations} from "./intake-operations";
import {intakeRouteFields,type IntakeRouteValues} from "./intake-route-fields";

function snapshotObject(raw:unknown):Record<string,unknown> {
  if(typeof raw!=="string")return{};
  try{const value:unknown=JSON.parse(raw);return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};}catch{return{};}
}
function normalized(value:unknown):unknown {
  if(value==null||typeof value==="string"&&!value.trim())return null;
  if(Array.isArray(value))return value.map(normalized);
  if(typeof value==="object")return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,normalized(value)]));
  return value;
}
const equal=(a:unknown,b:unknown)=>JSON.stringify(normalized(a))===JSON.stringify(normalized(b));
function merge(current:unknown,incoming:unknown,source:unknown,label:string) {
  if(equal(incoming,source)||normalized(incoming)===null)return current;
  if(equal(current,source)||normalized(current)===null||equal(current,incoming))return incoming;
  throw new Error(`${label}已在订单补录，且报价也有不同修改；本次未覆盖。请先对照本单补录值更正报价，或办理订单受控变更`);
}
const text=(value:unknown)=>typeof value==="string"&&value.trim()?value:null;

/** Three-way recovery for orders marked as canonically supplemented. */
export function recoveredSupplementedIntake(current:Record<string,unknown>,quote:Record<string,unknown>,sourceRaw:unknown) {
  const source=snapshotObject(sourceRaw),currentPlan=readIntakeOperations(current.intake_operations_json),incomingPlan=readIntakeOperations(quote.intake_operations_json);
  const sourcePlan=source.intakeOperations&&typeof source.intakeOperations==="object"?source.intakeOperations as Record<string,unknown>:{};
  const plan:Record<string,unknown>={...currentPlan};
  for(const field of intakeOperationFields)if(field.key!=="entrustedServices"&&Object.hasOwn(incomingPlan,field.key))plan[field.key]=merge(currentPlan[field.key],incomingPlan[field.key],sourcePlan[field.key],field.label);
  // The supplement entry never edits services; preserve their existing quote
  // recovery path and its separate workflow-branch controls.
  if(Array.isArray(incomingPlan.entrustedServices))plan.entrustedServices=incomingPlan.entrustedServices;
  const routes={}as IntakeRouteValues;
  const sourceRoutes=source.intakeRoute&&typeof source.intakeRoute==="object"?source.intakeRoute as Record<string,unknown>:{};
  for(const field of intakeRouteFields)routes[field.column]=text(quote.intake_route_recorded===1?merge(current[field.column],quote[field.column],sourceRoutes[field.column],field.label):current[field.column]);
  const person=(id:unknown,name:unknown)=>text(id)||text(name)?{id:text(id),name:text(name)}:null;
  const commercial=merge(person(current.quote_commercial_user_id,current.quote_commercial_name_snapshot),person(quote.quote_commercial_user_id,quote.quote_commercial_name_snapshot),person(source.quoteCommercialUserId,source.quoteCommercialName),"报价商务")as{id:string|null;name:string|null}|null;
  return{...routes,intake_operations_json:Object.keys(plan).length?JSON.stringify(plan):null,quote_commercial_user_id:commercial?.id??null,quote_commercial_name_snapshot:commercial?.name??null};
}
