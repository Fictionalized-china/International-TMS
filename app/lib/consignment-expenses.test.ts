import { describe, expect, it } from "vitest";
import { canReadConsignmentExpenses, consignmentExpenseTotals, type ConsignmentExpense } from "./consignment-expenses";
const fee: ConsignmentExpense = { id: "a", direction: "receivable", charge_name: "运费", counterparty_name: "客户", currency: "CNY", quantity: 1, unit_price: 10, amount: 10, exchange_rate: 1, stage: "estimated", notes: null };
describe("order-local consignment expenses", () => {
  it("lets assigned cost maintainers and the actual salesperson read necessary amounts, not arbitrary order viewers", () => {
    const input = { permissions: ["order.view", "order.module.costs.manage"], userId: "op", salespersonUserId: "sales", responsibleUserIds: ["op"] };
    expect(canReadConsignmentExpenses(input)).toBe(true);
    expect(canReadConsignmentExpenses({ ...input, responsibleUserIds: ["other"] })).toBe(false);
    expect(canReadConsignmentExpenses({ ...input, permissions: ["order.view"] })).toBe(false);
    expect(canReadConsignmentExpenses({ ...input, permissions: ["order.module.costs.manage"] })).toBe(false);
    expect(canReadConsignmentExpenses({ ...input, userId: "sales", responsibleUserIds: [], permissions: ["order.view", "billing.assigned_expense.review"] })).toBe(true);
  });
  it("keeps original currencies separate, includes zero and omits cancelled totals without mutating history", () => {
    const rows = [fee, { ...fee, id: "b", currency: "USD", amount: 2, exchange_rate: 7 }, { ...fee, id: "c", amount: 1000, stage: "cancelled" }, { ...fee, id: "d", amount: 0, direction: "payable" }];
    expect(consignmentExpenseTotals(rows, "receivable")).toEqual({ count: 2, currencyLabel: "CNY 10.00 · USD 2.00", base: 24 });
    expect(consignmentExpenseTotals(rows, "payable")).toEqual({ count: 1, currencyLabel: "CNY 0.00", base: 0 });
    expect(rows[2].amount).toBe(1000);
  });
  it("does not silently display malformed conversion as a valid margin", () => {
    expect(consignmentExpenseTotals([{ ...fee, exchange_rate: 0 }], "receivable").base).toBeNull();
    expect(consignmentExpenseTotals([{ ...fee, amount: NaN }], "receivable").base).toBeNull();
  });
});
