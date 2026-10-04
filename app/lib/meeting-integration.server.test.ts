import { afterEach,beforeEach,describe,it,expect,vi } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";
import { submitMeetingSignature,loadMeetingSettlement,assertMeetingSignoffsComplete } from "./meeting-settlement.server";
import { loadHrReport,saveCommission,generateScheduledHrReports } from "./hr-reports.server";
import { requestDispatchTask,fulfillDispatchTask,refreshAutomaticDispatchTasks } from "./dispatch-tasks.server";
vi.mock("cloudflare:workers",()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{fixture=await meetingFixture();});afterEach(()=>fixture?.database.close());
function fee(direction:string,amount=100){fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,currency,exchange_rate,amount,stage,counterparty_name,created_at,updated_at) VALUES(?,'org','order',?,'FREIGHT','运费','CNY',1,?,'estimated','测试往来',?,?)").run(`fee:${direction}`,direction,amount,fixture.now,fixture.now);}
function exported(){fixture.database.prepare("INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,created_at) VALUES('export','org','order','exported','实际出境',?,?)").run(fixture.now,fixture.now);}
describe("meeting workflow integrated against all real migrations",()=>{
  it("requires export, exact person and sequential AR signatures; never advances transport",async()=>{
    fee("receivable");const input={current:fixture.actors.get("sales")!,orderId:"order",direction:"receivable" as const,action:"confirm" as const,notes:"",refresh:async()=>{}};
    await expect(submitMeetingSignature(fixture.db,input)).rejects.toThrow("实际出境");exported();
    await expect(submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("supervisor")!,action:"finance_review"})).rejects.toThrow("前序");
    await expect(submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("cs")!})).rejects.toThrow("未配置客服");
    await submitMeetingSignature(fixture.db,input);
    await submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("operation")!,action:"business_review"});
    expect(fixture.database.prepare("SELECT stage FROM business_expenses").get()?.stage).toBe("estimated");
    await submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("supervisor")!,action:"finance_review"});
    expect(fixture.database.prepare("SELECT stage FROM business_expenses").get()?.stage).toBe("confirmed");
    expect((await loadMeetingSettlement(fixture.db,"org","order")).order.status).toBe("in_execution");
  });
  it("requires all AP approvals plus recorded offline approval before payment",async()=>{
    fee("payable");exported();const input={current:fixture.actors.get("operation")!,orderId:"order",direction:"payable" as const,action:"confirm" as const,notes:"",refresh:async()=>{}};
    await submitMeetingSignature(fixture.db,input);await submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("supervisor")!,action:"business_review"});
    await expect(assertMeetingSignoffsComplete(fixture.db,"org",["order"],"payable",true)).rejects.toThrow("必办签核");
    await submitMeetingSignature(fixture.db,{...input,current:fixture.actors.get("finance")!,action:"finance_review"});
    await expect(assertMeetingSignoffsComplete(fixture.db,"org",["order"],"payable",true)).rejects.toThrow("线下审批");
    fixture.database.prepare("INSERT INTO order_payable_offline_approvals VALUES('approval','org','order','总经理',?,'proof','finance',?)").run(fixture.now,fixture.now);
    await expect(assertMeetingSignoffsComplete(fixture.db,"org",["order"],"payable",true)).resolves.toBeUndefined();
  });
  it("retains optimistic commission history and filters partial collections out of HR reports",async()=>{
    fee("receivable");fixture.database.exec("UPDATE business_expenses SET stage='confirmed'");
    const input={current:fixture.actors.get("hr")!,orderId:"order",amount:10,status:"pending",paidOn:"",notes:"人工核算",revision:0};
    await saveCommission(fixture.db,input);await saveCommission(fixture.db,{...input,amount:20,revision:1});
    await expect(saveCommission(fixture.db,{...input,revision:1})).rejects.toThrow("其他人修改");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_commission_history").get()?.n).toBe(2);
    expect(await loadHrReport(fixture.db,input.current,"2026-09-01","2026-09-30")).toEqual([]);
    expect(await generateScheduledHrReports(fixture.db,"org",new Date("2026-10-04"))).toEqual({created:2});
    expect(await generateScheduledHrReports(fixture.db,"org",new Date("2026-10-04"))).toEqual({created:0});
  });
  it("creates one dispatch task and deduplicated notices, then validates supplier-linked resources",async()=>{
    fee("receivable");const current=fixture.actors.get("operation")!;
    const request={current,orderId:"order",plannedPortArrivalAt:"2026-10-05T00:00:00Z"};
    expect((await requestDispatchTask(fixture.db,request)).created).toBe(true);expect((await requestDispatchTask(fixture.db,request)).created).toBe(false);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM internal_notifications WHERE category='dispatch_request'").get()?.n).toBe(1);
    await expect(fulfillDispatchTask(fixture.db,{current:fixture.actors.get("commercial")!,orderId:"order",carrierId:"missing",vehicleId:"missing",driverId:"missing",freightAmount:10,currency:"CNY",exchangeRate:1,notes:""})).rejects.toThrow("同一有效运输资源");
    expect(await refreshAutomaticDispatchTasks(fixture.db,"org")).toEqual({created:0,skipped:0});
  });
});
