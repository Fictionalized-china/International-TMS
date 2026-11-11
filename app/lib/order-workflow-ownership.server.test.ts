import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture, seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
import { executeOrderWorkflowAction, validateOrderWorkflowAction } from "./order-workflow.server";
import { orderDocumentSupplementNotificationStatement } from "./internal-notifications.server";
vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); Object.assign(env, { DB: fixture.db });
  seedFrozenMeetingWorkflow(fixture);
  fixture.database.prepare("INSERT INTO users(id,email,password_hash,display_name,phone,created_at,updated_at) VALUES('former-sales','former@test.local','not-a-login-hash','原业务员','13900000019',?,?)").run(fixture.now, fixture.now);
  fixture.database.prepare("INSERT INTO memberships(id,organization_id,user_id,department_id,position_id,created_at,updated_at) SELECT 'member:former','org','former-sales',department_id,position_id,?,? FROM memberships WHERE user_id='sales'").run(fixture.now, fixture.now);
  fixture.database.prepare(`INSERT INTO quotations(id,organization_id,quote_number,customer_id,salesperson_user_id,origin_country,origin_city,destination_country,destination_city,transport_mode,cargo_description,created_at,updated_at) VALUES('quote','org','Q-HISTORY','customer','former-sales','CN','深圳','RU','莫斯科','ROAD','来源货物',?,?)`).run(fixture.now, fixture.now);
  fixture.database.exec("UPDATE transport_orders SET status='draft',quotation_id='quote',current_step_code='order_creation',salesperson_user_id='sales' WHERE id='order'");
  fixture.database.prepare(`INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,created_at,updated_at) VALUES('cancel','org','cancel_draft','取消草稿','draft','cancelled','cancelled','已取消',0,?,?)`).run(fixture.now, fixture.now);
});
afterEach(() => fixture?.database.close());
const check = (actorUserId: string) => validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId, actionCode: "cancel_draft" });
describe("current order owner is authoritative after quote conversion", () => {
  it.each(["owner", "sales"])("preserves normal draft correction/cancellation for %s", async actorUserId => {
    expect(await executeOrderWorkflowAction({organizationId:"org",orderId:"order",actorUserId,actionCode:"cancel_draft"})).toMatchObject({toStatus:"cancelled"});
  });
  it.each([
    ["account", "UPDATE users SET status='disabled' WHERE id='sales'"],
    ["membership", "UPDATE memberships SET status='disabled' WHERE user_id='sales'"],
    ["department", "UPDATE departments SET status='disabled' WHERE id=(SELECT department_id FROM memberships WHERE user_id='sales')"],
    ["position", "UPDATE positions SET status='disabled' WHERE organization_id='org' AND code='SALES'"],
    ["role", "UPDATE roles SET status='disabled' WHERE organization_id='org' AND code='pos_sales'"],
    ["view permission", "DELETE FROM role_permissions WHERE role_id='org:role:pos_sales' AND permission_code='order.view'"],
    ["intake permission", "DELETE FROM role_permissions WHERE role_id='org:role:pos_sales' AND permission_code='order.intake.manage'"],
    ["current owner", "UPDATE transport_orders SET salesperson_user_id='former-sales' WHERE id='order'"],
    ["workflow transition", "UPDATE order_workflow_transitions SET is_active=0 WHERE id='cancel'"],
    ["configured position", "INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_by_user_id,updated_at) VALUES('org','order.submit_positions','CS','owner','changed')"],
  ])("rejects %s changing after preflight, without committing history or caller side effects", async (_label, change) => {
    const original=fixture.db.batch.bind(fixture.db);
    const spy=vi.spyOn(fixture.db,"batch").mockImplementationOnce(async statements=>{fixture.database.exec(change);return original(statements);});
    try{
      await expect(executeOrderWorkflowAction({organizationId:"org",orderId:"order",actorUserId:"sales",actionCode:"cancel_draft",atomicStatements:[fixture.db.prepare("UPDATE customers SET name='must-not-commit' WHERE id='customer'")]})).rejects.toThrow("本次未提交");
    }finally{spy.mockRestore();}
    expect(fixture.database.prepare("SELECT status,current_step_code FROM transport_orders WHERE id='order'").get()).toEqual({status:"draft",current_step_code:"order_creation"});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_workflow_history WHERE order_id='order'").get()).toEqual({n:0});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM mutation_commit_guards").get()).toEqual({n:0});
    expect(fixture.database.prepare("SELECT name FROM customers WHERE id='customer'").get()).toEqual({name:"测试客户"});
    if(_label==="account"){
      fixture.database.exec("UPDATE users SET status='active' WHERE id='sales'");
      expect(await executeOrderWorkflowAction({organizationId:"org",orderId:"order",actorUserId:"sales",actionCode:"cancel_draft"})).toMatchObject({toStatus:"cancelled"});
    }
  });
  it("does not reuse boss authority after a concurrent position downgrade", async()=>{
    const original=fixture.db.batch.bind(fixture.db);
    const spy=vi.spyOn(fixture.db,"batch").mockImplementationOnce(async statements=>{
      fixture.database.exec("UPDATE memberships SET department_id=(SELECT department_id FROM memberships WHERE user_id='sales'),position_id=(SELECT position_id FROM memberships WHERE user_id='sales') WHERE user_id='owner'");
      return original(statements);
    });
    try{await expect(executeOrderWorkflowAction({organizationId:"org",orderId:"order",actorUserId:"owner",actionCode:"cancel_draft"})).rejects.toThrow("本次未提交");}finally{spy.mockRestore();}
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()).toEqual({status:"draft"});
  });
  it("does not block a valid action for an unrelated hot-plug policy change", async()=>{
    const original=fixture.db.batch.bind(fixture.db);
    const spy=vi.spyOn(fixture.db,"batch").mockImplementationOnce(async statements=>{
      fixture.database.exec("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_by_user_id,updated_at) VALUES('org','order.default_tail_carrier','另一个新单默认计划','owner','changed')");
      return original(statements);
    });
    try{expect(await executeOrderWorkflowAction({organizationId:"org",orderId:"order",actorUserId:"sales",actionCode:"cancel_draft"})).toMatchObject({toStatus:"cancelled"});}finally{spy.mockRestore();}
  });
  it("refuses a configured action when its current actor no longer has order view permission",async()=>{
    fixture.database.exec("DELETE FROM role_permissions WHERE role_id='org:role:pos_sales' AND permission_code='order.view'");
    expect(await check("sales")).toMatchObject({ok:false,reason:expect.stringContaining("查看权限已撤销")});
  });
  it("permits the current salesperson, not the stale source quote salesperson", async () => {
    expect(await check("sales")).toMatchObject({ ok: true });
    expect(await check("former-sales")).toMatchObject({ ok: false });
  });
  it("does not restore a deliberately unassigned owner from the source quote", async () => {
    fixture.database.exec("UPDATE transport_orders SET salesperson_user_id=NULL WHERE id='order'");
    expect(await check("former-sales")).toMatchObject({ ok: false });
    expect(await check("owner")).toMatchObject({ ok: true });
  });
  it("sends a missing-document notice to the current owner only", async () => {
    await orderDocumentSupplementNotificationStatement(fixture.db, { organizationId: "org", orderId: "order", fieldLabel: "委托单", actorUserId: "owner", now: fixture.now }).run();
    expect(fixture.database.prepare("SELECT user_id FROM internal_notifications WHERE category='order_document_supplement'").all()).toEqual([{ user_id: "sales" }]);
  });
  it("refuses an inactive account even if the assigned position itself remains active", async () => {
    fixture.database.prepare(`INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,created_at,updated_at) VALUES('reject','org','reject','退回补录','submitted','draft','order_creation','录单',0,?,?)`).run(fixture.now, fixture.now);
    fixture.database.exec("UPDATE transport_orders SET status='submitted',current_step_code='consignment_approval',current_assignee_user_id='supervisor' WHERE id='order'; UPDATE users SET status='disabled' WHERE id='supervisor'");
    expect(await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId: "supervisor", actionCode: "reject" })).toMatchObject({ ok: false });
  });
});
