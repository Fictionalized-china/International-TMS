import { businessDateTimeLabel } from "../lib/business-time";
import { intakeOperationFields, intakeOperationFieldKey, intakeOperationFormName, intakeOperationDisplay, intakeOperationPresent, intakeServiceOptions, readIntakeOperations, type IntakePerson, type IntakeOperationKey } from "../lib/intake-operations";
import type { IntakeFieldPolicy } from "../lib/intake-route-fields";
import { DateTimeSelect } from "./DateTimeSelect";

export function IntakeOperationsFields({people,policy,direct=false,raw,defaultTailCarrier,editableKeys}:{
  people:{businessAssistant:IntakePerson[];customerService:IntakePerson[]};policy:(key:string)=>IntakeFieldPolicy;direct?:boolean;raw?:unknown;defaultTailCarrier:string;
  editableKeys?:readonly IntakeOperationKey[];
}) {
  const values=readIntakeOperations(raw);
  return <div className="quote-field-grid intake-operations-fields">{intakeOperationFields.map(field=>{
    const rule=policy(intakeOperationFieldKey(field.key));if(!direct&&!rule.isActive)return null;
    const required=direct||rule.isRequired, name=intakeOperationFormName(field.key),value=editableKeys&&!intakeOperationPresent(field.key,values)?undefined:values[field.key];
    if(editableKeys&&!editableKeys.includes(field.key))return <label className="field" key={field.key}><span>{field.label}{intakeOperationPresent(field.key,values)?"（已记录）":"（待补录）"}</span><input className="control" readOnly value={intakeOperationDisplay(field.key,values[field.key])} /></label>;
    if(field.kind==="services")return <fieldset className="field" key={field.key}><legend>{field.label}{required?" *":""}</legend><input type="hidden" name={`${name}_included`} value="1"/>{intakeServiceOptions.map(([code,label])=><label key={code}><input type="checkbox" name={name} value={code} defaultChecked={values.entrustedServices?.includes(code)??false}/>{label}</label>)}<small>只选择本单实际委托的服务，后续自动继承。</small></fieldset>;
    if(field.kind==="datetime")return <label className="field" key={field.key}><span>{field.label}</span><DateTimeSelect name={name} required={required} defaultValue={typeof value==="string"?businessDateTimeLabel(value).replace(" ","T"):undefined}/></label>;
    if(field.kind==="person") {const old=values[field.key];return <label className="field" key={field.key}><span>{field.label}</span><select className="control" name={name} defaultValue={old?.id??""} required={required}><option value="">请选择{field.label}</option>{old&&!people[field.key].some(person=>person.id===old.id)&&<option value={old.id}>历史归属：{old.display_name}</option>}{people[field.key].map(person=><option key={person.id} value={person.id}>{person.display_name}</option>)}</select>{!people[field.key].length&&!old&&<small>暂无可选人员，请由管理员配置岗位及人员。</small>}</label>;}
    return <label className="field" key={field.key}><span>{field.label}</span><input className="control" name={name} type={field.kind==="integer"?"number":"text"} min={field.kind==="integer"?1:undefined} max={field.kind==="integer"?10000:undefined} step={field.kind==="integer"?1:undefined} maxLength={200} required={required} defaultValue={value===undefined?(field.key==="tailCarrier"&&!raw?defaultTailCarrier:""):String(value??"")}/>{field.key==="headCarrier"&&<small>填写计划承运人；不代替后续实际车辆绑定。</small>}</label>;
  })}</div>;
}
