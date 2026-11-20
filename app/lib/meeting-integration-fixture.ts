import { DatabaseSync } from "node:sqlite";
import { readdirSync,readFileSync } from "node:fs";
import { sqliteD1 } from "./sqlite-d1-test-helper";
import { accessModelBootstrapStatements } from "./access-model-seed.server";
import { loadActivePositionAccessProfile } from "./position-access-profile.server";
import type { SessionUser } from "./auth.server";
export async function meetingFixture() {
  const database=new DatabaseSync(":memory:"),root=new URL("../../migrations/",import.meta.url);
  for(const name of readdirSync(root).filter(name=>name.endsWith(".sql")).sort()) {
    try {database.exec(readFileSync(new URL(name,root),"utf8"));}catch(error){database.close();throw new Error(`${name}: ${String(error)}`);}
  }
  const db=sqliteD1(database),now="2026-09-01T00:00:00Z";
  database.prepare("INSERT INTO organizations(id,code,name,created_at,updated_at) VALUES('org','test','测试组织',?,?)").run(now,now);
  const people=[['owner','BOSS'],['sales','SALES'],['operation','OPERATION'],['supervisor','OPERATION_SUPERVISOR'],['cs','CS'],['finance','FINANCE_ACCOUNTING'],['commercial','BUSINESS_ROUTE'],['tracker','TRACKING'],['cashier','CASHIER'],['hr','HR_ADMIN']] as const;
  for(const [index,[id]] of people.entries())database.prepare("INSERT INTO users(id,email,password_hash,display_name,phone,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id,`${id}@test.local`,"not-a-login-hash",id,`138000000${String(index).padStart(2,"0")}`,now,now);
  await db.batch(accessModelBootstrapStatements(db,"org","owner",now));
  for(const [id,position] of people)database.prepare("INSERT INTO memberships(id,organization_id,user_id,department_id,position_id,created_at,updated_at) SELECT ?,'org',?,d.id,p.id,?,? FROM positions p JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code WHERE p.organization_id='org' AND p.code=?").run(`member:${id}`,id,now,now,position);
  database.prepare("INSERT INTO customers(id,organization_id,code,identity_code,name,sales_owner_user_id,created_at,updated_at) VALUES('customer','org','customer','TE5ST','测试客户','sales',?,?)").run(now,now);
  database.prepare(`INSERT INTO transport_orders(id,organization_id,order_number,customer_id,shipper_name,shipper_contact,shipper_phone,origin_country,origin_city,origin_address,consignee_name,destination_country,destination_city,destination_address,cargo_description,transport_mode,status,created_by_user_id,created_at,updated_at,business_type,salesperson_user_id,operation_supervisor_user_id,exit_port)
    VALUES('order','org','TEST-SO','customer','发货人','联系人','123','CN','深圳','工厂','收货人','RU','莫斯科','仓库','测试货','road','in_execution','sales',?,?,'ltl','sales','supervisor','test-port')`).run(now,now);
  for(const [code,actor] of [['costs','cs'],['transport','operation'],['assignment','supervisor'],['review','finance']])database.prepare("INSERT INTO order_module_instances(id,organization_id,order_id,module_code,module_name,assignee_user_id,created_at,updated_at) VALUES(?,'org','order',?,?,?, ?,?)").run(`module:${code}`,code,code,actor,now,now);
  const actors=new Map<string,SessionUser>();
  for(const [id] of people){const profile=await loadActivePositionAccessProfile(db,"org",id);if(!profile)throw new Error(`Missing test profile ${id}`);actors.set(id,{userId:id,organizationId:"org",sessionId:id,organizationName:"测试",email:`${id}@test.local`,displayName:id,site:"admin",positionCode:profile.positionCode,roleCodes:[profile.roleCode],departmentId:profile.departmentId,departmentCode:profile.departmentCode,dataScope:profile.dataScope,permissions:profile.permissions,warehouseIds:[],regionCountryCodes:[]});}
  return {database,db,actors,now};
}

/** Seed one physically complete OUL without weakening production completion gates. */
export function seedCompletedOrderTransport(
  fixture: Awaited<ReturnType<typeof meetingFixture>>,
  options: { batchId?: string; orderId?: string } = {},
) {
  const sql = fixture.database;
  const now = fixture.now;
  const batchId = options.batchId ?? "completed-transport-batch";
  const orderId = options.orderId ?? "order";
  const suffix = `${orderId}:${batchId}`;
  const warehouseId = `completed-transport-warehouse:${suffix}`;
  const shipmentId = `completed-transport-shipment:${suffix}`;
  const zoneId = `completed-transport-zone:${suffix}`;
  const locationId = `completed-transport-location:${suffix}`;
  const receiptId = `completed-transport-receipt:${suffix}`;
  const jobId = `completed-transport-job:${suffix}`;
  const inboundPackageId = `completed-transport-inbound-package:${suffix}`;
  const packageId = `completed-transport-package:${suffix}`;
  sql.prepare(
    "INSERT OR IGNORE INTO warehouses(id,organization_id,code,name,warehouse_role,created_at,updated_at) VALUES(?,'org',?,'测试国内仓','domestic_collection',?,?)",
  ).run(warehouseId, `W-${suffix}`, now, now);
  sql.prepare(
    "INSERT OR IGNORE INTO shipments(id,organization_id,shipment_number,order_id,customer_id,status,created_at,updated_at) VALUES(?,'org',?,?, 'customer','in_transit',?,?)",
  ).run(shipmentId, `SHIP-${suffix}`, orderId, now, now);
  sql.prepare(
    "INSERT OR IGNORE INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES(?,'org',?,'Z','测试收货区',?,?)",
  ).run(zoneId, warehouseId, now, now);
  sql.prepare(
    "INSERT OR IGNORE INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES(?,'org',?,?,'L','测试库位',?,?)",
  ).run(locationId, warehouseId, zoneId, now, now);
  sql.prepare(
    `INSERT OR IGNORE INTO warehouse_receipts(
      id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,status,
      total_packages,total_weight_kg,total_volume_cbm,cargo_complete,received_at,created_at,updated_at
    ) VALUES(?,'org',?,?,?,?,'completed',1,1,1,1,?,?,?)`,
  ).run(receiptId, `IN-${suffix}`, shipmentId, warehouseId, locationId, now, now, now);
  sql.prepare(
    `INSERT INTO warehouse_packing_jobs(
      id,organization_id,warehouse_id,order_id,shipment_id,packing_mode,
      source_package_count,outbound_package_count,total_weight_kg,total_volume_cbm,
      status,created_by_user_id,created_at,updated_at
    ) VALUES(?,'org',?,?,?,'preserve',1,1,1,1,'labelled','supervisor',?,?)`,
  ).run(jobId, warehouseId, orderId, shipmentId, now, now);
  const packingScope = sql.prepare(
    "SELECT id,organization_id,warehouse_id,order_id,shipment_id,status FROM warehouse_packing_jobs WHERE id=?",
  ).get(jobId);
  if (!packingScope) throw new Error(`completed transport packing job missing: ${jobId}`);
  const packingScopeValid = sql.prepare(
    `SELECT 1 ok FROM warehouse_packing_jobs job
     WHERE job.id=? AND job.organization_id='org' AND job.warehouse_id=?
       AND job.shipment_id=? AND job.status!='cancelled'`,
  ).get(jobId, warehouseId, shipmentId);
  if (!packingScopeValid) throw new Error(`completed transport packing scope invalid: ${JSON.stringify(packingScope)}`);
  sql.prepare(
    `INSERT INTO warehouse_packages(
      id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,
      pieces,weight_kg,volume_cbm,length_cm,width_cm,height_cm,label_kind,created_at,updated_at
    ) VALUES(?,'org',?,?,?,?,?,?,1,1,1,1,1,1,'inbound_mark',?,?)`,
  ).run(
    inboundPackageId,
    receiptId,
    shipmentId,
    warehouseId,
    locationId,
    `IN-${suffix}`,
    `IN-P-${suffix}`,
    now,
    now,
  );
  sql.prepare(
    `INSERT INTO warehouse_packing_job_sources(
      id,organization_id,packing_job_id,inbound_warehouse_package_id,created_at
    ) VALUES(?,'org',?,?,?)`,
  ).run(`completed-transport-source:${suffix}`, jobId, inboundPackageId, now);
  sql.prepare(
    `INSERT INTO warehouse_packages(
      id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,
      pieces,weight_kg,volume_cbm,length_cm,width_cm,height_cm,label_kind,packing_job_id,created_at,updated_at
    ) VALUES(?,'org',?,?,?,?,?,?,1,1,1,1,1,1,'oul',?,?,?)`,
  ).run(packageId, receiptId, shipmentId, warehouseId, locationId, `OUL-${suffix}`, `P-${suffix}`, jobId, now, now);
  sql.prepare(
    `INSERT OR IGNORE INTO transport_batches(
      id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,
      warehouse_id,status,road_status,actual_departure_at,created_by_user_id,created_at,updated_at
    ) VALUES(?,'org',?,?,?,'国内仓','境外仓',?,'arrived','overseas_arrived',?,'supervisor',?,?)`,
  ).run(batchId, orderId, `PZ-${suffix}`, `完成运输-${suffix}`, warehouseId, now, now, now);
  sql.prepare(
    `UPDATE transport_batches SET warehouse_id=?,status='arrived',road_status='overseas_arrived',
      actual_departure_at=COALESCE(actual_departure_at,?),updated_at=?
      WHERE id=? AND organization_id='org'`,
  ).run(warehouseId, now, now, batchId);
  sql.prepare(
    `INSERT OR IGNORE INTO transport_batch_orders(
      id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at
    ) VALUES(?,'org',?,?,1,'arrived','supervisor',?,?)`,
  ).run(`completed-transport-membership:${suffix}`, batchId, orderId, now, now);
  sql.prepare(
    `INSERT OR IGNORE INTO transport_batch_packages(
      id,organization_id,batch_id,order_id,packing_job_id,package_id,sequence_no,status,
      added_by_user_id,created_at,updated_at
    ) VALUES(?,'org',?,?,?,?,1,'planned','supervisor',?,?)`,
  ).run(`completed-transport-map:${suffix}`, batchId, orderId, jobId, packageId, now, now);
  sql.prepare(
    "UPDATE transport_batch_packages SET status='arrived',updated_at=? WHERE organization_id='org' AND batch_id=? AND package_id=?",
  ).run(now, batchId, packageId);
  sql.prepare("UPDATE warehouse_packing_jobs SET status='allocated',updated_at=? WHERE id=?").run(now, jobId);
  sql.prepare("UPDATE warehouse_packing_jobs SET status='loading',updated_at=? WHERE id=?").run(now, jobId);
  sql.prepare("UPDATE warehouse_packing_jobs SET status='dispatched',updated_at=? WHERE id=?").run(now, jobId);
  sql.prepare(
    "UPDATE warehouse_packages SET status='dispatched',lifecycle_status='overseas_received',updated_at=? WHERE organization_id='org' AND id=?",
  ).run(now, packageId);
}

export function seedFrozenMeetingWorkflow(fixture:Awaited<ReturnType<typeof meetingFixture>>) {
  const sql=fixture.database,now=fixture.now;
  sql.prepare("INSERT INTO workflow_definitions(id,organization_id,code,name,created_at,updated_at) VALUES('wf','org','test-flow','测试流程',?,?)").run(now,now);
  for(const [key,sort] of [['order_creation',20],['reconciliation',100]] as const){
    sql.prepare("INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,created_at,updated_at) VALUES(?,'wf',?,?,'order',?,?,?,?)").run(`step:${key}`,key,key,`${key}.test`,sort,now,now);
    sql.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES(?,'wf',?,'costs','费用',?,?)").run(`placement:${key}`,`step:${key}`,now,now);
  }
  sql.prepare("INSERT INTO workflow_instances(id,organization_id,workflow_id,customer_id,order_id,current_step_key,started_at,updated_at) VALUES('instance','org','wf','customer','order','reconciliation',?,?)").run(now,now);
  sql.exec("UPDATE transport_orders SET workflow_instance_id='instance' WHERE id='order'");
  for(const [key,sort] of [['order_creation',20],['reconciliation',100]] as const){
    sql.prepare("INSERT INTO workflow_instance_step_states(id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,updated_at) VALUES(?,'instance','wf',?,?,?,?,?,?)").run(`state:${key}`,`step:${key}`,key,key,sort,key==='order_creation'?'completed':'active',now);
    sql.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,updated_at) VALUES(?,?,?,'costs','费用',10,1,'all_tasks',?)").run(`module-state:${key}`,`state:${key}`,`placement:${key}`,now);
    for(const field of ['customer_service_confirmation','business_review','finance_review'])sql.prepare("INSERT INTO workflow_instance_fields(id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,is_active,created_at) VALUES(?,'instance','wf',?,'costs',?,?,'text',1,1,?)").run(`field:${key}:${field}`,key,field,field,now);
  }
}
