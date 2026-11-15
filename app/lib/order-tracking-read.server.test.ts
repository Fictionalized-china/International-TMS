import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";
import { loadOrderTrackingReadView } from "./order-tracking-read.server";
vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); const db = fixture.database, now = fixture.now;
  // The cashier's existing order scope is tied to ledger-bearing orders.
  db.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,currency,amount,created_at,updated_at) VALUES('fee','org','order','receivable','FREIGHT','运费','CNY',100,?,?)").run(now, now);
  db.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,created_at,updated_at) VALUES('shipment','org','SHP-TEST','order','customer',?,?)").run(now, now);
  for (const [id, visible] of [["customer-event", 1], ["internal-event", 0]]) db.prepare("INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_at) VALUES(?,'shipment','in_transit','测试地点',?,?,?,?)").run(id, id, now, visible, now);
});
afterEach(() => { vi.restoreAllMocks(); fixture?.database.close(); });
describe("scoped read-only order tracking", () => {
  it.each(["owner", "sales", "operation", "supervisor", "cs", "commercial", "finance", "cashier", "hr", "tracker"])("lets authorized %s read without any writes or tracking management grant", async actor => {
    const batch = vi.spyOn(fixture.db, "batch");
    const current = fixture.actors.get(actor)!, permissions = [...current.permissions];
    const data = await loadOrderTrackingReadView(fixture.db, current, new URLSearchParams("orderId=order"));
    expect(data.selected?.id).toBe("order"); expect(data.events).toHaveLength(2);
    expect(data.events.find(event => event.id === "internal-event")?.visible_to_customer).toBe(0);
    expect(batch).not.toHaveBeenCalled(); expect(current.permissions).toEqual(permissions);
    expect(JSON.stringify(data)).not.toContain("business_expenses");
  });
  it("does not leak a foreign/unassigned order through a forged id, organization or warehouse query", async () => {
    const current = fixture.actors.get("operation")!;
    await expect(loadOrderTrackingReadView(fixture.db, { ...current, userId: "unassigned", dataScope: "self" }, new URLSearchParams("orderId=order&warehouseId=anything"))).rejects.toMatchObject({ status: 404 });
    await expect(loadOrderTrackingReadView(fixture.db, { ...current, organizationId: "other" }, new URLSearchParams("orderId=order"))).rejects.toMatchObject({ status: 404 });
    await expect(loadOrderTrackingReadView(fixture.db, { ...current, permissions: [] }, new URLSearchParams())).rejects.toMatchObject({ status: 403 });
  });
  it("has real order and event pagination and retains a selected authorized order outside a search page", async () => {
    const original = fixture.database.prepare("SELECT * FROM transport_orders WHERE id='order'").get()!;
    for (let index = 0; index < 25; index++) {
      const row = { ...original, id: `other-${index}`, order_number: `SO-${index}` }, keys = Object.keys(row);
      fixture.database.prepare(`INSERT INTO transport_orders(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key as keyof typeof row]));
    }
    for (let index = 0; index < 55; index++) fixture.database.prepare("INSERT INTO shipment_events(id,shipment_id,status,description,event_at,created_at) VALUES(?,'shipment','in_transit','测试分页',?,?)").run(`event-${index}`, fixture.now, fixture.now);
    const data = await loadOrderTrackingReadView(fixture.db, fixture.actors.get("owner")!, new URLSearchParams("page=2&orderId=order&eventsPage=2"));
    expect(data.pagination).toMatchObject({ total: 26, page: 2, pageCount: 2 }); expect(data.pagination.items).toHaveLength(6);
    expect(data.eventPagination).toMatchObject({ total: 57, page: 2 }); expect(data.events).toHaveLength(7);
    const empty = await loadOrderTrackingReadView(fixture.db, fixture.actors.get("owner")!, new URLSearchParams("q=not-found")); expect(empty.selected).toBeNull(); expect(empty.events).toEqual([]);
  });
});
