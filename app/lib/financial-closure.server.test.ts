import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingFixture, seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
const harness = vi.hoisted(() => ({ db: null as unknown as D1Database }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
import { loadFinancialClosure, financialClosurePredicate } from "./financial-closure.server";
import { loadCostsCompletionGate } from "./order-modules.server";
import { loadOrderReviewFinalizationGate } from "./order-review.server";
import { predicateGuard, guardedBatch } from "./mutation-guard.server";
import { synchronizeWorkflowExecution } from "./workflow-execution.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); });
async function setup() {
  fixture = await meetingFixture(); harness.db = fixture.db; seedFrozenMeetingWorkflow(fixture);
  fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,counterparty_name,quantity,unit_price,amount,stage,created_by_user_id,created_at,updated_at) VALUES('fee','org','order','receivable','freight','运输费','客户',1,100,100,'confirmed','sales',?,?)").run(fixture.now, fixture.now);
  fixture.database.exec("UPDATE business_expenses SET currency='CNY'");
  fixture.database.exec("UPDATE workflow_instance_module_states SET status='completed'; UPDATE order_module_instances SET status='completed';");
}
function statement() {
  fixture.database.prepare("INSERT INTO settlement_reconciliations(id,organization_id,document_number,direction,counterparty_name,settlement_entity,currency,total_amount,status,created_by_user_id,created_at,updated_at) VALUES('statement','org','R-1','receivable','客户','测试公司','CNY',100,'confirmed','cs',?,?)").run(fixture.now, fixture.now);
  fixture.database.prepare("INSERT INTO settlement_reconciliation_lines(id,organization_id,reconciliation_id,expense_id,amount,created_at) VALUES('line','org','statement','fee',100,?)").run(fixture.now);
}
function cash(amount = 100) {
  fixture.database.prepare("INSERT INTO settlement_cash_transactions(id,organization_id,transaction_number,direction,counterparty_name,currency,amount,occurred_on,settlement_entity,account_name,handled_by_user_id,status,created_by_user_id,created_at,updated_at) VALUES('cash','org','C-1','receipt','客户','CNY',?,'2026-09-01','测试公司','测试账户','cashier','allocated','cashier',?,?)").run(amount, fixture.now, fixture.now);
  fixture.database.prepare("INSERT INTO settlement_cash_allocations(id,organization_id,cash_transaction_id,reconciliation_id,expense_id,amount,created_by_user_id,created_at) VALUES('allocation','org','cash','statement','fee',?,'cashier',?)").run(amount, fixture.now);
}
describe("financial closure is real evidence, not signature completion", () => {
  it("blocks stage completion and final archive when all signatures are done but there are no statements or cash allocations", async () => {
    await setup();
    const closure = await loadFinancialClosure(fixture.db, "org", "order");
    expect(closure.complete).toBe(false); expect(closure.blockers).toHaveLength(2);
    expect((await loadCostsCompletionGate("org", "order")).complete).toBe(false);
    const gate = await loadOrderReviewFinalizationGate(fixture.db, "org", "order", { snapshotId: "snapshot", completionStatus: "business_complete_unsettled", blockers: [] } as never);
    expect(gate.allowed).toBe(false); expect(gate.reason).toContain("财务闭环");
  });
  it("requires confirmed statements and complete real allocations; partial or void cash is insufficient", async () => {
    await setup(); statement(); cash(60);
    expect((await loadFinancialClosure(fixture.db, "org", "order")).amounts[0].outstanding).toBe(40);
    fixture.database.exec("UPDATE settlement_cash_allocations SET amount=100; UPDATE settlement_cash_transactions SET amount=100");
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(true);
    fixture.database.exec("UPDATE settlement_cash_transactions SET status='void'");
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(false);
  });
  it("rolls back the entire archive batch when funds change between page inspection and commit", async () => {
    await setup(); statement(); cash();
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(true);
    fixture.database.exec("UPDATE settlement_cash_transactions SET status='void'");
    await expect(guardedBatch(fixture.db, [predicateGuard(fixture.db, financialClosurePredicate(), ["org", "order"], fixture.now), fixture.db.prepare("UPDATE transport_orders SET status='completed' WHERE id='order'")], "财务状态已变化")).rejects.toThrow("财务状态已变化");
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()?.status).toBe("in_execution");
  });
  it("keeps zero fees and cancelled fees from inventing a payment, and retains a configurable business-first mode", async () => {
    await setup(); fixture.database.exec("UPDATE business_expenses SET amount=0,unit_price=0");
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(true);
    fixture.database.exec("UPDATE business_expenses SET amount=100,unit_price=100,stage='cancelled'");
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(true);
    fixture.database.exec("UPDATE business_expenses SET stage='confirmed'");
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','settlement.require_cash_before_archive','0',?)").run(fixture.now);
    const gate = await loadOrderReviewFinalizationGate(fixture.db, "org", "order", { snapshotId: "snapshot", completionStatus: "business_complete_unsettled", blockers: [] } as never);
    expect(gate.allowed).toBe(true);
  });
  it("rejects cross-currency cash, opposite-direction funds and withdrawn statements as closure evidence", async () => {
    await setup(); statement(); cash();
    fixture.database.exec("UPDATE settlement_cash_transactions SET currency='USD'");
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(false);
    fixture.database.exec("UPDATE settlement_cash_transactions SET currency='CNY',direction='payment'");
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(false);
    fixture.database.exec("UPDATE settlement_cash_transactions SET direction='receipt'; UPDATE settlement_reconciliations SET status='withdrawn'");
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(false);
  });
  it("keeps the final frozen costs module unfinished despite completed signature tasks, until true cash closure", async () => {
    await setup();
    fixture.database.exec("UPDATE workflow_instance_step_states SET status='active' WHERE step_key='reconciliation'");
    for (const direction of ["receivable", "payable"]) fixture.database.prepare("INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,confirmed,business_reviewed,finance_reviewed,updated_at) VALUES('org','order',?,1,1,1,?)").run(direction, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_module_tasks(id,workflow_id,step_module_id,task_key,name,task_type,is_required,created_at,updated_at) VALUES('signed-task','wf','placement:reconciliation','signed','费用已签核','form',1,?,?)").run(fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_instance_task_states(id,instance_module_state_id,module_task_id,task_key,name,task_type,sort_order,is_required,status,updated_at) VALUES('signed-task-state','module-state:reconciliation','signed-task','signed','费用已签核','form',10,1,'completed',?)").run(fixture.now);
    const sync = () => synchronizeWorkflowExecution({ organizationId: "org", orderId: "order", instanceId: "instance", workflowId: "wf", targetStepKey: "reconciliation", orderStatus: "in_execution" });
    await sync();
    expect(fixture.database.prepare("SELECT status FROM workflow_instance_module_states WHERE id='module-state:reconciliation'").get()?.status).not.toBe("completed");
    expect(fixture.database.prepare("SELECT status FROM workflow_instance_module_states WHERE id='module-state:order_creation'").get()?.status).toBe("completed");
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','settlement.require_cash_before_archive','0',?)").run(fixture.now);
    await sync();
    expect(fixture.database.prepare("SELECT status FROM workflow_instance_module_states WHERE id='module-state:reconciliation'").get()?.status).toBe("completed");
    fixture.database.exec("DELETE FROM business_process_policies WHERE policy_key='settlement.require_cash_before_archive'");
    await sync();
    expect(fixture.database.prepare("SELECT status FROM workflow_instance_module_states WHERE id='module-state:reconciliation'").get()?.status).not.toBe("completed");
    statement(); cash();
    await sync();
    expect(fixture.database.prepare("SELECT status FROM workflow_instance_module_states WHERE id='module-state:reconciliation'").get()?.status).toBe("completed");
  });
});
