import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture } from "./meeting-integration-fixture";
import { listIntakeDrafts,loadIntakeDraft,markIntakeDraftSubmitted,saveIntakeDraft,intakeDraftSubmissionGuard } from "./intake-drafts.server";
vi.mock("cloudflare:workers",()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{fixture=await meetingFixture();Object.assign(env,{DB:fixture.db});});
afterEach(()=>fixture?.database.close());
const id="request-draft-00001";
const payload=JSON.stringify({fields:[["intakeRequestId",id],["weight",""],["volume","0"],["cargoDescription","草稿货物"]],filesOmitted:[]});
function save(revision=0,current=fixture.actors.get("sales")!){return saveIntakeDraft({current,id,revision,payload,request:new Request("http://localhost/admin/quotations")});}
describe("scoped intake drafts against real migrations",()=>{
  it("rechecks the revision inside the write transaction, not just at read time",async()=>{
    await save();const guard=intakeDraftSubmissionGuard(fixture.actors.get("sales")!,id,1,fixture.now);
    fixture.database.prepare("UPDATE order_intake_drafts SET revision=2 WHERE id=?").run(id);
    await expect(fixture.db.batch([guard,fixture.db.prepare("UPDATE transport_orders SET cargo_description='must not commit' WHERE id='order'")])).rejects.toThrow();
    expect(fixture.database.prepare("SELECT cargo_description FROM transport_orders WHERE id='order'").get()).toMatchObject({cargo_description:"测试货"});
  });
  it("saves incomplete data and restores it without creating any downstream facts",async()=>{
    const before=["transport_orders","quotations","business_expenses","order_cargo_packages","order_tasks","workflow_instances"].map(table=>fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get());
    expect(await save()).toMatchObject({id,revision:1});
    expect(await loadIntakeDraft(fixture.actors.get("sales")!,id)).toMatchObject({id,revision:1,payload:JSON.parse(payload)});
    expect(await listIntakeDrafts(fixture.actors.get("sales")!)).toMatchObject([{id,title:"草稿货物",revision:1}]);
    expect(["transport_orders","quotations","business_expenses","order_cargo_packages","order_tasks","workflow_instances"].map(table=>fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get())).toEqual(before);
  });
  it("does not let boss or another user read or overwrite someone else's draft",async()=>{
    await save();const owner=fixture.actors.get("owner")!;
    expect(await listIntakeDrafts(owner)).toEqual([]);await expect(loadIntakeDraft(owner,id)).rejects.toThrow("不属于当前账号");await expect(save(1,owner)).rejects.toThrow("其他窗口");
    expect((await loadIntakeDraft(fixture.actors.get("sales")!,id)).revision).toBe(1);
  });
  it("checks organization as well as owner and permission",async()=>{
    await save();const sales=fixture.actors.get("sales")!;
    await expect(loadIntakeDraft({...sales,organizationId:"other"},id)).rejects.toThrow();
    await expect(loadIntakeDraft({...sales,permissions:[]},id)).rejects.toThrow("草稿权限");
  });
  it("rejects stale saves without replacing newer fields or adding a false audit",async()=>{
    await save();expect(await save(1)).toMatchObject({revision:2});
    expect(await save(1)).toMatchObject({revision:2}); // Exact lost-response retry is not another revision or audit.
    await expect(saveIntakeDraft({current:fixture.actors.get("sales")!,id,revision:1,payload:payload.replace("草稿货物","另一窗口的旧稿"),request:new Request("http://localhost/admin/quotations")})).rejects.toThrow("其他窗口");
    await expect(save()).rejects.toThrow("已保存");
    expect((await loadIntakeDraft(fixture.actors.get("sales")!,id)).revision).toBe(2);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='order.intake_draft.save'").get()).toMatchObject({n:2});
  });
  it("only hides a draft after an actual order exists under the same creator and organization",async()=>{
    await save();const sales=fixture.actors.get("sales")!;
    await markIntakeDraftSubmitted(sales,id,"missing");expect(await listIntakeDrafts(sales)).toHaveLength(1);
    await markIntakeDraftSubmitted(sales,id,"order");expect(await listIntakeDrafts(sales)).toEqual([]);
    await expect(save(1)).rejects.toThrow("转单");await expect(loadIntakeDraft(sales,id)).rejects.toThrow("已转单");
  });
});
