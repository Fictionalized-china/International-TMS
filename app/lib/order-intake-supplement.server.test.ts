import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {meetingFixture} from "./meeting-integration-fixture";
import {loadOrderIntakeSupplement,saveOrderIntakeSupplement,supplementMissingOrderServices} from "./order-intake-supplement.server";
vi.mock("cloudflare:workers",()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{fixture=await meetingFixture();Object.assign(env,{DB:fixture.db});});
afterEach(()=>fixture?.database.close());
function body(){const form=new FormData();form.set("version",fixture.now);form.set("reason","核对原始委托后补录");form.set("intake_headCarrier","原委托头程承运人");return form;}
const save=(form=body(),actor="operation")=>saveOrderIntakeSupplement(fixture.actors.get(actor)!,"order",form);
describe("missing-only order intake remediation",()=>{
  function services(codes=['pickup']){const form=body();form.set('serviceReason','对照原始委托核实服务');for(const code of codes)form.append('missingServiceCode',code);return form;}
  it('repairs absent historical services without altering frozen modules, stock or money',async()=>{
    const modules=fixture.database.prepare('SELECT * FROM order_module_instances ORDER BY id').all();
    expect((await loadOrderIntakeSupplement(fixture.actors.get('owner')!,'order')).servicesMissing).toBe(true);
    await supplementMissingOrderServices(fixture.actors.get('operation')!,'order',services());
    expect(fixture.database.prepare('SELECT service_code,service_name FROM order_services').get()).toEqual({service_code:'pickup',service_name:'提货'});
    expect(fixture.database.prepare('SELECT * FROM order_module_instances ORDER BY id').all()).toEqual(modules);
    expect((await loadOrderIntakeSupplement(fixture.actors.get('owner')!,'order')).servicesMissing).toBe(false);
    const repeated=services();repeated.set('version',String(fixture.database.prepare("SELECT updated_at FROM transport_orders WHERE id='order'").get()?.updated_at));
    await expect(supplementMissingOrderServices(fixture.actors.get('owner')!,'order',repeated)).rejects.toThrow('已有委托服务');
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM business_expenses').get()?.n).toBe(0);
  });
  it('does not activate missing customs/overseas branches by changing service facts',async()=>{
    await expect(supplementMissingOrderServices(fixture.actors.get('owner')!,'order',services(['customs']))).rejects.toThrow('未启用');
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_services').get()?.n).toBe(0);
  });
  it.each(['authority','responsible','competing-services'])('rolls back historical service remediation after %s changes',async change=>{
    const original=fixture.db.batch.bind(fixture.db);vi.spyOn(fixture.db,'batch').mockImplementationOnce(async statements=>{
      if(change==='authority')fixture.database.exec("UPDATE users SET status='disabled' WHERE id='operation'");
      if(change==='responsible')fixture.database.exec("UPDATE order_module_instances SET assignee_user_id=NULL WHERE assignee_user_id='operation'");
      if(change==='competing-services')fixture.database.prepare("INSERT INTO order_services(id,organization_id,order_id,service_code,service_name,created_at) VALUES('other','org','order','other','其他服务',?)").run(fixture.now);
      return original(statements);
    });
    try{await expect(supplementMissingOrderServices(fixture.actors.get('operation')!,'order',services())).rejects.toThrow('本次未保存');}finally{vi.restoreAllMocks();}
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_services WHERE service_code='pickup'").get()?.n).toBe(0);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.intake.services.supplement'").get()?.n).toBe(0);
  });
  it("does not invent supplemental facts from the empty controls of a partially filled form",async()=>{
    const form=body();for(const key of["tailCarrier","headVehicleCount","tailVehicleCount","plannedDeparture","plannedArrival","businessAssistant","customerService"])form.set(`intake_${key}`,"");
    expect(await save(form)).toMatchObject({success:expect.stringContaining("已补录 1 项")});
    const row=fixture.database.prepare("SELECT intake_operations_json FROM transport_orders WHERE id='order'").get()as{intake_operations_json:string};expect(JSON.parse(row.intake_operations_json)).toEqual({headCarrier:"原委托头程承运人",canonicalSupplementVersion:1});
  });
  it("preserves attribution when only the historical commercial name remains",async()=>{
    fixture.database.exec("UPDATE transport_orders SET quote_commercial_name_snapshot='历史报价人' WHERE id='order'");
    expect((await loadOrderIntakeSupplement(fixture.actors.get("owner")!,"order")).missing).not.toContain("报价商务");
    const form=body();form.set("quoteCommercialUserId","commercial");await expect(save(form,"owner")).rejects.toThrow("已有归属");
  });
  it.each(["person","policy","reference"])("rejects newly selected %s becoming invalid before commit",async change=>{
    const form=body();form.set("quoteCommercialUserId","commercial");
    fixture.database.prepare("INSERT INTO reference_data(id,organization_id,category,code,name,created_at,updated_at) VALUES('ref','org','customs_place','PORT','清关地',?,?)").run(fixture.now,fixture.now);form.set("customsLocation","PORT");
    const original=fixture.db.batch.bind(fixture.db);const spy=vi.spyOn(fixture.db,"batch").mockImplementationOnce(async statements=>{
      if(change==="person")fixture.database.exec("UPDATE users SET status='disabled' WHERE id='commercial'");
      if(change==="policy")fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_by_user_id,updated_at) VALUES('org','order.quote_commercial_positions','OPERATION','owner',?)").run(fixture.now);
      if(change==="reference")fixture.database.exec("UPDATE reference_data SET status='disabled' WHERE id='ref'");
      return original(statements);
    });
    try{await expect(save(form,"owner")).rejects.toThrow("本次未保存");}finally{spy.mockRestore();}
    expect(fixture.database.prepare("SELECT intake_operations_json,quote_commercial_user_id,customs_location FROM transport_orders WHERE id='order'").get()).toMatchObject({intake_operations_json:null,quote_commercial_user_id:null,customs_location:null});
  });
  it("allows the assigned operator to save a partial supplement, preserving business facts and recording why",async()=>{
    const before=fixture.database.prepare("SELECT status,current_step_code,quotation_id,ro_agent FROM transport_orders WHERE id='order'").get();
    const counts=["order_tasks","business_expenses","order_services","order_cargo_packages"].map(table=>fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get());
    expect(await save()).toMatchObject({success:expect.stringContaining("已补录 1 项")});
    expect(fixture.database.prepare("SELECT status,current_step_code,quotation_id,ro_agent FROM transport_orders WHERE id='order'").get()).toEqual(before);
    expect(["order_tasks","business_expenses","order_services","order_cargo_packages"].map(table=>fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get())).toEqual(counts);
    expect(await loadOrderIntakeSupplement(fixture.actors.get("operation")!,"order")).toMatchObject({canEdit:true,operationKeys:expect.not.arrayContaining(["headCarrier"])});
    const audit=fixture.database.prepare("SELECT metadata_json FROM audit_logs WHERE action='order.intake.supplement'").get()as{metadata_json:string};expect(JSON.parse(audit.metadata_json)).toMatchObject({reason:"核对原始委托后补录",changes:[{field:"头程承运人",before:null,after:"原委托头程承运人"}]});
    expect(await save()).toMatchObject({success:expect.stringContaining("无需重复")});expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.intake.supplement'").get()).toMatchObject({n:1});
  });
  it.each(["owner","sales","supervisor","cs"])("allows responsible %s or boss, without guessing a commercial",async actor=>{
    expect(await save(body(),actor)).toMatchObject({success:expect.any(String)});
    expect(fixture.database.prepare("SELECT quote_commercial_user_id FROM transport_orders WHERE id='order'").get()).toMatchObject({quote_commercial_user_id:null});
  });
  it.each(["finance","cashier","tracker","commercial","hr"])("does not turn %s read authority into intake editing",async actor=>{await expect(save(body(),actor)).rejects.toThrow();});
  it("uses live profile and denies a forged boss role on an ordinary session",async()=>{
    await expect(saveOrderIntakeSupplement({...fixture.actors.get("finance")!,roleCodes:["boss"],positionCode:"BOSS"},"order",body())).rejects.toThrow("不是本单");
  });
  it("does not modify an already populated route, plan, commercial or service selection",async()=>{
    const route=body();route.set("exitPort","different");await expect(save(route)).rejects.toThrow();
    await save();const changed=body();changed.set("intake_headCarrier","覆盖计划");await expect(save(changed)).rejects.toThrow("只补缺项");
    const services=body();services.set("intake_entrustedServices","packing");await expect(save(services)).rejects.toThrow("流程分支");
  });
  it.each(["cancelled","completed"])("keeps %s orders closed",async status=>{fixture.database.prepare("UPDATE transport_orders SET status=? WHERE id='order'").run(status);await expect(save(body(),"owner")).rejects.toThrow("终结");});
  it("rejects stale windows before any material update",async()=>{
    fixture.database.exec("UPDATE transport_orders SET updated_at='other-version' WHERE id='order'");await expect(save()).rejects.toThrow("其他窗口");expect(fixture.database.prepare("SELECT intake_operations_json FROM transport_orders WHERE id='order'").get()).toMatchObject({intake_operations_json:null});
  });
  it.each(["permission","assignment","version"])("rechecks %s within the transaction and rolls back audit and changes",async change=>{
    const original=fixture.db.batch.bind(fixture.db);const spy=vi.spyOn(fixture.db,"batch").mockImplementationOnce(async statements=>{
      if(change==="permission")fixture.database.exec("DELETE FROM role_permissions WHERE permission_code='order.manage' AND role_id='org:role:pos_operation'");
      if(change==="assignment")fixture.database.exec("UPDATE order_module_instances SET assignee_user_id=NULL WHERE assignee_user_id='operation'");
      if(change==="version")fixture.database.exec("UPDATE transport_orders SET updated_at='concurrent-version' WHERE id='order'");
      return original(statements);
    });
    try{await expect(save()).rejects.toThrow("本次未保存");}finally{spy.mockRestore();}
    expect(fixture.database.prepare("SELECT intake_operations_json FROM transport_orders WHERE id='order'").get()).toMatchObject({intake_operations_json:null});expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.intake.supplement'").get()).toMatchObject({n:0});
  });
});
