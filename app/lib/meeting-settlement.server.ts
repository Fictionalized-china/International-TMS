import type { SessionUser } from "./auth.server";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { policyEnabled } from "./business-process-policy";
import { orderVisibilitySql } from "./order-access";
import { expenseDirectionActions,expenseDirectionActionPolicies,expenseDirectionActionCompleted,emptyExpenseDirectionControl,type ExpenseDirectionAction,type ExpenseDirectionControl } from "./expense-control";
import { loadLockedWorkflowStageContext } from "./workflow-instance-stage-gate.server";
import { meetingSignatureAccess } from "./meeting-settlement";
export { meetingSignatureAccess } from './meeting-settlement';
import { persistExpenseDirectionAction } from "./expense-direction-submit.server";

export const actualExportSql=(alias="o")=>`(EXISTS(SELECT 1 FROM order_tracking_milestones m WHERE m.organization_id=${alias}.organization_id AND m.order_id=${alias}.id AND m.milestone_code IN ('exported','actual_exit','exit')) OR EXISTS(SELECT 1 FROM transport_exit_confirmations x JOIN transport_batches b ON b.id=x.batch_id AND b.organization_id=x.organization_id WHERE x.organization_id=${alias}.organization_id AND (b.order_id=${alias}.id OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.order_id=${alias}.id AND bo.status!='removed'))))`;
export async function loadMeetingSettlement(db:D1Database,org:string,orderId:string) {
  const order=await db.prepare(`SELECT o.id,o.order_number,o.status,o.salesperson_user_id,o.created_by_user_id,o.operation_supervisor_user_id,c.cs_order_entry_enabled,${actualExportSql()} actual_exported,
    (SELECT assignee_user_id FROM order_module_instances WHERE organization_id=o.organization_id AND order_id=o.id AND module_code='costs' AND enabled=1) cs_user_id,
    (SELECT assignee_user_id FROM order_module_instances WHERE organization_id=o.organization_id AND order_id=o.id AND module_code='transport' AND enabled=1) operation_user_id,
    (SELECT assignee_user_id FROM order_module_instances WHERE organization_id=o.organization_id AND order_id=o.id AND module_code='review' AND enabled=1) finance_user_id,
    (SELECT fulfilled_by_user_id FROM order_dispatch_requests WHERE organization_id=o.organization_id AND order_id=o.id AND status='fulfilled') commercial_user_id
    FROM transport_orders o JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id WHERE o.id=? AND o.organization_id=?`).bind(orderId,org).first<{id:string;order_number:string;status:string;salesperson_user_id:string|null;created_by_user_id:string|null;operation_supervisor_user_id:string|null;cs_order_entry_enabled:number;actual_exported:number;cs_user_id:string|null;operation_user_id:string|null;finance_user_id:string|null;commercial_user_id:string|null}>();
  if(!order) throw new Error("订单不存在");
  const [policy,workflow,controls]=await Promise.all([loadBusinessProcessPolicy(org,db),loadLockedWorkflowStageContext(db,org,orderId,"costs"),db.prepare("SELECT direction,confirmed,business_reviewed,finance_reviewed,business_locked,finance_locked FROM order_expense_direction_controls WHERE organization_id=? AND order_id=?").bind(org,orderId).all<ExpenseDirectionControl>()]);
  const costSteps=workflow.steps.filter(s=>workflow.modulePlacements.some(m=>m.moduleCode==='costs'&&m.stepKey===s.stepKey));
  const target=costSteps.at(-1)?.stepKey;
  const validBinding=!workflow.locked||Boolean(target&&workflow.steps.some(s=>s.stepKey===workflow.currentStepKey));
  const configuredFields=workflow.fields.filter(f=>f.moduleCode==="costs"&&(!target||f.stepKey===target));
  // A frozen costs placement with no fields is deliberately empty, not legacy.
  const fields=configuredFields.length||!workflow.locked?configuredFields:[{fieldKey:'__empty_frozen_costs__',isActive:false,isRequired:false}];
  const historical=workflow.locked&&target?Boolean(await db.prepare("SELECT 1 FROM workflow_instance_step_states s JOIN workflow_instances wi ON wi.id=s.instance_id JOIN transport_orders o ON o.workflow_instance_id=wi.id AND o.id=wi.order_id AND o.organization_id=wi.organization_id WHERE o.organization_id=? AND o.id=? AND s.step_key=? AND s.status='completed'").bind(org,orderId,target).first()):false;
  const open=validBinding&&!historical&&order.status==="in_execution"&&(policyEnabled(policy,"settlement.after_actual_export")?Boolean(order.actual_exported):["reconciliation","completion_review"].includes(workflow.currentStepKey??""));
  return {order,policy,workflow,fields,open,historical,validBinding,controls:controls.results};
}
export async function submitMeetingSignature(db:D1Database,input:{current:SessionUser;orderId:string;direction:"receivable"|"payable";action:ExpenseDirectionAction;notes:string;refresh:()=>Promise<void>}) {
  const visibility=orderVisibilitySql(input.current,"o");
  if(!await db.prepare(`SELECT 1 FROM transport_orders o WHERE o.id=? AND o.organization_id=? AND ${visibility.sql}`).bind(input.orderId,input.current.organizationId,...visibility.values).first()) throw new Error("订单不在当前读取范围");
  const state=await loadMeetingSettlement(db,input.current.organizationId,input.orderId);
  const denied=meetingSignatureAccess(state,input.current,input.direction,input.action);if(denied) throw new Error(denied);
  const expenses=await db.prepare("SELECT COUNT(*) n,SUM(CASE WHEN counterparty_name IS NULL OR TRIM(counterparty_name)='' THEN 1 ELSE 0 END) missing FROM business_expenses WHERE organization_id=? AND order_id=? AND direction=? AND stage!='cancelled'").bind(input.current.organizationId,input.orderId,input.direction).first<{n:number;missing:number}>();
  if(!expenses?.n||expenses.missing) throw new Error("请先录入费用并填写往来单位");
  const required=expenseDirectionActionPolicies(state.fields).filter(p=>p.required).map(p=>p.action);
  const previous=policyEnabled(state.policy,"settlement.sequential")?required.filter(a=>expenseDirectionActions.indexOf(a)<expenseDirectionActions.indexOf(input.action)):[];
  const result=await persistExpenseDirectionAction({db,organizationId:input.current.organizationId,orderId:input.orderId,direction:input.direction,action:input.action,userId:input.current.userId,notes:input.notes||null,now:new Date().toISOString(),previousActions:previous,confirmFeesWhenAllActions:required,refresh:input.refresh});
  const current=await db.prepare("SELECT direction,confirmed,business_reviewed,finance_reviewed,business_locked,finance_locked FROM order_expense_direction_controls WHERE organization_id=? AND order_id=? AND direction=?").bind(input.current.organizationId,input.orderId,input.direction).first<ExpenseDirectionControl>();
  if(!result.applied && !current || current&&!expenseDirectionActionCompleted(current,input.action)) throw new Error("前序签核状态已变化，请刷新后按顺序办理");
  return result;
}
export async function assertMeetingSignoffsComplete(db:D1Database,org:string,orderIds:readonly string[],direction:"receivable"|"payable",requireOffline=false) {
  for(const id of new Set(orderIds)) {
    const state=await loadMeetingSettlement(db,org,id);
    // Passed settlement nodes are historical; do not force new gates onto completed business.
    if(state.order.status==="completed"||state.historical) continue;
    if(!state.validBinding)throw new Error(`${state.order.order_number}：冻结工作流费用节点不完整，请修正工作流配置后重试`);
    const control=state.controls.find(c=>c.direction===direction)??emptyExpenseDirectionControl(direction);
    if(expenseDirectionActionPolicies(state.fields).filter(p=>p.required).some(p=>!expenseDirectionActionCompleted(control,p.action))) throw new Error(`${state.order.order_number}：必办签核尚未完成，不能生成对账单或付款`);
    if(requireOffline&&direction==="payable"&&policyEnabled(state.policy,"payable.offline_approval_required")&&!await db.prepare("SELECT 1 FROM order_payable_offline_approvals WHERE organization_id=? AND order_id=?").bind(org,id).first()) throw new Error(`${state.order.order_number}：尚未记录总经理线下审批，不能付款核销`);
  }
}
