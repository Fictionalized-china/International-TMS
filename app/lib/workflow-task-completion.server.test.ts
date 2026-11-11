import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture, seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
import { completeWorkflowTask } from "./workflow-execution.server";
vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); Object.assign(env, { DB: fixture.db }); seedFrozenMeetingWorkflow(fixture);
  fixture.database.exec("UPDATE order_module_instances SET enabled=1,assignee_user_id='cs' WHERE module_code='costs'; UPDATE workflow_instance_module_states SET responsibility_position_code='CS' WHERE id='module-state:reconciliation'");
  fixture.database.prepare(`INSERT INTO workflow_module_tasks(id,workflow_id,step_module_id,task_key,name,task_type,created_at,updated_at)
    VALUES('manual-definition','wf','placement:reconciliation','confirm_note','人工核对补充说明','form',?,?)`).run(fixture.now, fixture.now);
  fixture.database.prepare(`INSERT INTO workflow_instance_task_states(id,instance_module_state_id,module_task_id,task_key,name,task_type,sort_order,is_required,status,responsibility_position_code,assignee_user_id,updated_at)
    VALUES('manual-task','module-state:reconciliation','manual-definition','confirm_note','人工核对补充说明','form',10,1,'pending','CS','cs',?)`).run(fixture.now);
});
afterEach(() => { vi.restoreAllMocks(); fixture?.database.close(); });
const complete = (actorUserId = "cs", actorRoleCodes?: readonly string[]) => completeWorkflowTask({ organizationId: "org", orderId: "order", taskStateId: "manual-task", actorUserId, actorRoleCodes });
const saved = () => fixture.database.prepare("SELECT status,completed_by_user_id,completed_at FROM workflow_instance_task_states WHERE id='manual-task'").get();

function injectBeforeWrite(sql: string) {
  let fired = false, inBatch = false;
  const change = () => { if (!fired) { fired = true; fixture.database.exec(sql); } };
  const prepare = fixture.db.prepare.bind(fixture.db), batch = fixture.db.batch.bind(fixture.db);
  vi.spyOn(fixture.db, "prepare").mockImplementation(query => {
    const statement = prepare(query);
    if (query.includes("UPDATE workflow_instance_task_states SET status='completed'")) {
      const run = statement.run.bind(statement);
      statement.run = async () => { if (!inBatch) change(); return run(); };
    }
    return statement;
  });
  vi.spyOn(fixture.db, "batch").mockImplementation(async statements => { inBatch = true; change(); try { return await batch(statements); } finally { inBatch = false; } });
  return () => expect(fired).toBe(true);
}

