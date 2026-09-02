import { describe, expect, it, vi } from "vitest";

const d1 = vi.hoisted(() => {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    calls,
    DB: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            calls.push({ sql, binds });
            return {
              all: async () => ({
                results: sql.includes("FROM quotations q")
                  ? [
                    { id: "quote-1", quote_number: "QT-001", lifecycle_status: "pending" },
                    { id: "quote-2", quote_number: "QT-002", lifecycle_status: "pending" },
                  ]
                  : [],
              }),
            };
          },
        };
      },
    },
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: d1.DB } }));
vi.mock("../lib/portal.server", () => ({
  requirePortalCustomer: vi.fn().mockResolvedValue({
    user: { organizationId: "org-1", userId: "user-1" },
    customer: { id: "customer-1" },
  }),
}));
vi.mock("../lib/quotation-workflow-fields.server", () => ({
  listQuotationWorkflowFields: vi.fn().mockResolvedValue([]),
  listQuotationWorkflowInstanceFields: vi.fn().mockResolvedValue([]),
}));

import { loader } from "./portal.quotes";

describe("portal quotation direct view", () => {
  it("keeps the selected quotation as focus while listing every pending quotation", async () => {
    const result = await loader({
      request: new Request("http://local.test/portal/quotes?quote=quote-1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.quotationId).toBe("quote-1");
    expect(result.lifecycle).toBe("pending");
    expect(result.quotes).toEqual([
      expect.objectContaining({ id: "quote-1", lifecycle_status: "pending" }),
      expect.objectContaining({ id: "quote-2", lifecycle_status: "pending" }),
    ]);
    expect(d1.calls[0].sql).toContain("q.organization_id=? AND q.customer_id=? AND q.lifecycle_status=?");
    expect(d1.calls[0].sql).not.toContain("AND q.id=?");
    expect(d1.calls[0].sql).toContain("ORDER BY CASE WHEN q.id=? THEN 0 ELSE 1 END");
    expect(d1.calls[0].binds).toEqual(["org-1", "customer-1", "pending", "quote-1"]);
  });
});
