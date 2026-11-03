import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { loadBusinessProcessPolicy } from "./business-process-policy.server";
import { policyEnabled,policyPositions } from "./business-process-policy";
import { dispatchTaskAccess } from "./dispatch-tasks";
import { loadActivePositionAccessProfile } from "./position-access-profile.server";
import type { AllocationMethod } from "./cost-allocation";
import { synchronizeBatchTransport } from "./batch-transport-sync.server";
import { orderVisibilitySql } from "./order-access";

function dispatchBatchScope(current: SessionUser) {
  const scope = orderVisibilitySql(current, "scope_order");
  return { values: scope.values, sql: `NOT EXISTS(SELECT 1 FROM transport_batch_orders scope_link
    JOIN transport_orders scope_order ON scope_order.id=scope_link.order_id AND scope_order.organization_id=scope_link.organization_id
    WHERE scope_link.batch_id=b.id AND scope_link.organization_id=b.organization_id AND scope_link.status!='removed' AND NOT (${scope.sql}))` };
}

export type BatchFindVehicleTask = {
  id:string;batch_number:string;batch_name:string;origin_location:string;destination_location:string;
  border_port:string|null;planned_departure_at:string|null;warehouse_name:string|null;
  order_numbers:string|null;order_count:number;package_count:number;weight_kg:number;volume_cbm:number;
  carrier_id:string|null;carrier_name:string|null;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;
};

export async function loadBatchFindVehicleTasks(current:SessionUser):Promise<BatchFindVehicleTask[]> {
  if(!current.permissions.includes("dispatch.view"))return [];
  const scope = dispatchBatchScope(current);
  return (await env.DB.prepare(`SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,
      b.border_port,b.planned_departure_at,w.name warehouse_name,b.carrier_id,c.name carrier_name,
      b.overseas_vehicle_plate,b.overseas_driver_name,COUNT(DISTINCT bo.order_id) order_count,
      GROUP_CONCAT(DISTINCT o.order_number) order_numbers,
      COALESCE(SUM(job.outbound_package_count),0) package_count,
      COALESCE(SUM(job.total_weight_kg),0) weight_kg,
      COALESCE(SUM(job.total_volume_cbm),0) volume_cbm
    FROM transport_batches b
    JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
    JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id AND o.business_type='ltl'
    LEFT JOIN warehouse_packing_jobs job ON job.organization_id=bo.organization_id AND job.order_id=bo.order_id AND job.transport_batch_id=b.id
    LEFT JOIN warehouses w ON w.id=b.warehouse_id AND w.organization_id=b.organization_id
    LEFT JOIN carriers c ON c.id=b.carrier_id AND c.organization_id=b.organization_id
    WHERE b.organization_id=? AND b.batch_number LIKE 'PZ-%'
      AND ${scope.sql}
      AND (b.approval_status='submitted' OR EXISTS(SELECT 1 FROM batch_dispatch_quotes quote WHERE quote.organization_id=b.organization_id AND quote.batch_id=b.id))
      AND b.submitted_at IS NOT NULL AND b.status!='cancelled'
    GROUP BY b.id ORDER BY CASE WHEN b.carrier_id IS NULL THEN 0 ELSE 1 END,b.submitted_at DESC`).bind(current.organizationId,...scope.values).all<BatchFindVehicleTask>()).results;
}

