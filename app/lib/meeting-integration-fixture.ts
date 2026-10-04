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
