import { beforeEach, describe, expect, it, vi } from "vitest";

const d1 = vi.hoisted(() => {
  let active = 0;
  let maxActive = 0;

  async function tracked<T>(value: T): Promise<T> {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return value;
    } finally {
      active -= 1;
    }
  }

  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              all: async () => tracked({
                results: sql.includes("FROM quotations")
                  ? [{
                    id: "quote-1",
                    quote_number: "QT-001",
                    road_load_type: "ftl",
                    cargo_description: "测试货物",
                    origin_city: "深圳市",
                    destination_city: "塔什干",
                    total_amount: 1200,
                    valid_until: "2026-09-30",
                    created_at: "2026-09-02T00:00:00.000Z",
                  }]
                  : [],
              }),
              first: async () => tracked(sql.includes("pending_quotes")
                ? { orders: 2, shipments: 1, outstanding: 500, pending_quotes: 1 }
                : { count: 0 }),
            };
          },
        };
      },
    },
    reset() {
      active = 0;
      maxActive = 0;
    },
    snapshot() {
      return { active, maxActive };
    },
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: d1.DB } }));
vi.mock("../lib/portal.server", () => ({
  requirePortalCustomer: vi.fn().mockResolvedValue({
    user: { organizationId: "org-1", userId: "user-1" },
    customer: { id: "customer-1", name: "客户一", code: "C001", status: "active" },
  }),
}));

import { loader, quotationDetailLink } from "./portal.index";

describe("portal home quotation entry", () => {
  beforeEach(() => d1.reset());

  it("returns pending quotations without exceeding the D1 concurrency limit", async () => {
    const result = await loader({
      request: new Request("http://local.test/portal"),
      params: {},
      context: undefined,
    } as never);

    expect(result.pendingQuotes).toEqual([
      expect.objectContaining({ id: "quote-1", quote_number: "QT-001" }),
    ]);
    expect(result.summary.pendingQuotes).toBe(1);
    expect(d1.snapshot().maxActive).toBeLessThanOrEqual(4);
    expect(d1.snapshot().active).toBe(0);
  });

  it("links a pending quotation to its exact customer confirmation view", () => {
    expect(quotationDetailLink("quote 1/2")).toBe("/portal/orders?status=quote_pending&quote=quote%201%2F2");
  });
});
