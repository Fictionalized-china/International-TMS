import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";

const harness = vi.hoisted(() => ({ db: null as unknown as D1Database }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
import { syncOrderBusinessWorkflow } from "./business-workflow.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); });

describe("business workflow snapshot initialization", () => {
  it("initializes a missing instance exactly once and still repairs missing execution rows later", async () => {
    fixture = await meetingFixture(); harness.db = fixture.db;
    fixture.database.exec("UPDATE transport_orders SET status='draft',current_step_code='draft' WHERE id='order'");
    fixture.database.prepare("INSERT INTO workflow_definitions(id,organization_id,code,name,lifecycle_status,validation_status,status,created_at,updated_at) VALUES('wf','org','tms-default','测试已发布流程','published','valid','active',?,?)").run(fixture.now,fixture.now);
    for (const [index, key] of ["order_creation", "reconciliation"].entries()) {
      fixture.database.prepare("INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,created_at,updated_at) VALUES(?,'wf',?,?,'order',?,?,?,?)").run(`step:${key}`,key,key,`manual.${key}`,index*10,fixture.now,fixture.now);
      fixture.database.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES(?,'wf',?,'costs','费用',?,?)").run(`placement:${key}`,`step:${key}`,fixture.now,fixture.now);
    }
    const prepare = vi.spyOn(fixture.db, "prepare");
    const initializations = () => prepare.mock.calls.filter(([sql]) => /INSERT OR IGNORE INTO workflow_instance_step_states/.test(sql)).length;
    expect(await syncOrderBusinessWorkflow({ organizationId: "org", orderId: "order" })).toBe("order_creation");
    expect(initializations()).toBe(1);
    const instance = fixture.database.prepare("SELECT id,workflow_id FROM workflow_instances WHERE order_id='order'").get()!;
    const states = fixture.database.prepare("SELECT step_key,status FROM workflow_instance_step_states WHERE instance_id=? ORDER BY sort_order").all(instance.id);
    expect(states.length).toBeGreaterThan(1);
    expect(states[0]).toMatchObject({ step_key: "order_creation", status: "active" });
    expect(fixture.database.prepare("SELECT workflow_instance_id FROM transport_orders WHERE id='order'").get()?.workflow_instance_id).toBe(instance.id);
    // A later request must still repair an incomplete snapshot; no sticky
    // initialized flag or cross-request business cache is allowed.
    fixture.database.prepare("DELETE FROM workflow_instance_task_states WHERE instance_module_state_id IN (SELECT ms.id FROM workflow_instance_module_states ms JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id WHERE ss.instance_id=?)").run(instance.id);
    fixture.database.prepare("DELETE FROM workflow_instance_module_states WHERE instance_step_state_id IN (SELECT id FROM workflow_instance_step_states WHERE instance_id=?)").run(instance.id);
    prepare.mockClear();
    expect(await syncOrderBusinessWorkflow({ organizationId: "org", orderId: "order" })).toBe("order_creation");
    expect(initializations()).toBe(1);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM workflow_instance_module_states ms JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id WHERE ss.instance_id=?").get(instance.id)?.n).toBeGreaterThan(0);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM workflow_instances WHERE order_id='order'").get()?.n).toBe(1);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM workflow_history WHERE instance_id=? AND step_key='order_creation'").get(instance.id)?.n).toBe(1);
  });
});
