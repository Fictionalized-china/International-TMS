import { policyPositions,policyEnabled,type BusinessProcessPolicy } from "./business-process-policy";
import { expenseDirectionActions,expenseDirectionActionCompleted,expenseDirectionActionPolicies,type ExpenseDirectionAction,type ExpenseDirectionControl,type ExpenseDirectionWorkflowField } from "./expense-control";
export function settlementActorPositions(policy:BusinessProcessPolicy,direction:"receivable"|"payable",action:ExpenseDirectionAction) {
  return policyPositions(policy,`${direction}.${action==="confirm"?"initiator":action==="business_review"?"review":"approve"}_positions`);
}
export function settlementSequenceReason(control:ExpenseDirectionControl,action:ExpenseDirectionAction,fields:readonly ExpenseDirectionWorkflowField[],policy:BusinessProcessPolicy) {
  if(!policyEnabled(policy,"settlement.sequential") || expenseDirectionActionCompleted(control,action)) return null;
  const index=expenseDirectionActions.indexOf(action);
  const prior=expenseDirectionActionPolicies(fields).filter(item=>item.required&&expenseDirectionActions.indexOf(item.action)<index&&!expenseDirectionActionCompleted(control,item.action));
  return prior.length?"前序必办签核尚未完成，不能越级审批":null;
}
