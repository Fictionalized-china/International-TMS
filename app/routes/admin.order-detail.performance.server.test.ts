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
  it.each(["当前订单联系人", null])("shows current consignment contact/cargo facts, including a deliberately empty contact (%s)", async contact => {
    await setup("owner");
    fixture.database.prepare(`INSERT INTO quotations(id,organization_id,quote_number,customer_id,customer_contact_name,customer_contact_phone,origin_country,origin_city,destination_country,destination_city,transport_mode,cargo_description,pieces,gross_weight_kg,volume_cbm,notes,created_at,updated_at)
      VALUES('history-quote','org','Q-HISTORY','customer','旧报价联系人','旧电话','CN','深圳','RU','莫斯科','ROAD','旧报价货物',200,300,400,'来源报价备注',?,?)`).run(fixture.now, fixture.now);
    fixture.database.prepare("UPDATE transport_orders SET quotation_id='history-quote',shipper_contact=?,shipper_phone=NULL,cargo_description='当前货物',pieces=10,gross_weight_kg=24,volume_cbm=0,special_instructions='订单作业备注' WHERE id='order'").run(contact);
    const data = await moduleLoader(args());
    expect(data.order).toMatchObject({ quotation_customer_contact_name: contact, quotation_customer_contact_phone: null, quotation_cargo_description: "当前货物", quotation_pieces: 10, quotation_gross_weight_kg: 24, quotation_volume_cbm: 0, quotation_notes: "来源报价备注" });
    expect(fixture.database.prepare("SELECT customer_contact_name,cargo_description,pieces FROM quotations WHERE id='history-quote'").get()).toEqual({ customer_contact_name: "旧报价联系人", cargo_description: "旧报价货物", pieces: 200 });
  });
  it("loads declared product quantity and unit separately from warehouse packaging", async () => {
    await setup("owner");
    fixture.database.prepare(`INSERT INTO order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,net_weight_per_package_kg,length_cm,width_cm,height_cm,volume_per_package_cbm,declared_value,currency,declared_quantity,declared_unit,created_at,updated_at)
      VALUES('quantity-cargo','org','order',1,'当前货物','carton',2,1,12,12,1,1,1,0,0,'CNY',10,'台',?,?)`).run(fixture.now, fixture.now);
    expect((await moduleLoader(args())).cargo[0]).toMatchObject({ declared_quantity: 10, declared_unit: "台", package_count: 2, pieces_per_package: 1 });
  });
  it.each(["sales", null])("keeps current order salesperson %s authoritative in both detail and embedded module", async salesperson => {
    await setup("owner");
    fixture.database.prepare(`INSERT INTO quotations(id,organization_id,quote_number,customer_id,salesperson_user_id,origin_country,origin_city,destination_country,destination_city,transport_mode,cargo_description,created_at,updated_at) VALUES('history-quote','org','Q-HISTORY','customer','owner','CN','深圳','RU','莫斯科','ROAD','来源货物',?,?)`).run(fixture.now, fixture.now);
    fixture.database.prepare("UPDATE transport_orders SET quotation_id='history-quote',salesperson_user_id=? WHERE id='order'").run(salesperson);
    const detail = await detailLoader(args());
    expect(detail.order.salesperson_user_id).toBe(salesperson);
    expect(detail.embeddedModuleData?.order.salesperson_user_id).toBe(salesperson);
    expect(fixture.database.prepare("SELECT salesperson_user_id FROM quotations WHERE id='history-quote'").get()).toEqual({salesperson_user_id:"owner"});
  });
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
