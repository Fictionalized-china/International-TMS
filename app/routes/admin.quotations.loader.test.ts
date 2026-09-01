import { beforeEach, describe, expect, it, vi } from "vitest";

const d1 = vi.hoisted(() => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;

  async function tracked<T>(value: T): Promise<T> {
    active += 1;
    calls += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return value;
    } finally {
      active -= 1;
    }
  }

  const DB = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            all: async () => tracked({
              results: sql.includes("FROM quotations q") ? [{ id: "quote-1" }] : [],
            }),
          };
        },
      };
    },
  };

  return {
    DB,
    tracked,
    reset() {
      active = 0;
      maxActive = 0;
      calls = 0;
    },
    snapshot() {
      return { active, maxActive, calls };
    },
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: d1.DB } }));
vi.mock("../lib/auth.server", () => ({
  requireSessionUser: vi.fn().mockResolvedValue({
    organizationId: "org-1",
    userId: "user-1",
    permissions: [],
  }),
}));
vi.mock("../lib/quotation-workflow-fields.server", () => ({
  listQuotationWorkflowFields: vi.fn(() => d1.tracked([])),
  listQuotationWorkflowFieldValues: vi.fn(() => d1.tracked([])),
  listQuotationWorkflowInstanceFields: vi.fn(() => d1.tracked([])),
  prepareQuotationWorkflowFieldValues: vi.fn(),
  savePreparedQuotationWorkflowFieldValues: vi.fn(),
}));

import { loader } from "./admin.quotations";

describe("quotation loader D1 concurrency", () => {
  beforeEach(() => d1.reset());

  it("loads the quotation desk in waves of at most four D1 connections", async () => {
    const result = await loader({
      request: new Request("http://local.test/admin/quotations"),
      params: {},
      context: undefined,
    } as never);

    expect(result.quotes).toEqual([{ id: "quote-1" }]);
    expect(d1.snapshot().calls).toBe(13);
    expect(d1.snapshot().maxActive).toBeLessThanOrEqual(4);
    expect(d1.snapshot().active).toBe(0);
  });
});
