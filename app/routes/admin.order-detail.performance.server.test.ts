import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingFixture, seedFrozenMeetingWorkflow } from "../lib/meeting-integration-fixture";
import type { SessionUser } from "../lib/auth.server";

const harness = vi.hoisted(() => ({ db: null as unknown as D1Database, actor: null as unknown as SessionUser }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: vi.fn(async () => harness.actor) }));
import { loader as detailLoader } from "./admin.order-detail";
import { loader as moduleLoader } from "./admin.order-module";
import { ensureOrderModules, listOrderModules, syncOrderWorkflowSnapshot } from "../lib/order-modules.server";
import { requireSessionUser } from "../lib/auth.server";
import { createOrderWorkflowFieldReader, loadOrderModuleWorkflowFields } from "../lib/workflow-fields.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); vi.clearAllMocks(); });
async function setup(actor: string) {
  fixture = await meetingFixture(); harness.db = fixture.db;
  seedFrozenMeetingWorkflow(fixture);
  fixture.database.exec("UPDATE order_module_instances SET status='completed' WHERE module_code='assignment'");
  fixture.database.prepare("INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,created_at) VALUES('export','org','order','exported','实际出境',?,?)").run(fixture.now, fixture.now);
  for (const code of ["transport", "review", "assignment"]) {
    fixture.database.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES(?,'wf','step:order_creation',?,?,?,?)").run(`placement:${code}`, code, code, fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,updated_at) VALUES(?,'state:order_creation',?,?,?,20,0,'all_tasks',?)").run(`frozen:${code}`, `placement:${code}`, code, code, fixture.now);
  }
  harness.actor = fixture.actors.get(actor)!;
  return vi.spyOn(fixture.db, "prepare");
}
function args() {
  return {
    request: new Request("http://localhost/admin/orders/order?stage=reconciliation&module=costs&section=expenses"),
    params: { orderId: "order", moduleCode: "costs" }, context: {},
  } as never;
}
const ensureCount = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(
  ([sql]) => String(sql).includes("SELECT o.id,o.business_type,o.status,o.current_assignee_user_id"),
).length;