export async function sendBatchToCommercial(current:SessionUser,batchId:string) {
  const privileged=["BOSS","DEVELOPER"].includes(current.positionCode??"")||current.roleCodes.some(code=>["owner","boss","developer"].includes(code));
  if(!privileged&&!current.permissions.includes("transport.batch.approve"))throw new Error("当前账号无权发送拼车配载需求");
  const batch=await env.DB.prepare(`SELECT id,batch_number,operation_supervisor_user_id,approval_status,submitted_at,carrier_id
    FROM transport_batches WHERE organization_id=? AND id=? AND batch_number LIKE 'PZ-%' AND status!='cancelled'`)
    .bind(current.organizationId,batchId).first<{id:string;batch_number:string;operation_supervisor_user_id:string|null;approval_status:string;submitted_at:string|null;carrier_id:string|null}>();
  if(!batch)throw new Error("配载单不存在");
  if(!privileged&&batch.operation_supervisor_user_id!==current.userId)throw new Error("仅本批操作主管可发送找车需求");
  if(batch.approval_status!=="submitted"||batch.submitted_at||batch.carrier_id)throw new Error("配载单已发送或已完成资源绑定，请刷新页面");
  const pending=await env.DB.prepare("SELECT 1 FROM loading_planning_submissions WHERE organization_id=? AND batch_id=? AND sync_status='pending'")
    .bind(current.organizationId,batchId).first();
  if(pending)throw new Error("配载资料仍在同步，请先重试同步");
  const policy=await loadBusinessProcessPolicy(current.organizationId,env.DB);
  if(!policyEnabled(policy,"dispatch.enabled"))throw new Error("商务找车功能已停用，请先在业务流程策略中启用");
  const positions=policyPositions(policy,"dispatch.handler_positions");
  if(!positions.length)throw new Error("尚未配置商务找车岗位");
  const members=(await env.DB.prepare(`SELECT DISTINCT m.user_id FROM memberships m
    JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
    WHERE m.organization_id=? AND m.status='active' AND p.code IN (${positions.map(()=>"?").join(",")})`)
    .bind(current.organizationId,...positions).all<{user_id:string}>()).results;
  const recipients:string[]=[];
  for(const member of members){
    const access=await loadActivePositionAccessProfile(env.DB,current.organizationId,member.user_id);
    if(access?.permissions.includes("dispatch.manage") && access.permissions.includes("dispatch.view"))recipients.push(member.user_id);
  }
  if(!recipients.length)throw new Error("找车岗位没有具备办理权限的有效账号，请先配置人员与权限");
  const now=new Date().toISOString();
  const statements:D1PreparedStatement[]=[env.DB.prepare(`UPDATE transport_batches SET submitted_by_user_id=?,submitted_at=?,updated_at=?
    WHERE organization_id=? AND id=? AND approval_status='submitted' AND submitted_at IS NULL AND carrier_id IS NULL AND status!='cancelled'`)
    .bind(current.userId,now,now,current.organizationId,batchId),env.DB.prepare(`INSERT INTO settlement_commit_guards(id,valid,created_at)
      VALUES(?,(SELECT CASE WHEN submitted_at=? AND submitted_by_user_id=? THEN 1 ELSE NULL END FROM transport_batches WHERE organization_id=? AND id=?),?)`)
    .bind(crypto.randomUUID(),now,current.userId,current.organizationId,batchId,now),...recipients.map(userId=>env.DB.prepare(`INSERT INTO internal_notifications
    (id,organization_id,user_id,category,severity,title,message,link,requires_ack,is_read,created_by_user_id,created_at)
    VALUES(?,?,?,'dispatch_request','warning',?,?,'/admin/dispatch',0,0,?,?)`)
    .bind(crypto.randomUUID(),current.organizationId,userId,`配载单 ${batch.batch_number} 待找车`,"请进入找车工作台，按整张配载单落实车辆、司机和运价。",current.userId,now))];
  try{const results=await env.DB.batch(statements);if(!Number(results[0]?.meta?.changes||0))throw new Error("配载单状态已变化，请刷新页面");}
  catch(error){if(String(error).includes("NOT NULL"))throw new Error("配载单状态已变化，请刷新页面");throw error;}
  return batch.batch_number;
}

