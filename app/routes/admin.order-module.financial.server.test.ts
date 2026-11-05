import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingFixture, seedFrozenMeetingWorkflow } from "../lib/meeting-integration-fixture";
import type { SessionUser } from "../lib/auth.server";
const harness = vi.hoisted(() => ({ db: null as unknown as D1Database, actor: null as unknown as SessionUser }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: async () => harness.actor }));
import { loader, action, EmbeddedOrderModule } from "./admin.order-module";
import { loadOrderFinancialWorkspace, assertOrderFinancialSubmission } from "../lib/order-settlement-workbench.server";
import { loadFinancialClosure } from "../lib/financial-closure.server";
import { orderFinancialHref } from "../lib/order-financial-navigation";
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); });
async function setup(actor = "finance") {
  fixture = await meetingFixture(); harness.db = fixture.db; seedFrozenMeetingWorkflow(fixture);
  fixture.database.exec("UPDATE order_module_instances SET status='completed' WHERE module_code='assignment'");
  for (const code of ["transport", "review", "assignment"]) {
    fixture.database.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES(?,'wf','step:order_creation',?,?,?,?)").run(`placement:${code}`, code, code, fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,status,updated_at) VALUES(?,'state:order_creation',?,?,?,20,0,'all_tasks','completed',?)").run(`frozen:${code}`, `placement:${code}`, code, code, fixture.now);
  }
  for (const key of ["reconciliation_statement", "cash_records", "writeoff_records", "invoice_records"]) fixture.database.prepare("INSERT INTO workflow_instance_fields(id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,is_active,created_at) VALUES(?,'instance','wf','reconciliation','costs',?,?,'text',0,1,?)").run(key, key, key, fixture.now);
  fixture.database.prepare("INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,created_at) VALUES('export','org','order','exported','实际出境',?,?)").run(fixture.now, fixture.now);
  for (const [direction, amount] of [["receivable", 100], ["payable", 50]] as const) {
    fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,stage,created_by_user_id,created_at,updated_at) VALUES(?,'org','order',?,'freight','运输费',?,'CNY',1,?,?,'confirmed','cs',?,?)").run(direction, direction, direction === "receivable" ? "测试客户" : "供应商", amount, amount, fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,confirmed,business_reviewed,finance_reviewed,updated_at) VALUES('org','order',?,1,1,1,?)").run(direction, fixture.now);
  }
  for (const id of ["finance", "cs", "cashier", "operation"]) fixture.database.prepare("INSERT INTO sessions(id,user_id,organization_id,token_hash,expires_at,last_seen_at,created_at,site) VALUES(?,?,'org',?,'2099-01-01T00:00:00Z',?,?,'admin')").run(id, id, `test-${id}`, fixture.now, fixture.now);
  harness.actor = fixture.actors.get(actor)!;
}
function args(form?: Record<string, string>, query = "") {
  return { request: new Request(`http://localhost/admin/orders/order?stage=reconciliation&module=costs&section=expenses${query}`, form ? { method: "POST", body: new URLSearchParams(form) } : undefined), params: { orderId: "order", moduleCode: "costs" }, context: {} } as never;
}
async function post(actor: string, form: Record<string, string>) {
  harness.actor = fixture.actors.get(actor)!;
  const result = await action(args(form)).catch(async error => { throw new Error(`${actor}/${form.intent}: ${error instanceof Response ? `${error.status} ${await error.text()}` : String(error)}`); });
  expect(result).not.toHaveProperty("formError");
  return result;
}
async function render(actor: string, query = "") {
  harness.actor = fixture.actors.get(actor)!;
  const data = await loader(args(undefined, query));
  const router = createMemoryRouter([{ path: "*", element: createElement(EmbeddedOrderModule, { data: data as never, busy: false, readOnly: true, costsSection: "expenses", workflowStepKey: "reconciliation", actionUrl: "/admin/orders/order?stage=reconciliation&module=costs&section=expenses&itmsTab=slot-12345678" }) }], { initialEntries: ["/"] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
describe("financial operations remain in the scoped order", () => {
  it("shows finance its AP creation form in the order, not a missing entrance or external workbench", async () => {
    await setup(); const html = await render("finance");
    expect(html).toContain('aria-label="本单财务办理"');
    const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
    expect(forms.some(form => form.includes('value="create_reconciliation"') && form.includes('value="payable"'))).toBe(true);
    expect(forms.some(form => form.includes('value="create_reconciliation"') && form.includes('value="receivable"'))).toBe(false);
    expect(html).not.toContain("/admin/billing");
    expect(html).not.toContain("/admin/settlement-approvals");
    expect(html).toContain("itmsTab=slot-12345678");
    expect((await render("cs")).includes('value="receivable"')).toBe(true);
  });
  it("uses actual existing route services for AR/AP statements, offline approval, real cash and allocation without leaving the order", async () => {
    await setup();
    for (const [direction, actor] of [["receivable", "cs"], ["payable", "finance"]]) {
      await post(actor, { intent: "create_reconciliation", direction, expenseId: direction });
      const statement = fixture.database.prepare("SELECT id,document_number FROM settlement_reconciliations WHERE direction=?").get(direction)!;
      await post(actor, { intent: "confirm_reconciliation", id: String(statement.id) });
      if (direction === "payable") await post("finance", { intent: "offline", orderId: "order", approver: "测试审批人", approvedAt: "2026-09-01", evidence: "仅本地测试凭证" });
      const amount = direction === "receivable" ? "100" : "50";
      await post("cashier", { intent: "record_cash", reconciliationId: String(statement.id), direction: direction === "receivable" ? "receipt" : "payment", counterpartyName: direction === "receivable" ? "测试客户" : "供应商", currency: "CNY", amount, occurredOn: "2026-09-01", settlementEntity: "测试", accountName: "本地测试账户", handledByUserId: "cashier", paymentStatementNumber: direction === "payable" ? String(statement.document_number) : "", evidenceReference: "本地测试凭证", requestId: `${direction}-cash` });
      const cash = fixture.database.prepare("SELECT id FROM settlement_cash_transactions WHERE request_id=?").get(`${direction}-cash`)!;
      const html = await render("cashier", "&financeTab=cash");
      expect(html).toContain('value="allocate_cash"'); expect(html).not.toContain("/admin/billing");
      const allocation = (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []).find(form => form.includes('value="allocate_cash"'))!;
      expect(allocation).toContain(`value="${cash.id}" selected=""`);
      expect(allocation).toContain(`name="amount" value="${Number(amount).toFixed(2)}"`);
      expect(allocation).toContain('min="0.01"');
      expect(allocation).not.toContain('disabled=""');
      expect(html).toContain('class="billing-card-operation" open=""');
      if (direction === "payable") {
        // Exact production state: AR already settled, AP paid but not allocated.
        expect(html).toContain("本账单付款流水已足额登记，无需重复登记");
        expect(html).not.toContain('value="record_cash"');
        const view = await loadOrderFinancialWorkspace(fixture.db, harness.actor, "order", new URLSearchParams("financeTab=cash"));
        expect(view?.statements.items.find(row => row.id === statement.id)?.registered_payment_amount).toBe(50);
        expect(view?.cash.find(row => row.id === cash.id)?.payment_reconciliation_id).toBe(statement.id);
        const duplicate = await action(args({ intent: "record_cash", reconciliationId: String(statement.id), direction: "payment", counterpartyName: "供应商", currency: "CNY", amount, occurredOn: "2026-09-01", settlementEntity: "测试", accountName: "本地测试账户", handledByUserId: "cashier", paymentStatementNumber: String(statement.document_number), requestId: "duplicate-payment" }));
        expect(duplicate).toMatchObject({ financialIntent: "record_cash", reconciliationId: statement.id });
        expect(duplicate).toHaveProperty("formError", expect.stringContaining("勿重复登记"));
        expect(fixture.database.prepare("SELECT COUNT(*) n FROM settlement_cash_transactions WHERE direction='payment'").get()?.n).toBe(1);
      }
      await post("cashier", { intent: "allocate_cash", transactionId: String(cash.id), reconciliationId: String(statement.id), amount, requestId: `${direction}-allocate` });
    }
    expect((await loadFinancialClosure(fixture.db, "org", "order")).complete).toBe(true);
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()?.status).toBe("in_execution");
  });
  it("shows only the unpaid registration remainder after a partial payment and exposes its existing cash for allocation", async () => {
    await setup();
    await post("finance", { intent: "create_reconciliation", direction: "payable", expenseId: "payable" });
    const statement = fixture.database.prepare("SELECT id,document_number FROM settlement_reconciliations").get()!;
    await post("finance", { intent: "confirm_reconciliation", id: String(statement.id) });
    await post("finance", { intent: "offline", orderId: "order", approver: "测试审批人", approvedAt: "2026-09-01", evidence: "测试凭证" });
    await post("cashier", { intent: "record_cash", reconciliationId: String(statement.id), direction: "payment", counterpartyName: "供应商", currency: "CNY", amount: "20", occurredOn: "2026-09-01", settlementEntity: "测试", accountName: "测试账户", handledByUserId: "cashier", paymentStatementNumber: String(statement.document_number), requestId: "partial-payment" });
    const html = await render("cashier", "&financeTab=cash");
    const registration = (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []).find(form => form.includes('value="record_cash"'))!;
    expect(registration).toContain('max="30"'); expect(registration).toContain('name="amount" value="30.00"');
    const allocation = (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []).find(form => form.includes('value="allocate_cash"'))!;
    expect(allocation).toContain('max="20"'); expect(allocation).toContain('name="amount" value="20.00"');
  });
  it("rejects foreign-order references, mismatched cash and non-financial accounts before any financial writes", async () => {
    await setup();
    const injected = new FormData(); injected.set("intent", "create_reconciliation"); injected.set("expenseId", "foreign-fee");
    await expect(assertOrderFinancialSubmission(fixture.db, harness.actor, "order", injected)).rejects.toThrow("其他订单");
    harness.actor = fixture.actors.get("operation")!;
    expect(await loadOrderFinancialWorkspace(fixture.db, harness.actor, "order", new URLSearchParams())).toBeNull();
    expect(await action(args({ intent: "create_reconciliation", direction: "payable", expenseId: "payable" }))).toHaveProperty("formError");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM settlement_reconciliations").get()?.n).toBe(0);
    await post("cs", { intent: "create_reconciliation", direction: "receivable", expenseId: "receivable" });
    const statement = fixture.database.prepare("SELECT id FROM settlement_reconciliations").get()!;
    await post("cs", { intent: "confirm_reconciliation", id: String(statement.id) });
    harness.actor = fixture.actors.get("cashier")!;
    expect(await action(args({ intent: "record_cash", reconciliationId: String(statement.id), direction: "receipt", counterpartyName: "其他客户", currency: "CNY" }))).toHaveProperty("formError");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM settlement_cash_transactions").get()?.n).toBe(0);
  });
  it("honors unplugged cash fields and rejects an expired live session", async () => {
    await setup(); await post("cs", { intent: "create_reconciliation", direction: "receivable", expenseId: "receivable" });
    const statement = fixture.database.prepare("SELECT id FROM settlement_reconciliations").get()!;
    await post("cs", { intent: "confirm_reconciliation", id: String(statement.id) });
    fixture.database.exec("UPDATE workflow_instance_fields SET is_active=0 WHERE field_key IN ('cash_records','writeoff_records')");
    harness.actor = fixture.actors.get("cashier")!;
    expect(await action(args({ intent: "record_cash", reconciliationId: String(statement.id), direction: "receipt", counterpartyName: "测试客户", currency: "CNY" }))).toHaveProperty("formError");
    fixture.database.exec("UPDATE sessions SET expires_at='2000-01-01' WHERE user_id='finance'");
    harness.actor = fixture.actors.get("finance")!;
    expect(await action(args({ intent: "create_reconciliation", direction: "payable", expenseId: "payable" }))).toHaveProperty("formError");
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM settlement_reconciliations WHERE direction='payable'").get()?.n).toBe(0);
  });
  it("rejects a mixed-order statement instead of letting its order page mutate other orders", async () => {
    await setup();
    await post("cs", { intent: "create_reconciliation", direction: "receivable", expenseId: "receivable" });
    const original = fixture.database.prepare("SELECT * FROM transport_orders WHERE id='order'").get()!;
    const other = { ...original, id: "other", order_number: "OTHER-SO", workflow_instance_id: null };
    const keys = Object.keys(other);
    fixture.database.prepare(`INSERT INTO transport_orders(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(key => other[key as keyof typeof other]));
    fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,counterparty_name,currency,amount,created_by_user_id,created_at,updated_at) VALUES('other-fee','org','other','receivable','freight','运费','测试客户','CNY',20,'cs',?,?)").run(fixture.now, fixture.now);
    const statement = fixture.database.prepare("SELECT id FROM settlement_reconciliations").get()!;
    fixture.database.prepare("INSERT INTO settlement_reconciliation_lines(id,organization_id,reconciliation_id,expense_id,amount,created_at) VALUES('mixed','org',?,'other-fee',20,?)").run(statement.id, fixture.now);
    harness.actor = fixture.actors.get("finance")!;
    const result = await action(args({ intent: "confirm_reconciliation", id: String(statement.id) }));
    expect(result).toHaveProperty("formError");
    expect(fixture.database.prepare("SELECT status FROM settlement_reconciliations").get()?.status).toBe("draft");
    const view = await loadOrderFinancialWorkspace(fixture.db, harness.actor, "order", new URLSearchParams());
    expect(view?.statementAccess[String(statement.id)].confirm_reconciliation.canWrite).toBe(false);
  });
  it("exposes cashier order entry only with explicit organizational cash authority and retains direction prerequisites", async () => {
    await setup();
    const cashier = fixture.actors.get("cashier")!;
    expect(await loadOrderFinancialWorkspace(fixture.db, cashier, "order", new URLSearchParams())).not.toBeNull();
    await expect(loadOrderFinancialWorkspace(fixture.db, { ...cashier, permissions: cashier.permissions.filter(permission => permission !== "billing.scope.all") }, "order", new URLSearchParams())).rejects.toThrow("范围");
    fixture.database.exec("UPDATE order_expense_direction_controls SET finance_reviewed=0 WHERE direction='receivable'");
    const view = await loadOrderFinancialWorkspace(fixture.db, fixture.actors.get("cs")!, "order", new URLSearchParams());
    expect(view?.createAccess.receivable.canWrite).toBe(false);
    const finance = await loadOrderFinancialWorkspace(fixture.db, fixture.actors.get("finance")!, "order", new URLSearchParams());
    expect(finance?.handoff.canRecordOffline).toBe(true);
  });
  it("keeps login tab, queue context and custom workflow placement in all financial subpages", () => {
    const href = orderFinancialHref("order", "cash", "/admin/orders/order?stage=custom_finance&itmsTab=testslot&returnTo=%2Fadmin%2Forders&orderQueue=order");
    const url = new URL(href, "http://test");
    expect(url.pathname).toBe("/admin/orders/order"); expect(url.searchParams.get("stage")).toBe("custom_finance");
    expect(url.searchParams.get("itmsTab")).toBe("testslot"); expect(url.searchParams.get("returnTo")).toBe("/admin/orders");
  });
});
