export type IntakeDraftPayload = { fields:Array<[string,string]>; filesOmitted:string[] };
export const maxIntakeDraftBytes=200_000;
const excludedDraftFields=new Set(["intent","draftPayload","draftRevision","draftId","intakeDraftRevision"]);

/** Drafts retain text, not browser file handles or business authority. */
export function captureIntakeDraft(form:FormData):IntakeDraftPayload {
  const fields:Array<[string,string]>=[],filesOmitted:string[]=[];
  for(const [name,value]of form.entries()) {
    if(excludedDraftFields.has(name))continue;
    if(typeof value==="string")fields.push([name,value]);
    else if(value.size)filesOmitted.push(value.name);
  }
  return parseIntakeDraftPayload(JSON.stringify({fields,filesOmitted}));
}
export function parseIntakeDraftPayload(raw:string):IntakeDraftPayload {
  if(new TextEncoder().encode(raw).length>maxIntakeDraftBytes)throw new Error("草稿内容超过 200 KB，请减少备注后重试");
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error("草稿内容格式无效");}
  if(!value||typeof value!=="object"||Array.isArray(value)||!("fields" in value)||!Array.isArray(value.fields)||value.fields.length>2000||
    value.fields.some(pair=>!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=="string"||typeof pair[1]!=="string"||!pair[0]||pair[0].length>200||/[\u0000-\u001f\u007f]/.test(pair[0])||excludedDraftFields.has(pair[0])))throw new Error("草稿字段格式无效");
  const files="filesOmitted" in value?value.filesOmitted:[];
  if(!Array.isArray(files)||files.length>100||files.some(file=>typeof file!=="string"||file.length>255))throw new Error("草稿附件说明无效");
  const fields=value.fields as Array<[string,string]>;
  const requestIds=fields.filter(([key])=>key==="intakeRequestId");
  if(requestIds.length!==1||!/^[A-Za-z0-9_-]{10,160}$/.test(requestIds[0][1]))throw new Error("草稿录单身份无效，请重新打开录单窗口");
  return {fields:fields.map(([key,value])=>[key,value]),filesOmitted:[...new Set(files)]};
}
export function intakeDraftValues(payload:IntakeDraftPayload|null|undefined) {
  const values=new Map<string,string[]>();
  for(const [key,value]of payload?.fields??[])values.set(key,[...(values.get(key)??[]),value]);
  return {get:(key:string,fallback="")=>values.get(key)?.[0]??fallback,all:(key:string)=>values.get(key)??[]};
}
