import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {env} from "cloudflare:workers";
import {meetingFixture} from "./meeting-integration-fixture";
import {loadOrderIntakeChanges,requestOrderIntakeChange,reviewOrderIntakeChange} from "./order-intake-changes.server";
vi.mock("cloudflare:workers",()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{fixture=await meetingFixture();Object.assign(env,{DB:fixture.db});});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
const actor=(key:string)=>fixture.actors.get(key)!;
function proposal(){const form=new FormData();form.set("version",fixture.now);form.set("requestKey",crypto.randomUUID());form.set("changeReason","按原始委托核对承运计划");form.set("intake_headCarrier","核实后的头程承运人");return form;}
const apply=(form=proposal(),who="operation")=>requestOrderIntakeChange(actor(who),"order",form);
function decision(value="approved"){const form=new FormData();form.set("changeId",String(fixture.database.prepare("SELECT id FROM order_intake_change_requests WHERE status='pending'").get()?.id));form.set("decision",value);form.set("reviewNotes","已核对客户原始委托与承运计划");return form;}
const review=(form=decision(),who="supervisor")=>reviewOrderIntakeChange(actor(who),"order",form);
const facts=()=>fixture.database.prepare("SELECT status,current_step_code,intake_operations_json,gross_weight_kg,volume_cbm FROM transport_orders WHERE id='order'").get();
describe("review-before-apply intake corrections",()=>{
  it("records a proposal without changing facts, then applies only after an assigned supervisor review",async()=>{
    const before=facts(),counts=['business_expenses','order_tasks','order_cargo_packages'].map(table=>fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get());
    await apply();expect(facts()).toEqual(before);
    expect(fixture.database.prepare("SELECT changes_json FROM order_intake_change_requests").get()?.changes_json).toBe(JSON.stringify([{label:'头程承运人',before:'未记录',after:'核实后的头程承运人'}]));
    const form=decision();await review(form);
    expect(JSON.parse(String(facts()?.intake_operations_json))).toEqual({headCarrier:'核实后的头程承运人'});
    expect(facts()).toMatchObject({status:before?.status,current_step_code:before?.current_step_code,gross_weight_kg:before?.gross_weight_kg,volume_cbm:before?.volume_cbm});
    expect(['business_expenses','order_tasks','order_cargo_packages'].map(table=>fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get())).toEqual(counts);
    expect(await review(form)).toMatchObject({success:expect.stringContaining('无需重复')});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.intake.change.approved'").get()?.n).toBe(1);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM internal_notifications WHERE category='order_intake_change' AND link LIKE '/admin/orders/order%'").get()?.n).toBeGreaterThanOrEqual(2);
  });
  it("allows the boss to request and review in the same order without bypassing source checks",async()=>{await apply(proposal(),'owner');await review(decision(),'owner');expect((await loadOrderIntakeChanges(actor('owner'),'order')).requests[0].status).toBe('approved');});
  it("deduplicates an identical retry and rejects changed content or a second pending proposal",async()=>{
    const form=proposal();await apply(form);expect(await apply(form)).toMatchObject({success:expect.stringContaining('无需重复')});
    form.set('intake_headCarrier','改变重试内容');await expect(apply(form)).rejects.toThrow('内容已改变');
    await expect(apply(proposal())).rejects.toThrow('已有待复核');
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_intake_change_requests').get()?.n).toBe(1);
  });
  it.each(['rejected','withdrawn'])('keeps original facts after %s and frees the pending slot',async value=>{
    const before=facts();await apply();await review(decision(value),value==='withdrawn'?'operation':'supervisor');expect(facts()).toEqual(before);
    expect(fixture.database.prepare('SELECT status,pending_order_id FROM order_intake_change_requests').get()).toEqual({status:value,pending_order_id:null});await apply();
  });
  it.each(['finance','cashier','tracker','commercial','hr'])('does not give %s intake write or review authority',async who=>{await expect(apply(proposal(),who)).rejects.toThrow();await apply();await expect(review(decision(),who)).rejects.toThrow();});
  it('does not trust a forged boss session or an unassigned supervisor',async()=>{
    await expect(requestOrderIntakeChange({...actor('finance'),positionCode:'BOSS',roleCodes:['boss']},'order',proposal())).rejects.toThrow();
    await apply();fixture.database.exec("UPDATE transport_orders SET operation_supervisor_user_id=NULL;UPDATE order_module_instances SET assignee_user_id=NULL WHERE assignee_user_id='supervisor'");
    await expect(review()).rejects.toThrow();
  });
  it('rejects stale source but keeps a rejection/withdrawal route available',async()=>{
    await apply();fixture.database.exec(`UPDATE transport_orders SET intake_operations_json='{"headCarrier":"其他窗口已核实"}'`);
    await expect(review()).rejects.toThrow('原资料已');await review(decision('rejected'));expect(JSON.parse(String(facts()?.intake_operations_json)).headCarrier).toBe('其他窗口已核实');
  });
  it('rejects clearing recorded fields, reversed dates or entrusted-service changes',async()=>{
    fixture.database.exec(`UPDATE transport_orders SET intake_operations_json='{"headCarrier":"原承运计划"}'`);
    const empty=proposal();empty.set('intake_headCarrier','');await expect(apply(empty)).rejects.toThrow('不能留空');
    const time=proposal();time.set('intake_plannedDeparture','2026-11-20T09:00');time.set('intake_plannedArrival','2026-11-19T09:00');await expect(apply(time)).rejects.toThrow('不得早于');
    const service=proposal();service.set('intake_entrustedServices','packing');await expect(apply(service)).rejects.toThrow('独立受控');
  });
  it('does not overwrite an actual transport arrangement created while the request waits',async()=>{
    await apply();fixture.database.prepare("INSERT INTO order_transport_assignments(id,organization_id,order_id,leg_type,status,created_at,updated_at) VALUES('actual','org','order','first_mile','planned',?,?)").run(fixture.now,fixture.now);
    await expect(review()).rejects.toThrow('实际运输安排');expect(facts()?.intake_operations_json).toBe(null);await review(decision('rejected'));
  });
  it.each(['actor','policy','source','assignment','audit'])('rolls back approval and history when %s changes or fails at commit',async change=>{
    await apply();const form=decision(),original=fixture.db.batch.bind(fixture.db);
    vi.spyOn(fixture.db,'batch').mockImplementationOnce(async statements=>{
      if(change==='actor')fixture.database.exec("UPDATE users SET status='disabled' WHERE id='supervisor'");
      if(change==='policy')fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_by_user_id,updated_at) VALUES('org','order.approve_positions','FINANCE_ACCOUNTING','owner',?)").run(fixture.now);
      if(change==='source')fixture.database.exec("UPDATE transport_orders SET domestic_agent='其他代理'");
      if(change==='assignment')fixture.database.prepare("INSERT INTO order_transport_assignments(id,organization_id,order_id,leg_type,created_at,updated_at) VALUES('actual','org','order','first_mile',?,?)").run(fixture.now,fixture.now);
      if(change==='audit')fixture.database.exec("CREATE TRIGGER fail_change_audit BEFORE INSERT ON audit_logs WHEN NEW.action='order.intake.change.approved' BEGIN SELECT RAISE(ABORT,'simulated audit failure');END");
      return original(statements);
    });
    await expect(review(form)).rejects.toThrow();expect(facts()?.intake_operations_json).toBe(null);
    expect(fixture.database.prepare('SELECT status FROM order_intake_change_requests').get()?.status).toBe('pending');
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.intake.change.approved'").get()?.n).toBe(0);
  });
  it.each(['completed','cancelled'])('does not reopen %s orders for corrections',async status=>{fixture.database.prepare('UPDATE transport_orders SET status=?').run(status);await expect(apply(proposal(),'owner')).rejects.toThrow('终结');});
  it.each(['completed','cancelled'])('can close an unapplied pending proposal on a %s order without reopening facts',async status=>{
    await apply();fixture.database.prepare('UPDATE transport_orders SET status=?').run(status);
    const pending=decision();await expect(review(pending)).rejects.toThrow('终结');
    expect(await loadOrderIntakeChanges(actor('supervisor'),'order')).toMatchObject({canReview:false,canReject:true});
    pending.set('decision','rejected');await review(pending);
    expect(facts()?.status).toBe(status);expect(facts()?.intake_operations_json).toBe(null);
    expect(fixture.database.prepare('SELECT status,pending_order_id FROM order_intake_change_requests').get()).toEqual({status:'rejected',pending_order_id:null});
  });
  it('does not create a request which only an inactive or unauthorized reviewer could handle',async()=>{
    fixture.database.exec("UPDATE users SET status='disabled' WHERE id='supervisor'");
    await expect(apply()).rejects.toThrow('尚无配置');expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_intake_change_requests').get()?.n).toBe(0);
  });
});
