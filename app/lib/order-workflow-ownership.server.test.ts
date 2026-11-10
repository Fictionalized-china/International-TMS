import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture } from "./meeting-integration-fixture";
import { validateOrderWorkflowAction } from "./order-workflow.server";
import { orderDocumentSupplementNotificationStatement } from "./internal-notifications.server";
vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); Object.assign(env, { DB: fixture.db });
  fixture.database.prepare("INSERT INTO users(id,email,password_hash,display_name,phone,created_at,updated_at) VALUES('former-sales','former@test.local','not-a-login-hash','原业务员','13900000019',?,?)").run(fixture.now, fixture.now);
  fixture.database.prepare("INSERT INTO memberships(id,organization_id,user_id,department_id,position_id,created_at,updated_at) SELECT 'member:former','org','former-sales',department_id,position_id,?,? FROM memberships WHERE user_id='sales'").run(fixture.now, fixture.now);
  fixture.database.prepare(`INSERT INTO quotations(id,organization_id,quote_number,customer_id,salesperson_user_id,origin_country,origin_city,destination_country,destination_city,transport_mode,cargo_description,created_at,updated_at) VALUES('quote','org','Q-HISTORY','customer','former-sales','CN','深圳','RU','莫斯科','ROAD','来源货物',?,?)`).run(fixture.now, fixture.now);
  fixture.database.exec("UPDATE transport_orders SET status='draft',quotation_id='quote',current_step_code='order_creation',salesperson_user_id='sales' WHERE id='order'");
  fixture.database.prepare(`INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,created_at,updated_at) VALUES('cancel','org','cancel_draft','取消草稿','draft','cancelled','cancelled','已取消',0,?,?)`).run(fixture.now, fixture.now);
});
afterEach(() => fixture?.database.close());
const check = (actorUserId: string) => validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId, actionCode: "cancel_draft" });
describe("current order owner is authoritative after quote conversion", () => {
  it("permits the current salesperson, not the stale source quote salesperson", async () => {
    expect(await check("sales")).toMatchObject({ ok: true });
    expect(await check("former-sales")).toMatchObject({ ok: false });
  });
  it("does not restore a deliberately unassigned owner from the source quote", async () => {
    fixture.database.exec("UPDATE transport_orders SET salesperson_user_id=NULL WHERE id='order'");
    expect(await check("former-sales")).toMatchObject({ ok: false });
    expect(await check("owner")).toMatchObject({ ok: true });
  });
  it("sends a missing-document notice to the current owner only", async () => {
    await orderDocumentSupplementNotificationStatement(fixture.db, { organizationId: "org", orderId: "order", fieldLabel: "委托单", actorUserId: "owner", now: fixture.now }).run();
    expect(fixture.database.prepare("SELECT user_id FROM internal_notifications WHERE category='order_document_supplement'").all()).toEqual([{ user_id: "sales" }]);
  });
  it("refuses an inactive account even if the assigned position itself remains active", async () => {
    fixture.database.prepare(`INSERT INTO order_workflow_transitions(id,organization_id,action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,created_at,updated_at) VALUES('reject','org','reject','退回补录','submitted','draft','order_creation','录单',0,?,?)`).run(fixture.now, fixture.now);
    fixture.database.exec("UPDATE transport_orders SET status='submitted',current_step_code='consignment_approval',current_assignee_user_id='supervisor' WHERE id='order'; UPDATE users SET status='disabled' WHERE id='supervisor'");
    expect(await validateOrderWorkflowAction({ organizationId: "org", orderId: "order", actorUserId: "supervisor", actionCode: "reject" })).toMatchObject({ ok: false });
  });
});