type FeedbackInput={current:SessionUser;batchId:string;carrierId:string;newCarrierName:string;vehicleId:string;newPlateNumber:string;newVehicleType:string;driverId:string;newDriverName:string;newDriverPhone:string;freightAmount:number;currency:string;exchangeRate:number;allocationMethod:"auto"|AllocationMethod;notes:string};
export async function fulfillBatchFindVehicle(input:FeedbackInput){
  const {current}=input;
  const policy=await loadBusinessProcessPolicy(current.organizationId,env.DB);
  const denied=dispatchTaskAccess(policy,current.positionCode,current.permissions,"fulfill",current.roleCodes);
  if(denied)throw new Error(denied);
  if(!Number.isFinite(input.freightAmount)||input.freightAmount<=0)throw new Error("请填写大于零的整批运价");
  if(!["CNY","USD","RUB","KZT","UZS"].includes(input.currency))throw new Error("成本币种无效");
  if(!Number.isFinite(input.exchangeRate)||input.exchangeRate<=0||(input.currency==="CNY"&&input.exchangeRate!==1))throw new Error("实际汇率无效；人民币汇率须为 1");
  const newCarrier=input.carrierId==="__new";
  const newVehicle=input.vehicleId==="__new";
  const newDriver=input.driverId==="__new";
  if((newCarrier||newVehicle||newDriver)&&!current.permissions.includes("carrier.manage"))throw new Error("新增承运商、车辆或司机需要运输资源维护权限");
  if(newCarrier&&(!newVehicle||!newDriver))throw new Error("新增承运商时请同时新增车辆和司机");
  const carrierName=input.newCarrierName.trim();
  const plate=input.newPlateNumber.trim().toUpperCase();
  const vehicleType=input.newVehicleType.trim();
  const driverName=input.newDriverName.trim();
  const driverPhone=input.newDriverPhone.trim();
  if(newCarrier&&(carrierName.length<2||carrierName.length>100))throw new Error("新承运商名称须为 2–100 字符");
  if(newVehicle&&(plate.length<2||plate.length>40||vehicleType.length<2||vehicleType.length>80))throw new Error("请填写有效的新车牌和车型");
  if(newDriver&&(driverName.length<2||driverName.length>80||!/^[+0-9()\-\s]{5,30}$/.test(driverPhone)))throw new Error("请填写新司机姓名和有效联系电话");
  const scope = dispatchBatchScope(current);
  const batch=await env.DB.prepare(`SELECT b.id,b.batch_number,b.operation_supervisor_user_id,b.approval_status,b.submitted_at,b.carrier_id
    FROM transport_batches b WHERE b.organization_id=? AND b.id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled' AND ${scope.sql}`)
    .bind(current.organizationId,input.batchId,...scope.values).first<{id:string;batch_number:string;operation_supervisor_user_id:string|null;approval_status:string;submitted_at:string|null;carrier_id:string|null}>();
  if(!batch||batch.approval_status!=="submitted"||!batch.submitted_at||batch.carrier_id)throw new Error("配载需求不存在、尚未发送或已经完成绑定");
  const carrierId=newCarrier?crypto.randomUUID():input.carrierId;
  const vehicleId=newVehicle?crypto.randomUUID():input.vehicleId;
  const driverId=newDriver?crypto.randomUUID():input.driverId;
  const [carrier,vehicle,driver,orders]=await Promise.all([
    newCarrier?Promise.resolve(null):env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND id=? AND status='active' AND carrier_scope='overseas'").bind(current.organizationId,carrierId).first<{id:string;name:string}>(),
    newVehicle?Promise.resolve(null):env.DB.prepare("SELECT id,carrier_id,plate_number,vehicle_type,capacity_weight_kg,capacity_volume_cbm FROM carrier_vehicles WHERE organization_id=? AND id=? AND status='active'").bind(current.organizationId,vehicleId).first<{id:string;carrier_id:string;plate_number:string;vehicle_type:string|null;capacity_weight_kg:number;capacity_volume_cbm:number}>(),
    newDriver?Promise.resolve(null):env.DB.prepare("SELECT id,carrier_id,name,phone FROM carrier_drivers WHERE organization_id=? AND id=? AND status='active'").bind(current.organizationId,driverId).first<{id:string;carrier_id:string;name:string;phone:string|null}>(),
    env.DB.prepare(`SELECT bo.order_id,COALESCE(job.total_weight_kg,0) weight_kg,COALESCE(job.total_volume_cbm,0) volume_cbm
      FROM transport_batch_orders bo LEFT JOIN warehouse_packing_jobs job ON job.organization_id=bo.organization_id AND job.order_id=bo.order_id AND job.transport_batch_id=bo.batch_id
      WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(current.organizationId,input.batchId).all<{order_id:string;weight_kg:number;volume_cbm:number}>(),
  ]);
  if(!newCarrier&&!carrier)throw new Error("承运商不存在或已停用");
  if(!newVehicle&&(!vehicle||vehicle.carrier_id!==carrierId||!vehicle.vehicle_type))throw new Error("车辆不属于所选承运商，或缺少车型");
  if(!newDriver&&(!driver||driver.carrier_id!==carrierId||!driver.phone))throw new Error("司机不属于所选承运商，或缺少电话");
  if(orders.results.length<2)throw new Error("配载单挂载订单不足，请主管核对");
  if(newVehicle){const duplicate=await env.DB.prepare("SELECT 1 FROM carrier_vehicles WHERE organization_id=? AND plate_number=?").bind(current.organizationId,plate).first();if(duplicate)throw new Error("该车牌已存在，请直接选择现有车辆");}
  if(newDriver){const duplicate=await env.DB.prepare("SELECT 1 FROM carrier_drivers WHERE organization_id=? AND carrier_id=? AND name=?").bind(current.organizationId,carrierId,driverName).first();if(duplicate)throw new Error("该司机已存在，请直接选择现有司机");}
  const name=newCarrier?carrierName:carrier!.name;
  const finalPlate=newVehicle?plate:vehicle!.plate_number;
  const finalType=newVehicle?vehicleType:vehicle!.vehicle_type!;
  const finalDriver=newDriver?driverName:driver!.name;
  const finalPhone=newDriver?driverPhone:driver!.phone!;
  if(!["auto","weight","volume","equal"].includes(input.allocationMethod))throw new Error("成本分摊方式无效");
  const now=new Date().toISOString();
  const statements:D1PreparedStatement[]=[env.DB.prepare(`INSERT INTO settlement_commit_guards(id,valid,created_at)
    VALUES(?,(SELECT CASE WHEN approval_status='submitted' AND submitted_at IS NOT NULL AND carrier_id IS NULL AND status!='cancelled' THEN 1 ELSE NULL END
      FROM transport_batches WHERE organization_id=? AND id=?),?)`).bind(crypto.randomUUID(),current.organizationId,input.batchId,now)];
  if(newCarrier)statements.push(env.DB.prepare(`INSERT INTO carriers(id,organization_id,code,name,status,created_at,updated_at,carrier_scope)
    VALUES(?,?,?,?,'active',?,?,'overseas')`).bind(carrierId,current.organizationId,`carrier-${Date.now().toString(36)}-${carrierId.slice(0,6)}`,carrierName,now,now));
  if(newVehicle)statements.push(env.DB.prepare(`INSERT INTO carrier_vehicles(id,organization_id,carrier_id,plate_number,vehicle_type,status,created_at,updated_at)
    VALUES(?,?,?,?,?,'active',?,?)`).bind(vehicleId,current.organizationId,carrierId,plate,vehicleType,now,now));
  if(newDriver)statements.push(env.DB.prepare(`INSERT INTO carrier_drivers(id,organization_id,carrier_id,name,phone,status,created_at,updated_at)
    VALUES(?,?,?,?,?,'active',?,?)`).bind(driverId,current.organizationId,carrierId,driverName,driverPhone,now,now));
  statements.push(env.DB.prepare(`UPDATE transport_batches SET carrier_id=?,overseas_carrier_name=?,overseas_vehicle_type=?,overseas_vehicle_count=1,
    overseas_vehicle_plate=?,overseas_driver_name=?,overseas_driver_phone=?,updated_at=?
    WHERE organization_id=? AND id=? AND approval_status='submitted' AND submitted_at IS NOT NULL AND carrier_id IS NULL`)
    .bind(carrierId,name,finalType,finalPlate,finalDriver,finalPhone,now,current.organizationId,input.batchId));
  statements.push(env.DB.prepare(`INSERT INTO transport_batch_vehicles(id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,
    carrier_id,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at,vehicle_master_id,driver_master_id)
    VALUES(?,?,?,'MAIN-1',?,?,?,?,?,?,?,'planned',?,?,?,?)`)
    .bind(crypto.randomUUID(),current.organizationId,input.batchId,finalType,finalPlate,carrierId,finalDriver,finalPhone,
      vehicle?.capacity_weight_kg||0,vehicle?.capacity_volume_cbm||0,now,now,vehicleId,driverId));
  statements.push(env.DB.prepare(`INSERT INTO batch_dispatch_quotes(organization_id,batch_id,carrier_id,vehicle_id,driver_id,
    freight_amount,currency,exchange_rate,allocation_method,notes,created_by_user_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(current.organizationId,input.batchId,carrierId,vehicleId,driverId,
      input.freightAmount,input.currency,input.exchangeRate,input.allocationMethod,input.notes||null,current.userId,now));
  if(batch.operation_supervisor_user_id)statements.push(env.DB.prepare(`INSERT INTO internal_notifications
    (id,organization_id,user_id,category,severity,title,message,link,requires_ack,is_read,created_by_user_id,created_at)
    VALUES(?,?,?,'dispatch_request','info',?,?,?,0,0,?,?)`).bind(crypto.randomUUID(),current.organizationId,
      batch.operation_supervisor_user_id,`${batch.batch_number} 车辆已落实`,`商务已绑定 ${finalPlate}、${finalDriver}，请审核确认后交仓库装车。`,
      `/admin/loading/${input.batchId}`,current.userId,now));
  await env.DB.batch(statements);
  await synchronizeBatchTransport(current.organizationId,input.batchId,now).catch(error=>console.error("BATCH_DISPATCH_SYNC_PENDING",{batchId:input.batchId,error:String(error)}));
  return batch.batch_number;
}

export async function returnBatchVehicleToCommercial(input:{organizationId:string;batchId:string;batchNumber:string;actorUserId:string;reason:string}){
  const now=new Date().toISOString();
  const statements:D1PreparedStatement[]=[env.DB.prepare(`UPDATE transport_batches SET carrier_id=NULL,overseas_carrier_name=NULL,
    overseas_vehicle_type=NULL,overseas_vehicle_count=0,overseas_vehicle_plate=NULL,overseas_driver_name=NULL,
    overseas_driver_phone=NULL,updated_at=? WHERE organization_id=? AND id=? AND approval_status='submitted'
    AND submitted_at IS NOT NULL AND carrier_id IS NOT NULL AND status!='cancelled'`)
    .bind(now,input.organizationId,input.batchId),env.DB.prepare(`INSERT INTO settlement_commit_guards(id,valid,created_at)
      VALUES(?,(SELECT CASE WHEN carrier_id IS NULL AND updated_at=? THEN 1 ELSE NULL END FROM transport_batches WHERE organization_id=? AND id=?),?)`)
    .bind(crypto.randomUUID(),now,input.organizationId,input.batchId,now),env.DB.prepare(`DELETE FROM batch_dispatch_quotes WHERE organization_id=? AND batch_id=?`)
    .bind(input.organizationId,input.batchId),env.DB.prepare(`DELETE FROM transport_batch_vehicles WHERE organization_id=? AND batch_id=? AND status='planned'`)
    .bind(input.organizationId,input.batchId)];
  const policy=await loadBusinessProcessPolicy(input.organizationId,env.DB);
  if(!policyEnabled(policy,"dispatch.enabled"))throw new Error("商务找车功能已停用，不能退回重新找车");
  const positions=policyPositions(policy,"dispatch.handler_positions");
  let recipientCount=0;
  if(positions.length){
    const members=(await env.DB.prepare(`SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
      JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
      WHERE m.organization_id=? AND m.status='active' AND p.code IN (${positions.map(()=>"?").join(",")})`)
      .bind(input.organizationId,...positions).all<{user_id:string}>()).results;
    for(const member of members){
      const access=await loadActivePositionAccessProfile(env.DB,input.organizationId,member.user_id);
      if(!access?.permissions.includes("dispatch.manage")||!access.permissions.includes("dispatch.view"))continue;
      recipientCount++;
      statements.push(env.DB.prepare(`INSERT INTO internal_notifications
      (id,organization_id,user_id,category,severity,title,message,link,requires_ack,is_read,created_by_user_id,created_at)
      VALUES(?,?,?,'dispatch_request','warning',?,?,'/admin/dispatch',0,0,?,?)`)
      .bind(crypto.randomUUID(),input.organizationId,member.user_id,`${input.batchNumber} 找车资源需调整`,input.reason,input.actorUserId,now));
    }
  }
  if(!recipientCount)throw new Error("找车岗位没有同时具备查看和办理权限的有效账号，请先配置后再退回");
  try{const results=await env.DB.batch(statements);if(!Number(results[0]?.meta?.changes||0))throw new Error("配载资源状态已变化，请刷新页面");}
  catch(error){if(String(error).includes("NOT NULL"))throw new Error("配载资源状态已变化，请刷新页面");throw error;}
  await synchronizeBatchTransport(input.organizationId,input.batchId,now).catch(error=>console.error("BATCH_DISPATCH_RETURN_SYNC_PENDING",{batchId:input.batchId,error:String(error)}));
}
