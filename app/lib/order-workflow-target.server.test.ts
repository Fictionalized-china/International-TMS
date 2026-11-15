import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture, seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
import { executeOrderWorkflowAction } from "./order-workflow.server";

vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); Object.assign(env, { DB: fixture.db });
  seedFrozenMeetingWorkflow(fixture);
  fixture.database.exec("UPDATE transport_orders SET status='submitted',current_step_code='consignment_approval',current_assignee_user_id='supervisor' WHERE id='order'");
  fixture.database.prepare(`INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,created_at,updated_at)
    VALUES('approve','org','approve','审核通过','submitted','confirmed','task_assignment','审核分配',1,?,?)`).run(fixture.now, fixture.now);
});
afterEach(() => { vi.restoreAllMocks(); fixture?.database.close(); });

const execute = (actorUserId = "owner") => executeOrderWorkflowAction({
  organizationId: "org", orderId: "order", actorUserId, actionCode: "approve", assigneeUserId: "supervisor",
  atomicStatements: [fixture.db.prepare("UPDATE customers SET name='caller-committed' WHERE id='customer'")],
});

function beforeCommit(change: () => void) {
  let pending = false, fired = false;
  const prepare = fixture.db.prepare.bind(fixture.db), batch = fixture.db.batch.bind(fixture.db);
  vi.spyOn(fixture.db, "prepare").mockImplementation(sql => {
    if (sql.startsWith("UPDATE transport_orders SET status=?")) pending = true;
    return prepare(sql);
  });
  vi.spyOn(fixture.db, "batch").mockImplementation(async statements => {
    if (pending && !fired) { fired = true; change(); }
    return batch(statements);
  });
  return () => expect(fired).toBe(true);
}

describe("workflow handoff target remains eligible at commit", () => {
  it.each(["owner", "supervisor"])("preserves normal approval/assignment handoff for %s", async actor => {
    expect(await execute(actor)).toMatchObject({ toStatus: "confirmed" });
    expect(fixture.database.prepare("SELECT current_assignee_user_id,operation_supervisor_user_id FROM transport_orders WHERE id='order'").get()).toEqual({ current_assignee_user_id: "supervisor", operation_supervisor_user_id: "supervisor" });
  });
  it.each([
    ["account", "UPDATE users SET status='disabled' WHERE id='supervisor'"],
    ["membership", "UPDATE memberships SET status='disabled' WHERE user_id='supervisor'"],
    ["department", "UPDATE departments SET status='disabled' WHERE id=(SELECT department_id FROM memberships WHERE user_id='supervisor')"],
    ["position", "UPDATE positions SET status='disabled' WHERE code='OPERATION_SUPERVISOR' AND organization_id='org'"],
    ["role", "UPDATE roles SET status='disabled' WHERE code='pos_operation_supervisor' AND organization_id='org'"],
    ["transfer", "UPDATE memberships SET department_id=(SELECT department_id FROM memberships WHERE user_id='operation'),position_id=(SELECT position_id FROM memberships WHERE user_id='operation') WHERE user_id='supervisor'"],
    ["view permission", "DELETE FROM role_permissions WHERE role_id='org:role:pos_operation_supervisor' AND permission_code='order.view'"],
    ["assignment permission", "DELETE FROM role_permissions WHERE role_id='org:role:pos_operation_supervisor' AND permission_code='order.module.assignment.manage'"],
    ["batch approval permission", "DELETE FROM role_permissions WHERE role_id='org:role:pos_operation_supervisor' AND permission_code='transport.batch.approve'"],
  ])("rolls back a handoff after target %s changes", async (_label, change) => {
    const assertInjected = beforeCommit(() => fixture.database.exec(change));
    await expect(execute()).rejects.toThrow("本次未提交");
    assertInjected();
    expect(fixture.database.prepare("SELECT status,current_step_code,current_assignee_user_id FROM transport_orders WHERE id='order'").get()).toEqual({ status: "submitted", current_step_code: "consignment_approval", current_assignee_user_id: "supervisor" });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_workflow_history WHERE order_id='order'").get()).toEqual({ n: 0 });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM internal_notifications WHERE user_id='supervisor'").get()).toEqual({ n: 0 });
    expect(fixture.database.prepare("SELECT name FROM customers WHERE id='customer'").get()).toEqual({ name: "测试客户" });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM mutation_commit_guards").get()).toEqual({ n: 0 });
  });
  it("does not reject a valid selection just because the target display name changed", async () => {
    const assertInjected = beforeCommit(() => fixture.database.exec("UPDATE users SET display_name='新显示姓名' WHERE id='supervisor'"));
    expect(await execute()).toMatchObject({ toStatus: "confirmed" }); assertInjected();
  });
  it("rolls back approval when the current reviewer's amount capability is revoked before commit", async () => {
    const assertInjected = beforeCommit(() => fixture.database.exec("DELETE FROM role_permissions WHERE role_id='org:role:pos_operation_supervisor' AND permission_code='order.module.costs.manage'"));
    await expect(execute("supervisor")).rejects.toThrow("本次未提交"); assertInjected();
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()).toEqual({ status: "submitted" });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_workflow_history WHERE order_id='order'").get()).toEqual({ n: 0 });
  });
});
