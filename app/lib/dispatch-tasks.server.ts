import type { SessionUser } from "./auth.server";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { policyEnabled,policyPositions,type BusinessProcessPolicy } from "./business-process-policy";
import { dispatchIsDue,dispatchTaskAccess } from "./dispatch-tasks";
import { loadOperationalRules } from "./operational-rules.server";
import { orderVisibilitySql } from "./order-access";
import { loadActivePositionAccessProfile } from "./position-access-profile.server";

type DispatchOrder={id:string;order_number:string;status:string;business_type:string;exit_port:string|null;planned_port_arrival_at:string|null;has_receivable:number;[field:string]:unknown};
const sourceSql=`SELECT o.*,CASE WHEN EXISTS(SELECT 1 FROM business_expenses e WHERE e.organization_id=o.organization_id AND e.order_id=o.id AND e.direction='receivable' AND e.stage!='cancelled') THEN 1 ELSE 0 END has_receivable FROM transport_orders o`;
const dispatchFieldLabels:Record<string,string>={shipper_name:"发货人",shipper_contact:"发货联系人",shipper_phone:"发货联系电话",origin_city:"起运城市",origin_address:"提货地址",consignee_name:"收货人",consignee_contact:"收货联系人",consignee_phone:"收货联系电话",destination_city:"目的城市",destination_address:"目的地址",cargo_description:"货物描述",exit_port:"出境口岸",requested_pickup_date:"要求提货日期",overseas_warehouse_id:"境外目的仓"};
function dispatchReadiness(order:DispatchOrder,policy:BusinessProcessPolicy) {
  if(order.status!=="in_execution") throw new Error("订单须审核并完成派单后才能发起找车");
  const required=policy["dispatch.required_order_fields"].split(",").filter(Boolean);
  const missing=required.filter(key=>!String(order[key]??"").trim());
  if(missing.length) throw new Error(`订单资料不齐，尚缺：${missing.map(key=>dispatchFieldLabels[key]||key).join("、")}`);
  if(policyEnabled(policy,"order.require_receivable") && !order.has_receivable) throw new Error("订单尚未录入客户应收，不能发起找车");
}

