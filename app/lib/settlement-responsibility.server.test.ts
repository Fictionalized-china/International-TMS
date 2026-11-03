import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingFixture, seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
const harness = vi.hoisted(() => ({ db: null as unknown as D1Database }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
import { loadMeetingSettlement, submitMeetingSignature } from "./meeting-settlement.server";
import { meetingSignatureAccess, settlementActionOwners } from "./meeting-settlement";
import { loadOrderModuleWorkflowFields, expenseLedgerFieldPresent } from "./workflow-fields.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => {if(fixture?.database.isOpen)fixture.database.close();});
async function setup() {
  fixture = await meetingFixture(); harness.db = fixture.db;
  seedFrozenMeetingWorkflow(fixture);
  fixture.database.prepare("INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,created_at) VALUES('export','org','order','exported','实际出境',?,?)").run(fixture.now, fixture.now);
  fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,counterparty_name,quantity,unit_price,amount,created_by_user_id,created_at,updated_at) VALUES('ar','org','order','receivable','freight','运费','客户',1,100,100,'cs',?,?)").run(fixture.now, fixture.now);
}
describe("settlement canonical responsibility and valid zero fees", () => {
  it("allows the assigned CS to initiate AR without granting customer order-entry permission, then enforces the remaining chain", async () => {
    await setup();
    expect(fixture.database.prepare("SELECT cs_order_entry_enabled FROM customers WHERE id='customer'").get()?.cs_order_entry_enabled).toBe(0);
    const state = await loadMeetingSettlement(fixture.db, "org", "order");
    expect(meetingSignatureAccess(state, fixture.actors.get("cs")!, "receivable", "confirm")).toBeNull();
    const base = { orderId: "order", direction: "receivable" as const, notes: "", refresh: async () => {} };
    await submitMeetingSignature(fixture.db, { ...base, current: fixture.actors.get("cs")!, action: "confirm" });
    await expect(submitMeetingSignature(fixture.db, { ...base, current: fixture.actors.get("supervisor")!, action: "finance_review" })).rejects.toThrow("前序");
    await submitMeetingSignature(fixture.db, { ...base, current: fixture.actors.get("operation")!, action: "business_review" });
    await submitMeetingSignature(fixture.db, { ...base, current: fixture.actors.get("supervisor")!, action: "finance_review" });
    expect(fixture.database.prepare("SELECT stage FROM business_expenses WHERE id='ar'").get()?.stage).toBe("confirmed");
    expect(fixture.database.prepare("SELECT cs_order_entry_enabled FROM customers WHERE id='customer'").get()?.cs_order_entry_enabled).toBe(0);
  });
  it("uses the direct operation supervisor instead of the stale assignment-module owner", async () => {
    await setup();
    fixture.database.exec("UPDATE order_module_instances SET assignee_user_id='operation' WHERE module_code='assignment'");
    const state = await loadMeetingSettlement(fixture.db, "org", "order");
    expect(settlementActionOwners(state, "receivable", "finance_review").map(user => user.userId)).toEqual(["supervisor"]);
    expect(settlementActionOwners(state, "payable", "business_review").map(user => user.userId)).toEqual(["supervisor"]);
  });
  it("honors configured signature roles and rejects unrelated people even when they have the signature permission", async () => {
    await setup();
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','receivable.review_positions','FINANCE_ACCOUNTING',?)").run(fixture.now);
    await submitMeetingSignature(fixture.db, { current: fixture.actors.get("cs")!, orderId: "order", direction: "receivable", action: "confirm", notes: "", refresh: async () => {} });
    const state = await loadMeetingSettlement(fixture.db, "org", "order");
    expect(meetingSignatureAccess(state, fixture.actors.get("finance")!, "receivable", "business_review")).toBeNull();
    expect(meetingSignatureAccess(state, fixture.actors.get("operation")!, "receivable", "business_review")).toContain("岗位");
    const unrelated = { ...fixture.actors.get("cs")!, userId: "another-cs" };
    expect(meetingSignatureAccess(state, unrelated, "receivable", "confirm")).toContain("责任人");
  });
  it("recognizes zero-price pickup as filled through the real frozen field loader", async () => {
    await setup();
    fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,counterparty_name,quantity,unit_price,amount,created_by_user_id,created_at,updated_at) VALUES('zero','org','order','payable','pickup','客户自送','客户自送',1,0,0,'operation',?,?)").run(fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_instance_fields(id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,is_active,created_at) VALUES('price','instance','wf','reconciliation','costs','expense_unit_price','单价','amount',1,1,?)").run(fixture.now);
    const fields = await loadOrderModuleWorkflowFields("org", "order", "costs");
    expect(fields.find(field => field.fieldKey === "expense_unit_price")?.present).toBe(true);
  });
  it.each([0, "0", 123, "12.50"])("accepts an explicitly entered non-negative price %s", value => {
    expect(expenseLedgerFieldPresent("expense_unit_price", value, "amount")).toBe(true);
  });
  it.each([null, undefined, "", "  ", -1, "-1", Infinity, "Infinity", "oops"])("rejects a missing or invalid price %s", value => {
    expect(expenseLedgerFieldPresent("expense_unit_price", value, "amount")).toBe(false);
  });
  it("does not relax positive quantity or exchange-rate requirements", () => {
    expect(expenseLedgerFieldPresent("expense_quantity", 0, "number")).toBe(false);
    expect(expenseLedgerFieldPresent("expense_exchange_rate", 0, "number")).toBe(false);
    expect(expenseLedgerFieldPresent("expense_tax_rate", 0, "number")).toBe(true);
    expect(expenseLedgerFieldPresent("expense_is_internal", 0, "boolean")).toBe(true);
  });
});
