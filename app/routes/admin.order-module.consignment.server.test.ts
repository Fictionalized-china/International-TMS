import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.server";
import { meetingFixture } from "../lib/meeting-integration-fixture";
const harness = vi.hoisted(() => ({ db: null as unknown as D1Database, actor: null as unknown as SessionUser }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: async () => harness.actor }));
import { EmbeddedOrderModule, loader } from "./admin.order-module";
import { validateOrderWorkflowAction } from "../lib/order-workflow.server";
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); harness.db = fixture.db;
  const db = fixture.database, now = fixture.now;
  db.prepare("INSERT INTO workflow_definitions(id,organization_id,code,name,created_at,updated_at) VALUES('wf','org','approval-test','审核分配',?,?)").run(now, now);
  db.prepare("INSERT INTO workflow_instances(id,organization_id,workflow_id,customer_id,order_id,current_step_key,started_at,updated_at) VALUES('instance','org','wf','customer','order','consignment_approval',?,?)").run(now, now);
  for (const [key, sort, status] of [["order_creation", 10, "completed"], ["consignment_approval", 20, "active"]] as const) {
    db.prepare("INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,created_at,updated_at) VALUES(?,'wf',?,?,'order',?,?,?,?)").run(key, key, key, `manual.${key}`, sort, now, now);
    db.prepare("INSERT INTO workflow_step_modules(id,workflow_id,step_id,module_code,display_name,created_at,updated_at) VALUES(?,'wf',?,'consignment','委托',?,?)").run(`p:${key}`, key, now, now);
    db.prepare("INSERT INTO workflow_instance_step_states(id,instance_id,workflow_id,step_id,step_key,step_name,sort_order,status,updated_at) VALUES(?,'instance','wf',?,?,?,?,?,?)").run(`s:${key}`, key, key, key, sort, status, now);
    db.prepare("INSERT INTO workflow_instance_module_states(id,instance_step_state_id,step_module_id,module_code,display_name,sort_order,is_required,completion_mode,responsibility_position_code,updated_at) VALUES(?,?,?,'consignment','委托',10,1,'all_tasks','OPERATION_SUPERVISOR',?)").run(`m:${key}`, `s:${key}`, `p:${key}`, now);
  }
  db.exec("UPDATE transport_orders SET workflow_instance_id='instance',status='submitted',current_step_code='consignment_approval',current_assignee_user_id='supervisor',shipper_contact='当前联系人',special_instructions='当前订单说明' WHERE id='order'");
  for (const key of ["quotation_customer_contact_name", "quotation_origin_region", "quotation_destination_region", "special_instructions"]) {
    db.prepare("INSERT INTO workflow_instance_fields(id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,is_active,created_at) VALUES(?,'instance','wf','order_creation','consignment',?,?,'text',0,1,?)").run(key, key, key, now);
  }
  db.prepare("INSERT INTO order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,volume_per_package_cbm,declared_quantity,declared_unit,created_at,updated_at) VALUES('cargo','org','order',1,'当前货物','carton',2,1,12,0,10,'台',?,?)").run(now, now);
  for (const [id, direction, amount, stage, source] of [["ar", "receivable", 100, "estimated", "quotation_charge"], ["ap", "payable", 20, "estimated", "intake"], ["cancelled", "payable", 1000, "cancelled", "manual"]]) {
    db.prepare("INSERT INTO business_expenses(id,organization_id,order_id,direction,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,stage,source_type,foreign_account_no,created_by_user_id,created_at,updated_at) VALUES(?,'org','order',?,?,'当前费用','往来单位','CNY',1,?,?,1,?,?,'BANK-SECRET','sales',?,?)").run(id, direction, id, amount, amount, stage, source, now, now);
  }
});
afterEach(() => fixture?.database.close());
async function read(actor: string) {
  harness.actor = fixture.actors.get(actor)!;
  return loader({ request: new Request("http://localhost/admin/orders/order?stage=consignment_approval&module=consignment"), params: { orderId: "order", moduleCode: "consignment" } } as never);
}
function render(data: Awaited<ReturnType<typeof loader>>, approval = true) {
  const router = createMemoryRouter([{ path: "*", element: createElement(EmbeddedOrderModule, { data: data as never, busy: false, actionUrl: "/admin/orders/order?stage=consignment_approval&module=consignment", workflowStepKey: "consignment_approval", approvalMode: approval, combinedReviewAssignment: true, consignmentSection: "costs", hideConsignmentActionBar: true }) }], { initialEntries: ["/"] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
describe("complete order-local consignment review", () => {
  it.each(["owner", "sales", "supervisor", "cs"])("lets assigned %s read the current AR and AP, without widening financial permissions", async actor => {
    const data = await read(actor);
    expect(data.canViewConsignmentExpenses).toBe(true);
    expect(data.expenses.map(row => row.id)).toEqual(expect.arrayContaining(["ar", "ap"]));
    if (["sales", "operation", "supervisor"].includes(actor)) {
      expect(data.canViewFullExpenseDetails).toBe(false);
      expect(data.expenses.every(row => row.foreign_account_no === null)).toBe(true);
    }
  });
  it("lets the explicitly assigned operation handler read necessary AR/AP without bank access", async () => {
    fixture.database.exec("UPDATE transport_orders SET current_assignee_user_id='operation' WHERE id='order'");
    const data = await read("operation"); expect(data.canViewConsignmentExpenses).toBe(true);
    expect(data.expenses.map(row => row.id)).toEqual(expect.arrayContaining(["ar", "ap"]));
    expect(data.canViewFullExpenseDetails).toBe(false); expect(data.expenses.every(row => row.foreign_account_no === null)).toBe(true);
  });
  it("keeps the complete current info, individual cargo and both ledgers visible before approving", async () => {
    const data = await read("supervisor"), html = render(data);
    expect(html).toContain("当前联系人"); expect(html).toContain("当前订单说明"); expect(html).toContain("10 台"); expect(html).toContain("2 包");
    expect(html).toContain("应收费用明细"); expect(html).toContain("应付费用明细"); expect(html).toContain("CNY 100.00"); expect(html).toContain("CNY 20.00");
    expect(html).toContain("审核结果"); expect(html).not.toContain("BANK-SECRET"); expect(html).not.toContain("预计收支差额");
    const currentFees = html.slice(html.indexOf('aria-label="当前订单费用"'));
    expect(currentFees).not.toContain("CNY 1020.00");
  });
  it("does not grant amounts to unrelated order viewers or removed cost permissions", async () => {
    const tracker = await read("tracker"); expect(tracker.canViewConsignmentExpenses).toBe(false); expect(tracker.expenses).toEqual([]);
    harness.actor = { ...fixture.actors.get("supervisor")!, permissions: fixture.actors.get("supervisor")!.permissions.filter(p => p !== "order.module.costs.manage") };
    const data = await loader({ request: new Request("http://localhost/admin/orders/order"), params: { orderId: "order", moduleCode: "consignment" } } as never);
    expect(data.canViewConsignmentExpenses).toBe(false); expect(data.expenses).toEqual([]);
  });
  it("renders the current ledger in the order's costs tab as well as approval", async () => {
    const html = render(await read("owner"), false);
    expect(html).toContain("应收费用明细"); expect(html).toContain("应付费用明细"); expect(html).toContain("CNY 100.00"); expect(html).toContain("预计收支差额");
  });
  it("keeps full review facts visible to read-only participants, without showing approval actions", async () => {
    const html = render(await read("sales"));
    expect(html).toContain("当前订单说明"); expect(html).toContain("应收费用明细"); expect(html).toContain("委托审核状态"); expect(html).not.toContain('id="consignment-approval-form"');
  });
  it("does not expose a foreign organization's quote charges through a broken historical source reference", async () => {
    const db = fixture.database, now = fixture.now;
    db.prepare("INSERT INTO organizations(id,code,name,created_at,updated_at) VALUES('other-org','other','其他组织',?,?)").run(now, now);
    db.prepare("INSERT INTO customers(id,organization_id,code,identity_code,name,created_at,updated_at) VALUES('other-customer','other-org','other','ABC23','其他客户',?,?)").run(now, now);
    db.prepare("INSERT INTO quotations(id,organization_id,quote_number,customer_id,origin_country,origin_city,destination_country,destination_city,transport_mode,cargo_description,created_at,updated_at) VALUES('other-quote','other-org','Q-OTHER','other-customer','CN','深圳','RU','莫斯科','ROAD','其他货物',?,?)").run(now, now);
    db.prepare("INSERT INTO quotation_charges(id,quotation_id,charge_code,description,quantity,unit_price,amount,created_at) VALUES('secret-charge','other-quote','FREIGHT','OTHER-ORG-SECRET',1,123,123,?)").run(now);
    db.exec("UPDATE transport_orders SET quotation_id='other-quote' WHERE id='order'");
    const data = await read("owner"); expect(data.quotationCharges).toEqual([]); expect(data.order.quotation_total_amount).toBeNull();
  });
  it("blocks blind approval from a direct service request after amount capability is revoked, without cancelling correction paths", async () => {
    fixture.database.prepare("INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,is_active,created_at,updated_at) VALUES('approve','org','approve','审核通过','submitted','confirmed','task_assignment','任务分配',1,10,1,?,?) ON CONFLICT DO NOTHING").run(fixture.now, fixture.now);
    fixture.database.exec("DELETE FROM role_permissions WHERE role_id='org:role:pos_operation_supervisor' AND permission_code='order.module.costs.manage'");
    const checked = await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId: "supervisor", actionCode: "approve", assigneeUserId: "supervisor" });
    expect(checked).toMatchObject({ ok: false, reason: expect.stringContaining("不能盲审") });
    fixture.database.prepare("INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order,is_active,created_at,updated_at) VALUES('reject','org','reject','退回补录','submitted','draft','order_creation','录单',0,20,1,?,?)").run(fixture.now, fixture.now);
    expect(await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId: "supervisor", actionCode: "reject" })).toMatchObject({ ok: true });
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()).toEqual({ status: "submitted" });
  });
});
