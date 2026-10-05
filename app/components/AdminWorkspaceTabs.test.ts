import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AdminWorkspaceTabs } from "./AdminWorkspaceTabs";
import type { AdminWorkspaceKey } from "../lib/admin-workspace-navigation";

function render(workspace: AdminWorkspaceKey, path: string, permissions: string[]) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] },
    createElement(AdminWorkspaceTabs, { workspace, user: { permissions, positionCode: "OPERATION", roleCodes: [] } })));
}

describe("admin workspace tab rendering", () => {
  it("shows only the authorized approval tab for non-financial approval staff", () => {
    const markup = render("billing", "/admin/settlement-approvals", ["menu.admin.settlement_approvals.view", "order.view", "settlement.signature.manage"]);
    expect(markup).toContain("待我审批");
    expect(markup).not.toContain('href="/admin/billing');
    expect(markup).toContain('aria-current="page"');
  });

  it("shows both independent workbench views with exactly one current-page marker", () => {
    const markup = render("portal", "/admin?view=blocked", ["menu.admin.portal.view", "menu.admin.dashboard.view", "dashboard.view"]);
    expect(markup).toContain("我的待办");
    expect(markup).toContain("运营看板");
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup.match(/<a\b[^>]*class="active"[^>]*>/)?.[0]).toContain('href="/admin"');
  });

  it("keeps intake accessible when quotation is disabled and preserves the tab identity", () => {
    const markup = render("orders", "/admin/orders?itmsTab=session-tab-123&q=FOO&page=4", ["menu.admin.orders.view", "order.view", "order.intake.manage"]);
    expect(markup).toContain('/admin/quotations?entryMode=direct&amp;itmsTab=session-tab-123');
    expect(markup).not.toContain("报价辅助");
    expect(markup).not.toContain("q=FOO");
    expect(markup).not.toContain("page=4");
  });

  it("does not render intake controls for read-only order viewers", () => {
    expect(render("orders", "/admin/orders", ["menu.admin.orders.view", "order.view"])).not.toContain("直接录单");
  });

  it("highlights intake, not the order list, at the preserved legacy intake URL", () => {
    const markup = render("orders", "/admin/quotations?entryMode=direct", ["menu.admin.orders.view", "order.view", "order.intake.manage"]);
    expect(markup.match(/<a\b[^>]*class="active"[^>]*>/)?.[0]).toContain('href="/admin/quotations?entryMode=direct"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("does not render unauthorized peer-page links for users without menu permissions", () => {
    expect(render("sales", "/admin/quotations", ["quote.view", "sales.view"])).toBe("");
  });
});
