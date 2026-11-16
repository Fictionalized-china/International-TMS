import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetingFixture } from "./meeting-integration-fixture";
import { hrConsignmentCsv, loadHrConsignments } from "./hr-consignments.server";
import { readHrConsignmentFilters } from "./hr-consignments";
import { loadHrReport } from "./hr-reports.server";
import { recordCashTransaction, allocateCashTransaction } from "./settlement-workbench.server";
import { plannedCostIntegrationStatements } from "./planning-cost-integration.server";
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("./order-review.server", () => ({ refreshOrderCompletionStatus: async () => {} }));
vi.mock("./order-modules.server", () => ({ syncCostsModuleStatus: async () => {}, syncOrderWorkflowSnapshot: async () => {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
const filters = (query = "") => readHrConsignmentFilters(new URLSearchParams(query), { from: "2026-09-01", to: "2026-09-30" });
beforeEach(async () => {
  fixture = await meetingFixture();
  fixture.database.exec("UPDATE transport_orders SET quote_commercial_user_id='commercial',quote_commercial_name_snapshot='报价商务快照' WHERE id='order'");
});
afterEach(() => fixture?.database.close());
const load = (query = "") => loadHrConsignments(fixture.db, fixture.actors.get("hr")!, filters(query));
function fee(id: string, amount = 100, stage = "confirmed", direction = "receivable", rate = 1) {
  fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,stage,created_at,updated_at) VALUES(?,'org','order',?,'FREIGHT','运费','测试往来','CNY',1,?,?,?,?,?,?)").run(id, direction, amount, amount, rate, stage, fixture.now, fixture.now);
}
async function receive(amount: number, allocate: number) {
  const cash = await recordCashTransaction(fixture.db, { organizationId: "org", direction: "receipt", counterpartyName: "测试往来", currency: "CNY", amount, occurredOn: "2026-09-20", settlementEntity: "公司", accountName: "PRIVATE-BANK", handledByUserId: "cashier", userId: "cashier", now: fixture.now, requestId: crypto.randomUUID(), assertCanMutate: async () => {} });
  if (allocate) {
    fixture.database.prepare("INSERT INTO settlement_reconciliations(id,organization_id,document_number,direction,counterparty_name,settlement_entity,currency,total_amount,status,created_at,updated_at) VALUES('ar','org','AR-TEST','receivable','测试往来','公司','CNY',100,'confirmed',?,?)").run(fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO settlement_reconciliation_lines(id,organization_id,reconciliation_id,expense_id,amount,created_at) VALUES('line','org','ar','ar-fee',100,?)").run(fixture.now);
    await allocateCashTransaction(fixture.db, { organizationId: "org", transactionId: cash.id, reconciliationId: "ar", amount: allocate, userId: "cashier", now: fixture.now, requestId: crypto.randomUUID(), assertCanMutate: async () => {} });
  }
  return cash;
}
describe("HR all-consignment read model", () => {
  it("filters and exports manual business classifications separately from FTL/LTL",async()=>{
    fixture.database.prepare("UPDATE transport_orders SET intake_operations_json=? WHERE id='order'").run(JSON.stringify({businessMajor:'国际运输',businessKind:'项目货'}));
    const data=await load('businessMajor=国际&businessKind=项目&businessType=ltl');
    expect(data.rows).toHaveLength(1);expect(data.rows[0]).toMatchObject({businessMajor:'国际运输',businessKind:'项目货',business_type:'ltl'});
    expect(data.rows[0]).not.toHaveProperty('intake_operations_json');expect(hrConsignmentCsv(data.rows)).toContain('国际运输');
    expect((await load('businessKind=整车')).rows).toHaveLength(0);
  });
  it("includes uncollected/draft orders and preserves quotation identity without guessing", async () => {
    fixture.database.exec("UPDATE transport_orders SET status='draft'");
    const data = await load(); expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ quote_commercial_user_id: "commercial", quote_commercial_name_snapshot: "报价商务快照", salesperson_user_id: "sales", creator_name: "sales", receiptState: "unrecorded", commissionEligible: false });
    fixture.database.exec("UPDATE transport_orders SET quote_commercial_user_id=NULL,quote_commercial_name_snapshot=NULL");
    expect(hrConsignmentCsv((await load()).rows)).toContain("历史未记录");
  });
  it("separates estimated/confirmed/zero amounts and excludes cancelled rows", async () => {
    fee("ar-fee"); fee("pending-ar", 20, "estimated"); fee("ap", 5, "confirmed", "payable", 7); fee("zero", 0, "confirmed", "payable"); fee("cancelled", 1000, "cancelled");
    const row = (await load()).rows[0];
    expect(row.amounts).toMatchObject({ estimatedReceivable: 20, confirmedReceivable: 100, estimatedPayable: 0, confirmedPayable: 35, receiptAllocated: 0, paymentAllocated: 0 });
    expect(row.receiptState).toBe("unconfirmed"); expect(row.paymentState).toBe("unpaid");
  });
  it("does not count registered but unallocated money as paid", async () => {
    fee("ar-fee"); await receive(100, 0);
    expect((await load()).rows[0]).toMatchObject({ receiptState: "unpaid", commissionEligible: false, amounts: { receiptAllocated: 0 } });
    expect(JSON.stringify(await load())).not.toContain("PRIVATE-BANK");
  });
  it.each([50, 100])("agrees with the existing paid report at %s actually allocated", async allocated => {
    fee("ar-fee"); await receive(100, allocated);
    const row = (await load()).rows[0];
    expect(row).toMatchObject({ receiptState: allocated === 100 ? "cleared" : "partial", commissionEligible: allocated === 100, amounts: { receiptAllocated: allocated } });
    const paid = await loadHrReport(fixture.db, fixture.actors.get("hr")!, "2026-09-01", "2026-09-30");
    expect(paid.some(item => item.id === row.id)).toBe(row.commissionEligible);
  });
  it("filters person/type/state from the same scoped rows and neutralizes CSV formula text", async () => {
    fee("ar-fee"); fixture.database.exec("UPDATE transport_orders SET quote_commercial_name_snapshot='=EXEC()'");
    expect((await load("commercial=commercial&salesperson=sales&businessType=ltl&receipt=unpaid")).rows).toHaveLength(1);
    for (const query of ["commercial=owner", "salesperson=owner", "businessType=ftl", "receipt=cleared", "payment=partial", "commercial=%27%20OR%201%3D1--"]) expect((await load(query)).rows).toHaveLength(0);
    expect(hrConsignmentCsv((await load()).rows)).toContain("'=EXEC()");
  });
  it("hides financial amounts in both the response and CSV without amount visibility", async () => {
    fee("ar-fee", 912345.67);
    const actor = { ...fixture.actors.get("hr")!, permissions: fixture.actors.get("hr")!.permissions.filter(p => p !== "hr.report.amount.view") };
    const data = await loadHrConsignments(fixture.db, actor, filters());
    expect(data.rows[0].amounts).toBeNull(); expect(JSON.stringify(data)).not.toContain("912345"); expect(hrConsignmentCsv(data.rows)).not.toContain("912345");
  });
  it("displays confirmed batch allocation separately without adding it to payable a second time", async () => {
    const db = fixture.database, now = fixture.now;
    fee("other-ap", 10, "confirmed", "payable");
    db.prepare("INSERT INTO warehouses(id,organization_id,code,name,created_at,updated_at) VALUES('wh','org','WH','仓库',?,?)").run(now, now);
    db.prepare("INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES('zone','org','wh','Z','收货区',?,?)").run(now, now);
    db.prepare("INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES('location','org','wh','zone','L','库位',?,?)").run(now, now);
    db.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,created_at,updated_at) VALUES('shipment','org','SHP','order','customer',?,?)").run(now, now);
    db.prepare("INSERT INTO warehouse_receipts(id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,cargo_complete,received_at,created_at,updated_at) VALUES('receipt','org','IN-TEST','shipment','wh','location',1,?,?,?)").run(now, now, now);
    db.prepare("INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,warehouse_id,approval_status,approved_by_user_id,created_at,updated_at) VALUES('batch','org','order','PZ-TEST','配载','国内仓','目的仓','wh','draft','supervisor',?,?)").run(now, now);
    db.prepare("INSERT INTO loading_planning_submissions(organization_id,actor_user_id,request_id,payload_hash,batch_id,result_json,created_at,updated_at) VALUES('org','supervisor','plan-hr-test','hash','batch','{}',?,?)").run(now, now);
    db.prepare("INSERT INTO warehouse_packing_jobs(id,organization_id,warehouse_id,order_id,shipment_id,transport_batch_id,packing_mode,source_package_count,outbound_package_count,total_weight_kg,total_volume_cbm,status,created_at,updated_at) VALUES('job','org','wh','order','shipment','batch','preserve',1,1,100,1,'allocated',?,?)").run(now, now);
    db.prepare("INSERT INTO transport_batch_orders(id,organization_id,batch_id,order_id,created_at,updated_at) VALUES('mount','org','batch','order',?,?)").run(now, now);
    db.prepare("INSERT INTO transport_cost_allocations(id,organization_id,batch_id,charge_code,charge_name,counterparty_name,total_amount,allocation_method,density_result,created_by_user_id,creation_mode,created_at,updated_at) VALUES('allocation','org','batch','OVERSEAS_TRANSPORT','境外运输费','供应商',10,'equal','equal','supervisor','planning',?,?)").run(now, now);
    db.prepare("INSERT INTO transport_cost_allocation_lines(id,organization_id,allocation_id,order_id,final_amount,created_at,updated_at) VALUES('allocation-line','org','allocation','order',10,?,?)").run(now, now);
    await fixture.db.batch(plannedCostIntegrationStatements(fixture.db, { organizationId: "org", allocationId: "allocation", actorUserId: "supervisor", currency: "CNY", exchangeRate: 1, counterparty: "供应商", now, lines: [{ id: "allocation-line", orderId: "order", amount: 10 }] }));
    const row = (await load()).rows[0]; expect(row.amounts).toMatchObject({ confirmedPayable: 10, estimatedPayable: 10, confirmedAllocation: 10 });
    expect(db.prepare("SELECT COUNT(*) n FROM business_expenses").get()).toEqual({ n: 2 });
  });
  it("checks organization, scoped-order permissions and report permission", async () => {
    const actor = fixture.actors.get("hr")!;
    expect((await loadHrConsignments(fixture.db, { ...actor, organizationId: "other" }, filters())).rows).toEqual([]);
    expect((await loadHrConsignments(fixture.db, { ...actor, permissions: ["hr.report.view"], dataScope: "self", positionCode: null }, filters())).rows).toEqual([]);
    await expect(loadHrConsignments(fixture.db, { ...actor, permissions: [] }, filters())).rejects.toThrow("人事报表权限");
  });
  it("uses Beijing dates for a legacy order without order_date at UTC midnight boundaries", async () => {
    fixture.database.exec("UPDATE transport_orders SET order_date=NULL,created_at='2026-08-31T16:30:00Z'");
    expect((await load("from=2026-09-01&to=2026-09-01")).rows[0].order_date).toBe("2026-09-01");
    expect((await load("from=2026-08-31&to=2026-08-31")).rows).toHaveLength(0);
    fixture.database.exec("UPDATE transport_orders SET order_date='2026-08-31'");
    expect((await load("from=2026-08-31&to=2026-08-31")).rows).toHaveLength(1);
  });
  it("validates real dates and known statuses, including direct service calls", async () => {
    for (const query of ["from=2026-02-30", "from=2026-10-01&to=2026-09-01", "receipt=__proto__", "payment=toString", "businessType=unknown"]) expect(() => filters(query)).toThrow();
    await expect(loadHrConsignments(fixture.db, fixture.actors.get("hr")!, { ...filters(), receipt: "unexpected" })).rejects.toThrow("核销状态");
  });
  it("keeps the newest saved name for each quoted identity and distinguishes namesakes in filters", async () => {
    const original = fixture.database.prepare("SELECT * FROM transport_orders WHERE id='order'").get()!;
    for (const [id, commercial] of [["newer-quote", "commercial"], ["namesake-quote", "owner"]]) {
      const row = { ...original, id, order_number: id, created_at: "2026-09-02T00:00:00Z", quote_commercial_user_id: commercial, quote_commercial_name_snapshot: "最近报价人" }, keys = Object.keys(row);
      fixture.database.prepare(`INSERT INTO transport_orders(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key as keyof typeof row]));
    }
    const options = (await load()).commercialOptions;
    expect(options).toHaveLength(2); expect(options.every(person => person.name.startsWith("最近报价人（"))).toBe(true); expect(new Set(options.map(person => person.name)).size).toBe(2);
  });
});