async function createDispatchTask(db:D1Database,org:string,order:DispatchOrder,policy:BusinessProcessPolicy,actor:string|null,now:string) {
  dispatchReadiness(order,policy);
  if(!order.planned_port_arrival_at || !Number.isFinite(Date.parse(order.planned_port_arrival_at))) throw new Error("请先填写计划到口岸时间");
  const existing=await db.prepare("SELECT id,status FROM order_dispatch_requests WHERE organization_id=? AND order_id=?").bind(org,order.id).first<{id:string;status:string}>();
  if(existing) return {created:false,id:existing.id};
  const id=`dispatch:${org}:${order.id}`,taskId=id;
  const recipientPositions=policyPositions(policy,"dispatch.handler_positions");
  if(!recipientPositions.length) throw new Error("尚未配置商务找车岗位，请先配置岗位与有效账号");
  const recipients=await db.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
    WHERE m.organization_id=? AND m.status='active' AND p.code IN (${recipientPositions.map(()=>"?").join(",")})`)
    .bind(org,...recipientPositions).all<{user_id:string}>();
  const eligible=[];
  for(const recipient of recipients.results) {
    const profile=await loadActivePositionAccessProfile(db,org,recipient.user_id);
    if(profile?.permissions.includes("dispatch.manage") && profile.permissions.includes("dispatch.view")) eligible.push(recipient);
  }
  if(!eligible.length) throw new Error("找车办理岗位尚无具有办理权限的有效账号，请配置人员与权限后再发送");
  const statements=[
    db.prepare(`INSERT OR IGNORE INTO order_dispatch_requests(id,organization_id,order_id,task_id,status,planned_port_arrival_at,requested_by_user_id,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?,?)`)
      .bind(id,org,order.id,taskId,order.planned_port_arrival_at,actor,now,now),
    db.prepare(`INSERT OR IGNORE INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,priority,status,assigned_by_user_id,due_at,created_at,updated_at)
      VALUES(?,?,?,'dispatch','find_overseas_vehicle',?,'high','pending',?,?,?,?)`).bind(taskId,org,order.id,`商务找车：${order.order_number}`,actor,order.planned_port_arrival_at,now,now),
    ...eligible.map(r=>db.prepare(`INSERT OR IGNORE INTO internal_notifications(id,organization_id,user_id,category,severity,title,message,link,requires_ack,is_read,created_by_user_id,created_at)
      VALUES(?,?,?,'dispatch_request','warning','有新的商务找车任务','请打开找车工作台，反馈境外运输资源。','/admin/dispatch',0,0,?,?)`)
      .bind(`${id}:${r.user_id}`,org,r.user_id,actor,now)),
  ];
  const results=await db.batch(statements);
  return {created:Number(results[0].meta.changes)>0,id};
}

export async function requestDispatchTask(db:D1Database,input:{current:SessionUser;orderId:string;plannedPortArrivalAt:string;exitPort?:string;planOnly?:boolean}) {
  const {current}=input,policy=await loadBusinessProcessPolicy(current.organizationId,db);
  const denied=dispatchTaskAccess(policy,current.positionCode,current.permissions,"request",current.roleCodes);
  if(denied) throw new Error(denied);
  const visibility=orderVisibilitySql(current,"o");
  const order=await db.prepare(`${sourceSql} WHERE o.organization_id=? AND o.id=? AND ${visibility.sql}`).bind(current.organizationId,input.orderId,...visibility.values).first<DispatchOrder>();
  if(!order) throw new Error("订单不存在或超出当前账号数据范围");
  if(order.business_type==="ltl") throw new Error("拼车请先由操作主管生成配载单，再按整张配载单发送商务找车");
  const selectedPort=input.exitPort?.trim()||"";
  if(selectedPort && selectedPort!==order.exit_port) {
    if(order.exit_port?.trim()) throw new Error("订单已登记出境口岸，请在订单线路资料中核对，不能从找车任务直接改写");
    const activePort=await db.prepare("SELECT code FROM reference_data WHERE organization_id=? AND category='border_port' AND code=? AND status='active'")
      .bind(current.organizationId,selectedPort).first<{code:string}>();
    if(!activePort) throw new Error("请选择基础数据中启用的出境口岸");
    order.exit_port=selectedPort;
  }
  dispatchReadiness(order,policy);
  const time=Date.parse(input.plannedPortArrivalAt);
  if(!Number.isFinite(time)) throw new Error("计划到口岸时间无效");
  order.planned_port_arrival_at=new Date(time).toISOString();
  const now=new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE transport_orders SET planned_port_arrival_at=?,exit_port=CASE WHEN TRIM(COALESCE(exit_port,''))='' THEN ? ELSE exit_port END,updated_at=? WHERE id=? AND organization_id=?").bind(order.planned_port_arrival_at,selectedPort||null,now,order.id,current.organizationId),
    db.prepare(`INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at)
      VALUES(?,?,?,'dispatch.plan.update','transport_order',?,'success',?,?)`).bind(crypto.randomUUID(),current.organizationId,current.userId,order.id,JSON.stringify({plannedPortArrivalAt:order.planned_port_arrival_at,exitPort:selectedPort||null}),now),
  ]);
  if(selectedPort) {
    const saved=await db.prepare("SELECT exit_port FROM transport_orders WHERE id=? AND organization_id=?").bind(order.id,current.organizationId).first<{exit_port:string|null}>();
    if(saved?.exit_port!==selectedPort) throw new Error("订单出境口岸已由其他操作更新，请刷新并核对后再发送找车任务");
  }
  if(input.planOnly) return {created:false,planned:true};
  return createDispatchTask(db,current.organizationId,order,policy,current.userId,now);
}

export async function refreshAutomaticDispatchTasks(db:D1Database,org:string,now=new Date()) {
  const policy=await loadBusinessProcessPolicy(org,db);
  if(!policyEnabled(policy,"dispatch.enabled") || !policyEnabled(policy,"dispatch.automatic")) return {created:0,skipped:0};
  const rules=await loadOperationalRules(org,db);
  const rows=await db.prepare(`${sourceSql} WHERE o.organization_id=? AND o.business_type='ftl' AND o.status='in_execution' AND o.planned_port_arrival_at IS NOT NULL
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
  const denied=dispatchTaskAccess(policy,current.positionCode,current.permissions,"fulfill",current.roleCodes);
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
  const guardId=crypto.randomUUID();
  let results:D1Result[];
  try { results=await db.batch([
    db.prepare(`UPDATE order_dispatch_requests SET status='fulfilled',carrier_id=?,vehicle_id=?,driver_id=?,freight_amount=?,freight_currency=?,exchange_rate=?,resource_notes=?,fulfilled_by_user_id=?,fulfilled_at=?,updated_at=?
      WHERE id=? AND organization_id=? AND status='pending'`).bind(input.carrierId,input.vehicleId,input.driverId,input.freightAmount,input.currency,input.exchangeRate,input.notes.trim(),current.userId,now,now,request.id,current.organizationId),
    // Validate the committed resource within the same transaction. A stale
    // pending read must not silently succeed when another submit wins.
    db.prepare(`INSERT INTO settlement_commit_guards(id,valid,created_at)
      SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM order_dispatch_requests WHERE id=? AND organization_id=? AND status='fulfilled'
        AND carrier_id=? AND vehicle_id=? AND driver_id=? AND freight_amount=? AND freight_currency=? AND exchange_rate=? AND COALESCE(resource_notes,'')=?) THEN 1 ELSE NULL END,?`)
      .bind(guardId,request.id,current.organizationId,input.carrierId,input.vehicleId,input.driverId,input.freightAmount,input.currency,input.exchangeRate,input.notes.trim(),now),
    db.prepare(`UPDATE order_tasks SET status='completed',assignee_user_id=?,completed_at=?,updated_at=? WHERE id=? AND organization_id=? AND status IN ('pending','in_progress')
      AND EXISTS(SELECT 1 FROM order_dispatch_requests d WHERE d.id=? AND d.organization_id=? AND d.status='fulfilled' AND d.fulfilled_by_user_id=? AND d.fulfilled_at=?)`).bind(current.userId,now,now,request.task_id,current.organizationId,request.id,current.organizationId,current.userId,now),
    db.prepare(`INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at)
      SELECT ?,?,?,'dispatch.resource.fulfill','transport_order',?,'success',?,? WHERE EXISTS(SELECT 1 FROM order_dispatch_requests WHERE id=? AND organization_id=? AND fulfilled_by_user_id=? AND fulfilled_at=?)`).bind(crypto.randomUUID(),current.organizationId,current.userId,input.orderId,JSON.stringify({carrierId:input.carrierId,vehicleId:input.vehicleId,driverId:input.driverId}),now,request.id,current.organizationId,current.userId,now),
    ...owners.results.map(owner=>db.prepare(`INSERT OR IGNORE INTO internal_notifications(id,organization_id,user_id,category,severity,title,message,link,requires_ack,is_read,created_by_user_id,created_at)
      VALUES(?,?,?,'dispatch_ready','info','商务运输资源已反馈','请查看订单中的运输资源并继续办理。',?,0,0,?,?)`)
      .bind(`${request.id}:ready:${owner.user_id}`,current.organizationId,owner.user_id,`/admin/orders/${input.orderId}`,current.userId,now)),
  ]); } catch(error) {
    if(String(error).includes('settlement_commit_guards')) throw new Error('运输资源已由其他提交更新，请刷新核对；本次未覆盖资源');
    throw error;
  }
  return {duplicate:!Number(results[0].meta.changes)};
}

