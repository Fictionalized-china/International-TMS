import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.server";
import { meetingFixture } from "../lib/meeting-integration-fixture";
import { loadActivePositionAccessProfile } from "../lib/position-access-profile.server";
const harness = vi.hoisted(() => ({ db: null as unknown as D1Database, actor: null as unknown as SessionUser }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: vi.fn(async () => harness.actor) }));
import { action } from "./warehouse.order-module";
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); harness.db = fixture.db;
  const db = fixture.database, now = fixture.now;
  db.exec("UPDATE memberships SET position_id=(SELECT id FROM positions WHERE organization_id='org' AND code='WAREHOUSE'),department_id=(SELECT d.id FROM positions p JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code WHERE p.organization_id='org' AND p.code='WAREHOUSE') WHERE user_id='operation'");
  const profile = await loadActivePositionAccessProfile(fixture.db, "org", "operation"); expect(profile).toBeTruthy();
  harness.actor = { ...fixture.actors.get("operation")!, ...profile!, roleCodes: [profile!.roleCode], warehouseIds: ["warehouse-a"], site: "warehouse" };
  for (const id of ["warehouse-a", "warehouse-b"]) db.prepare("INSERT INTO warehouses(id,organization_id,code,name,warehouse_role,created_at,updated_at) VALUES(?,'org',?,?,'domestic_collection',?,?)").run(id, id, id, now, now);
  db.prepare("INSERT INTO warehouse_user_access(id,organization_id,warehouse_id,user_id,access_level,created_at,updated_at) VALUES('warehouse-access','org','warehouse-a','operation','operator',?,?)").run(now, now);
  db.prepare("INSERT INTO order_transport_assignments(id,organization_id,order_id,leg_type,destination_warehouse_id,created_at,updated_at) VALUES('first-mile','org','order','first_mile','warehouse-a',?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_definitions(id,organization_id,code,name,created_at,updated_at) VALUES('wf','org','warehouse-fixture','仓库冻结流程',?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,created_at,updated_at) VALUES('warehouse-step','wf','warehouse_receiving','国内仓收货','order','manual.warehouse',10,?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,responsibility_position_code,created_at,updated_at) VALUES('warehouse-placement','wf','warehouse-step','warehouse','仓库','WAREHOUSE',?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_instances(id,organization_id,workflow_id,customer_id,order_id,current_step_key,started_at,updated_at) VALUES('instance','org','wf','customer','order','warehouse_receiving',?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_instance_step_states(id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,updated_at) VALUES('warehouse-state','instance','wf','warehouse-step','warehouse_receiving','国内仓收货',10,'active',?)").run(now);
  db.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,responsibility_position_code,updated_at) VALUES('warehouse-module-state','warehouse-state','warehouse-placement','warehouse','仓库',10,1,'all_tasks','WAREHOUSE',?)").run(now);
  db.prepare("INSERT INTO order_module_instances(id,organization_id,order_id,module_code,module_name,enabled,status,current_step_code,created_at,updated_at) VALUES('warehouse-module','org','order','warehouse','仓库',1,'not_started','waiting',?,?)").run(now, now);
  db.exec("UPDATE transport_orders SET workflow_instance_id='instance',current_step_code='warehouse_receiving',current_assignee_user_id=NULL WHERE id='order'");
});
afterEach(() => { vi.restoreAllMocks(); fixture?.database.close(); });
async function submit(warehouseId = "warehouse-a") {
  try {
    await action({ request: new Request(`http://localhost/warehouse/order-module?warehouseId=${warehouseId}`, { method: "POST", body: new URLSearchParams({ orderId: "order", redirectTo: `/warehouse/acceptance?warehouseId=${warehouseId}` }) }) } as never);
    throw new Error("Expected a warehouse result redirect");
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
const noAdvance = () => expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_module_history WHERE order_id='order'").get()).toEqual({ n: 0 });
function beforeAdvance(change: string) {
  let pending = false, fired = false;
  const prepare = fixture.db.prepare.bind(fixture.db), batch = fixture.db.batch.bind(fixture.db);
  vi.spyOn(fixture.db, "prepare").mockImplementation(sql => { if (sql.includes("SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,blocking_reason=NULL")) pending = true; return prepare(sql); });
  vi.spyOn(fixture.db, "batch").mockImplementation(async statements => { if (pending && !fired) { fired = true; fixture.database.exec(change); } return batch(statements); });
  return () => expect(fired).toBe(true);
}
describe("warehouse generic advance remains in the selected physical warehouse", () => {
  it.each(["operation", "owner"])("preserves a valid physical handoff for %s", async actor => {
    if (actor === "owner") harness.actor = { ...fixture.actors.get("owner")!, site: "warehouse" };
    const response = await submit(); expect(response.status).toBe(302);
    expect(new URL(response.headers.get("Location")!, "http://localhost").searchParams.get("warehouseResult")).toContain("已推进");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_module_history WHERE order_id='order'").get()).toEqual({ n: 1 });
  });
  it.each([
    ["another warehouse destination", "UPDATE order_transport_assignments SET destination_warehouse_id='warehouse-b' WHERE id='first-mile'"],
    ["viewer-only warehouse access", "UPDATE warehouse_user_access SET access_level='viewer' WHERE id='warehouse-access'"],
    ["inactive warehouse", "UPDATE warehouses SET status='disabled' WHERE id='warehouse-a'"],
    ["overseas warehouse", "UPDATE warehouses SET warehouse_role='overseas_destination' WHERE id='warehouse-a'"],
    ["another frozen responsibility", "UPDATE workflow_instance_module_states SET responsibility_position_code='OPERATION' WHERE id='warehouse-module-state'"],
    ["revoked operation permission", "DELETE FROM role_permissions WHERE role_id='org:role:warehouse_operator' AND permission_code='warehouse.operate'"],
    ["inactive account", "UPDATE users SET status='disabled' WHERE id='operation'"],
  ])("refuses %s without advancing", async (_label, change) => {
    fixture.database.exec(change); const response = await submit();
    expect(response.status >= 400 || new URL(response.headers.get("Location")!, "http://localhost").searchParams.has("warehouseError")).toBe(true); noAdvance();
  });
  it("does not accept a forged selected warehouse even for an order in the same organization", async () => {
    const response = await submit("warehouse-b"); expect(response.status).toBe(403); noAdvance();
  });
  it.each([false, true])("preserves configured warehouse managers (explicit assignment=%s)", async explicit => {
    fixture.database.exec("INSERT OR IGNORE INTO role_permissions(role_id,permission_code) VALUES('org:role:warehouse_operator','warehouse.manage')");
    if (explicit) fixture.database.exec("UPDATE warehouse_user_access SET access_level='viewer' WHERE id='warehouse-access'");
    else fixture.database.exec("DELETE FROM warehouse_user_access WHERE id='warehouse-access'");
    const response = await submit(); expect(new URL(response.headers.get("Location")!, "http://localhost").searchParams.get("warehouseResult")).toContain("已推进");
  });
  it("does not turn a read-only projection timestamp refresh into a false conflict", async () => {
    const assertInjected = beforeAdvance("UPDATE order_module_instances SET updated_at='projection-refresh' WHERE id='warehouse-module'");
    const response = await submit(); assertInjected();
    expect(new URL(response.headers.get("Location")!, "http://localhost").searchParams.get("warehouseResult")).toContain("已推进");
  });
  it.each([
    ["warehouse assignment", "DELETE FROM warehouse_user_access WHERE id='warehouse-access'"],
    ["planned destination", "UPDATE order_transport_assignments SET destination_warehouse_id='warehouse-b' WHERE id='first-mile'"],
    ["warehouse disabled", "UPDATE warehouses SET status='disabled' WHERE id='warehouse-a'"],
    ["order cancellation", "UPDATE transport_orders SET status='cancelled' WHERE id='order'"],
    ["permission removal", "DELETE FROM role_permissions WHERE role_id='org:role:warehouse_operator' AND permission_code='warehouse.operate'"],
    ["frozen queue change", "UPDATE workflow_instance_module_states SET responsibility_position_code='OPERATION' WHERE id='warehouse-module-state'"],
    ["module state", "UPDATE order_module_instances SET status='in_progress',current_step_code='receiving' WHERE id='warehouse-module'"],
    ["second warehouse binding", "INSERT INTO warehouse_user_access(id,organization_id,warehouse_id,user_id,access_level,created_at,updated_at) VALUES('second-access','org','warehouse-b','operation','operator','now','now')"],
  ])("rejects %s changing before the advance transaction", async (_label, change) => {
    const assertInjected = beforeAdvance(change); const response = await submit(); assertInjected();
    expect(new URL(response.headers.get("Location")!, "http://localhost").searchParams.get("warehouseError")).toContain("本次未提交"); noAdvance();
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM mutation_commit_guards").get()).toEqual({ n: 0 });
  });
});
