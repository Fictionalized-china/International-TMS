import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));
import {
  ExpenseSelection,
  PendingReconciliationPage,
  ReconciliationSheet,
} from "./admin.billing";

const expense = {
  id: "expense-1",
  order_id: "order-1",
  order_number: "SO-001",
  customer_name: "客户甲",
  direction: "receivable" as const,
  charge_name: "运费",
  counterparty_name: "客户甲",
  currency: "CNY",
  amount: 100,
  stage: "confirmed",
  invoiced_amount: 0,
  settled_amount: 0,
  outbound_ready: 1,
};

const reconciliation = {
  id: "rec-1",
  document_number: "REC-001",
  direction: "receivable" as const,
  counterparty_name: "客户甲",
  settlement_entity: "测试组织",
  currency: "CNY",
  total_amount: 100,
  status: "confirmed",
  notes: null,
  confirmed_at: "2026-09-06T00:00:00Z",
  created_at: "2026-09-06T00:00:00Z",
  expense_count: 1,
  orders: "SO-001",
  order_refs: "order-1|SO-001",
  invoiced_amount: 0,
  settled_amount: 0,
};

describe("central settlement workbench UI gates", () => {
  it("renders an unavailable expense group as information, not disabled controls", () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(ExpenseSelection, {
        direction: "receivable",
        counterparty: "客户甲",
        currency: "CNY",
        expenses: [expense],
        busy: false,
        access: {
          visible: true,
          canWrite: false,
          reason: "当前处于“客户签收”，进入“三方结算”后开放",
        },
      }),
    ));

    expect(markup).toContain("进入“三方结算”后开放");
    expect(markup).toContain("SO-001");
    expect(markup).not.toContain('name="expenseId"');
    expect(markup).not.toContain('value="create_reconciliation"');
  });

  it("does not render an action or its reason when an expense action is invisible", () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(ExpenseSelection, {
        direction: "receivable",
        counterparty: "Customer A",
        currency: "CNY",
        expenses: [expense],
        busy: false,
        access: {
          visible: false,
          canWrite: false,
          reason: "hidden expense gate reason",
        },
      }),
    ));

    expect(markup).toBe("");
    expect(markup).not.toContain("hidden expense gate reason");
    expect(markup).not.toContain('value="create_reconciliation"');
  });

  it("builds one form from the writable subset and renders each blocked expense read-only", () => {
    const blockedExpense = {
      ...expense,
      id: "expense-2",
      order_id: "order-2",
      order_number: "SO-002",
    };
    const hiddenExpense = {
      ...expense,
      id: "expense-3",
      order_id: "order-3",
      order_number: "SO-003",
    };
    const page = {
      items: [expense, blockedExpense, hiddenExpense],
      page: 1,
      pageCount: 1,
      pageSize: 10,
      total: 3,
    };
    const workbench = createElement(PendingReconciliationPage, {
      view: {
        tab: "pending",
        page: 1,
        query: "",
        direction: "receivable",
        currency: "",
        status: "",
        historyType: "cash",
      },
      page,
      accessByExpenseId: {
        "expense-1": { visible: true, canWrite: true, reason: null },
        "expense-2": {
          visible: true,
          canWrite: false,
          reason: "SO-002 waits for settlement step",
        },
        "expense-3": {
          visible: false,
          canWrite: false,
          reason: "hidden expense reason",
        },
      },
      busy: false,
    });
    const router = createMemoryRouter([{ path: "/", element: workbench }], {
      initialEntries: ["/"],
    });
    const markup = renderToStaticMarkup(createElement(RouterProvider, { router }));

    expect(markup).toContain('name="expenseId" value="expense-1"');
    expect(markup).not.toContain('name="expenseId" value="expense-2"');
    expect(markup).not.toContain('name="expenseId" value="expense-3"');
    expect(markup).toContain("SO-002");
    expect(markup).toContain("SO-002 waits for settlement step");
    expect(markup).not.toContain("SO-003");
    expect(markup).not.toContain("hidden expense reason");
    expect(markup).toContain("当前页 2 条");
  });

  it("renders a configured current expense action as a real form", () => {
    const workbench = createElement(ExpenseSelection, {
        direction: "receivable", counterparty: "客户甲", currency: "CNY",
        expenses: [expense], busy: false,
        access: { visible: true, canWrite: true, reason: null },
      });
    const router = createMemoryRouter([{ path: "/", element: workbench }], { initialEntries: ["/"] });
    const markup = renderToStaticMarkup(createElement(RouterProvider, { router }));
    expect(markup).toContain('name="expenseId"');
    expect(markup).toContain('value="create_reconciliation"');
  });

  it("shows the frozen-stage reason instead of an invoice form", () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(ReconciliationSheet, {
        row: reconciliation,
        mode: "invoice",
        busy: false,
        access: {
          visible: true,
          canWrite: false,
          reason: "当前已离开“三方结算”，本项仅可查看历史",
        },
      }),
    ));
    expect(markup).toContain("本项仅可查看历史");
    expect(markup).not.toContain('value="record_invoice"');
  });

  it("does not render an action card or its reason when reconciliation access is invisible", () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(ReconciliationSheet, {
        row: reconciliation,
        mode: "invoice",
        busy: false,
        access: {
          visible: false,
          canWrite: false,
          reason: "hidden reconciliation gate reason",
        },
      }),
    ));

    expect(markup).toBe("");
    expect(markup).not.toContain("hidden reconciliation gate reason");
    expect(markup).not.toContain('value="record_invoice"');
  });
});