export async function loadDispatchTaskRows(db:D1Database,current:SessionUser) {
  const visibility=orderVisibilitySql(current,"o");
  return (await db.prepare(`SELECT d.id,d.order_id,o.order_number,o.origin_city,o.destination_city,customer.name customer_name,d.status,d.planned_port_arrival_at,d.freight_amount,d.freight_currency,d.resource_notes,
    c.name carrier_name,v.plate_number,driver.name driver_name,d.fulfilled_at FROM order_dispatch_requests d
    JOIN transport_orders o ON o.id=d.order_id AND o.organization_id=d.organization_id
    JOIN customers customer ON customer.id=o.customer_id AND customer.organization_id=o.organization_id
    LEFT JOIN carriers c ON c.id=d.carrier_id AND c.organization_id=d.organization_id
    LEFT JOIN carrier_vehicles v ON v.id=d.vehicle_id AND v.organization_id=d.organization_id
    LEFT JOIN carrier_drivers driver ON driver.id=d.driver_id AND driver.organization_id=d.organization_id
    WHERE d.organization_id=? AND o.business_type='ftl' AND ${visibility.sql} ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END,d.planned_port_arrival_at`)
    .bind(current.organizationId,...visibility.values).all<{id:string;order_id:string;order_number:string;origin_city:string|null;destination_city:string|null;customer_name:string;status:string;planned_port_arrival_at:string;freight_amount:number|null;freight_currency:string|null;resource_notes:string|null;carrier_name:string|null;plate_number:string|null;driver_name:string|null;fulfilled_at:string|null}>()).results.map(row=>current.permissions.includes("dispatch.cost.view")?row:{...row,freight_amount:null,freight_currency:null});
}
