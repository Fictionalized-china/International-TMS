import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";
import { fulfillDispatchTask, requestDispatchTask } from "./dispatch-tasks.server";

vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture();
  const sql = fixture.database, now = fixture.now;
  sql.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,currency,exchange_rate,amount,stage,counterparty_name,created_at,updated_at) VALUES('fee','org','order','receivable','FREIGHT','运费','CNY',1,100,'estimated','客户',?,?)").run(now, now);
  sql.prepare("INSERT INTO carriers(id,organization_id,code,name,created_at,updated_at) VALUES('carrier','org','CAR','运输商',?,?)").run(now, now);
  sql.prepare("INSERT INTO carrier_vehicles(id,organization_id,carrier_id,plate_number,created_at,updated_at) VALUES('vehicle','org','carrier','车牌',?,?)").run(now, now);
  sql.prepare("INSERT INTO carrier_drivers(id,organization_id,carrier_id,name,created_at,updated_at) VALUES('driver','org','carrier','司机',?,?)").run(now, now);
  await requestDispatchTask(fixture.db, { current: fixture.actors.get("operation")!, orderId: "order", plannedPortArrivalAt: "2026-10-05T00:00:00Z" });
});
afterEach(() => { fixture?.database.close(); vi.restoreAllMocks(); });
const input = () => ({ current: fixture.actors.get("commercial")!, orderId: "order", carrierId: "carrier", vehicleId: "vehicle", driverId: "driver", freightAmount: 100, currency: "CNY", exchangeRate: 1, notes: "已确认资源" });

describe("commercial resource feedback concurrency", () => {
  it("saves linked resources once and treats an identical retry as duplicate", async () => {
    expect(await fulfillDispatchTask(fixture.db, input())).toEqual({ duplicate: false });
    expect(await fulfillDispatchTask(fixture.db, input())).toEqual({ duplicate: true });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='dispatch.resource.fulfill'").get()?.n).toBe(1);
    expect(fixture.database.prepare("SELECT status FROM order_tasks WHERE module_code='dispatch'").get()?.status).toBe("completed");
  });

  it("rejects a changed resource saved between read and commit, without false success audit", async () => {
    const original = fixture.db.batch.bind(fixture.db);
    vi.spyOn(fixture.db, "batch").mockImplementationOnce(async statements => {
      fixture.database.exec("UPDATE order_dispatch_requests SET status='fulfilled',carrier_id='carrier',vehicle_id='vehicle',driver_id='driver',freight_amount=200,freight_currency='CNY',exchange_rate=1,resource_notes='其他人的资源' WHERE order_id='order'");
      return original(statements);
    });
    await expect(fulfillDispatchTask(fixture.db, input())).rejects.toThrow("已由其他提交更新");
    expect(fixture.database.prepare("SELECT freight_amount FROM order_dispatch_requests").get()?.freight_amount).toBe(200);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='dispatch.resource.fulfill'").get()?.n).toBe(0);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM internal_notifications WHERE category='dispatch_ready'").get()?.n).toBe(0);
  });
});
