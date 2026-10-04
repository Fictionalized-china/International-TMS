import type { SessionUser } from "./auth.server";
import { orderVisibilitySql } from "./order-access";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { policyEnabled,policyPositions } from "./business-process-policy";
import { loadMeetingSettlement,meetingSignatureAccess,actualExportSql } from "./meeting-settlement.server";
import { expenseDirectionActionPolicies,expenseDirectionActionCompleted,expenseDirectionActionLabel,emptyExpenseDirectionControl } from "./expense-control";
export async function loadMeetingWorkOverview(db:D1Database,current:SessionUser) {
  const policy=await loadBusinessProcessPolicy(current.organizationId,db),scope=orderVisibilitySql(current,"o"),items:{title:string;href:string}[]=[];
  let dispatch=0,daily=0,signatures=0;
  if(policyEnabled(policy,"dispatch.enabled")&&policyPositions(policy,"dispatch.handler_positions").includes(current.positionCode??"")&&current.permissions.includes("dispatch.manage")) {
    const rows=await db.prepare(`SELECT o.order_number FROM order_dispatch_requests d JOIN transport_orders o ON o.id=d.order_id AND o.organization_id=d.organization_id WHERE d.organization_id=? AND d.status='pending' AND ${scope.sql}`).bind(current.organizationId,...scope.values).all<{order_number:string}>();dispatch=rows.results.length;for(const r of rows.results.slice(0,5))items.push({title:`商务找车：${r.order_number}`,href:"/admin/tracking-center?dispatchTask=pending"});
  }
  if(policyEnabled(policy,"tracking.daily_enabled")&&policyPositions(policy,"tracking.positions").includes(current.positionCode??"")&&current.permissions.includes("tracking.daily.manage")) {
    const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10)+"T00:00:00+08:00";
    const rows=await db.prepare(`SELECT o.order_number FROM transport_orders o WHERE o.organization_id=? AND o.status='in_execution' AND ${scope.sql} AND EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=o.id AND s.organization_id=o.organization_id AND s.status!='delivered') AND NOT EXISTS(SELECT 1 FROM order_daily_tracking d WHERE d.organization_id=o.organization_id AND d.order_id=o.id AND d.event_at>=?)`).bind(current.organizationId,...scope.values,new Date(today).toISOString()).all<{order_number:string}>();daily=rows.results.length;for(const r of rows.results.slice(0,5)) items.push({title:`今日运踪待更新：${r.order_number}`,href:`/admin/tracking-center?q=${encodeURIComponent(r.order_number)}`});
  }
  if(current.permissions.includes("settlement.signature.manage")) {
    const rows=await db.prepare(`SELECT o.id FROM transport_orders o WHERE o.organization_id=? AND o.status='in_execution' AND ${scope.sql} AND ${actualExportSql()} AND (o.salesperson_user_id=? OR o.operation_supervisor_user_id=? OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=o.organization_id AND m.order_id=o.id AND m.assignee_user_id=?) OR EXISTS(SELECT 1 FROM order_dispatch_requests d WHERE d.organization_id=o.organization_id AND d.order_id=o.id AND d.fulfilled_by_user_id=?))`).bind(current.organizationId,...scope.values,current.userId,current.userId,current.userId,current.userId).all<{id:string}>();
    for(const row of rows.results) {
      const state=await loadMeetingSettlement(db,current.organizationId,row.id);
      for(const direction of ["receivable","payable"] as const) {
        if(!await db.prepare("SELECT 1 FROM business_expenses WHERE organization_id=? AND order_id=? AND direction=? AND stage!='cancelled' LIMIT 1").bind(current.organizationId,row.id,direction).first())continue;
        const control=state.controls.find(c=>c.direction===direction)??emptyExpenseDirectionControl(direction);
        for(const action of expenseDirectionActionPolicies(state.fields).filter(a=>a.active))if(!expenseDirectionActionCompleted(control,action.action)&&!meetingSignatureAccess(state,current,direction,action.action)){signatures++;if(items.length<15) items.push({title:`${state.order.order_number}：${expenseDirectionActionLabel(action.action,direction)}`,href:`/admin/settlement-approvals?q=${encodeURIComponent(state.order.order_number)}`});}
      }
    }
  }
  return {dispatch,daily,signatures,items};
}
