import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "./sqlite-d1-test-helper";
vi.mock("cloudflare:workers", () => ({ env: {} }));
import { loadBusinessProcessPolicy, saveBusinessProcessPolicy } from "./business-process-policy.server";
let database: DatabaseSync;
let db: D1Database;
beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE positions(organization_id TEXT,code TEXT,status TEXT);
    CREATE TABLE business_process_policies(organization_id TEXT,policy_key TEXT,policy_value TEXT,updated_by_user_id TEXT,updated_at TEXT,PRIMARY KEY(organization_id,policy_key));
    CREATE TABLE business_process_policy_history(id TEXT PRIMARY KEY,organization_id TEXT,policy_key TEXT,old_value TEXT,new_value TEXT,actor_user_id TEXT,created_at TEXT);
    INSERT INTO positions VALUES('org','TRACKING','active');`);
  db = sqliteD1(database);
});
afterEach(() => database.close());
describe("persisted process policy", () => {
  it("keeps organization isolation and an audit trail on hot changes", async () => {
    await saveBusinessProcessPolicy({organizationId:"org",userId:"configurer",values:{"tracking.positions":"TRACKING"}},db);
    await saveBusinessProcessPolicy({organizationId:"org",userId:"configurer",values:{"tracking.daily_enabled":"0"}},db);
    expect((await loadBusinessProcessPolicy("org",db))["tracking.daily_enabled"]).toBe("0");
    expect((await loadBusinessProcessPolicy("other",db))["tracking.daily_enabled"]).toBe("1");
    expect(database.prepare("SELECT COUNT(*) n FROM business_process_policy_history").get()?.n).toBe(2);
  });
  it("rolls the policy back if the associated customer configuration fails", async () => {
    await expect(saveBusinessProcessPolicy({organizationId:"org",userId:"configurer",values:{"tracking.daily_enabled":"0"},additionalStatements:[db.prepare("INSERT INTO missing_table VALUES(1)")]},db)).rejects.toThrow();
    expect((await loadBusinessProcessPolicy("org",db))["tracking.daily_enabled"]).toBe("1");
    expect(database.prepare("SELECT COUNT(*) n FROM business_process_policy_history").get()?.n).toBe(0);
  });
  it("rejects a deleted role without saving an unusable actor", async () => {
    await expect(saveBusinessProcessPolicy({organizationId:"org",userId:"configurer",values:{"tracking.positions":"NO_SUCH_ROLE"}},db)).rejects.toThrow("已停用或不存在");
  });
});
