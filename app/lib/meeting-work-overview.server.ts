import type { SessionUser } from "./auth.server";
import { orderVisibilitySql } from "./order-access";
import { settlementOrderScopeSql } from './settlement-workbench-access.server';
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { policyEnabled,policyPositions } from "./business-process-policy";
import { loadMeetingSettlement,meetingSignatureAccess,actualExportSql } from "./meeting-settlement.server";
import { expenseDirectionActionPolicies,expenseDirectionActionCompleted,expenseDirectionActionLabel,emptyExpenseDirectionControl } from "./expense-control";
import { isBossBusinessActor } from "./permission-blocks";
export async function loadMeetingWorkOverview(db:D1Database,current:SessionUser) {
  const policy=await loadBusinessProcessPolicy(current.organizationId,db),scope=orderVisibilitySql(current,"o"),items:{title:string;href:string}[]=[];
  let dispatch=0,daily=0,signatures=0,statements=0,offline=0,payments=0;
  if(policyEnabled(policy,"dispatch.enabled")&&(isBossBusinessActor(current)||(policyPositions(policy,"dispatch.handler_positions").includes(current.positionCode??"")&&current.permissions.includes("dispatch.manage")))) {
    const rows=await db.prepare(`SELECT o.order_number FROM order_dispatch_requests d JOIN transport_orders o ON o.id=d.order_id AND o.organization_id=d.organization_id WHERE d.organization_id=? AND d.status='pending' AND ${scope.sql}`).bind(current.organizationId,...scope.values).all<{order_number:string}>();dispatch=rows.results.length;for(const r of rows.results.slice(0,5))items.push({title:`商务找车：${r.order_number}`,href:"/admin/tracking-center?dispatchTask=pending"});
  }
  if(policyEnabled(policy,"tracking.daily_enabled")&&(isBossBusinessActor(current)||(policyPositions(policy,"tracking.positions").includes(current.positionCode??"")&&current.permissions.includes("tracking.daily.manage")))) {
    const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10)+"T00:00:00+08:00";
    const rows=await db.prepare(`SELECT o.order_number FROM transport_orders o WHERE o.organization_id=? AND o.status='in_execution' AND ${scope.sql} AND EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=o.id AND s.organization_id=o.organization_id AND s.status!='delivered') AND NOT EXISTS(SELECT 1 FROM order_daily_tracking d WHERE d.organization_id=o.organization_id AND d.order_id=o.id AND d.event_at>=?)`).bind(current.organizationId,...scope.values,new Date(today).toISOString()).all<{order_number:string}>();daily=rows.results.length;for(const r of rows.results.slice(0,5)) items.push({title:`今日运踪待更新：${r.order_number}`,href:`/admin/tracking-center?q=${encodeURIComponent(r.order_number)}`});
  }
  if(isBossBusinessActor(current)||current.permissions.includes("settlement.signature.manage")) {
    const rows=await db.prepare(`SELECT o.id FROM transport_orders o WHERE o.organization_id=? AND o.status='in_execution' AND ${scope.sql} AND ${actualExportSql()} AND (o.salesperson_user_id=? OR o.operation_supervisor_user_id=? OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=o.organization_id AND m.order_id=o.id AND m.assignee_user_id=?) OR EXISTS(SELECT 1 FROM order_dispatch_requests d WHERE d.organization_id=o.organization_id AND d.order_id=o.id AND d.fulfilled_by_user_id=?))`).bind(current.organizationId,...scope.values,current.userId,current.userId,current.userId,current.userId).all<{id:string}>();
    for(const row of rows.results) {
      const state=await loadMeetingSettlement(db,current.organizationId,row.id);
      for(const direction of ["receivable","payable"] as const) {
        if(!await db.prepare("SELECT 1 FROM business_expenses WHERE organization_id=? AND order_id=? AND direction=? AND stage!='cancelled' LIMIT 1").bind(current.organizationId,row.id,direction).first())continue;
        const control=state.controls.find(c=>c.direction===direction)??emptyExpenseDirectionControl(direction);
        const actions=expenseDirectionActionPolicies(state.fields),release=actions.every(a=>!a.active);
        for(const action of actions.filter(a=>a.active||(release&&a.action==='confirm')))if(!expenseDirectionActionCompleted(control,action.action)&&!meetingSignatureAccess(state,current,direction,action.action)){signatures++;if(items.length<15) items.push({title:`${state.order.order_number}：${release?'按配置确认费用':expenseDirectionActionLabel(action.action,direction)}`,href:`/admin/settlement-approvals?q=${encodeURIComponent(state.order.order_number)}`});}
      }
    }
  }
  if(isBossBusinessActor(current)||current.permissions.includes('billing.manage')||current.permissions.includes('settlement.offline_approval.record')){
    const orders=await db.prepare(`SELECT o.id FROM transport_orders o WHERE o.organization_id=? AND o.status='in_execution' AND ${scope.sql} AND ${actualExportSql()} AND (EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=o.organization_id AND m.order_id=o.id AND m.assignee_user_id=?))`).bind(current.organizationId,...scope.values,current.userId).all<{id:string}>();
    for(const row of orders.results){
      const state=await loadMeetingSettlement(db,current.organizationId,row.id);
      if(!state.open)continue;
      const complete=(direction:'receivable'|'payable')=>{const c=state.controls.find(c=>c.direction===direction)??emptyExpenseDirectionControl(direction);return expenseDirectionActionPolicies(state.fields).filter(a=>a.required).every(a=>expenseDirectionActionCompleted(c,a.action));};
      if((isBossBusinessActor(current)||(state.order.cs_user_id===current.userId&&current.permissions.includes('billing.manage')&&policyPositions(policy,'receivable.statement_positions').includes(current.positionCode??'')))&&complete('receivable')&&await db.prepare(`SELECT 1 FROM business_expenses e WHERE e.organization_id=? AND e.order_id=? AND e.direction='receivable' AND e.stage='confirmed' AND NOT EXISTS(SELECT 1 FROM settlement_reconciliation_lines l JOIN settlement_reconciliations r ON r.id=l.reconciliation_id AND r.organization_id=l.organization_id WHERE l.organization_id=e.organization_id AND l.expense_id=e.id AND r.status!='cancelled')`).bind(current.organizationId,row.id).first()){
        statements++;if(items.length<15)items.push({title:`${state.order.order_number}：客服生成应收对账单`,href:`/admin/billing?tab=pending&q=${encodeURIComponent(state.order.order_number)}`});
      }
      if(policyEnabled(policy,'payable.offline_approval_required')&&(isBossBusinessActor(current)||(state.order.finance_user_id===current.userId&&current.permissions.includes('settlement.offline_approval.record')))&&complete('payable')&&await db.prepare("SELECT 1 FROM business_expenses WHERE organization_id=? AND order_id=? AND direction='payable' AND stage!='cancelled'").bind(current.organizationId,row.id).first()&&!await db.prepare('SELECT 1 FROM order_payable_offline_approvals WHERE organization_id=? AND order_id=?').bind(current.organizationId,row.id).first()){
        offline++;if(items.length<15)items.push({title:`${state.order.order_number}：财务登记总经理线下审批`,href:`/admin/settlement-approvals?q=${encodeURIComponent(state.order.order_number)}`});
      }
    }
  }
  if(current.permissions.includes('billing.cash.manage')){
    const cashScope=settlementOrderScopeSql(current,'o');
    const pending=await db.prepare(`SELECT DISTINCT r.id,r.document_number FROM settlement_reconciliations r JOIN settlement_reconciliation_lines l ON l.reconciliation_id=r.id AND l.organization_id=r.organization_id JOIN business_expenses e ON e.id=l.expense_id AND e.organization_id=l.organization_id JOIN transport_orders o ON o.id=e.order_id AND o.organization_id=e.organization_id WHERE r.organization_id=? AND r.direction='payable' AND r.status='confirmed' AND r.payment_reserved_amount<r.total_amount-0.009 AND ${cashScope.sql} ${policyEnabled(policy,'payable.offline_approval_required')?"AND NOT EXISTS(SELECT 1 FROM settlement_reconciliation_lines ll JOIN business_expenses ee ON ee.id=ll.expense_id AND ee.organization_id=ll.organization_id WHERE ll.reconciliation_id=r.id AND ll.organization_id=r.organization_id AND NOT EXISTS(SELECT 1 FROM order_payable_offline_approvals a WHERE a.order_id=ee.order_id AND a.organization_id=ee.organization_id))":''}`).bind(current.organizationId,...cashScope.values).all<{id:string;document_number:string}>();
    payments=pending.results.length;for(const row of pending.results.slice(0,Math.max(0,15-items.length)))items.push({title:`出纳待付款：${row.document_number}`,href:`/admin/billing?tab=cash&q=${encodeURIComponent(row.document_number)}`});
  }
  return {dispatch,daily,signatures,statements,offline,payments,items};
}
