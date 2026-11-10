import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture } from "./meeting-integration-fixture";
import { defaultBusinessProcessPolicy } from "./business-process-policy";
import { listIntakePeople,resolveIntakeOperations } from "./intake-operations.server";
import { intakeOperationFields,intakeOperationFormName,missingIntakeOperations } from "./intake-operations";
vi.mock("cloudflare:workers",()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{fixture=await meetingFixture();Object.assign(env,{DB:fixture.db});});
afterEach(()=>fixture?.database.close());
const policy=()=>({isActive:true,isRequired:false});
const resolve=(form:FormData,existing?:string,direct=true)=>resolveIntakeOperations({organizationId:"org",form,existing,direct,policy,processPolicy:defaultBusinessProcessPolicy});
function valid(){const f=new FormData();Object.entries({headCarrier:"头程计划",tailCarrier:"口岸调度",headVehicleCount:"1",tailVehicleCount:"2",plannedDeparture:"2026-11-10T09:00",plannedArrival:"2026-11-12T09:00",businessAssistant:"sales",customerService:"cs",entrustedServices:"pickup"}).forEach(([key,value])=>f.set(`intake_${key}`,value));return f;}
describe("planned intake facts",()=>{
  it("reports all missing values at once without fabricating legacy plans",async()=>{
    await expect(resolve(new FormData())).rejects.toThrow(/头程承运人.*头程车量.*尾程车量.*预计发车.*预计到达.*业务助理.*客服.*委托服务/);
    expect(missingIntakeOperations({})).toHaveLength(9);
  });
  it("uses one shared scoped candidate list and exposes no employee contacts",async()=>{
    expect(await listIntakePeople("org",defaultBusinessProcessPolicy)).toEqual({quoteCommercials:[{id:"commercial",display_name:"commercial"}],businessAssistant:[{id:"sales",display_name:"sales"},{id:"cs",display_name:"cs"}],customerService:[{id:"cs",display_name:"cs"}]});
  });
  it("keeps valid historical responsibility after account deactivation, but refuses a newly selected disabled one",async()=>{
    const existing=(await resolve(valid()))!;
    fixture.database.exec("UPDATE users SET status='disabled' WHERE id='cs'");
    expect(await resolve(valid(),existing)).toBe(existing);
    await expect(resolve(valid())).rejects.toThrow("客服");
  });
  it("does not populate absent or hidden auxiliary fields and does not clear their historical values",async()=>{
    expect(await resolve(new FormData(),undefined,false)).toBeNull();
    const existing=(await resolve(valid()))!;
    const form=valid();form.set("intake_headCarrier","hidden override");
    expect(await resolveIntakeOperations({organizationId:"org",form,existing,direct:false,policy:()=>({isActive:false,isRequired:false}),processPolicy:defaultBusinessProcessPolicy})).toBe(existing);
  });
  it.each(intakeOperationFields.map(field=>field.key))("rejects file substitution for %s",async key=>{
    const form=valid();form.set(intakeOperationFormName(key),new File(["x"],"x.txt"));
    await expect(resolve(form)).rejects.toThrow("不能用文件代替");
  });
  it("retains canonical UTC facts when editing unrelated fields",async()=>{
    const existing=(await resolve(valid()))!;const form=new FormData();form.set("intake_headCarrier","更正计划");
    const next=JSON.parse((await resolve(form,existing))!);expect(next.headCarrier).toBe("更正计划");expect(next.plannedDeparture).toBe("2026-11-10T01:00:00.000Z");
  });
});
