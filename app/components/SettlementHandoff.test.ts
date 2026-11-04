import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { SettlementHandoff } from "./SettlementHandoff";
function render(overrides: Record<string, unknown> = {}) {
  const data = { phase: "cash", canStatements: false, canCash: true, canReview: false, financiallyClosed: false, archived: false, canRecover: false, configurationIssue: null, offlineRequired: false, offlineRecorded: false, canRecordOffline: false, ...overrides };
  const router = createMemoryRouter([{ path: "*", element: createElement(SettlementHandoff, { data: data as never, orderId: "order", orderNumber: "SO-1", actionUrl: "/admin/orders/order?module=costs&itmsTab=test-session-123", busy: false }) }], { initialEntries: ["/"] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
describe("clear financial handoff entrances", () => {
  it("gives the cashier a real cash entrance without financial review or archive controls", () => {
    const html = render();
    expect(html).toContain("/admin/billing?tab=cash");
    expect(html).toContain("出纳 · 收付款核销");
    expect(html).not.toContain('name="intent" value="settlement_reopen"');
    expect(html).not.toContain("stage=completion_review");
  });
  it("gives assigned finance an explicit, confirmed recovery and final review entrance", () => {
    const html = render({ canCash: false, canReview: true, canRecover: true });
    expect(html).toContain("stage=completion_review");
    expect(html).toContain('name="intent" value="settlement_reopen"');
    const confirmation = html.match(/<input[^>]*name="confirmed"[^>]*>/)?.[0];
    expect(confirmation).toContain('type="checkbox"');
    expect(confirmation).toContain('required=""');
    expect(confirmation).toContain('value="1"');
    expect(html).toContain("itmsTab=test-session-123");
  });
  it("keeps a closed order free of further mutation controls", () => {
    const html = render({ archived: true, financiallyClosed: true, canCash: false });
    expect(html).toContain("已完成并结清");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("tab=cash");
  });
  it("filters the creation entrance to payable when AR is assigned to a different configured position", () => {
    const html = render({ canStatements: true, statementDirection: "payable" });
    expect(html).toContain("tab=pending&amp;q=SO-1&amp;direction=payable");
    expect(html).toContain("tab=reconciliations&amp;q=SO-1");
  });
});
