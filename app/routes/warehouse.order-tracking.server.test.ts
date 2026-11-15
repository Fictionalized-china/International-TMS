import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.server";
import { meetingFixture } from "../lib/meeting-integration-fixture";
import { loadActivePositionAccessProfile } from "../lib/position-access-profile.server";
const harness = vi.hoisted(() => ({ db: null as unknown as D1Database, actor: null as unknown as SessionUser }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: async () => harness.actor }));
import { loader } from "./warehouse.order-tracking";
import { loader as warehouseLayout } from "./warehouse";
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); harness.db = fixture.db; const db = fixture.database, now = fixture.now;
  db.exec("UPDATE memberships SET position_id=(SELECT id FROM positions WHERE organization_id='org' AND code='WAREHOUSE'),department_id=(SELECT d.id FROM positions p JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code WHERE p.organization_id='org' AND p.code='WAREHOUSE') WHERE user_id='operation'");
  const profile = await loadActivePositionAccessProfile(fixture.db, "org", "operation"); expect(profile).toBeTruthy();
  harness.actor = { ...fixture.actors.get("operation")!, ...profile!, roleCodes: [profile!.roleCode], warehouseIds: ["wh-a"], site: "warehouse" };
  for (const id of ["wh-a", "wh-b"]) db.prepare("INSERT INTO warehouses(id,organization_id,code,name,warehouse_role,created_at,updated_at) VALUES(?,'org',?,?,'domestic_collection',?,?)").run(id, id, id, now, now);
  db.prepare("INSERT INTO warehouse_user_access(id,organization_id,warehouse_id,user_id,access_level,created_at,updated_at) VALUES('access','org','wh-a','operation','viewer',?,?)").run(now, now);
  db.prepare("INSERT INTO order_transport_assignments(id,organization_id,order_id,leg_type,destination_warehouse_id,created_at,updated_at) VALUES('first-mile','org','order','first_mile','wh-a',?,?)").run(now, now);
  db.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,created_at,updated_at) VALUES('shipment','org','SHP-TEST','order','customer',?,?)").run(now, now);
  db.prepare("INSERT INTO shipment_events(id,shipment_id,status,description,event_at,created_at) VALUES('event','shipment','booked','共同运踪已同步',?,?)").run(now, now);
});
afterEach(() => fixture?.database.close());
const args = (query = "orderId=order&warehouseId=wh-a") => ({ request: new Request(`http://localhost/warehouse/order-tracking?${query}`), params: {} } as never);
describe("warehouse scoped read-only tracking", () => {
  it("allows a viewer in the actual planned warehouse without requiring warehouse operation or tracking writes", async () => {
    const data = await loader(args()); expect(data.selected?.id).toBe("order"); expect(data.events[0].description).toBe("共同运踪已同步");
    expect(harness.actor.permissions).not.toContain("order.module.tracking.manage");
  });
  it("rejects another selected warehouse and a cancelled/changed delivery relationship", async () => {
    await expect(loader(args("orderId=order&warehouseId=wh-b"))).rejects.toMatchObject({ status: 403 });
    fixture.database.exec("UPDATE order_transport_assignments SET status='cancelled'");
    await expect(loader(args())).rejects.toMatchObject({ status: 404 });
  });
  it("does not grant the historical planned warehouse access after a valid new target replaces it", async () => {
    fixture.database.prepare("INSERT INTO order_transport_assignments(id,organization_id,order_id,leg_type,destination_warehouse_id,created_at,updated_at) VALUES('new-target','org','order','first_mile','wh-b','2026-09-02','2026-09-02')").run();
    await expect(loader(args())).rejects.toMatchObject({ status: 404 });
  });
  it("can view its planned overseas destination without treating that as actual arrival", async () => {
    fixture.database.exec("UPDATE order_transport_assignments SET status='cancelled'; UPDATE warehouses SET warehouse_role='overseas_destination' WHERE id='wh-a'; UPDATE transport_orders SET overseas_warehouse_id='wh-a'");
    expect((await loader(args())).selected?.id).toBe("order");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM warehouse_receipts").get()).toEqual({ n: 0 });
  });
  it("does not expose an unrelated order in the warehouse layout's contextual header", async () => {
    fixture.database.exec("DELETE FROM order_transport_assignments");
    const data = await warehouseLayout({ request: new Request("http://localhost/warehouse/acceptance?orderId=order&warehouseId=wh-a") } as never); expect(data.orderContext).toBeNull(); expect(data.warehouseFlow).toBeNull();
  });
  it("does not require a published workflow or mutate projections just to read historical tracking", async () => {
    const batch = vi.spyOn(fixture.db, "batch");
    const layout = await warehouseLayout(args()); expect(layout.orderContext).toBeNull();
    expect((await loader(args())).events).toHaveLength(1); expect(batch).not.toHaveBeenCalled();
  });
});
