import { afterEach, describe, expect, it, vi } from "vitest";
import {
  meetingFixture,
  seedFrozenMeetingWorkflow,
} from "./meeting-integration-fixture";

const harness = vi.hoisted(() => ({ db: null as unknown as D1Database }));
vi.mock("cloudflare:workers", () => ({
  env: { get DB() { return harness.db; } },
}));

import { syncOrderWorkflowSnapshot } from "./order-modules.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => {
  if (fixture?.database.isOpen) fixture.database.close();
});

describe("order workflow projection convergence", () => {
  it("rechecks a pre-completed settlement after entering reconciliation and reaches review in one sync", async () => {
    fixture = await meetingFixture();
    harness.db = fixture.db;
    seedFrozenMeetingWorkflow(fixture);
    const sql = fixture.database;
    const now = fixture.now;

    sql.exec(`
      UPDATE workflow_instance_fields SET is_required=0 WHERE instance_id='instance';
      UPDATE workflow_step_modules SET is_required=0 WHERE id='placement:order_creation';
      UPDATE workflow_instance_module_states SET is_required=0 WHERE id='module-state:order_creation';
      UPDATE order_module_instances
         SET enabled=1,is_required=1,status='in_progress',current_step_code='parallel_review'
       WHERE order_id='order' AND module_code='costs';
      UPDATE order_module_instances
         SET enabled=1,is_required=1,status='not_started',current_step_code='waiting'
       WHERE order_id='order' AND module_code='review';
    `);
    sql.prepare(
      "INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,created_at,updated_at) VALUES('step:completion_review','wf','completion_review','完成复盘','order','manual.completion_review',110,?,?)",
    ).run(now, now);
    sql.prepare(
      "INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,sort_order,is_required,is_active,responsibility_position_code,completion_mode,created_at,updated_at) VALUES('placement:completion_review','wf','step:completion_review','review','订单复盘',10,1,1,'FINANCE_ACCOUNTING','automatic',?,?)",
    ).run(now, now);
    sql.prepare(
      "INSERT INTO workflow_instance_step_states(id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,updated_at) VALUES('state:completion_review','instance','wf','step:completion_review','completion_review','完成复盘',110,'pending',?)",
    ).run(now);
    sql.prepare(
      "INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,status,responsibility_position_code,completion_mode,updated_at) VALUES('module-state:completion_review','state:completion_review','placement:completion_review','review','订单复盘',10,1,'pending','FINANCE_ACCOUNTING','automatic',?)",
    ).run(now);

    await syncOrderWorkflowSnapshot("org", "order");

    expect(sql.prepare(
      "SELECT status,current_step_code,blocking_reason FROM order_module_instances WHERE order_id='order' AND module_code='costs'",
    ).get()).toEqual({
      status: "completed",
      current_step_code: "settled",
      blocking_reason: null,
    });
    expect(sql.prepare(
      "SELECT current_step_key FROM workflow_instances WHERE id='instance'",
    ).get()).toEqual({ current_step_key: "completion_review" });
    expect(sql.prepare(
      "SELECT current_step_code FROM transport_orders WHERE id='order'",
    ).get()).toEqual({ current_step_code: "module:review" });
  });
});
