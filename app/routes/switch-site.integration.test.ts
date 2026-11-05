import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingFixture } from "../lib/meeting-integration-fixture";
import { sessionCookieName } from "../lib/session-slot";

const harness = vi.hoisted(() => ({ db: null as unknown as D1Database }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
import { createSession, getSessionUser } from "../lib/auth.server";
import { action } from "./switch-site";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
const slot = "boss-integration-tab-01";
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); });
async function setup() {
  fixture = await meetingFixture(); harness.db = fixture.db;
  for (const [id, role, status] of [["domestic", "domestic_collection", "active"], ["moscow", "overseas_destination", "active"], ["disabled", "port", "disabled"]]) {
    fixture.database.prepare("INSERT INTO warehouses(id,organization_id,code,name,country_code,city,warehouse_role,status,created_at,updated_at) VALUES(?,'org',?,?,'CN','测试',?,?,?,?)").run(id, id, id, role, status, fixture.now, fixture.now);
  }
  fixture.database.prepare("INSERT INTO organizations(id,code,name,created_at,updated_at) VALUES('other-org','other-org','其他组织',?,?)").run(fixture.now, fixture.now);
  fixture.database.prepare("INSERT INTO warehouses(id,organization_id,code,name,country_code,city,warehouse_role,status,created_at,updated_at) VALUES('unassigned-other-org','other-org','outside','外部仓库','RU','测试','overseas_destination','active',?,?)").run(fixture.now, fixture.now);
}
function cookieOf(response: Response) { return response.headers.get("Set-Cookie")!.split(";")[0]; }
function request(cookie: string, fields: Record<string, string>, warehouseId?: string) {
  return new Request(`https://test.local/switch-site?itmsTab=${slot}${warehouseId ? `&warehouseId=${warehouseId}` : ""}`, {
    method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams(fields),
  });
}
async function submit(req: Request) { return action({ request: req } as Parameters<typeof action>[0]); }
async function actorAt(response: Response) {
  return getSessionUser(new Request(new URL(response.headers.get("Location")!, "https://test.local"), { headers: { Cookie: cookieOf(response) } }), response.headers.get("Location")!.startsWith("/warehouse") ? "warehouse" : "admin");
}

describe("same-identity boss warehouse site bridge", () => {
  it("enters, switches warehouses and returns to the order using the same real boss identity and tab", async () => {
    await setup();
    const adminCookie = (await createSession("owner", "org", "admin", null, slot)).split(";")[0];
    const entered = await submit(request(adminCookie, { target: "warehouse", warehouseTo: "/warehouse/inbound?warehouseId=moscow&orderId=order" }));
    expect(entered.status).toBe(302);
    expect(cookieOf(entered)).toContain(sessionCookieName("warehouse", "moscow", slot));
    expect(await actorAt(entered)).toMatchObject({ userId: "owner", positionCode: "BOSS", site: "warehouse", organizationId: "org" });
    const switched = await submit(request(cookieOf(entered), { target: "warehouse", sourceSite: "warehouse", warehouseTo: "/warehouse/acceptance?warehouseId=domestic" }, "moscow"));
    expect(cookieOf(switched)).toContain(sessionCookieName("warehouse", "domestic", slot));
    expect(await actorAt(switched)).toMatchObject({ userId: "owner", positionCode: "BOSS", dataScope: "company" });
    const returned = await submit(request(cookieOf(switched), { target: "admin", returnTo: "/admin/orders/order" }, "domestic"));
    expect(returned.headers.get("Location")).toBe(`/admin/orders/order?itmsTab=${slot}`);
    expect(await actorAt(returned)).toMatchObject({ userId: "owner", site: "admin" });
    const audits = fixture.database.prepare("SELECT actor_user_id,metadata_json FROM audit_logs WHERE action='auth.site.switch'").all();
    expect(audits).toHaveLength(3);
    expect(audits.every(row => row.actor_user_id === "owner")).toBe(true);
    expect(JSON.parse(String(audits[1].metadata_json))).toMatchObject({ bossStandIn: true, actingAsSelf: true, warehouseId: "domestic" });
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()?.status).toBe("in_execution");
  });

  it("does not let an ordinary warehouse account use the boss cross-warehouse entry", async () => {
    await setup();
    fixture.database.prepare("UPDATE memberships SET position_id=(SELECT id FROM positions WHERE organization_id='org' AND code='WAREHOUSE'),department_id=(SELECT d.id FROM departments d JOIN positions p ON p.organization_id=d.organization_id AND p.department_code=d.code WHERE p.organization_id='org' AND p.code='WAREHOUSE') WHERE user_id='operation'").run();
    fixture.database.prepare("INSERT INTO warehouse_user_access(id,organization_id,warehouse_id,user_id,access_level,created_at,updated_at) VALUES('access','org','domestic','operation','operator',?,?)").run(fixture.now, fixture.now);
    const cookie = (await createSession("operation", "org", "warehouse", "domestic", slot)).split(";")[0];
    const rejected = await submit(request(cookie, { target: "warehouse", sourceSite: "warehouse", warehouseTo: "/warehouse/inbound?warehouseId=moscow" }, "domestic"));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.has("Set-Cookie")).toBe(false);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM sessions").get()?.n).toBe(1);
  });

  it.each(["disabled", "unassigned-other-org"]) ("rejects an inactive or outside-organization warehouse: %s", async id => {
    await setup();
    const cookie = (await createSession("owner", "org", "admin", null, slot)).split(";")[0];
    expect((await submit(request(cookie, { target: "warehouse", warehouseTo: `/warehouse/inbound?warehouseId=${id}` }))).status).toBe(403);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM sessions").get()?.n).toBe(1);
  });

  it("rejects a normalized path escaping the warehouse site before creating a target session", async () => {
    await setup();
    const cookie = (await createSession("owner", "org", "admin", null, slot)).split(";")[0];
    expect((await submit(request(cookie, { target: "warehouse", warehouseTo: "/warehouse/../../admin/users?warehouseId=moscow" }))).status).toBe(400);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM sessions").get()?.n).toBe(1);
  });
});
