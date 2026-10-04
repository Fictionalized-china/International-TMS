import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { sqliteD1 } from "./sqlite-d1-test-helper";
import type { SessionUser } from "./auth.server";
vi.mock("cloudflare:workers",()=>({env:{}}));
import { recordDailyTracking } from "./daily-tracking.server";
import { dailyTrackingAccess } from "./daily-tracking";
import { defaultBusinessProcessPolicy } from "./business-process-policy";
import { dispatchIsDue,dispatchTaskAccess } from "./dispatch-tasks";
let sql:DatabaseSync,db:D1Database;
const current:SessionUser={sessionId:"s",organizationName:"测试",email:"tracker@test.local",displayName:"运踪",site:"admin",departmentId:null,departmentCode:null,warehouseIds:[],regionCountryCodes:[],userId:"tracker",organizationId:"org",positionCode:"TRACKING",permissions:["tracking.daily.manage"],roleCodes:[],dataScope:"company"};
const input=()=>({current,orderId:"order",requestId:"request-one-123",eventKind:"pickup",eventAt:"2026-09-01T01:00:00Z",location:"深圳",vehicleReference:"粤B123",notes:"工厂提货，已装车",visibleToCustomer:true});
beforeEach(()=>{
  sql=new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE transport_orders(id TEXT,organization_id TEXT,status TEXT);
    CREATE TABLE shipments(id TEXT,organization_id TEXT,order_id TEXT,status TEXT,actual_pickup_at TEXT,current_location TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE shipment_events(id TEXT PRIMARY KEY,shipment_id TEXT,status TEXT,location TEXT,description TEXT,event_at TEXT,visible_to_customer INT,created_by_user_id TEXT,created_at TEXT);
    CREATE TABLE audit_logs(id TEXT,organization_id TEXT,actor_user_id TEXT,action TEXT,resource_type TEXT,resource_id TEXT,outcome TEXT,metadata_json TEXT,created_at TEXT);
    CREATE TABLE business_process_policies(organization_id TEXT,policy_key TEXT,policy_value TEXT);
    CREATE TABLE permissions(code TEXT PRIMARY KEY,module TEXT,name TEXT,description TEXT);CREATE TABLE roles(id TEXT,code TEXT,status TEXT);
    CREATE TABLE role_permissions(role_id TEXT,permission_code TEXT,UNIQUE(role_id,permission_code));CREATE TABLE position_portal_settings(position_id TEXT,business_data_scope TEXT);CREATE TABLE positions(id TEXT,code TEXT);
    INSERT INTO transport_orders VALUES('order','org','in_execution');INSERT INTO shipments VALUES('shipment','org','order','booked',NULL,NULL,'2026-09-01','2026-09-01');`);
  sql.exec(readFileSync(new URL("../../migrations/0170_daily_tracking_and_dispatch.sql",import.meta.url),"utf8"));db=sqliteD1(sql);
});
afterEach(()=>sql.close());
describe("independent daily tracking",()=>{
  it("publishes full notes and vehicle; allows repeated daily locations without advancing workflow",async()=>{
    await recordDailyTracking(db,input());
    const first={...input(),requestId:"request-two-123",eventKind:"location",eventAt:"2026-09-02T01:00:00Z"};await recordDailyTracking(db,first);
    await recordDailyTracking(db,{...first,requestId:"request-three-123",eventAt:"2026-09-03T01:00:00Z"});
    expect(sql.prepare("SELECT COUNT(*) n FROM shipment_events").get()?.n).toBe(3);
    expect(sql.prepare("SELECT description FROM shipment_events LIMIT 1").get()?.description).toContain("车号：粤B123");
    expect(sql.prepare("SELECT status FROM transport_orders").get()?.status).toBe("in_execution");
  });
  it("deduplicates identical retries and rejects changed request content",async()=>{
    await recordDailyTracking(db,input());expect(await recordDailyTracking(db,input())).toEqual({duplicate:true});
    await expect(recordDailyTracking(db,{...input(),notes:"不同内容"})).rejects.toThrow("内容已变化");
    expect(sql.prepare("SELECT COUNT(*) n FROM order_daily_tracking").get()?.n).toBe(1);
  });
  it("rolls back the journal and event if audit fails",async()=>{
    sql.exec("DROP TABLE audit_logs");await expect(recordDailyTracking(db,input())).rejects.toThrow();
    expect(sql.prepare("SELECT COUNT(*) n FROM shipment_events").get()?.n).toBe(0);
    expect(sql.prepare("SELECT actual_pickup_at FROM shipments").get()?.actual_pickup_at).toBeNull();
  });
  it("rejects cross-organization writes and completed transport",async()=>{
    await expect(recordDailyTracking(db,{...input(),current:{...current,organizationId:"other"}})).rejects.toThrow("不存在");
    sql.exec("UPDATE shipments SET status='delivered'");await expect(recordDailyTracking(db,input())).rejects.toThrow("运输已结束");
  });
  it("hot-unplug preserves records but prevents new actions",async()=>{
    await recordDailyTracking(db,input());sql.exec("INSERT INTO business_process_policies VALUES('org','tracking.daily_enabled','0')");
    await expect(recordDailyTracking(db,{...input(),requestId:"new-request-123"})).rejects.toThrow("已停用");
    expect(sql.prepare("SELECT COUNT(*) n FROM shipment_events").get()?.n).toBe(1);
  });
  it("does not grant permission by role label alone or accept milestones as daily logs",()=>{
    expect(dailyTrackingAccess({policy:defaultBusinessProcessPolicy,positionCode:"TRACKING",permissions:[],orderStatus:"in_execution",eventKind:"pickup",pickupAt:null})).toContain("没有");
    expect(dailyTrackingAccess({policy:defaultBusinessProcessPolicy,positionCode:"TRACKING",permissions:current.permissions,orderStatus:"in_execution",eventKind:"actual_exit",pickupAt:null})).toContain("类型无效");
  });
});
describe("dispatch policy boundaries",()=>{
  it("uses configurable lead time and requires an actual plan",()=>{
    expect(dispatchIsDue(null,3,new Date("2026-09-01"))).toBe(false);
    expect(dispatchIsDue("2026-09-05",3,new Date("2026-09-01"))).toBe(false);
    expect(dispatchIsDue("2026-09-04",3,new Date("2026-09-01"))).toBe(true);
  });
  it("keeps commercial feedback and request permissions separate",()=>{
    expect(dispatchTaskAccess(defaultBusinessProcessPolicy,"BUSINESS_ROUTE",["dispatch.manage"],"fulfill")).toBeNull();
    expect(dispatchTaskAccess(defaultBusinessProcessPolicy,"BUSINESS_ROUTE",["dispatch.manage"],"request")).toBeTruthy();
    expect(dispatchTaskAccess({...defaultBusinessProcessPolicy,"dispatch.enabled":"0"},"BUSINESS_ROUTE",["dispatch.manage"],"fulfill")).toBeTruthy();
  });
});
