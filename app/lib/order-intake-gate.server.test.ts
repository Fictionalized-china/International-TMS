import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture,seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
import { completeIntakeFacts } from "./order-intake-completeness.test-fixture";
import { defaultBusinessProcessPolicy } from "./business-process-policy";
import { createIntakeRuleBinding, readIntakeRuleBinding } from "./order-intake-rule";
import { prepareOrderIntakeAdvance,prepareOrdersIntakeAdvance,prepareBatchIntakeAdvance,intakeManyCommitStatements, intakeGateCommitStatements, readIntakeGateSnapshot } from "./order-intake-gate.server";
import { executeOrderWorkflowAction } from "./order-workflow.server";
import { synchronizeWorkflowExecution } from "./workflow-execution.server";
import { activateOrderIntakeRule } from "./order-intake-supplement.server";
import { guardedBatch } from "./mutation-guard.server";
vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); Object.assign(env, { DB: fixture.db });
  const facts = completeIntakeFacts(), keys = Object.keys(facts.order).filter(key => key !== "id");
  fixture.database.prepare(`UPDATE transport_orders SET ${keys.map(key => `${key}=?`).join(",")} WHERE id='order'`).run(...keys.map(key => facts.order[key] as string));
  const insert = (table: string, row: Record<string, unknown>) => { const keys = Object.keys(row); fixture.database.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key] as string | number)); };
  insert("order_cargo_items", { ...facts.cargo[0], organization_id: "org", order_id: "order", line_no: 1, package_type: "carton", created_at: fixture.now, updated_at: fixture.now });
  for (const expense of facts.expenses) insert("business_expenses", { ...expense, organization_id: "org", order_id: "order", created_by_user_id: "sales", created_at: fixture.now, updated_at: fixture.now });
  insert("order_services", { id: "service", organization_id: "org", order_id: "order", service_code: "pickup", service_name: "提货", created_at: fixture.now });
});
afterEach(() => { vi.restoreAllMocks(); fixture?.database.close(); });
function bind() {
  const old = fixture.database.prepare("SELECT intake_operations_json FROM transport_orders WHERE id='order'").get() as { intake_operations_json: string };
  fixture.database.prepare("UPDATE transport_orders SET intake_operations_json=? WHERE id='order'").run(JSON.stringify({ ...JSON.parse(old.intake_operations_json), intakeRule: createIntakeRuleBinding(defaultBusinessProcessPolicy) }));
}
const prepare = () => prepareOrderIntakeAdvance("org", "order");
const apply = (snapshot: Awaited<ReturnType<typeof prepare>>) => guardedBatch(fixture.db, [...intakeGateCommitStatements(snapshot, fixture.now), fixture.db.prepare("UPDATE customers SET name='forward-effect' WHERE id='customer'")], "资料变更，整批未提交");
describe("versioned intake forward gate and commit snapshots", () => {
  it("uses independent business classifications and accepts explicit zero volume and self-delivery payable", async () => {
    bind(); const snapshot = await prepare(); expect(snapshot.binding?.version).toContain("v2"); expect(snapshot.result?.issues).toEqual([]);
    await apply(snapshot); expect(fixture.database.prepare("SELECT name FROM customers WHERE id='customer'").get()).toEqual({ name: "forward-effect" });
  });
  it.each(["businessMajor", "businessKind"])("rejects an empty %s even with a valid FTL/LTL load type", async key => {
    bind(); fixture.database.prepare("UPDATE transport_orders SET intake_operations_json=json_remove(intake_operations_json,?) WHERE id='order'").run(`$.${key}`);
    await expect(prepare()).rejects.toThrow(key === "businessMajor" ? "业务大类" : "业务类型");
  });
  it.each([
    ["order", "UPDATE transport_orders SET exit_port=NULL WHERE id='order'"],
    ["cargo", "UPDATE order_cargo_items SET cargo_name_cn='' WHERE id='cargo'"],
    ["removed cargo", "DELETE FROM order_cargo_items WHERE id='cargo'"],
    ["fee direction", "UPDATE business_expenses SET direction='receivable' WHERE id='ap'"],
    ["cancelled payable", "UPDATE business_expenses SET stage='cancelled' WHERE id='ap'"],
    ["new incomplete fee", "INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,currency,created_at,updated_at) VALUES('late','org','order','payable','OTHER','其他','CNY','2026-11-16','2026-11-16')"],
    ["service", "UPDATE order_services SET status='cancelled' WHERE id='service'"],
  ])("rolls back the entire forward transaction after a late %s change, even without changing timestamps", async (_label, change) => {
    bind(); const snapshot = await prepare(); fixture.database.exec(change);
    await expect(apply(snapshot)).rejects.toThrow("整批未提交");
    expect(fixture.database.prepare("SELECT name FROM customers WHERE id='customer'").get()).toEqual({ name: "测试客户" });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM mutation_commit_guards").get()).toEqual({ n: 0 });
  });
  it("keeps frozen fee requirements when organization defaults change, without caching current facts", async () => {
    bind(); fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','order.ltl_required_fees','handling',?)").run(fixture.now);
    expect((await prepare()).result?.issues).toEqual([]);
    fixture.database.exec("UPDATE business_expenses SET direction='receivable' WHERE id='ap'"); await expect(prepare()).rejects.toThrow("提货费");
  });
  it("does not silently bind legacy orders, but rejects an upgrade racing an already prepared legacy advance", async () => {
    const snapshot = await prepare(); expect(snapshot.binding).toBeNull(); bind(); await expect(apply(snapshot)).rejects.toThrow("整批未提交");
  });
  it("fails closed for a corrupt or unknown rule instead of silently treating it as legacy", async () => {
    fixture.database.prepare("UPDATE transport_orders SET intake_operations_json=? WHERE id='order'").run('{"intakeRule":{"version":"future"}}');
    await expect(prepare()).rejects.toThrow("规则版本无效");
  });
  it("audits an explicit complete legacy upgrade, is idempotent, and leaves the workflow and money untouched", async () => {
    const form = new FormData(); form.set("version", fixture.now); form.set("reason", "按原委托核对全部开单资料");
    const before = fixture.database.prepare("SELECT status,workflow_instance_id FROM transport_orders WHERE id='order'").get();
    await activateOrderIntakeRule(fixture.actors.get("owner")!, "order", form);
    expect(await activateOrderIntakeRule(fixture.actors.get("owner")!, "order", form)).toMatchObject({ success: expect.stringContaining("无需重复") });
    const raw = fixture.database.prepare("SELECT intake_operations_json FROM transport_orders WHERE id='order'").get() as { intake_operations_json: string };
    expect(readIntakeRuleBinding(raw.intake_operations_json)).toBeTruthy(); expect(fixture.database.prepare("SELECT status,workflow_instance_id FROM transport_orders WHERE id='order'").get()).toEqual(before);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.intake.rule.bind'").get()).toEqual({ n: 1 });
    expect(fixture.database.prepare("SELECT SUM(amount) amount FROM business_expenses").get()).toEqual({ amount: 100 });
  });
  it("shows missing fields before binding and does not lock or mutate an incomplete legacy order", async () => {
    fixture.database.exec("UPDATE transport_orders SET exit_port=NULL WHERE id='order'");
    const form = new FormData(); form.set("version", fixture.now); form.set("reason", "核对原始委托");
    await expect(activateOrderIntakeRule(fixture.actors.get("owner")!, "order", form)).rejects.toThrow("出境口岸");
    expect((await readIntakeGateSnapshot("org", "order")).binding).toBeNull();
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs").get()).toEqual({ n: 0 });
  });
  it("loads multiple bound children in four scoped queries and reports every incomplete order",async()=>{
    bind();
    const original=fixture.database.prepare("SELECT * FROM transport_orders WHERE id='order'").get()!;
    const row={...original,id:'second-order',order_number:'SECOND-SO'},keys=Object.keys(row);
    fixture.database.prepare(`INSERT INTO transport_orders(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key as keyof typeof row]));
    const prepareSpy=vi.spyOn(fixture.db,'prepare');
    await expect(prepareOrdersIntakeAdvance('org',['order','second-order'])).rejects.toThrow('SECOND-SO');
    expect(prepareSpy.mock.calls.filter(([sql])=>sql.startsWith('SELECT'))).toHaveLength(4);
    fixture.database.exec("UPDATE transport_orders SET exit_port=NULL");
    try{await prepareOrdersIntakeAdvance('org',['order','second-order']);throw new Error('should reject');}catch(error){expect(String(error)).toContain('TEST-SO');expect(String(error)).toContain('SECOND-SO');}
  });
  it("protects the legacy batch header relationship inside the same transaction",async()=>{
    fixture.database.prepare("INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,created_at,updated_at) VALUES('batch','org','order','TRIP-TEST','整批','起点','终点',?,?)").run(fixture.now,fixture.now);
    const snapshots=await prepareBatchIntakeAdvance('org','batch');
    const original=fixture.database.prepare("SELECT * FROM transport_orders WHERE id='order'").get()!,row={...original,id:'replacement',order_number:'REPLACEMENT'},keys=Object.keys(row);
    fixture.database.prepare(`INSERT INTO transport_orders(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key as keyof typeof row]));
    fixture.database.exec("UPDATE transport_batches SET order_id='replacement' WHERE id='batch'");
    await expect(guardedBatch(fixture.db,[...intakeManyCommitStatements(snapshots,fixture.now),fixture.db.prepare("UPDATE customers SET name='wrong' WHERE id='customer'")],'批次变更整批回滚')).rejects.toThrow('整批回滚');
    expect(fixture.database.prepare("SELECT name FROM customers WHERE id='customer'").get()).toEqual({name:'测试客户'});
  });
  it("rejects incomplete bound orders in the real approval service and leaves rejection available",async()=>{
    bind();seedFrozenMeetingWorkflow(fixture);
    fixture.database.exec("UPDATE transport_orders SET status='submitted',current_step_code='consignment_approval',current_assignee_user_id='supervisor',exit_port=NULL WHERE id='order'");
    for(const code of ['approve','reject'])fixture.database.prepare("INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,created_at,updated_at) VALUES(?,'org',?,?,'submitted',?,?,?,0,?,?)").run(code,code,code,code==='approve'?'confirmed':'draft',code==='approve'?'task_assignment':'order_creation','下一步',fixture.now,fixture.now);
    await expect(executeOrderWorkflowAction({organizationId:'org',orderId:'order',actorUserId:'owner',actionCode:'approve'})).rejects.toThrow('出境口岸');
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_workflow_history").get()).toEqual({n:0});
    expect(await executeOrderWorkflowAction({organizationId:'org',orderId:'order',actorUserId:'owner',actionCode:'reject'})).toMatchObject({toStatus:'draft'});
  });
  it("does not auto-cross a node on page synchronization when bound red data are missing, then resumes after correction",async()=>{
    bind();seedFrozenMeetingWorkflow(fixture);
    fixture.database.exec("DELETE FROM workflow_instance_fields; UPDATE workflow_step_modules SET module_code='cargo',completion_mode='automatic'; UPDATE workflow_instance_module_states SET module_code='cargo',completion_mode='automatic'; UPDATE workflow_instances SET current_step_key='order_creation'; UPDATE workflow_instance_step_states SET status=CASE WHEN step_key='order_creation' THEN 'active' ELSE 'pending' END; UPDATE transport_orders SET exit_port=NULL WHERE id='order'");
    const input={organizationId:'org',orderId:'order',instanceId:'instance',workflowId:'wf',targetStepKey:'reconciliation',orderStatus:'confirmed'};
    expect(await synchronizeWorkflowExecution(input)).toBe('order_creation');
    expect(fixture.database.prepare("SELECT current_step_key FROM workflow_instances WHERE id='instance'").get()).toEqual({current_step_key:'order_creation'});
    fixture.database.exec("UPDATE transport_orders SET exit_port='PORT' WHERE id='order'");
    expect(await synchronizeWorkflowExecution(input)).toBe('reconciliation');
  });
});
