import type { SessionUser } from "./auth.server";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { policyEnabled,policyPositions,type BusinessProcessPolicy } from "./business-process-policy";
import { dispatchIsDue,dispatchTaskAccess } from "./dispatch-tasks";
import { loadOperationalRules } from "./operational-rules.server";
import { orderVisibilitySql } from "./order-access";
import { loadActivePositionAccessProfile } from "./position-access-profile.server";

type DispatchOrder={id:string;order_number:string;status:string;planned_port_arrival_at:string|null;has_receivable:number;[field:string]:unknown};
const sourceSql=`SELECT o.*,CASE WHEN EXISTS(SELECT 1 FROM business_expenses e WHERE e.organization_id=o.organization_id AND e.order_id=o.id AND e.direction='receivable' AND e.stage!='cancelled') THEN 1 ELSE 0 END has_receivable FROM transport_orders o`;
function dispatchReadiness(order:DispatchOrder,policy:BusinessProcessPolicy) {
  if(order.status!=="in_execution") throw new Error("订单须审核并完成派单后才能发起找车");
  const required=policy["dispatch.required_order_fields"].split(",").filter(Boolean);
  const missing=required.filter(key=>!String(order[key]??"").trim());
  if(missing.length) throw new Error(`订单资料不齐，尚缺：${missing.join("、")}`);
  if(policyEnabled(policy,"order.require_receivable") && !order.has_receivable) throw new Error("订单尚未录入客户应收，不能发起找车");
}

