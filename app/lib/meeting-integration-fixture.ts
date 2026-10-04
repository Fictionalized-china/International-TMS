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
