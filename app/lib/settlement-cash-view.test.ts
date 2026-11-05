import { describe, expect, it } from "vitest";
import type { ReconciliationRow, CashTransactionRow } from "./settlement-workbench.server";
import { cashRegistrationRemaining, matchingStatementCash } from "./settlement-cash-view";

const row: ReconciliationRow = { id: "pay", document_number: "PAY", direction: "payable", counterparty_name: "供应商", currency: "CNY", settlement_entity: "公司", total_amount: 214, status: "confirmed", notes: null, confirmed_at: null, created_at: "2026-11-04", expense_count: 1, orders: "SO", order_refs: "order|SO", invoiced_amount: 0, settled_amount: 0 };
const cash: CashTransactionRow = { id: "cash", transaction_number: "CASH", direction: "payment", counterparty_name: "供应商", currency: "CNY", amount: 214, allocated_amount: 0, occurred_on: "2026-11-04", settlement_entity: "公司", account_name: "银行", status: "unallocated", created_at: "2026-11-04", payment_reconciliation_id: "pay" };

describe("cashier registration and allocation presentation", () => {
  it("distinguishes paid from allocated instead of inviting duplicate supplier payments", () => {
    expect(cashRegistrationRemaining({ ...row, registered_payment_amount: 214 })).toBe(0);
    expect(cashRegistrationRemaining({ ...row, registered_payment_amount: 14 })).toBe(200);
    expect(cashRegistrationRemaining({ ...row, total_amount: 0.3, registered_payment_amount: 0.1 })).toBe(0.2);
    expect(cashRegistrationRemaining({ ...row, registered_payment_amount: 220 })).toBe(0);
    expect(cashRegistrationRemaining({ ...row, direction: "receivable", settled_amount: 100, registered_payment_amount: 214 })).toBe(114);
  });
  it("excludes a payment bound to another statement even when party and currency match", () => {
    expect(matchingStatementCash(row, [cash])).toEqual([cash]);
    for (const change of [{ payment_reconciliation_id: "other" }, { direction: "receipt" as const }, { currency: "USD" }, { counterparty_name: "另一家" }, { allocated_amount: 214 }]) {
      expect(matchingStatementCash(row, [{ ...cash, ...change }])).toEqual([]);
    }
    expect(matchingStatementCash(row, [{ ...cash, payment_reconciliation_id: null }])).toHaveLength(1);
  });
});
