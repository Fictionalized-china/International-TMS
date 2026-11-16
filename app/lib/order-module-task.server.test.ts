import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture, seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
import { completeOrderModuleTask } from "./order-module-task.server";
vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); Object.assign(env, { DB: fixture.db }); seedFrozenMeetingWorkflow(fixture);
  fixture.database.exec("UPDATE order_module_instances SET enabled=1 WHERE module_code='costs'; UPDATE workflow_instance_module_states SET responsibility_position_code='CS' WHERE id='module-state:reconciliation'");
  fixture.database.prepare("INSERT INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,status,assignee_user_id,created_at,updated_at) VALUES('reminder','org','order','costs','manual_note','核对说明','pending','cs',?,?)").run(fixture.now,fixture.now);
});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
const complete=(actor='cs')=>completeOrderModuleTask(fixture.db,fixture.actors.get(actor)!,'order','costs','reminder');
const saved=()=>fixture.database.prepare("SELECT status FROM order_tasks WHERE id='reminder'").get();
describe('module reminders use current identity and frozen scope',()=>{
  it.each(['cs','owner'])('allows actual responsible staff and boss (%s), without completing the module',async actor=>{
    await complete(actor);expect(saved()).toEqual({status:'completed'});
    expect(fixture.database.prepare("SELECT status FROM order_module_instances WHERE module_code='costs'").get()?.status).not.toBe('completed');
    await expect(complete(actor)).rejects.toThrow();
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.task.complete'").get()).toEqual({n:1});
  });
  it.each([
    ['task transfer',"UPDATE order_tasks SET assignee_user_id='finance' WHERE id='reminder'"],
    ['node',"UPDATE workflow_instances SET current_step_key='order_creation' WHERE id='instance'"],
    ['cancel',"UPDATE transport_orders SET status='cancelled' WHERE id='order'"],
    ['module',"UPDATE order_module_instances SET enabled=0 WHERE module_code='costs'"],
    ['account',"UPDATE users SET status='disabled' WHERE id='cs'"],
    ['permission',"DELETE FROM role_permissions WHERE role_id='org:role:pos_customer_service' AND permission_code='order.module.costs.manage'"],
  ])('rolls back when %s changes after preflight',async(_label,change)=>{
    const batch=fixture.db.batch.bind(fixture.db);let fired=false;
    vi.spyOn(fixture.db,'batch').mockImplementation(async statements=>{if(!fired){fired=true;fixture.database.exec(change);}return batch(statements);});
    await expect(complete()).rejects.toThrow('本次未提交');expect(fired).toBe(true);expect(saved()).toEqual({status:'pending'});
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.task.complete'").get()).toEqual({n:0});
  });
  it('does not trust a stale boss role from the session',async()=>{
    const actor={...fixture.actors.get('sales')!,roleCodes:['boss'],positionCode:'BOSS'};
    await expect(completeOrderModuleTask(fixture.db,actor,'order','costs','reminder')).rejects.toThrow();expect(saved()).toEqual({status:'pending'});
  });
});
