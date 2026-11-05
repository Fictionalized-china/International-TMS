import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReconciliationRow } from "../lib/settlement-workbench.server";
vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));
import { CashEntryForm, ReconciliationSheet } from "./admin.billing";

const row: ReconciliationRow = { id: "pay", document_number: "PAY", direction: "payable", counterparty_name: "供应商", currency: "CNY", settlement_entity: "公司", total_amount: 214, status: "confirmed", notes: null, confirmed_at: null, created_at: "2026-11-04", expense_count: 1, orders: "SO", order_refs: "order|SO", invoiced_amount: 0, settled_amount: 0, registered_payment_amount: 0 };
const requestId = "11111111-1111-4111-8111-111111111111";
afterEach(() => vi.restoreAllMocks());
function render(element: React.ReactNode, actionData?: unknown) {
  const router = createMemoryRouter([{ id: "finance", path: "/", element }], { initialEntries: ["/"], hydrationData: { actionData: actionData ? { finance: actionData } : undefined } });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
const entry = (statement = row, busy = false) => createElement(CashEntryForm, { users: [{ id: "cashier", display_name: "出纳" }], organizationName: "公司", statement, busy });
describe("cashier forms provide local feedback instead of a silent repeated payment", () => {
  it("shows an error alongside the correct statement only", () => {
    const response = { financialIntent: "record_cash", reconciliationId: row.id, formError: "本账单已登记 214.00，请核对现有流水并办理核销" };
    expect(render(entry(), response)).toContain('role="alert"');
    expect(render(entry(), response)).toContain(response.formError);
    expect(render(entry({ ...row, id: "another" }), response)).not.toContain(response.formError);
  });
  it("retains a successful registration and requires an explicit new-entry action before another request", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    const html = render(entry({ ...row, direction: "receivable" }), { financialIntent: "record_cash", reconciliationId: row.id, cashRecordedId: "saved", cashRecordedRequestId: requestId, success: "流水已登记，请办理核销" });
    expect(html).toContain("流水已登记，请办理核销");
    expect(html).toContain("继续登记另一笔实际流水");
    expect(html).not.toContain('value="record_cash"');
  });
  it("distinguishes pending submission from an idle actionable button", () => {
    const busy = render(entry(row, true)), idle = render(entry());
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('disabled=""');
    expect(busy).toContain("正在登记，请勿重复操作");
    expect(idle).not.toContain('disabled=""');
    expect(idle).toContain('min="0.01" max="214"');
  });
  it("explains the no-cash disabled state in an expanded allocation section", () => {
    const html = render(createElement(ReconciliationSheet, { row, mode: "cash", access: { visible: true, canWrite: true, reason: null }, busy: false, cash: [] }));
    expect(html).toContain('class="billing-card-operation" open=""');
    expect(html).toContain("请先在下方登记");
    expect(html).toContain('disabled=""');
  });
  it("prevents the three-column notes span from creating an implicit column in a two-column order form", () => {
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    expect(css).toContain(".order-financial-body .settlement-cash-form > :is(.settlement-cash-notes, .financial-cash-submit, .financial-form-feedback) { grid-column: 1 / -1; }");
  });
});
