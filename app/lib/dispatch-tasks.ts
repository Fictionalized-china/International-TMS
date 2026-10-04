import { policyEnabled,policyPositions,type BusinessProcessPolicy } from "./business-process-policy";
export function dispatchTaskAccess(policy:BusinessProcessPolicy,positionCode:string|null,permissions:readonly string[],action:"request"|"fulfill") {
  if(!policyEnabled(policy,"dispatch.enabled")) return "商务找车功能已停用，历史任务与资源保留";
  const positions=policyPositions(policy,action==="request"?"dispatch.request_positions":"dispatch.handler_positions");
  if(!positions.includes(positionCode??"") || !permissions.includes(action==="request"?"dispatch.request":"dispatch.manage")) return "当前岗位没有此项调度办理权";
  return null;
}
export function dispatchIsDue(plannedPortArrivalAt:string|null,leadDays:number,now:Date) {
  if(!plannedPortArrivalAt) return false;
  const at=Date.parse(plannedPortArrivalAt);
  return Number.isFinite(at) && at<=now.getTime()+leadDays*86400000;
}