describe("order detail request-local module reuse", () => {
  it("runs concurrent module and whole-order synchronization without waiting on its own queue",async()=>{
    const spy=await setup("owner");
    await Promise.all([ensureOrderModules("org","order"),syncOrderWorkflowSnapshot("org","order"),ensureOrderModules("org","order")]);
    expect(ensureCount(spy)).toBe(3);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_module_instances WHERE order_id='order'").get()).toEqual({n:13});
  });
  it("serializes projection transactions but does not serialize independent fact reads",async()=>{
    await setup("owner");
    const originalBatch=fixture.db.batch.bind(fixture.db);
    let writes=0,maxWrites=0;
    vi.spyOn(fixture.db,"batch").mockImplementation(async statements=>{
      writes++;maxWrites=Math.max(maxWrites,writes);
      try {await new Promise(resolve=>setTimeout(resolve,1));return await originalBatch(statements);}
      finally {writes--;}
    });
    const prepare=fixture.db.prepare.bind(fixture.db);
    let reads=0,maxReads=0;
    vi.spyOn(fixture.db,"prepare").mockImplementation(sql=>{
      const statement=prepare(sql),bind=statement.bind.bind(statement);
      statement.bind=(...values)=>{
        const bound=bind(...values);
        if(sql.includes("SELECT o.id,o.business_type,o.status,o.current_assignee_user_id")) {
          const first=bound.first.bind(bound);
          bound.first=async <T>()=>{reads++;maxReads=Math.max(maxReads,reads);try{await new Promise(resolve=>setTimeout(resolve,1));return await first<T>();}finally{reads--;}};
        }
        return bound;
      };
      return statement;
    });
    await Promise.all([ensureOrderModules("org","order"),syncOrderWorkflowSnapshot("org","order"),ensureOrderModules("org","order")]);
    expect(maxWrites).toBe(1);
    expect(maxReads).toBeGreaterThan(1);
  });
  it("initializes the same module set with bounded multi-row statements",async()=>{
    const spy=await setup("owner");
    const modules=await listOrderModules("org","order");
    const inserts=spy.mock.calls.filter(([sql])=>String(sql).includes("INSERT INTO order_module_instances(id,organization_id,order_id,module_code"));
    expect(modules.length).toBeGreaterThan(6);
    expect(inserts.length).toBe(Math.ceil(modules.length/6));
    for(const [sql] of inserts) expect((String(sql).match(/\?/g)??[]).length).toBeLessThanOrEqual(100);
  });
  it("loads the full frozen definition once per phase without changing any module fields or placement markers", async()=>{
    const spy=await setup("owner");
    const codes=["consignment","costs","transport","review","assignment"] as const;
    const independent=await Promise.all(codes.map(code=>loadOrderModuleWorkflowFields("org","order",code)));
    spy.mockClear();
    const read=createOrderWorkflowFieldReader("org","order");
    const batched=await Promise.all(codes.map(code=>read(code)));
    expect(batched).toEqual(independent);
    expect(spy.mock.calls.filter(([sql])=>String(sql).includes("FROM workflow_instance_fields f")).length).toBe(1);
    expect(spy.mock.calls.filter(([sql])=>String(sql).includes("SELECT ms.module_code,ss.step_key,ss.step_name,ss.sort_order")).length).toBe(1);
  });
  it.each(["owner", "operation", "cs", "finance"])("keeps %s data and authorization with one module synchronization", async actor => {
    const spy = await setup(actor);
    const request = args();
    const detail = await detailLoader(request);
    expect(ensureCount(spy)).toBe(1);
    // Authorization is not removed from the embedded route.
    expect(requireSessionUser).toHaveBeenCalledTimes(2);
    const standalone = await moduleLoader(request);
    expect(ensureCount(spy)).toBe(2);
    expect(detail.embeddedModuleData).not.toBeNull();
    for (const key of ["canViewExpenseSummary", "canViewFullExpenseDetails", "expenses", "workflowFields", "moduleActionCanOperate", "access"] as const) {
      expect(detail.embeddedModuleData![key]).toEqual(standalone[key]);
    }
  });

  it("does not reuse snapshots from a different request, organization or order", async () => {
    const spy = await setup("owner");
    const modules = await listOrderModules("org", "order");
    spy.mockClear();
    for (const mismatch of [
      { request: new Request("http://localhost/other"), organizationId: "org", orderId: "order" },
      { organizationId: "other-org", orderId: "order" },
      { organizationId: "org", orderId: "other-order" },
    ]) {
      const request = args();
      await moduleLoader(request, { request: (request as Parameters<typeof moduleLoader>[0]).request, modules, ...mismatch });
    }
    expect(ensureCount(spy)).toBe(3);
  });

  it("still rejects expired or revoked sessions even with a matching read snapshot", async () => {
    const spy = await setup("owner");
    const modules = await listOrderModules("org", "order");
    spy.mockClear();
    const input = { request: new Request("http://localhost/admin/orders/order?module=costs"), params: { orderId: "order", moduleCode: "costs" }, context: {} };
    const denied = new Response("Session revoked", { status: 401 });
    vi.mocked(requireSessionUser).mockRejectedValueOnce(denied);
    await expect(moduleLoader(input as never, { request: input.request, organizationId: "org", orderId: "order", modules })).rejects.toBe(denied);
    expect(ensureCount(spy)).toBe(0);
  });

  it("does not reuse a read snapshot when invoked for a POST", async () => {
    const spy = await setup("owner");
    const modules = await listOrderModules("org", "order");
    spy.mockClear();
    const input = { request: new Request("http://localhost/admin/orders/order?module=costs", { method: "POST" }), params: { orderId: "order", moduleCode: "costs" }, context: {} };
    await moduleLoader(input as never, { request: input.request, organizationId: "org", orderId: "order", modules });
    expect(ensureCount(spy)).toBe(1);
  });
});
