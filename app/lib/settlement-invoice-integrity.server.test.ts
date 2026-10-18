import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {meetingFixture} from "./meeting-integration-fixture";
vi.mock("cloudflare:workers",()=>({env:{}}));
vi.mock("./order-review.server",()=>({refreshOrderCompletionStatus:async()=>{}}));
vi.mock("./order-modules.server",()=>({syncCostsModuleStatus:async()=>{},syncOrderWorkflowSnapshot:async()=>{}}));
import {recordSettlementInvoice} from "./settlement-workbench.server";
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
const input={organizationId:"org",reconciliationId:"rec",amount:40,invoiceCompany:"测试公司",invoiceType:"发票",invoiceNumber:"TEST-INVOICE",invoiceDate:"2026-10-18",taxRate:0,titleName:"测试",exchangeRate:1,userId:"finance",now:"2026-10-18T00:00:00Z",requestId:"invoice-request-0001",assertCanMutate:async()=>{}};
beforeEach(async()=>{
  fixture=await meetingFixture();
  fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,currency,exchange_rate,amount,stage,counterparty_name,created_at,updated_at) VALUES('fee','org','order','receivable','FREIGHT','运费','CNY',1,100,'confirmed','测试',?,?)").run(fixture.now,fixture.now);
  fixture.database.prepare("INSERT INTO settlement_reconciliations(id,organization_id,document_number,direction,counterparty_name,customer_id,settlement_entity,currency,total_amount,status,created_by_user_id,created_at,updated_at) VALUES('rec','org','REC-TEST','receivable','测试','customer','测试公司','CNY',100,'confirmed','finance',?,?)").run(fixture.now,fixture.now);
  fixture.database.prepare("INSERT INTO settlement_reconciliation_lines(id,organization_id,reconciliation_id,expense_id,amount,created_at) VALUES('line','org','rec','fee',100,?)").run(fixture.now);
});
afterEach(()=>fixture.database.close());
describe("invoice integrity against real schema",()=>{
  it("replays a lost-response submission without a second invoice or allocation",async()=>{
    const first=await recordSettlementInvoice(fixture.db,input);
    expect(await recordSettlementInvoice(fixture.db,input)).toEqual(first);
    expect(fixture.database.prepare("SELECT COUNT(*) n,SUM(amount) amount FROM settlement_invoice_records").get()).toEqual({n:1,amount:40});
    expect(fixture.database.prepare("SELECT COUNT(*) n,SUM(amount) amount FROM settlement_invoice_allocations").get()).toEqual({n:1,amount:40});
    await expect(recordSettlementInvoice(fixture.db,{...input,amount:50})).rejects.toThrow("内容不同");
  });
  it("rejects a stale allocation and rolls back the invoice header",async()=>{
    await recordSettlementInvoice(fixture.db,{...input,amount:80});
    // Model a request that read 100 outstanding before another transaction consumed 80.
    const original=fixture.db.prepare.bind(fixture.db);
    const staleDb={...fixture.db,prepare:(sql:string)=>{
      if(sql.startsWith("SELECT l.expense_id,l.amount-"))return {bind(){return this},all:async()=>({results:[{expense_id:"fee",outstanding:100}]})};
      return original(sql);
    }} as D1Database;
    await expect(recordSettlementInvoice(staleDb,{...input,requestId:"invoice-request-0002"})).rejects.toThrow("余额或对账状态已变化");
    expect(fixture.database.prepare("SELECT COUNT(*) n,SUM(amount) amount FROM settlement_invoice_records").get()).toEqual({n:1,amount:80});
  });
});
