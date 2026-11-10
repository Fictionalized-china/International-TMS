import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {meetingFixture,seedFrozenMeetingWorkflow} from "./meeting-integration-fixture";
import {createOrderWorkflowFieldReader,loadOrderModuleWorkflowFields} from "./workflow-fields.server";
vi.mock("cloudflare:workers",()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{
  fixture=await meetingFixture();Object.assign(env,{DB:fixture.db});seedFrozenMeetingWorkflow(fixture);
  fixture.database.prepare(`INSERT INTO quotations(id,organization_id,quote_number,customer_id,origin_country,origin_city,destination_country,destination_city,transport_mode,cargo_description,created_at,updated_at,exit_port,intake_operations_json)
    VALUES('quote','org','Q-1','customer','CN','旧起点','RU','旧目的地','ROAD','旧货物',?,?,'OLD',?)`).run(fixture.now,fixture.now,JSON.stringify({headCarrier:"旧报价计划",headVehicleCount:1}));
  fixture.database.exec("UPDATE transport_orders SET quotation_id='quote',exit_port=NULL WHERE id='order'");
});
afterEach(()=>fixture?.database.close());
function addField(key:string,module="consignment"){
  fixture.database.prepare(`INSERT INTO workflow_instance_fields(id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,is_active,created_at)
    VALUES(?,'instance','wf','order_creation',?,?,?,'text',1,1,?)`).run(key,module,key,key,fixture.now);
}
async function present(key:string,module="consignment"){return(await loadOrderModuleWorkflowFields("org","order",module as "consignment"|"cargo"|"costs")).find(field=>field.fieldKey===key)?.present;}
describe("order-owned intake facts in frozen fields",()=>{
  it("uses corrected order facts, never stale quote values or null coalescing back to the quote",async()=>{
    addField("quotation_exit_port");addField("quotation_intake_headCarrier");
    expect(await present("quotation_exit_port")).toBe(false);
    fixture.database.prepare("UPDATE transport_orders SET exit_port='NEW',intake_operations_json=? WHERE id='order'").run(JSON.stringify({headCarrier:"订单已补计划"}));
    expect(await present("quotation_exit_port")).toBe(true);expect(await present("quotation_intake_headCarrier")).toBe(true);
    fixture.database.exec("UPDATE transport_orders SET intake_operations_json=NULL WHERE id='order'");
    expect(await present("quotation_intake_headCarrier")).toBe(false);
    expect(fixture.database.prepare("SELECT exit_port FROM quotations WHERE id='quote'").get()).toMatchObject({exit_port:"OLD"});
  });
  it("can read independent legacy orders without any source quotation",async()=>{
    addField("quotation_quote_commercial_user_id");fixture.database.exec("UPDATE transport_orders SET quotation_id=NULL,quote_commercial_user_id='commercial' WHERE id='order'");
    expect(await present("quotation_quote_commercial_user_id")).toBe(true);
  });
  it("checks every actual cargo line rather than the source quotation or order totals, preserving explicit zero volume",async()=>{
    addField("quotation_cargo_description","cargo");addField("quotation_volume_cbm","cargo");
    for(const [index,[id,name,volume]]of ([["cargo1","货物甲",0],["cargo2","",0]]as const).entries())fixture.database.prepare(`INSERT INTO order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,volume_per_package_cbm,created_at,updated_at) VALUES(?,'org','order',?,?,'carton',1,1,10,?,?,?)`).run(id,index+1,name,volume,fixture.now,fixture.now);
    expect(await present("quotation_cargo_description","cargo")).toBe(false);expect(await present("quotation_volume_cbm","cargo")).toBe(true);
    fixture.database.exec("UPDATE order_cargo_items SET cargo_name_cn='货物乙',volume_per_package_cbm=0.0000001 WHERE id='cargo2'");
    expect(await present("quotation_cargo_description","cargo")).toBe(true);expect(await present("quotation_volume_cbm","cargo")).toBe(true);
  });
  it("only reuses current facts within an explicitly write-free reader, not across separate reads",async()=>{
    addField("quotation_exit_port");fixture.database.exec("UPDATE transport_orders SET exit_port='CURRENT' WHERE id='order'");
    const read=createOrderWorkflowFieldReader("org","order");expect((await read("consignment")).find(field=>field.fieldKey==="quotation_exit_port")?.present).toBe(true);
    fixture.database.exec("UPDATE transport_orders SET exit_port=NULL WHERE id='order'");
    expect(await present("quotation_exit_port")).toBe(false);
  });
  it("validates current order receivables, not old quotation charges, including explicit zero",async()=>{
    addField("quotation_charge_items","costs");
    fixture.database.prepare("INSERT INTO quotation_charges(id,quotation_id,charge_code,description,quantity,unit_price,amount,created_at) VALUES('q-charge','quote','freight','旧报价费用',1,100,100,?)").run(fixture.now);
    expect(await present("quotation_charge_items","costs")).toBe(false);
    fixture.database.prepare(`INSERT INTO business_expenses(id,organization_id,order_id,direction,stage,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,base_amount,created_by_user_id,created_at,updated_at)
      VALUES('expense','org','order','receivable','estimated','freight','当前费用','测试客户','CNY',1,0,0,1,0,'sales',?,?)`).run(fixture.now,fixture.now);
    expect(await present("quotation_charge_items","costs")).toBe(true);
    fixture.database.exec("UPDATE business_expenses SET currency='' WHERE id='expense'");expect(await present("quotation_charge_items","costs")).toBe(false);
    fixture.database.exec("UPDATE business_expenses SET currency='CNY',stage='cancelled' WHERE id='expense'");expect(await present("quotation_charge_items","costs")).toBe(false);
  });
  it("checks actual entrusted services instead of a now-obsolete planned selection",async()=>{
    addField("quotation_intake_entrustedServices");fixture.database.prepare("UPDATE transport_orders SET intake_operations_json=? WHERE id='order'").run(JSON.stringify({entrustedServices:["pickup"]}));
    expect(await present("quotation_intake_entrustedServices")).toBe(false);
    fixture.database.prepare("INSERT INTO order_services(id,organization_id,order_id,service_code,service_name,created_at) VALUES('pickup','org','order','pickup','提货',?)").run(fixture.now);
    expect(await present("quotation_intake_entrustedServices")).toBe(true);
    fixture.database.exec("DELETE FROM order_services WHERE id='pickup'");expect(await present("quotation_intake_entrustedServices")).toBe(false);
  });
});
