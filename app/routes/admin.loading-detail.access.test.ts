import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const current = {
    organizationId: "org-1",
    userId: "cs-1",
    permissions: ["order.view", "order.scope.assigned", "order.module.costs.manage"],
    positionCode: "CS",
    roleCodes: ["pos_customer_service"],
  };
  const DB = {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      })),
    })),
  };
  return {
    current,
    DB,
    requireSessionUser: vi.fn(async () => current),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));

import { action, loader } from "./admin.loading-detail";

function post(intent: string) {
  const body = new URLSearchParams({ intent });
  return new Request("http://local.test/admin/loading/batch-1", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("batch workspace customer-service access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.current.permissions = [
      "order.view",
      "order.scope.assigned",
      "order.module.costs.manage",
    ];
  });

  it("lets the loader pass the workspace gate for a cost-enabled customer-service account", async () => {
    await expect(loader({
      request: new Request("http://local.test/admin/loading/batch-1"),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never)).rejects.toMatchObject({ status: 404 });
    expect(harness.requireSessionUser).toHaveBeenCalledWith(
      expect.any(Request),
      "order.view",
    );
    expect(harness.DB.prepare).toHaveBeenCalledTimes(1);
  });

  it("lets the action reach the batch scope check for a cost allocation intent", async () => {
    await expect(action({
      request: post("create_cost_allocation"),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never)).resolves.toEqual({ formError: "配载批次无效" });
    expect(harness.DB.prepare).toHaveBeenCalledTimes(1);
  });

  it.each([
    "batch_approve",
    "arrangement",
    "batch_order_customs_declaration_save",
    "batch_tracking_add",
  ])("does not let the cost capability authorize %s", async (intent) => {
    await expect(action({
      request: post(intent),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never)).rejects.toMatchObject({ status: 403 });
    expect(harness.DB.prepare).not.toHaveBeenCalled();
  });

  it("keeps the loader closed when the cost permission is absent", async () => {
    harness.current.permissions = ["order.view", "order.scope.assigned"];
    await expect(loader({
      request: new Request("http://local.test/admin/loading/batch-1"),
      params: { batchId: "batch-1" },
      context: undefined,
    } as never)).rejects.toMatchObject({ status: 403 });
    expect(harness.DB.prepare).not.toHaveBeenCalled();
  });
});
