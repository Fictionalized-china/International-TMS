import type { SessionUser } from "./auth.server";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { dailyTrackingAccess,dailyTrackingDescription,validTrackingEventTime,storedTrackingTimestamp,type DailyTrackingKind } from "./daily-tracking";
import { sha256 } from "./crypto.server";
import { orderVisibilitySql } from "./order-access";

export async function recordDailyTracking(db:D1Database,input:{current:SessionUser;orderId:string;requestId:string;eventKind:string;eventAt:string;location:string;vehicleReference:string;notes:string;visibleToCustomer:boolean}) {
  const {current}=input;
  if (!/^[A-Za-z0-9:_-]{10,160}$/.test(input.requestId)) throw new Error("缺少有效提交标识，请刷新后重试");
  if (!input.location.trim() || !input.notes.trim() || input.notes.length>2000 || input.location.length>200 || input.vehicleReference.length>100) throw new Error("请填写地点与运踪说明，并保持内容长度合理");
  const now=new Date();
  if (!validTrackingEventTime(input.eventAt,now)) throw new Error("运踪时间无效或超出当前时间");
  const eventAt=new Date(input.eventAt).toISOString();
  const visibility=orderVisibilitySql(current,"o");
  const order=await db.prepare(`SELECT o.id,o.status,s.id shipment_id,s.status shipment_status,s.actual_pickup_at
    FROM transport_orders o JOIN shipments s ON s.id=(SELECT ss.id FROM shipments ss WHERE ss.organization_id=o.organization_id AND ss.order_id=o.id ORDER BY ss.updated_at DESC,ss.created_at DESC LIMIT 1)
    WHERE o.id=? AND o.organization_id=? AND ${visibility.sql}`)
    .bind(input.orderId,current.organizationId,...visibility.values).first<{id:string;status:string;shipment_id:string;shipment_status:string;actual_pickup_at:string|null}>();
  if(!order) throw new Error("订单或运单不存在，或超出当前账号数据范围");
  const policy=await loadBusinessProcessPolicy(current.organizationId,db);
  const denied=dailyTrackingAccess({policy,positionCode:current.positionCode,roleCodes:current.roleCodes,permissions:current.permissions,orderStatus:order.status,eventKind:input.eventKind,pickupAt:order.actual_pickup_at});
  if(denied) throw new Error(denied);
  if(order.shipment_status==="delivered") throw new Error("运输已结束，历史轨迹只读");
  if(order.actual_pickup_at) {
    const pickupTime=storedTrackingTimestamp(order.actual_pickup_at);
    if(!Number.isFinite(pickupTime)) throw new Error("实际提货时间无效，请核对历史运单数据");
    if(Date.parse(eventAt)<pickupTime) throw new Error("在途轨迹不能早于实际提货时间");
  }
  const kind=input.eventKind as DailyTrackingKind;
  const description=dailyTrackingDescription(kind,input.notes,input.vehicleReference);
  const hash=await sha256(JSON.stringify({orderId:input.orderId,kind,eventAt,location:input.location.trim(),vehicle:input.vehicleReference.trim(),notes:input.notes.trim(),visible:input.visibleToCustomer}));
  const existing=await db.prepare("SELECT payload_hash FROM order_daily_tracking WHERE organization_id=? AND actor_user_id=? AND request_id=?").bind(current.organizationId,current.userId,input.requestId).first<{payload_hash:string}>();
  if(existing) {
    if(existing.payload_hash!==hash) throw new Error("同一提交标识的内容已变化，请刷新后重新提交");
    return {duplicate:true};
  }
  const id=crypto.randomUUID(),at=now.toISOString();
  const status=kind==="pickup" ? "picked_up" : kind==="exception" ? "exception" : "in_transit";
  const statements=[
    db.prepare(`INSERT INTO order_daily_tracking(id,organization_id,order_id,shipment_id,request_id,payload_hash,event_kind,event_at,location,vehicle_reference,notes,visible_to_customer,actor_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,current.organizationId,order.id,order.shipment_id,input.requestId,hash,kind,eventAt,input.location.trim(),input.vehicleReference.trim()||null,input.notes.trim(),input.visibleToCustomer?1:0,current.userId,at),
    db.prepare(`INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(id,order.shipment_id,status,input.location.trim(),description,eventAt,input.visibleToCustomer?1:0,current.userId,at),
    db.prepare(`UPDATE shipments SET current_location=?,updated_at=? WHERE id=? AND organization_id=?
      AND NOT EXISTS(SELECT 1 FROM shipment_events e WHERE e.shipment_id=? AND e.event_at>?)`).bind(input.location.trim(),at,order.shipment_id,current.organizationId,order.shipment_id,eventAt),
    db.prepare(`INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at)
      VALUES(?,?,?,'tracking.daily.create','transport_order',?,'success',?,?)`).bind(crypto.randomUUID(),current.organizationId,current.userId,order.id,JSON.stringify({kind,visibleToCustomer:input.visibleToCustomer}),at),
  ];
  if(kind==="pickup") statements.push(db.prepare("UPDATE shipments SET actual_pickup_at=COALESCE(actual_pickup_at,?),status=CASE WHEN status IN ('pending','booked') THEN 'picked_up' ELSE status END,updated_at=? WHERE id=? AND organization_id=?").bind(eventAt,at,order.shipment_id,current.organizationId));
  try { await db.batch(statements); }
  catch(error) {
    const concurrent=await db.prepare("SELECT payload_hash FROM order_daily_tracking WHERE organization_id=? AND actor_user_id=? AND request_id=?").bind(current.organizationId,current.userId,input.requestId).first<{payload_hash:string}>();
    if(concurrent?.payload_hash===hash) return {duplicate:true};
    throw error;
  }
  return {duplicate:false};
}
