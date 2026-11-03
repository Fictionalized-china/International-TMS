import { policyPositions,policyEnabled,type BusinessProcessPolicy } from "./business-process-policy";
import { expenseDirectionActions,expenseDirectionActionCompleted,expenseDirectionActionPolicies,expenseDirectionActionLabel,emptyExpenseDirectionControl,type ExpenseDirectionAction,type ExpenseDirectionControl,type ExpenseDirectionWorkflowField } from "./expense-control";
import type { SessionUser } from './auth.server';
import type { loadMeetingSettlement } from './meeting-settlement.server';
import { isBossBusinessActor } from './permission-blocks';
export function settlementActorPositions(policy:BusinessProcessPolicy,direction:"receivable"|"payable",action:ExpenseDirectionAction) {
  return policyPositions(policy,`${direction}.${action==="confirm"?"initiator":action==="business_review"?"review":"approve"}_positions`);
}
export function settlementActionOwners(state:Awaited<ReturnType<typeof loadMeetingSettlement>>,direction:"receivable"|"payable",action:ExpenseDirectionAction) {
  const order=state.order;
  const canonical:Record<string,string|null>={SALES:order.salesperson_user_id,CS:order.cs_user_id,
    OPERATION:order.operation_user_id,OPERATION_SUPERVISOR:order.operation_supervisor_user_id,
    FINANCE_ACCOUNTING:order.finance_user_id,BUSINESS_ROUTE:order.commercial_user_id};
  const positions=settlementActorPositions(state.policy,direction,action);
  return (state.responsibleUsers??[]).filter(person=>positions.includes(person.positionCode)&&
    (!(person.positionCode in canonical)||canonical[person.positionCode]===person.userId));
}
export function settlementActionOwnerLabel(state:Awaited<ReturnType<typeof loadMeetingSettlement>>,direction:"receivable"|"payable",action:ExpenseDirectionAction) {
  const owners=settlementActionOwners(state,direction,action);
  return owners.length?owners.map(person=>`${person.displayName}（${person.positionName}）`).join(" / "):"尚未配置有效的本单签核责任人";
}
export function settlementSequenceReason(control:ExpenseDirectionControl,action:ExpenseDirectionAction,fields:readonly ExpenseDirectionWorkflowField[],policy:BusinessProcessPolicy) {
  if(!policyEnabled(policy,"settlement.sequential") || expenseDirectionActionCompleted(control,action)) return null;
  const index=expenseDirectionActions.indexOf(action);
  const prior=expenseDirectionActionPolicies(fields).filter(item=>item.required&&expenseDirectionActions.indexOf(item.action)<index&&!expenseDirectionActionCompleted(control,item.action));
  return prior.length?"前序必办签核尚未完成，不能越级审批":null;
}
export function meetingSignatureAccess(state:Awaited<ReturnType<typeof loadMeetingSettlement>>,actor:Pick<SessionUser,'userId'|'positionCode'|'permissions'|'roleCodes'>,direction:'receivable'|'payable',action:ExpenseDirectionAction) {
  if(!state.open)return '实际出境尚未确认或订单已结束，当前仅可查看';
  const actions=expenseDirectionActionPolicies(state.fields);
  if(!actions.find(p=>p.action===action)?.active&&!(action==='confirm'&&!actions.some(p=>p.required)))return '当前工作流已隐藏此签核';
  const control=state.controls.find(c=>c.direction===direction)??emptyExpenseDirectionControl(direction);
  const sequenceReason=settlementSequenceReason(control,action,state.fields,state.policy);
  if(sequenceReason){
    const prior=actions.find(item=>item.required&&expenseDirectionActions.indexOf(item.action)<expenseDirectionActions.indexOf(action)&&!expenseDirectionActionCompleted(control,item.action));
    return prior?`前序必办签核尚未完成：请先由${settlementActionOwnerLabel(state,direction,prior.action)}办理“${expenseDirectionActionLabel(prior.action,direction)}”`:sequenceReason;
  }
  if(isBossBusinessActor(actor)) return null;
  const pos=actor.positionCode??'',codes=settlementActorPositions(state.policy,direction,action);
  if(!codes.includes(pos)||!actor.permissions.includes('settlement.signature.manage'))return `当前岗位没有此项签核办理权；本步由${settlementActionOwnerLabel(state,direction,action)}办理`;
  if(!settlementActionOwners(state,direction,action).some(person=>person.userId===actor.userId&&person.positionCode===pos))
    return `请由本单指定责任人办理：${settlementActionOwnerLabel(state,direction,action)}`;
  // Customer order-entry authorization does not grant or revoke settlement authority.
  // Settlement uses the configured action roles, exact order owners and signature permission.
  return null;
}
