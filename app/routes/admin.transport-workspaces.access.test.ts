import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../lib/auth.server";
import { defaultBusinessProcessPolicy } from "../lib/business-process-policy";

const harness = vi.hoisted(() => ({ actor: {} as SessionUser, prepare: vi.fn(), loadTracking: vi.fn(), policy: vi.fn(), refresh: vi.fn(), loadOrders: vi.fn(), loadBatches: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { DB: { prepare: harness.prepare } } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: vi.fn(async (_: Request, permission?: string) => {
  if (permission && !harness.actor.permissions.includes(permission)) throw new Response("无权访问", { status: 403 });
  return harness.actor;
}) }));
vi.mock("../lib/tracking-center.server", () => ({ loadTrackingCenter: harness.loadTracking }));
vi.mock("../lib/business-process-policy.server", () => ({ loadBusinessProcessPolicy: harness.policy }));
vi.mock("../lib/dispatch-tasks.server", () => ({ refreshAutomaticDispatchTasks: harness.refresh, loadDispatchTaskRows: harness.loadOrders, requestDispatchTask: vi.fn(), fulfillDispatchTask: vi.fn() }));
vi.mock("../lib/batch-dispatch.server", () => ({ loadBatchFindVehicleTasks: harness.loadBatches, fulfillBatchFindVehicle: vi.fn() }));
vi.mock("../lib/daily-tracking.server", () => ({ recordDailyTracking: vi.fn() }));
import { loader as trackingLoader, action as trackingAction } from "./admin.tracking-center";
import { loader as dispatchLoader, action as dispatchAction } from "./admin.dispatch";
import { loader as workbenchLoader, action as workbenchAction } from "./admin.order-workbench";

function actor(permissions: string[], positionCode = "OPERATION") {
  harness.actor = { userId: "actor", organizationId: "org", permissions, roleCodes: [], positionCode,
    sessionId: "session", organizationName: "测试组织", email: "actor@e2e.test", displayName: "测试账号", site: "admin",
    departmentId: null, departmentCode: null, dataScope: "company", warehouseIds: [], regionCountryCodes: [] };
}
function args(workspace = "tracking") {
  return { request: new Request("https://tms.test/admin/workbenches/" + workspace + "?itmsTab=valid-session-123"), params: { workspace }, context: {} };
}
beforeEach(() => { vi.clearAllMocks(); actor(["order.view", "shipment.view"]); harness.policy.mockResolvedValue(defaultBusinessProcessPolicy); });

describe("transport route authorization before data access", () => {
  it.each(["tasks", "documents", "customs", "tracking", "costs"])("uses a non-reserved MySQL CTE name for the authorized %s workspace", async workspace => {
    actor(["order.view", "shipment.view", "tracking.center.view", "billing.view", "billing.sensitive.view"]);
    harness.prepare.mockImplementation(() => {
      const statement = { bind: (..._values: unknown[]) => statement, first: async () => ({ total: 0 }), all: async () => ({ results: [] }) };
      return statement;
    });
    const result = await workbenchLoader(args(workspace) as never);
    expect(result).toMatchObject({ workspace, total: 0, rows: [] });
    const cteQueries = harness.prepare.mock.calls.map(call => String(call[0])).filter(sql => /^WITH/i.test(sql));
    expect(cteQueries).toHaveLength(2);
    for (const sql of cteQueries) {
      expect(sql).toMatch(/^WITH workbench_rows AS/);
      expect(sql).toMatch(/FROM workbench_rows/);
      expect(sql).not.toMatch(/\b(?:WITH|FROM)\s+rows\b/i);
    }
  });
  it("blocks operation direct tracking reads and writes before querying any overseas data", async () => {
    await expect(trackingLoader(args() as never)).rejects.toMatchObject({ status: 403 });
    await expect(trackingAction(args() as never)).rejects.toMatchObject({ status: 403 });
    expect(harness.loadTracking).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
  });
  it.each(["tracking", "costs"])("blocks unprivileged %s workbench reads and writes before querying records", async workspace => {
    await expect(workbenchLoader(args(workspace) as never)).rejects.toMatchObject({ status: 403 });
    await expect(workbenchAction(args(workspace) as never)).rejects.toMatchObject({ status: 403 });
    expect(harness.prepare).not.toHaveBeenCalled();
  });
  it("redirects a commercial legacy notification to the dispatch page with its tab session", async () => {
    actor(["order.view", "shipment.view", "dispatch.view", "dispatch.manage"], "BUSINESS_ROUTE");
    const response = await trackingLoader(args() as never);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe("/admin/dispatch?itmsTab=valid-session-123");
    expect(harness.loadTracking).not.toHaveBeenCalled();
  });
  it("denies direct dispatch access without read permission and denies writes to read-only viewers", async () => {
    await expect(dispatchLoader(args() as never)).rejects.toMatchObject({ status: 403 });
    actor(["dispatch.view"]);
    await expect(dispatchAction(args() as never)).rejects.toMatchObject({ status: 403 });
    expect(harness.prepare).not.toHaveBeenCalled();
  });
});
