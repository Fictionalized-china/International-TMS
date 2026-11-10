import { businessDateTimeLabel, normalizeBusinessPlanTime } from "./business-time";

/** Planned facts only. Actual carriers/vehicles remain owned by dispatch. */
export const intakeOperationFields = [
  { key:"headCarrier", label:"头程承运人", kind:"text" },
  { key:"tailCarrier", label:"尾程承运人", kind:"text" },
  { key:"headVehicleCount", label:"头程车量", kind:"integer" },
  { key:"tailVehicleCount", label:"尾程车量", kind:"integer" },
  { key:"plannedDeparture", label:"预计发车（北京时间）", kind:"datetime" },
  { key:"plannedArrival", label:"预计到达（北京时间）", kind:"datetime" },
  { key:"businessAssistant", label:"业务助理", kind:"person" },
  { key:"customerService", label:"客服", kind:"person" },
  { key:"entrustedServices", label:"委托服务", kind:"services" },
] as const;
export type IntakeOperationKey = typeof intakeOperationFields[number]["key"];
export type IntakePerson = { id:string; display_name:string };
export type IntakeOperations = {
  /** Server-owned recovery marker; audit retention must not change business facts. */
  canonicalSupplementVersion?:1;
  headCarrier:string; tailCarrier:string; headVehicleCount:number|null; tailVehicleCount:number|null;
  plannedDeparture:string|null; plannedArrival:string|null;
  businessAssistant:IntakePerson|null; customerService:IntakePerson|null; entrustedServices:string[];
};
export const intakeServiceOptions = [
  ["pickup","提货"],["warehouse","仓储"],["packing","包装"],["customs","报关"],
  ["destination_customs","目的地清关"],["destination_warehouse","目的地仓储"],["other","其他服务"],
] as const;
export const intakeOperationFieldKey = (key:IntakeOperationKey) => `quotation_intake_${key}`;
export const intakeOperationFormName = (key:IntakeOperationKey) => `intake_${key}`;

export function readIntakeOperations(raw:unknown): Partial<IntakeOperations> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try { const value:unknown=JSON.parse(raw); return value && typeof value==="object" && !Array.isArray(value) ? value as Partial<IntakeOperations> : {}; }
  catch { return {}; }
}

export function intakeOperationDisplay(key:IntakeOperationKey, value:unknown):string {
  if (key==="businessAssistant" || key==="customerService") return value && typeof value==="object" && "display_name" in value ? String(value.display_name ?? "") : "";
  if (key==="entrustedServices") return Array.isArray(value) ? value.map(code=>intakeServiceOptions.find(option=>option[0]===code)?.[1]??code).join("、") : "";
  if (key==="plannedDeparture" || key==="plannedArrival") return typeof value==="string" ? businessDateTimeLabel(value) : "";
  return value===null || value===undefined ? "" : String(value);
}

export function missingIntakeOperations(values:Partial<IntakeOperations>) {
  return intakeOperationFields.filter(field=>!intakeOperationPresent(field.key,values)).map(field=>field.label);
}

/** Validate persisted facts too: a nonempty display label is not a hard gate. */
export function intakeOperationPresent(key:IntakeOperationKey,values:Partial<IntakeOperations>):boolean {
  const field=intakeOperationFields.find(field=>field.key===key)!;
  const value:unknown=values[key];
  if(field.kind==="integer")return typeof value==="number"&&Number.isSafeInteger(value)&&value>0&&value<=10000;
  const text=(value:unknown)=>typeof value==="string"&&value.trim().length>0&&!/[\u0000-\u001f\u007f]/.test(value);
  if(field.kind==="person")return Boolean(value&&typeof value==="object"&&"id" in value&&text(value.id)&&"display_name" in value&&text(value.display_name));
  if(field.kind==="services")return Array.isArray(value)&&value.length>0&&value.every(code=>typeof code==="string"&&intakeServiceOptions.some(option=>option[0]===code));
  if(field.kind==="datetime") {
    if(typeof value!=="string")return false;
    try {
      const normalized=normalizeBusinessPlanTime(value);if(!normalized)return false;
      if(key==="plannedArrival"&&values.plannedDeparture){
        const departure=normalizeBusinessPlanTime(values.plannedDeparture);
        if(!departure||Date.parse(normalized)<Date.parse(departure))return false;
      }
      return true;
    }catch{return false;}
  }
  return text(value)&&String(value).length<=200;
}
