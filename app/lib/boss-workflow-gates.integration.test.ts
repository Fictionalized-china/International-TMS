import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";
import { ftlOrderIntakeFeeRequirements } from "./order-intake-fees";
const harness = vi.hoisted(() => ({ db: null as unknown as D1Database }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
import { validateOrderWorkflowAction } from "./order-workflow.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); });
async function setup(businessType: string) {
  fixture = await meetingFixture(); harness.db = fixture.db;
  fixture.database.prepare("UPDATE transport_orders SET status='draft',current_step_code='draft',business_type=?,current_assignee_user_id='sales' WHERE id='order'").run(businessType);
  fixture.database.prepare("INSERT INTO workflow_definitions(id,organization_id,code,name,created_at,updated_at) VALUES('gate-wf','org','gate-test','岗位门禁测试',?,?)").run(fixture.now, fixture.now);
  fixture.database.prepare("INSERT INTO workflow_instances(id,organization_id,workflow_id,customer_id,order_id,current_step_key,started_at,updated_at) VALUES('gate-instance','org','gate-wf','customer','order','order_creation',?,?)").run(fixture.now, fixture.now);
  fixture.database.exec("UPDATE transport_orders SET workflow_instance_id='gate-instance' WHERE id='order'");
  for (const [sort, [step, code, position]] of [["order_creation", "consignment", "SALES"], ["consignment_approval", "consignment", "OPERATION_SUPERVISOR"], ["task_assignment", "assignment", "OPERATION_SUPERVISOR"], ["domestic_transport", "transport", "OPERATION"]].entries()) {
    fixture.database.prepare("INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,created_at,updated_at) VALUES(?,'gate-wf',?,?,'order',?,?,?,?)").run(`gate:${step}`, step, step, `${step}.test`, sort * 10, fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,responsibility_position_code,created_at,updated_at) VALUES(?,'gate-wf',?,?,?,?,?,?)").run(`gate-placement:${step}`, `gate:${step}`, code, code, position, fixture.now, fixture.now);
  }
  for (const [action, from, to, step] of [["submit", "draft", "submitted", "consignment_approval"], ["approve", "submitted", "confirmed", "task_assignment"], ["dispatch", "confirmed", "in_execution", "domestic_transport"]]) {
    fixture.database.prepare("INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,created_at,updated_at) VALUES(?,'org',?,?,?,?,?,?,1,?,?)").run(`transition:${action}`, action, action, from, to, step, step, fixture.now, fixture.now);
  }
}
describe("boss and position accounts share the real intake/review/dispatch gates", () => {
  it.each(["ltl", "ftl"])("%s permits both actor modes without bypassing required fees or valid status", async businessType => {
    await setup(businessType);
    for (const actorUserId of ["owner", "sales"]) {
      expect(await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId, actionCode: "submit", assigneeUserId: "supervisor" })).toMatchObject({ ok: false, reason: expect.stringContaining("开单前") });
    }
    for (const fee of businessType === "ftl" ? ftlOrderIntakeFeeRequirements : ftlOrderIntakeFeeRequirements.slice(0, 1)) {
      fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,amount,created_by_user_id,created_at,updated_at) VALUES(?,'org','order','payable',?,?,0,'sales',?,?)").run(fee.code, fee.code, fee.label, fixture.now, fixture.now);
    }
    fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,amount,created_by_user_id,created_at,updated_at) VALUES('income','org','order','receivable','freight','国际运输费',100,'sales',?,?)").run(fixture.now, fixture.now);
    for (const actorUserId of ["owner", "sales"]) expect(await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId, actionCode: "submit", assigneeUserId: "supervisor" })).toMatchObject({ ok: true });
    expect(await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId: "operation", actionCode: "submit", assigneeUserId: "supervisor" })).toMatchObject({ ok: false });
    fixture.database.exec("UPDATE transport_orders SET status='submitted',current_step_code='consignment_approval',current_assignee_user_id='supervisor' WHERE id='order'");
    for (const actorUserId of ["owner", "supervisor"]) expect(await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId, actionCode: "approve", assigneeUserId: "supervisor" })).toMatchObject({ ok: true });
    fixture.database.exec("UPDATE transport_orders SET status='confirmed',current_step_code='task_assignment',current_assignee_user_id='supervisor' WHERE id='order'");
    fixture.database.exec("UPDATE workflow_instance_step_states SET status='completed' WHERE step_key IN ('order_creation','consignment_approval'); UPDATE workflow_instance_module_states SET status='completed' WHERE instance_step_state_id IN (SELECT id FROM workflow_instance_step_states WHERE step_key IN ('order_creation','consignment_approval'))");
    for (const actorUserId of ["owner", "supervisor"]) expect(await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId, actionCode: "dispatch", assigneeUserId: "operation", allowPendingAssignment: true, prospectiveAssignmentAssigneeUserId: "operation" })).toMatchObject({ ok: true });
    fixture.database.exec("UPDATE transport_orders SET status='completed' WHERE id='order'");
    expect(await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId: "owner", actionCode: "approve", assigneeUserId: "supervisor" })).toMatchObject({ ok: false, reason: expect.stringContaining("当前状态") });
  });
});
