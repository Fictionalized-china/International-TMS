import { policyPositions,policyEnabled,type BusinessProcessPolicy } from "./business-process-policy";
import { expenseDirectionActions,expenseDirectionActionCompleted,expenseDirectionActionPolicies,emptyExpenseDirectionControl,type ExpenseDirectionAction,type ExpenseDirectionControl,type ExpenseDirectionWorkflowField } from "./expense-control";
import type { SessionUser } from './auth.server';
import type { loadMeetingSettlement } from './meeting-settlement.server';
export function settlementActorPositions(policy:BusinessProcessPolicy,direction:"receivable"|"payable",action:ExpenseDirectionAction) {
  return policyPositions(policy,`${direction}.${action==="confirm"?"initiator":action==="business_review"?"review":"approve"}_positions`);
}
export function settlementSequenceReason(control:ExpenseDirectionControl,action:ExpenseDirectionAction,fields:readonly ExpenseDirectionWorkflowField[],policy:BusinessProcessPolicy) {
  if(!policyEnabled(policy,"settlement.sequential") || expenseDirectionActionCompleted(control,action)) return null;
  const index=expenseDirectionActions.indexOf(action);
  const prior=expenseDirectionActionPolicies(fields).filter(item=>item.required&&expenseDirectionActions.indexOf(item.action)<index&&!expenseDirectionActionCompleted(control,item.action));
  return prior.length?"前序必办签核尚未完成，不能越级审批":null;
}
export function meetingSignatureAccess(state:Awaited<ReturnType<typeof loadMeetingSettlement>>,actor:Pick<SessionUser,'userId'|'positionCode'|'permissions'>,direction:'receivable'|'payable',action:ExpenseDirectionAction) {
  if(!state.open)return '实际出境尚未确认或订单已结束，当前仅可查看';
  const actions=expenseDirectionActionPolicies(state.fields);
  if(!actions.find(p=>p.action===action)?.active&&!(action==='confirm'&&!actions.some(p=>p.required)))return '当前工作流已隐藏此签核';
  const pos=actor.positionCode??'',codes=settlementActorPositions(state.policy,direction,action);
  if(!codes.includes(pos)||!actor.permissions.includes('settlement.signature.manage'))return '当前岗位没有此项签核办理权';
  const order=state.order;
  const assigned=action==='confirm'?(direction==='receivable'?(pos==='CS'?order.cs_user_id:order.salesperson_user_id):(pos==='BUSINESS_ROUTE'?order.commercial_user_id:order.operation_user_id)):action==='business_review'?(direction==='receivable'?order.operation_user_id:order.operation_supervisor_user_id):(direction==='receivable'?order.operation_supervisor_user_id:order.finance_user_id);
  if(assigned!==actor.userId)return '请由本单指定责任人办理；尚未分配时请先完成任务分派';
  if(direction==='receivable'&&action==='confirm'&&pos==='CS'&&policyEnabled(state.policy,'order.cs_requires_customer_flag')&&!order.cs_order_entry_enabled)return '此客户未配置客服代办应收，应由业务员发起';
  return settlementSequenceReason(state.controls.find(c=>c.direction===direction)??emptyExpenseDirectionControl(direction),action,state.fields,state.policy);
}
