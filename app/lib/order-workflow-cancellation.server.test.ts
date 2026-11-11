import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture, seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
import { executeOrderWorkflowAction } from "./order-workflow.server";
import { ensureOrderModules, syncOrderWorkflowSnapshot } from "./order-modules.server";
import { ensureWorkflowForBusinessType, syncOrderBusinessWorkflow } from "./business-workflow.server";

vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture();
  Object.assign(env, { DB: fixture.db });
  for (const [action, status] of [["cancel_draft", "draft"], ["cancel_submitted", "submitted"], ["cancel_confirmed", "confirmed"]]) {
    fixture.database.prepare(`INSERT INTO order_workflow_transitions(
      id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,created_at,updated_at
    ) VALUES(?,'org',?,'取消订单',?,'cancelled','cancelled','已取消',0,?,?)`).run(action, action, status, fixture.now, fixture.now);
  }
});
afterEach(() => fixture?.database.close());

function facts() {
  return {
    modules: fixture.database.prepare("SELECT * FROM order_module_instances ORDER BY id").all(),
    definitions: fixture.database.prepare("SELECT * FROM workflow_definitions ORDER BY id").all(),
    instances: fixture.database.prepare("SELECT * FROM workflow_instances ORDER BY id").all(),
    steps: fixture.database.prepare("SELECT * FROM workflow_instance_step_states ORDER BY id").all(),
    workflowHistory: fixture.database.prepare("SELECT * FROM workflow_history ORDER BY id").all(),
    expenses: fixture.database.prepare("SELECT * FROM business_expenses ORDER BY id").all(),
  };
}

describe("cancellation does not initialize or rewrite workflow facts", () => {
  it.each([
    ["cancel_draft", "draft", "sales", "ltl"],
    ["cancel_draft", "draft", "owner", "ftl"],
    ["cancel_submitted", "submitted", "supervisor", "ltl"],
    ["cancel_submitted", "submitted", "owner", "ftl"],
    ["cancel_confirmed", "confirmed", "supervisor", "ltl"],
    ["cancel_confirmed", "confirmed", "owner", "ftl"],
  ])("returns %s from %s by %s (%s), even without published workflow", async (actionCode, status, actorUserId, businessType) => {
    fixture.database.prepare("UPDATE transport_orders SET status=?,business_type=?,current_step_code='legacy-step',current_assignee_user_id='supervisor' WHERE id='order'").run(status, businessType);
    const before = facts();
    expect(await executeOrderWorkflowAction({ organizationId: "org", orderId: "order", actionCode, actorUserId })).toMatchObject({ toStatus: "cancelled", stepName: "已取消" });
    expect(fixture.database.prepare("SELECT status,current_step_code,current_assignee_user_id FROM transport_orders WHERE id='order'").get()).toEqual({ status: "cancelled", current_step_code: "cancelled", current_assignee_user_id: null });
    expect(facts()).toEqual(before);
    await expect(executeOrderWorkflowAction({ organizationId: "org", orderId: "order", actionCode, actorUserId })).rejects.toThrow("已取消");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_workflow_history WHERE order_id='order'").get()).toEqual({ n: 1 });
  });

  it.each([false, true])("keeps a cancelled order unchanged during repeated projection reads (bound=%s)", async bound => {
    if (bound) seedFrozenMeetingWorkflow(fixture);
    fixture.database.exec("UPDATE transport_orders SET status='cancelled',current_step_code='cancelled',current_step_name='已取消',current_assignee_user_id=NULL WHERE id='order'");
    const before = facts();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await ensureOrderModules("org", "order");
      expect(await syncOrderBusinessWorkflow({ organizationId: "org", orderId: "order" })).toBeNull();
      await syncOrderWorkflowSnapshot("org", "order");
    }
    expect(facts()).toEqual(before);
    expect(fixture.database.prepare("SELECT status,current_step_name FROM transport_orders WHERE id='order'").get()).toEqual({ status: "cancelled", current_step_name: "已取消" });
  });

  it("still requires a published valid workflow for active forward business", async () => {
    await expect(ensureWorkflowForBusinessType("org", "ltl")).rejects.toThrow("尚未发布且校验通过");
  });

  it("keeps cancellation responsibility and state checks", async () => {
    fixture.database.exec("UPDATE transport_orders SET status='submitted',current_step_code='consignment_approval',current_assignee_user_id='supervisor' WHERE id='order'");
    await expect(executeOrderWorkflowAction({ organizationId: "org", orderId: "order", actionCode: "cancel_submitted", actorUserId: "operation" })).rejects.toThrow("指定的操作主管");
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()).toEqual({ status: "submitted" });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_workflow_history WHERE order_id='order'").get()).toEqual({ n: 0 });
  });
});
