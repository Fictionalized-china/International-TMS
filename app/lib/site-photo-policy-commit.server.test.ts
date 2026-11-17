import {afterEach,describe,expect,it} from "vitest";
import {meetingFixture} from "./meeting-integration-fixture";
import {saveBusinessProcessPolicy,loadBusinessProcessPolicy} from "./business-process-policy.server";
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
afterEach(()=>fixture?.database.close());
describe("photo policy changes cannot create an upload/mandatory deadlock",()=>{
  it("rejects invalid merged partial configuration without writing policies or history",async()=>{
    fixture=await meetingFixture();
    await saveBusinessProcessPolicy({organizationId:"org",userId:"owner",values:{"photos.required_stages":"delivery"}},fixture.db);
    await expect(saveBusinessProcessPolicy({organizationId:"org",userId:"owner",values:{"photos.enabled_stages":"pickup"}},fixture.db)).rejects.toThrow("必须同时开放");
    expect((await loadBusinessProcessPolicy("org",fixture.db))["photos.required_stages"]).toBe("delivery");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM business_process_policy_history").get()?.n).toBe(1);
  });
  it("refuses a concurrent edit of the mandatory-stage policy in the same commit transaction",async()=>{
    fixture=await meetingFixture();const original=fixture.db.batch.bind(fixture.db);
    fixture.db.batch=async statements=>{fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','photos.required_stages','delivery',?)").run(fixture.now);return original(statements);};
    await expect(saveBusinessProcessPolicy({organizationId:"org",userId:"owner",values:{"photos.enabled_stages":"pickup"}},fixture.db)).rejects.toThrow("刷新后核对");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM business_process_policy_history").get()?.n).toBe(0);
    expect((await loadBusinessProcessPolicy("org",fixture.db))["photos.enabled_stages"]).toContain("delivery");
  });
});
