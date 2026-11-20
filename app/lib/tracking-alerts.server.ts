import { loadBusinessProcessPolicy } from './business-process-policy.server';
import { policyEnabled } from './business-process-policy';
import { loadOperationalRules } from './operational-rules.server';
import { deriveTrackingCenterState } from './tracking-center';
import { sha256 } from './crypto.server';
export async function refreshTrackingAlerts(db:D1Database,organizationId:string,now=new Date()) {
  const policy=await loadBusinessProcessPolicy(organizationId,db);
  if(!policyEnabled(policy,'tracking.alerts_enabled'))return {created:0};
  const rules=await loadOperationalRules(organizationId,db);
  const rows=await db.prepare(`SELECT o.id,o.order_number,o.is_overdue,o.exception_status,o.salesperson_user_id,
    (SELECT assignee_user_id FROM order_module_instances WHERE organization_id=o.organization_id AND order_id=o.id AND module_code='transport' AND enabled=1) operation_user_id,
    COALESCE(s.estimated_delivery_at,o.requested_delivery_date) arrival_at,s.actual_delivery_at,
    COALESCE((SELECT MAX(e.event_at) FROM shipment_events e WHERE e.shipment_id=s.id),s.actual_pickup_at,s.created_at) latest_at,s.actual_pickup_at,s.id shipment_id,
    (SELECT a.planned_arrival_at FROM order_transport_assignments a WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.status!='cancelled' ORDER BY a.updated_at DESC LIMIT 1) assignment_arrival_at,
    b.id batch_id,b.road_status,b.planned_arrival_at,b.actual_arrival_at
    FROM transport_orders o LEFT JOIN shipments s ON s.id=(SELECT ss.id FROM shipments ss WHERE ss.organization_id=o.organization_id AND ss.order_id=o.id ORDER BY ss.updated_at DESC,ss.created_at DESC LIMIT 1)
    LEFT JOIN transport_batches b ON b.id=(SELECT bb.id FROM transport_batches bb WHERE bb.organization_id=o.organization_id AND bb.status!='cancelled' AND (bb.order_id=o.id OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.organization_id=bb.organization_id AND bo.batch_id=bb.id AND bo.order_id=o.id AND bo.status!='removed')) ORDER BY CASE WHEN bb.actual_arrival_at IS NULL AND COALESCE(bb.road_status,'') NOT IN ('overseas_arrived','waiting_pickup','pickup_completed') THEN 0 ELSE 1 END,bb.updated_at DESC,bb.created_at DESC LIMIT 1)
    WHERE o.organization_id=? AND o.status='in_execution' AND (s.status IS NULL OR s.status!='delivered')`).bind(organizationId).all<{id:string;order_number:string;is_overdue:number;exception_status:string;salesperson_user_id:string|null;operation_user_id:string|null;arrival_at:string|null;actual_delivery_at:string|null;latest_at:string|null;actual_pickup_at:string|null;shipment_id:string|null;assignment_arrival_at:string|null;batch_id:string|null;road_status:string|null;planned_arrival_at:string|null;actual_arrival_at:string|null}>();
  let created=0;
  const day=new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
  for(const row of rows.results){
    const {warning}=deriveTrackingCenterState({orderStatus:'in_execution',isOverdue:Boolean(row.is_overdue),exceptionStatus:row.exception_status,assignmentId:row.actual_pickup_at?row.shipment_id:null,batchId:row.batch_id,batchRoadStatus:row.road_status,plannedArrivalAt:row.planned_arrival_at||row.assignment_arrival_at||row.arrival_at,actualArrivalAt:row.actual_arrival_at||row.actual_delivery_at,latestEventAt:row.latest_at},now,{dueWarningHours:rules['tracking.due_warning_hours'],staleWarningHours:rules['tracking.stale_warning_hours']});
    if(warning.code==='normal')continue;
    for(const userId of new Set([row.salesperson_user_id,row.operation_user_id].filter((id):id is string=>Boolean(id)))){
      const result=await db.prepare(`INSERT OR IGNORE INTO internal_notifications(id,organization_id,user_id,category,severity,title,message,link,requires_ack,is_read,created_at)
        SELECT ?,m.organization_id,m.user_id,'tracking_sla',?,?,?,?,0,0,? FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active' WHERE m.organization_id=? AND m.user_id=? AND m.status='active'`)
        .bind(`sla:${await sha256(`${organizationId}:${row.id}:${warning.code}:${day}:${userId}`)}`,warning.tone==='danger'?'critical':'warning',`运踪预警：${row.order_number}`,`${warning.label}；请核对运输进展并联系运踪岗。`,`/admin/orders/${row.id}`,now.toISOString(),organizationId,userId).run();
      if(Number(result.meta.changes)>0)created++;
    }
  }
  return {created};
}
