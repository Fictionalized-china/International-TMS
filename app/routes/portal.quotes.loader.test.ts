import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));
vi.mock("../lib/portal.server", () => ({
  requirePortalCustomer: vi.fn().mockResolvedValue({
    user: { organizationId: "org-1", userId: "user-1" },
    customer: { id: "customer-1" },
  }),
}));

import { legacyPortalQuotesRedirectPath, loader } from "./portal.quotes";

describe("legacy portal quotation route", () => {
  it("redirects an old pending-quotation link to the unified order view", async () => {
    const result = await loader({
      request: new Request("http://local.test/portal/quotes?status=pending&quote=quote-1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/portal/orders?status=quote_pending&quote=quote-1");
  });

  it("preserves the multi-account portal context while mapping old filters", () => {
    expect(legacyPortalQuotesRedirectPath("http://local.test/portal/quotes?status=withdrawn&quote=q%2F2&portalContext=ctx-1"))
      .toBe("/portal/orders?status=quote_withdrawn&quote=q%2F2&portalContext=ctx-1");
  });
});
