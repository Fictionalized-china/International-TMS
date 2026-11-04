import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));
import { EmbeddedOrderModule } from "./admin.order-module";

const directions = [{
  direction: "payable",
  actions: [{ action: "confirm", active: true, required: true, completed: false,
    configuredRelease: false, ownerLabel: "操作员甲（操作岗）", reason: null }],
}];

function render(input: { canReadMoney?: boolean; stageAvailable?: boolean; reason?: string | null } = {}) {
  const data = {
    current: { userId: "operation", positionCode: "OPERATION", roleCodes: [], permissions: ["order.view", "settlement.signature.manage"] },
    order: { id: "order", order_number: "SO-TEST", status: "in_execution" },
    definition: { code: "costs" },
    access: { canEdit: false, reason: "当前节点由客服负责" },
    workflowStageAccess: { available: input.stageAvailable ?? true, currentStepKey: "reconciliation" },
    workflowFields: [],
    canViewExpenseSummary: input.canReadMoney ?? false,
    settlementDirections: directions.map(direction => ({ ...direction, actions: direction.actions.map(action => ({ ...action, reason: input.reason ?? null })) })),
    // Hidden ledger data must never be rendered in the sign-only view.
    expenses: [{ amount: 981234.56, foreign_account_no: "PRIVATE-ACCOUNT" }],
  };
  const router = createMemoryRouter([{ path: "*", element: createElement(EmbeddedOrderModule, {
    data: data as never, busy: false, readOnly: true, costsSection: "expenses",
    actionUrl: "/admin/orders/order?stage=reconciliation&module=costs&section=expenses&itmsTab=demo-tab-123",
  }) }], { initialEntries: ["/admin/orders/order?module=costs"] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("embedded settlement sign-only access", () => {
  it("keeps the assigned operation signature form even without sensitive finance read or current-node ownership", () => {
    const html = render();
    expect(html).toContain('name="controlAction" value="confirm"');
    expect(html).toContain('name="direction" value="payable"');
    expect(html).toContain("操作员甲（操作岗）");
    expect(html).toContain("itmsTab=demo-tab-123");
    expect(html).not.toContain("当前账号无需办理费用结算");
    expect(html).not.toContain("981234.56");
    expect(html).not.toContain("PRIVATE-ACCOUNT");
    expect(html).not.toContain("预计利润");
    expect(html).not.toContain('value="expense_add"');
  });

  it("does not let the module stage gate hide an independently authorized post-export signature", () => {
    expect(render({ stageAvailable: false })).toContain('name="controlAction" value="confirm"');
  });

  it("shows the actual prerequisite or assignee reason without rendering a submit button", () => {
    const html = render({ reason: "请先由本单客服完成应收确认" });
    expect(html).toContain("请先由本单客服完成应收确认");
    expect(html).not.toContain('name="controlAction"');
    expect(html).not.toContain("/admin/settlement-approvals");
  });
});