describe("manual workflow task submission is current and atomic", () => {
  it.each(["cs", "owner"])("allows the current task owner or boss (%s), not an automatic task bypass", async actor => {
    await complete(actor); expect(saved()).toMatchObject({ status: "completed", completed_by_user_id: actor });
    await expect(complete(actor)).rejects.toThrow("已经完成");
  });
  it("does not trust stale caller-provided boss role codes", async () => {
    await expect(complete("sales", ["boss"])).rejects.toThrow("无权完成");
    expect(saved()).toEqual({ status: "pending", completed_by_user_id: null, completed_at: null });
  });
  it.each(["module owner", "frozen position", "custom task without a physical module row"])("preserves configured manual handling through %s", async source => {
    if (source !== "custom task without a physical module row") fixture.database.exec("UPDATE workflow_instance_task_states SET assignee_user_id=NULL WHERE id='manual-task'");
    if (source === "frozen position") fixture.database.exec("UPDATE order_module_instances SET assignee_user_id=NULL WHERE module_code='costs'");
    if (source === "custom task without a physical module row") fixture.database.exec("DELETE FROM order_module_instances WHERE module_code='costs'");
    await complete(); expect(saved()).toMatchObject({ status: "completed", completed_by_user_id: "cs" });
  });
  it("does not fall through to a matching module or position when a different personal owner is assigned", async () => {
    fixture.database.exec("UPDATE workflow_instance_task_states SET assignee_user_id='finance' WHERE id='manual-task'");
    await expect(complete()).rejects.toThrow("无权完成"); expect(saved()?.status).toBe("pending");
  });
  it.each([
    ["cancelled order", "UPDATE transport_orders SET status='cancelled' WHERE id='order'"],
    ["completed order", "UPDATE transport_orders SET status='completed' WHERE id='order'"],
    ["unbound instance", "UPDATE transport_orders SET workflow_instance_id=NULL WHERE id='order'"],
    ["inactive step", "UPDATE workflow_instance_step_states SET status='pending' WHERE id='state:reconciliation'"],
    ["disabled module", "UPDATE order_module_instances SET enabled=0 WHERE module_code='costs'"],
    ["disabled account", "UPDATE users SET status='disabled' WHERE id='cs'"],
    ["disabled department", "UPDATE departments SET status='disabled' WHERE id=(SELECT department_id FROM memberships WHERE user_id='cs')"],
    ["disabled role", "UPDATE roles SET status='disabled' WHERE code='pos_customer_service' AND organization_id='org'"],
    ["revoked view", "DELETE FROM role_permissions WHERE role_id='org:role:pos_customer_service' AND permission_code='order.view'"],
  ])("rejects %s before writing", async (_label, change) => {
    fixture.database.exec(change); await expect(complete()).rejects.toThrow();
    expect(saved()).toEqual({ status: "pending", completed_by_user_id: null, completed_at: null });
  });
  it.each([
    ["task owner", "UPDATE workflow_instance_task_states SET assignee_user_id='finance' WHERE id='manual-task'"],
    ["module owner", "UPDATE order_module_instances SET assignee_user_id='finance' WHERE module_code='costs'"],
    ["node", "UPDATE workflow_instances SET current_step_key='order_creation' WHERE id='instance'"],
    ["instance closure", "UPDATE workflow_instances SET status='cancelled' WHERE id='instance'"],
    ["order cancellation", "UPDATE transport_orders SET status='cancelled' WHERE id='order'"],
    ["order binding", "UPDATE transport_orders SET workflow_instance_id=NULL WHERE id='order'"],
    ["module unplug", "UPDATE order_module_instances SET enabled=0 WHERE module_code='costs'"],
    ["frozen duty", "UPDATE workflow_instance_module_states SET responsibility_position_code='FINANCE_ACCOUNTING' WHERE id='module-state:reconciliation'"],
    ["task revision", "UPDATE workflow_instance_task_states SET updated_at='changed' WHERE id='manual-task'"],
    ["task identity", "UPDATE workflow_instance_task_states SET task_key='handle_costs' WHERE id='manual-task'"],
    ["step identity", "UPDATE workflow_instance_step_states SET step_key='custom_replaced' WHERE id='state:reconciliation'; UPDATE workflow_instances SET current_step_key='custom_replaced' WHERE id='instance'"],
    ["workflow version", "INSERT INTO workflow_definitions(id,organization_id,code,name,created_at,updated_at) VALUES('other-wf','org','other-wf','另一流程','now','now'); UPDATE workflow_instances SET workflow_id='other-wf' WHERE id='instance'"],
    ["account", "UPDATE users SET status='disabled' WHERE id='cs'"],
    ["role permission", "DELETE FROM role_permissions WHERE role_id='org:role:pos_customer_service' AND permission_code='order.view'"],
  ])("rejects a concurrent change to %s without marking the task done", async (_label, change) => {
    const assertInjected = injectBeforeWrite(change);
    await expect(complete()).rejects.toThrow("本次未提交"); assertInjected();
    expect(saved()).toEqual({ status: "pending", completed_by_user_id: null, completed_at: null });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM mutation_commit_guards").get()).toEqual({ n: 0 });
  });
  it("keeps a completion already recorded by another request", async () => {
    const assertInjected = injectBeforeWrite("UPDATE workflow_instance_task_states SET status='completed',completed_by_user_id='owner',completed_at='other-request',updated_at='other-request' WHERE id='manual-task'");
    await expect(complete()).rejects.toThrow("本次未提交"); assertInjected();
    expect(saved()).toEqual({ status: "completed", completed_by_user_id: "owner", completed_at: "other-request" });
  });
  it("still refuses the existing business-module automatic handler", async () => {
    fixture.database.exec("UPDATE workflow_instance_task_states SET task_key='handle_costs',task_type='system' WHERE id='manual-task'");
    await expect(complete("owner")).rejects.toThrow("不能人工跳过");
    expect(saved()?.status).toBe("pending");
  });
});
