import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingFixture, seedFrozenMeetingWorkflow } from "./meeting-integration-fixture";
const harness = vi.hoisted(() => ({ db: null as unknown as D1Database }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
import { loadMeetingSettlement, loadMeetingSettlementDirections, submitMeetingSignature, assertMeetingSignoffsComplete } from "./meeting-settlement.server";
import { loadFinancialClosure, loadSettlementHandoff } from "./financial-closure.server";
import { createReconciliation, confirmReconciliation, recordCashTransaction, allocateCashTransaction } from "./settlement-workbench.server";
import { loadSettlementWorkbenchActionAccess, type SettlementAccessSource } from "./settlement-workbench-access.server";
import type { SettlementWorkbenchAction } from "./settlement-workbench-access";
import { generateOrderReview, finalizeOrderReview } from "./order-review.server";
import { loadReconciliationPage } from "./settlement-workbench-pages.server";
import { reopenPrematureSettlement } from "./settlement-recovery.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); });
async function setup() {
  fixture = await meetingFixture(); harness.db = fixture.db; seedFrozenMeetingWorkflow(fixture);
  fixture.database.exec("UPDATE order_module_instances SET status='completed' WHERE module_code='assignment'; UPDATE workflow_instance_step_states SET status='completed' WHERE step_key='order_creation'; UPDATE workflow_instance_module_states SET status='completed' WHERE instance_step_state_id='state:order_creation'");
  for (const code of ["transport", "assignment"]) {
    fixture.database.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES(?,'wf','step:order_creation',?,?,?,?)").run(`placement:${code}`, code, code, fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,status,updated_at) VALUES(?,'state:order_creation',?,?,?,20,0,'all_tasks','completed',?)").run(`frozen:${code}`, `placement:${code}`, code, code, fixture.now);
  }
  fixture.database.prepare("INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,created_at,updated_at) VALUES('review-step','wf','completion_review','最终复盘','order','review',110,?,?)").run(fixture.now, fixture.now);
  fixture.database.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES('review-placement','wf','review-step','review','最终复盘',?,?)").run(fixture.now, fixture.now);
  fixture.database.prepare("INSERT INTO workflow_instance_step_states(id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,updated_at) VALUES('review-state','instance','wf','review-step','completion_review','最终复盘',110,'pending',?)").run(fixture.now);
  fixture.database.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,updated_at) VALUES('review-module-state','review-state','review-placement','review','最终复盘',10,1,'all_tasks',?)").run(fixture.now);
  for (const key of ["reconciliation_statement", "cash_records", "writeoff_records"]) fixture.database.prepare("INSERT INTO workflow_instance_fields(id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,is_active,created_at) VALUES(?,'instance','wf','reconciliation','costs',?,?,'text',0,1,?)").run(key, key, key, fixture.now);
  fixture.database.prepare("INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,created_at) VALUES('export','org','order','exported','实际出境',?,?)").run(fixture.now, fixture.now);
  for (const [direction, amount] of [["receivable", 100], ["payable", 50]] as const) fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,foreign_account_no,created_by_user_id,created_at,updated_at) VALUES(?,'org','order',?,'freight','运输费',?,'CNY',1,?,?,'PRIVATE-BANK-REFERENCE','cs',?,?)").run(direction, direction, direction === "receivable" ? "测试客户" : "供应商", amount, amount, fixture.now, fixture.now);
}
async function allSignatures(actorOverride?: string) {
  for (const [direction, actors] of [["receivable", ["cs", "operation", "supervisor"]], ["payable", ["operation", "supervisor", "finance"]]] as const)
    for (const [index, action] of (["confirm", "business_review", "finance_review"] as const).entries()) await submitMeetingSignature(fixture.db, { current: fixture.actors.get(actorOverride ?? actors[index])!, orderId: "order", direction, action, notes: "核对完成", refresh: async () => {} });
}
function access(actor: string, action: SettlementWorkbenchAction, source: SettlementAccessSource) {
  return async () => {
    const result = await loadSettlementWorkbenchActionAccess(fixture.db, { actor: fixture.actors.get(actor)!, action, source, legacyFallback: "deny" });
    if (!result.canWrite) throw new Error(result.reason ?? "本项不能办理");
  };
}
describe("reviewed statements -> real cash -> final archive", () => {
  it.each([
    { mode: "岗位协作", businessType: "ltl", solo: false },
    { mode: "老板代办", businessType: "ltl", solo: true },
    { mode: "岗位协作", businessType: "ftl", solo: false },
    { mode: "老板代办", businessType: "ftl", solo: true },
  ])("$mode / $businessType completes signatures and real cash settlement before final archive", async ({ solo, businessType }) => {
    await setup();
    fixture.database.prepare("UPDATE transport_orders SET business_type=? WHERE id='order'").run(businessType);
    const reviewer = solo ? "owner" : "finance";
    const cashier = solo ? "owner" : "cashier";
    const receivableCreator = solo ? "owner" : "cs";
    await expect(createReconciliation(fixture.db, { organizationId: "org", expenseIds: ["receivable"], direction: "receivable", userId: receivableCreator, now: fixture.now, assertCanMutate: access(receivableCreator, "create_reconciliation", { kind: "expense_ids", ids: ["receivable"] }) })).rejects.toThrow();
    if (solo) await expect(submitMeetingSignature(fixture.db, { current: fixture.actors.get("owner")!, orderId: "order", direction: "receivable", action: "finance_review", notes: "不得越级", refresh: async () => {} })).rejects.toThrow();
    await allSignatures(solo ? "owner" : undefined);
    await generateOrderReview(fixture.db, { organizationId: "org", orderId: "order", userId: reviewer, now: fixture.now, reviewConclusion: "财务尚未结清" });
    expect((await finalizeOrderReview(fixture.db, { organizationId: "org", orderId: "order", userId: reviewer, now: fixture.now, confirmed: true })).completed).toBe(false);
    fixture.database.prepare("INSERT INTO order_payable_offline_approvals(id,organization_id,order_id,approver_name,approved_at,evidence_reference,recorded_by_user_id,created_at) VALUES('offline','org','order','本地测试审批人',?,'本地测试凭证',?,?)").run(fixture.now, reviewer, fixture.now);
    for (const direction of ["receivable", "payable"] as const) {
      const actor = direction === "receivable" ? receivableCreator : reviewer;
      const statement = await createReconciliation(fixture.db, { organizationId: "org", expenseIds: [direction], direction, userId: actor, now: fixture.now, assertCanMutate: access(actor, "create_reconciliation", { kind: "expense_ids", ids: [direction] }) });
      await confirmReconciliation(fixture.db, { organizationId: "org", id: statement.id, userId: actor, now: fixture.now, assertCanMutate: access(actor, "confirm_reconciliation", { kind: "reconciliation_id", id: statement.id }) });
      const cashierPage = await loadReconciliationPage(fixture.db, fixture.actors.get(cashier)!, { page: 1, pageSize: 10, query: "TEST-SO", direction: "", currency: "", status: "" }, "cash");
      expect(cashierPage.items.some(item => item.id === statement.id)).toBe(true);
      const amount = direction === "receivable" ? 100 : 50;
      const cash = await recordCashTransaction(fixture.db, { organizationId: "org", direction: direction === "receivable" ? "receipt" : "payment", counterpartyName: direction === "receivable" ? "测试客户" : "供应商", currency: "CNY", amount, occurredOn: "2026-09-01", settlementEntity: "测试", accountName: "本地测试账户", handledByUserId: cashier, paymentStatementNumber: statement.number, evidenceReference: "本地测试资金凭证", userId: cashier, now: fixture.now, requestId: `${direction}-cash-record`, assertCanMutate: access(cashier, "allocate_cash", { kind: "reconciliation_id", id: statement.id }) });
      await allocateCashTransaction(fixture.db, { organizationId: "org", transactionId: cash.id, reconciliationId: statement.id, amount, userId: cashier, now: fixture.now, requestId: `${direction}-cash-allocation`, assertCanMutate: access(cashier, "allocate_cash", { kind: "reconciliation_id", id: statement.id }) });
    }
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(true);
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()?.status).not.toBe("completed");
    await generateOrderReview(fixture.db, { organizationId: "org", orderId: "order", userId: reviewer, now: fixture.now, reviewConclusion: "全部真实收付款已核销" });
    const result = await finalizeOrderReview(fixture.db, { organizationId: "org", orderId: "order", userId: reviewer, now: fixture.now, confirmed: true });
    expect(result).toMatchObject({ completed: true, completionStatus: "completed_settled" });
    expect(fixture.database.prepare("SELECT status,completion_status FROM transport_orders WHERE id='order'").get()).toMatchObject({ status: "completed", completion_status: "completed_settled" });
    expect(fixture.database.prepare("SELECT DISTINCT created_by_user_id FROM settlement_cash_transactions").all()).toEqual([{ created_by_user_id: cashier }]);
    await expect(reopenPrematureSettlement(fixture.db, fixture.actors.get("finance")!, "order", true)).rejects.toThrow("仅可恢复");
  });
  it("provides only the assigned review direction's amounts and honors the visibility switch without permitting blind approval", async () => {
    await setup();
    const state = await loadMeetingSettlement(fixture.db, "org", "order");
    const cs = { ...fixture.actors.get("cs")!, permissions: fixture.actors.get("cs")!.permissions.filter(permission => permission !== "billing.sensitive.view") };
    const view = await loadMeetingSettlementDirections(fixture.db, "org", "order", state, cs);
    expect(view.find(item => item.direction === "receivable")?.expenses[0].amount).toBe(100);
    expect(view.find(item => item.direction === "payable")?.expenses).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("PRIVATE-BANK-REFERENCE");
    expect((await loadMeetingSettlementDirections(fixture.db, "org", "order", state, { ...cs, userId: "someone-else" })).every(item => !item.expenses.length)).toBe(true);
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','settlement.approver_amounts_visible','0',?)").run(fixture.now);
    const hidden = await loadMeetingSettlementDirections(fixture.db, "org", "order", await loadMeetingSettlement(fixture.db, "org", "order"), cs);
    expect(hidden.every(item => !item.expenses.length)).toBe(true);
    expect(hidden[0].actions.find(action => action.action === "confirm")?.reason).toContain("不能盲签");
  });
  it("recovers only financial stages with an audit, preserves signed fees and business history, and is repeat-safe", async () => {
    await setup(); await allSignatures();
    fixture.database.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES('exceptions-placement','wf','review-step','exceptions','异常处理',?,?)").run(fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,status,updated_at) VALUES('exceptions-state','review-state','exceptions-placement','exceptions','异常处理',5,0,'all_tasks','completed',?)").run(fixture.now);
    await generateOrderReview(fixture.db, { organizationId: "org", orderId: "order", userId: "finance", now: fixture.now, reviewConclusion: "原复盘应保留" });
    fixture.database.exec("UPDATE transport_orders SET status='completed',completion_status='business_complete_unsettled'; UPDATE workflow_instances SET status='completed',current_step_key='completion_review'; UPDATE workflow_instance_step_states SET status='completed'; UPDATE workflow_instance_module_states SET status='completed'; UPDATE order_module_instances SET status='completed'");
    const fees = fixture.database.prepare("SELECT * FROM business_expenses ORDER BY id").all();
    const signs = fixture.database.prepare("SELECT * FROM order_expense_direction_controls ORDER BY direction").all();
    const snapshot = fixture.database.prepare("SELECT * FROM order_review_snapshots").all();
    await expect(reopenPrematureSettlement(fixture.db, fixture.actors.get("operation")!, "order", true)).rejects.toThrow("仅本单财务");
    await expect(reopenPrematureSettlement(fixture.db, fixture.actors.get("finance")!, "order", false)).rejects.toThrow("请明确确认");
    await reopenPrematureSettlement(fixture.db, fixture.actors.get("finance")!, "order", true);
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()?.status).toBe("in_execution");
    expect(fixture.database.prepare("SELECT status FROM workflow_instance_step_states WHERE step_key='order_creation'").get()?.status).toBe("completed");
    expect(fixture.database.prepare("SELECT status FROM workflow_instance_step_states WHERE step_key='reconciliation'").get()?.status).toBe("active");
    expect(fixture.database.prepare("SELECT status FROM workflow_instance_step_states WHERE step_key='completion_review'").get()?.status).toBe("pending");
    expect(fixture.database.prepare("SELECT status FROM workflow_instance_module_states WHERE id='exceptions-state'").get()?.status).toBe("completed");
    expect(fixture.database.prepare("SELECT * FROM business_expenses ORDER BY id").all()).toEqual(fees);
    expect(fixture.database.prepare("SELECT * FROM order_expense_direction_controls ORDER BY direction").all()).toEqual(signs);
    expect(fixture.database.prepare("SELECT * FROM order_review_snapshots").all()).toEqual(snapshot);
    await reopenPrematureSettlement(fixture.db, fixture.actors.get("finance")!, "order", true);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='settlement.archive.reopen'").get()?.n).toBe(1);
    await access("cs", "create_reconciliation", { kind: "expense_ids", ids: ["receivable"] })();
  });
  it("projects the same configurable AR statement creator rule in row controls, links and mutations", async () => {
    await setup(); await allSignatures();
    const state = await loadMeetingSettlement(fixture.db, "org", "order");
    const finance = fixture.actors.get("finance")!;
    expect((await loadSettlementHandoff(fixture.db, state, finance, await loadMeetingSettlementDirections(fixture.db, "org", "order", state, finance))).statementDirection).toBe("payable");
    await expect(access("finance", "create_reconciliation", { kind: "expense_ids", ids: ["receivable"] })()).rejects.toThrow("策略配置");
    await expect(access("finance", "create_reconciliation", { kind: "expense_ids", ids: ["payable"] })()).resolves.toBeUndefined();
    await expect(access("cs", "create_reconciliation", { kind: "expense_ids", ids: ["receivable"] })()).resolves.toBeUndefined();
    await expect(createReconciliation(fixture.db, { organizationId: "org", expenseIds: ["receivable"], direction: "receivable", userId: "finance", now: fixture.now, assertCanMutate: async () => {} })).rejects.toThrow("策略配置");
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','receivable.statement_positions','FINANCE_ACCOUNTING',?)").run(fixture.now);
    await expect(access("finance", "create_reconciliation", { kind: "expense_ids", ids: ["receivable"] })()).resolves.toBeUndefined();
    await expect(access("cs", "create_reconciliation", { kind: "expense_ids", ids: ["receivable"] })()).rejects.toThrow("策略配置");
  });
  it("refuses automatic recovery when an unfinished or required non-financial module follows settlement", async () => {
    await setup();
    fixture.database.exec("UPDATE transport_orders SET status='completed',completion_status='business_complete_unsettled'");
    fixture.database.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES('exceptions-placement','wf','review-step','exceptions','异常处理',?,?)").run(fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,status,updated_at) VALUES('exceptions-state','review-state','exceptions-placement','exceptions','异常处理',5,0,'all_tasks','pending',?)").run(fixture.now);
    await expect(reopenPrematureSettlement(fixture.db, fixture.actors.get("finance")!, "order", true)).rejects.toThrow("人工核查");
    fixture.database.exec("UPDATE workflow_instance_module_states SET status='completed',is_required=1 WHERE id='exceptions-state'");
    await expect(reopenPrematureSettlement(fixture.db, fixture.actors.get("finance")!, "order", true)).rejects.toThrow("人工核查");
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()?.status).toBe("completed");
  });
  it("does not let business-only archive bypass signature or offline approval requirements", async () => {
    await setup();
    fixture.database.exec("UPDATE transport_orders SET status='completed',completion_status='business_complete_unsettled'; UPDATE workflow_instance_step_states SET status='completed'");
    await expect(assertMeetingSignoffsComplete(fixture.db, "org", ["order"], "payable", true)).rejects.toThrow("必办签核");
    fixture.database.prepare("INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,confirmed,business_reviewed,finance_reviewed,updated_at) VALUES('org','order','payable',1,1,1,?)").run(fixture.now);
    await expect(assertMeetingSignoffsComplete(fixture.db, "org", ["order"], "payable", true)).rejects.toThrow("线下审批");
  });
});
