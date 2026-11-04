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
import { loadMeetingSettlement, loadMeetingSettlementDirections, submitMeetingSignature } from "../lib/meeting-settlement.server";

let fixture: Awaited<ReturnType<typeof meetingFixture>>;
afterEach(() => { if (fixture?.database.isOpen) fixture.database.close(); });
async function setup(actor = "operation") {
  fixture = await meetingFixture(); harness.db = fixture.db;
  seedFrozenMeetingWorkflow(fixture);
  fixture.database.exec("UPDATE order_module_instances SET status='completed' WHERE module_code='assignment'");
  // Keep the responsibility modules in this frozen workflow, as in real orders.
  for (const code of ["transport", "review", "assignment"]) {
    fixture.database.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES(?,'wf','step:order_creation',?,?,?,?)").run(`placement:${code}`, code, code, fixture.now, fixture.now);
    fixture.database.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,updated_at) VALUES(?,'state:order_creation',?,?,?,20,0,'all_tasks',?)").run(`frozen:${code}`, `placement:${code}`, code, code, fixture.now);
  }
  harness.actor = fixture.actors.get(actor)!;
  fixture.database.prepare("INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,created_at) VALUES('export','org','order','exported','实际出境',?,?)").run(fixture.now, fixture.now);
  for (const direction of ["receivable", "payable"]) {
    fixture.database.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,counterparty_name,quantity,unit_price,amount,created_by_user_id,created_at,updated_at) VALUES(?,'org','order',?,'freight','运费','往来单位',1,981234.56,981234.56,'cs',?,?)").run(direction, direction, fixture.now, fixture.now);
  }
}
function request(form?: Record<string, string>) {
  return { request: new Request("http://localhost/admin/orders/order?stage=reconciliation&module=costs&section=expenses", form ? { method: "POST", body: new URLSearchParams(form) } : undefined), params: { orderId: "order", moduleCode: "costs" }, context: {} } as never;
}
async function sign(actor: string, direction: "receivable" | "payable", action: "confirm" | "business_review" | "finance_review") {
  return submitMeetingSignature(fixture.db, { current: fixture.actors.get(actor)!, orderId: "order", direction, action, notes: "", refresh: async () => {} });
}
function markup(data: Awaited<ReturnType<typeof loader>>) {
  const router = createMemoryRouter([{ path: "*", element: createElement(EmbeddedOrderModule, {
    data: data as never, busy: false, readOnly: true, costsSection: "expenses",
    actionUrl: "/admin/orders/order?module=costs&stage=reconciliation&section=expenses",
    workflowStepKey: "reconciliation",
  }) }], { initialEntries: ["/admin/orders/order?module=costs"] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
describe("real frozen workflow settlement entrances", () => {
  it("loads and renders both operation actions without returning expense amounts or expanding financial permissions", async () => {
    await setup(); await sign("cs", "receivable", "confirm");
    const data = await loader(request());
    expect(data.canViewExpenseSummary).toBe(false);
    expect(data.expenses).toEqual([]);
    expect(data.canViewFullExpenseDetails).toBe(false);
    const html = markup(data);
    expect(html).toContain('name="controlAction" value="business_review"');
    expect(html).toContain('name="controlAction" value="confirm"');
    expect(html).not.toContain("981234.56");
    expect(html).not.toContain("预计利润");
    expect(harness.actor.permissions).not.toContain("billing.sensitive.view");
  });
  it.each(["cs", "sales", "supervisor", "finance"])("keeps the %s entrance consistent with the shared authority projection", async actor => {
    await setup(actor);
    await sign("cs", "receivable", "confirm");
    await sign("operation", "receivable", "business_review");
    await sign("operation", "payable", "confirm");
    await sign("supervisor", "payable", "business_review");
    const data = await loader(request());
    const state = await loadMeetingSettlement(fixture.db, "org", "order");
    expect(data.settlementDirections).toEqual(await loadMeetingSettlementDirections(fixture.db, "org", "order", state, harness.actor));
    expect(data.settlementDirections.flatMap(direction => direction.actions.filter(action => action.active && !action.completed && !action.reason)).length).toBe(actor === "supervisor" || actor === "finance" ? 1 : 0);
    const html = markup(data);
    expect(html).toContain("本单责任人：");
    expect(html.includes('name="controlAction"')).toBe(actor === "supervisor" || actor === "finance");
  });
  it("posts a sign-only operation action through the module route but rejects another person's action", async () => {
    await setup(); await sign("cs", "receivable", "confirm");
    expect(await action(request({ intent: "expense_direction_control", direction: "receivable", controlAction: "business_review" }))).toMatchObject({ actionKind: "expense_direction_control" });
    expect(await action(request({ intent: "expense_direction_control", direction: "receivable", controlAction: "finance_review" }))).toMatchObject({ formError: expect.any(String) });
    expect(fixture.database.prepare("SELECT business_reviewed,finance_reviewed FROM order_expense_direction_controls WHERE direction='receivable'").get()).toMatchObject({ business_reviewed: 1, finance_reviewed: 0 });
  });
  it("renders closed orders as history with no signature forms", async () => {
    await setup(); fixture.database.exec("UPDATE transport_orders SET status='completed'");
    const data = await loader(request());
    expect(markup(data)).not.toContain('name="controlAction"');
  });
  it("honors reconfigured signing roles without also granting them financial visibility", async () => {
    await setup("cs");
    harness.actor = { ...harness.actor, permissions: harness.actor.permissions.filter(permission => permission !== "billing.sensitive.view") };
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','receivable.review_positions','CS',?)").run(fixture.now);
    await sign("cs", "receivable", "confirm");
    const data = await loader(request());
    expect(data.canViewExpenseSummary).toBe(false);
    expect(markup(data)).toContain('name="controlAction" value="business_review"');
    expect(markup(data)).not.toContain("981234.56");
  });
  it("keeps a hidden approval chain usable through its explicit fee-confirmation fallback", async () => {
    await setup();
    fixture.database.exec("UPDATE workflow_instance_fields SET is_active=0,is_required=0 WHERE module_code='costs'");
    const data = await loader(request());
    const confirmation = data.settlementDirections.find(direction => direction.direction === "payable")!.actions.find(action => action.active)!;
    expect(confirmation).toMatchObject({ action: "confirm", configuredRelease: true, reason: null });
    expect(markup(data)).toContain('name="controlAction" value="confirm"');
    expect(await action(request({ intent: "expense_direction_control", direction: "payable", controlAction: "confirm" }))).toMatchObject({ actionKind: "expense_direction_control" });
    expect(fixture.database.prepare("SELECT stage FROM business_expenses WHERE id='payable'").get()?.stage).toBe("confirmed");
  });
  it("shows missing counterparties rather than offering a signature which the server will reject", async () => {
    await setup(); fixture.database.exec("UPDATE business_expenses SET counterparty_name='' WHERE direction='payable'");
    const data = await loader(request());
    const html = markup(data);
    expect(html).toContain("请先补齐费用往来单位");
    expect(html).not.toContain('name="controlAction"');
    expect(await action(request({ intent: "expense_direction_control", direction: "payable", controlAction: "confirm" }))).toMatchObject({ formError: "请先录入费用并填写往来单位" });
  });
  it("does not restore a revoked signature permission just because the user owns a module", async () => {
    await setup();
    harness.actor = { ...harness.actor, permissions: harness.actor.permissions.filter(permission => permission !== "settlement.signature.manage") };
    expect(markup(await loader(request()))).not.toContain('name="controlAction"');
    expect(await action(request({ intent: "expense_direction_control", direction: "payable", controlAction: "confirm" }))).toMatchObject({ formError: expect.stringContaining("没有此项签核办理权") });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_expense_direction_controls").get()?.n).toBe(0);
  });
  it("preserves the expense tab and account identity when following a legacy module entry", async () => {
    await setup();
    const args = { request: new Request("http://localhost/admin/orders/order/modules/costs?section=expenses&itmsTab=valid-session-123"), params: { orderId: "order", moduleCode: "costs" }, context: {} };
    try { await loader(args as never); throw new Error("Expected a redirect"); }
    catch (response) {
      expect(response).toBeInstanceOf(Response);
      const target = new URL((response as Response).headers.get("Location")!, "http://localhost");
      expect(target.searchParams.get("section")).toBe("expenses");
      expect(target.searchParams.get("module")).toBe("costs");
      expect(target.searchParams.get("itmsTab")).toBe("valid-session-123");
    }
  });
});