async function createDispatchTask(db:D1Database,org:string,order:DispatchOrder,policy:BusinessProcessPolicy,actor:string|null,now:string) {
  dispatchReadiness(order,policy);
  if(!order.planned_port_arrival_at || !Number.isFinite(Date.parse(order.planned_port_arrival_at))) throw new Error("请先填写计划到口岸时间");
  const existing=await db.prepare("SELECT id,status FROM order_dispatch_requests WHERE organization_id=? AND order_id=?").bind(org,order.id).first<{id:string;status:string}>();
  if(existing) return {created:false,id:existing.id};
  const id=`dispatch:${org}:${order.id}`,taskId=id;
  const recipientPositions=policyPositions(policy,"dispatch.handler_positions");
  const recipients=await db.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
    WHERE m.organization_id=? AND m.status='active' AND p.code IN (${recipientPositions.map(()=>"?").join(",")})`)
    .bind(org,...recipientPositions).all<{user_id:string}>();
  const eligible=[];
  for(const recipient of recipients.results) {
    const profile=await loadActivePositionAccessProfile(db,org,recipient.user_id);
    if(profile?.permissions.includes("dispatch.manage")) eligible.push(recipient);
  }
  if(!eligible.length) throw new Error("找车办理岗位尚无具有办理权限的有效账号，请配置人员与权限后再发送");
  const statements=[
    db.prepare(`INSERT OR IGNORE INTO order_dispatch_requests(id,organization_id,order_id,task_id,status,planned_port_arrival_at,requested_by_user_id,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?,?)`)
      .bind(id,org,order.id,taskId,order.planned_port_arrival_at,actor,now,now),
    db.prepare(`INSERT OR IGNORE INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,priority,status,assigned_by_user_id,due_at,created_at,updated_at)
      VALUES(?,?,?,'dispatch','find_overseas_vehicle',?,'high','pending',?,?,?,?)`).bind(taskId,org,order.id,`商务找车：${order.order_number}`,actor,order.planned_port_arrival_at,now,now),
    ...eligible.map(r=>db.prepare(`INSERT OR IGNORE INTO internal_notifications(id,organization_id,user_id,category,severity,title,message,link,requires_ack,is_read,created_by_user_id,created_at)
      VALUES(?,?,?,'dispatch_request','warning','有新的商务找车任务','请打开调度与运踪中的找车待办，反馈境外运输资源。','/admin/tracking-center?dispatchTask=pending',0,0,?,?)`)
      .bind(`${id}:${r.user_id}`,org,r.user_id,actor,now)),
  ];
  const results=await db.batch(statements);
  return {created:Number(results[0].meta.changes)>0,id};
}

export async function requestDispatchTask(db:D1Database,input:{current:SessionUser;orderId:string;plannedPortArrivalAt:string;planOnly?:boolean}) {
  const {current}=input,policy=await loadBusinessProcessPolicy(current.organizationId,db);
  const denied=dispatchTaskAccess(policy,current.positionCode,current.permissions,"request");
  if(denied) throw new Error(denied);
  const visibility=orderVisibilitySql(current,"o");
  const order=await db.prepare(`${sourceSql} WHERE o.organization_id=? AND o.id=? AND ${visibility.sql}`).bind(current.organizationId,input.orderId,...visibility.values).first<DispatchOrder>();
  if(!order) throw new Error("订单不存在或超出当前账号数据范围");
  dispatchReadiness(order,policy);
  const time=Date.parse(input.plannedPortArrivalAt);
  if(!Number.isFinite(time)) throw new Error("计划到口岸时间无效");
  order.planned_port_arrival_at=new Date(time).toISOString();
  const now=new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE transport_orders SET planned_port_arrival_at=?,updated_at=? WHERE id=? AND organization_id=?").bind(order.planned_port_arrival_at,now,order.id,current.organizationId),
    db.prepare(`INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at)
      VALUES(?,?,?,'dispatch.plan.update','transport_order',?,'success',?,?)`).bind(crypto.randomUUID(),current.organizationId,current.userId,order.id,JSON.stringify({plannedPortArrivalAt:order.planned_port_arrival_at}),now),
  ]);
  if(input.planOnly) return {created:false,planned:true};
  return createDispatchTask(db,current.organizationId,order,policy,current.userId,now);
}

export async function refreshAutomaticDispatchTasks(db:D1Database,org:string,now=new Date()) {
  const policy=await loadBusinessProcessPolicy(org,db);
  if(!policyEnabled(policy,"dispatch.enabled") || !policyEnabled(policy,"dispatch.automatic")) return {created:0,skipped:0};
  const rules=await loadOperationalRules(org,db);
  const rows=await db.prepare(`${sourceSql} WHERE o.organization_id=? AND o.status='in_execution' AND o.planned_port_arrival_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM order_dispatch_requests d WHERE d.organization_id=o.organization_id AND d.order_id=o.id)`)
    .bind(org).all<DispatchOrder>();
  let created=0,skipped=0;
  for(const order of rows.results) {
    if(!dispatchIsDue(order.planned_port_arrival_at,rules["dispatch.find_vehicle_lead_days"],now)) continue;
    try {if((await createDispatchTask(db,org,order,policy,null,now.toISOString())).created) created++;}
    catch(error){skipped++;console.warn("DISPATCH_TASK_NOT_READY",{orderId:order.id,reason:String(error)});}
  }
  return {created,skipped};
}

export async function fulfillDispatchTask(db:D1Database,input:{current:SessionUser;orderId:string;carrierId:string;vehicleId:string;driverId:string;freightAmount:number;currency:string;exchangeRate:number;notes:string}) {
  const {current}=input,policy=await loadBusinessProcessPolicy(current.organizationId,db);
  const denied=dispatchTaskAccess(policy,current.positionCode,current.permissions,"fulfill");
  if(denied) throw new Error(denied);
  if(!(input.freightAmount>0) || !Number.isFinite(input.freightAmount) || !(input.exchangeRate>0) || !Number.isFinite(input.exchangeRate) || !/^[A-Z]{3}$/.test(input.currency)) throw new Error("请填写有效运价、币种与实际汇率");
  const visibility=orderVisibilitySql(current,"o");
  const request=await db.prepare(`SELECT d.id,d.task_id,d.status,d.carrier_id,d.vehicle_id,d.driver_id,d.freight_amount,d.freight_currency,d.exchange_rate,d.resource_notes,d.requested_by_user_id FROM order_dispatch_requests d JOIN transport_orders o ON o.id=d.order_id AND o.organization_id=d.organization_id
    WHERE d.organization_id=? AND d.order_id=? AND o.status='in_execution' AND ${visibility.sql}`)
    .bind(current.organizationId,input.orderId,...visibility.values).first<{id:string;task_id:string;status:string;carrier_id:string|null;vehicle_id:string|null;driver_id:string|null;freight_amount:number|null;freight_currency:string|null;exchange_rate:number|null;resource_notes:string|null;requested_by_user_id:string|null}>();
  if(!request) throw new Error("找车任务不存在或当前无权办理");
  if(request.status==="fulfilled") {
    if(request.carrier_id!==input.carrierId || request.vehicle_id!==input.vehicleId || request.driver_id!==input.driverId || Number(request.freight_amount)!==input.freightAmount || request.freight_currency!==input.currency || Number(request.exchange_rate)!==input.exchangeRate || (request.resource_notes??"")!==input.notes.trim()) throw new Error("资源已反馈；重复提交内容不同，请先核对已保存资源，不能静默覆盖");
    return {duplicate:true};
  }
  const resource=await db.prepare(`SELECT v.id FROM carrier_vehicles v JOIN carriers c ON c.id=v.carrier_id AND c.organization_id=v.organization_id
    JOIN carrier_drivers driver ON driver.carrier_id=c.id AND driver.organization_id=c.organization_id
    WHERE c.organization_id=? AND c.id=? AND c.status='active' AND v.id=? AND v.status='active' AND driver.id=? AND driver.status='active'`)
    .bind(current.organizationId,input.carrierId,input.vehicleId,input.driverId).first();
  if(!resource) throw new Error("承运商、车辆与司机须属于同一有效运输资源");
  const now=new Date().toISOString();
  const owners=await db.prepare(`SELECT DISTINCT user_id FROM (SELECT requested_by_user_id user_id FROM order_dispatch_requests WHERE id=? AND organization_id=?
    UNION SELECT operation_supervisor_user_id FROM transport_orders WHERE id=? AND organization_id=?
    UNION SELECT assignee_user_id FROM order_module_instances WHERE order_id=? AND organization_id=? AND module_code='transport') dispatch_owners WHERE user_id IS NOT NULL`)
    .bind(request.id,current.organizationId,input.orderId,current.organizationId,input.orderId,current.organizationId).all<{user_id:string}>();
  const results=await db.batch([
    db.prepare(`UPDATE order_dispatch_requests SET status='fulfilled',carrier_id=?,vehicle_id=?,driver_id=?,freight_amount=?,freight_currency=?,exchange_rate=?,resource_notes=?,fulfilled_by_user_id=?,fulfilled_at=?,updated_at=?
      WHERE id=? AND organization_id=? AND status='pending'`).bind(input.carrierId,input.vehicleId,input.driverId,input.freightAmount,input.currency,input.exchangeRate,input.notes.trim(),current.userId,now,now,request.id,current.organizationId),
    db.prepare(`UPDATE order_tasks SET status='completed',assignee_user_id=?,completed_at=?,updated_at=? WHERE id=? AND organization_id=? AND status IN ('pending','in_progress')
      AND EXISTS(SELECT 1 FROM order_dispatch_requests d WHERE d.id=? AND d.organization_id=? AND d.status='fulfilled')`).bind(current.userId,now,now,request.task_id,current.organizationId,request.id,current.organizationId),
    db.prepare(`INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at)
      VALUES(?,?,?,'dispatch.resource.fulfill','transport_order',?,'success',?,?)`).bind(crypto.randomUUID(),current.organizationId,current.userId,input.orderId,JSON.stringify({carrierId:input.carrierId,vehicleId:input.vehicleId,driverId:input.driverId}),now),
    ...owners.results.map(owner=>db.prepare(`INSERT OR IGNORE INTO internal_notifications(id,organization_id,user_id,category,severity,title,message,link,requires_ack,is_read,created_by_user_id,created_at)
      VALUES(?,?,?,'dispatch_ready','info','商务运输资源已反馈','可在调度与运踪查看资源并安排配载。','/admin/tracking-center',0,0,?,?)`)
      .bind(`${request.id}:ready:${owner.user_id}`,current.organizationId,owner.user_id,current.userId,now)),
  ]);
  return {duplicate:!Number(results[0].meta.changes)};
}

export async function loadDispatchTaskRows(db:D1Database,current:SessionUser) {
  const visibility=orderVisibilitySql(current,"o");
  return (await db.prepare(`SELECT d.id,d.order_id,o.order_number,d.status,d.planned_port_arrival_at,d.freight_amount,d.freight_currency,d.resource_notes,
    c.name carrier_name,v.plate_number,driver.name driver_name,d.fulfilled_at FROM order_dispatch_requests d
    JOIN transport_orders o ON o.id=d.order_id AND o.organization_id=d.organization_id
    LEFT JOIN carriers c ON c.id=d.carrier_id AND c.organization_id=d.organization_id
    LEFT JOIN carrier_vehicles v ON v.id=d.vehicle_id AND v.organization_id=d.organization_id
    LEFT JOIN carrier_drivers driver ON driver.id=d.driver_id AND driver.organization_id=d.organization_id
    WHERE d.organization_id=? AND ${visibility.sql} ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END,d.planned_port_arrival_at`)
    .bind(current.organizationId,...visibility.values).all<{id:string;order_id:string;order_number:string;status:string;planned_port_arrival_at:string;freight_amount:number|null;freight_currency:string|null;resource_notes:string|null;carrier_name:string|null;plate_number:string|null;driver_name:string|null;fulfilled_at:string|null}>()).results.map(row=>current.permissions.includes("dispatch.cost.view")?row:{...row,freight_amount:null,freight_currency:null});
}
