import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.server";
import { meetingFixture } from "../lib/meeting-integration-fixture";
const harness = vi.hoisted(() => ({ db: null as unknown as D1Database, actor: null as unknown as SessionUser }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return harness.db; } } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: async (_request: Request, permission: string) => {
  if (!harness.actor.permissions.includes(permission)) throw new Response("没有权限", { status: 403 });
  return harness.actor;
} }));
import HrReports, { loader } from "./admin.hr-reports";
import { loader as exportLoader } from "./admin.hr-reports-export";
let fixture: Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async () => {
  fixture = await meetingFixture(); harness.db = fixture.db; harness.actor = fixture.actors.get("hr")!;
  fixture.database.exec("UPDATE transport_orders SET quote_commercial_user_id='commercial',quote_commercial_name_snapshot='报价人快照'");
});
afterEach(() => fixture?.database.close());
const args = (query = "") => ({ request: new Request(`http://localhost/admin/hr-reports?from=2026-09-01&to=2026-09-30&${query}`) } as never);
describe("HR ledger view and export routes", () => {
  it("opens the all-consignment view for unpaid business and preserves the paid report as a separate view", async () => {
    const data = await loader(args()); expect(data).not.toBeInstanceOf(Response);
    if (data instanceof Response) throw new Error("Expected ledger data");
    expect(data.view).toBe("consignments"); expect(data.total).toBe(1);
    const router = createMemoryRouter([{ path: "*", element: createElement(HrReports, { loaderData: data, actionData: undefined } as never) }], { initialEntries: ["/"] });
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    for (const text of ["全部委托与报价归属", "已回款提成依据", "报价人快照", "TEST-SO", 'name="commercial"', 'name="payment"', "导出当前筛选 CSV"]) expect(html).toContain(text);
    const paid = await loader(args("view=paid"));
    if (paid instanceof Response) throw new Error("Expected paid data");
    expect(paid.view).toBe("paid"); expect(paid.total).toBe(0);
  });
  it("exports the current filter and requires an independent export permission", async () => {
    await expect(loader(args("export=1&commercial=commercial"))).rejects.toMatchObject({ status: 302 });
    const exported = await exportLoader(args("commercial=commercial")); expect(exported).toBeInstanceOf(Response);
    const response = exported as Response;
    expect(response.headers.get("Cache-Control")).toContain("no-store"); expect(await response.text()).toContain("报价人快照");
    const empty = await exportLoader(args("commercial=owner")); expect(await empty.text()).not.toContain("TEST-SO");
    harness.actor = { ...harness.actor, permissions: harness.actor.permissions.filter(p => p !== "data.export") };
    await expect(exportLoader(args())).rejects.toMatchObject({ status: 403 });
    await expect(loader(args("export=1"))).rejects.toMatchObject({ status: 403 });
  });
  it("retains the account slot and current filters in the download link and old-link redirect", async () => {
    const request = new Request("http://localhost/admin/hr-reports?from=2026-09-01&to=2026-09-30&view=consignments&commercial=commercial&itmsTab=slot-12345678&export=1");
    try { await loader({ request } as never); throw new Error("Expected a redirect"); }
    catch (error) { expect(error).toBeInstanceOf(Response); const location = (error as Response).headers.get("Location")!; expect(location).toContain("/admin/hr-reports/export?"); expect(location).toContain("itmsTab=slot-12345678"); expect(location).toContain("commercial=commercial"); }
    const paid = await exportLoader(args("view=paid")); expect(paid.headers.get("Content-Disposition")).toContain("hr-paid-orders");
    expect(await paid.text()).toContain("确认收入CNY");
  });
  it("rejects missing HR access and invalid date/state filters without writing anything", async () => {
    await expect(loader(args("receipt=__proto__"))).rejects.toMatchObject({ status: 400 });
    harness.actor = fixture.actors.get("operation")!;
    await expect(loader(args())).rejects.toMatchObject({ status: 403 });
    expect(fixture.database.prepare("SELECT COUNT(*) n FROM order_commission_records").get()).toEqual({ n: 0 });
  });
});
