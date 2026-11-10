import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { meetingFixture } from "./meeting-integration-fixture";
import { completeIntakeFacts } from "./order-intake-completeness.test-fixture";
import { loadOrderIntakeCompleteness } from "./order-intake-completeness.server";
vi.mock("cloudflare:workers", () => ({ env: {} }));
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); Object.assign(env, { DB: fixture.db });
  const facts = completeIntakeFacts();
  const orderKeys = Object.keys(facts.order).filter(key => key !== "id");
  fixture.database.prepare(`UPDATE transport_orders SET ${orderKeys.map(key => `${key}=?`).join(",")} WHERE id='order'`).run(...orderKeys.map(key => facts.order[key] as string));
  function insert(table: string, row: Record<string, unknown>) {
    const keys = Object.keys(row); fixture.database.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key] as string | number));
  }
  insert("order_cargo_items", { ...facts.cargo[0], organization_id: "org", order_id: "order", line_no: 1, package_type: "carton", created_at: fixture.now, updated_at: fixture.now });
  for (const expense of facts.expenses) insert("business_expenses", { ...expense, organization_id: "org", order_id: "order", created_by_user_id: "sales", created_at: fixture.now, updated_at: fixture.now });
  insert("order_services", { id: "service", organization_id: "org", order_id: "order", service_code: "pickup", service_name: "提货", created_at: fixture.now });
});
afterEach(() => fixture?.database.close());
describe("current-order intake completeness loader", () => {
  it("reads current facts without requiring a source quotation or writing business state", async () => {
    const before = fixture.database.prepare("SELECT * FROM transport_orders WHERE id='order'").get();
    expect(await loadOrderIntakeCompleteness("org", "order")).toMatchObject({ knownFieldsSatisfied: true, issues: [] });
    expect(fixture.database.prepare("SELECT * FROM transport_orders WHERE id='order'").get()).toEqual(before);
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM audit_logs").get()).toMatchObject({ n: 0 });
  });
  it("does not cache missing or complete results across subsequent writes", async () => {
    expect((await loadOrderIntakeCompleteness("org", "order")).knownFieldsSatisfied).toBe(true);
    fixture.database.exec("UPDATE transport_orders SET exit_port=NULL WHERE id='order'");
    expect((await loadOrderIntakeCompleteness("org", "order")).issues).toContainEqual(expect.objectContaining({ fieldKey: "quotation_exit_port" }));
    fixture.database.exec("UPDATE transport_orders SET exit_port='RESTORED' WHERE id='order'");
    expect((await loadOrderIntakeCompleteness("org", "order")).knownFieldsSatisfied).toBe(true);
  });
  it("excludes cancelled expense/service facts without changing completed or cancelled historical orders", async () => {
    fixture.database.exec("UPDATE business_expenses SET stage='cancelled' WHERE id='ap'; UPDATE order_services SET status='cancelled'; UPDATE transport_orders SET status='completed' WHERE id='order'");
    const result = await loadOrderIntakeCompleteness("org", "order");
    expect(result.issues.map(issue => issue.fieldKey)).toEqual(expect.arrayContaining(["quotation_intake_entrustedServices", "intake_fee_pickup"]));
    expect(fixture.database.prepare("SELECT status FROM transport_orders WHERE id='order'").get()).toMatchObject({ status: "completed" });
  });
  it("cannot read another organization's order", async () => {
    await expect(loadOrderIntakeCompleteness("other-org", "order")).rejects.toThrow("不属于当前组织");
  });
});
