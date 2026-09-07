import { describe, expect, it } from "vitest";
import { settlementTaskNextAction, type SettlementTaskPackRow } from "./settlement-task-pack";

const row = (overrides: Partial<SettlementTaskPackRow> = {}): SettlementTaskPackRow => ({
  id: "order-1", order_number: "SO-001", customer_name: "客户", business_type: "ftl",
  status: "in_execution", current_step_name: "对账结算", completion_status: "in_progress",
  expense_count: 2, receivable_count: 1, payable_count: 1, expense_amount: 200,
  receivable_confirmed: 1, payable_confirmed: 1,
  receivable_business_reviewed: 1, payable_business_reviewed: 1,
  receivable_finance_reviewed: 1, payable_finance_reviewed: 1,
  reconciliation_count: 0, reconciliation_draft_count: 0, reconciliation_confirmed_count: 0,
  invoiced_amount: 0, settled_amount: 0, billing_document_count: 0, payment_receipt_count: 0,
  review_snapshot_count: 0, review_conclusion: null, updated_at: "2026-09-07T00:00:00Z",
  ...overrides,
});

describe("settlement task next action", () => {
  it("sends each signoff role to the same order expense workspace", () => {
    expect(settlementTaskNextAction(row({ receivable_confirmed: 0 }), "CS").label).toBe("客服确认费用");
    expect(settlementTaskNextAction(row({ payable_business_reviewed: 0 }), "SALES").label).toBe("业务签核费用");
    expect(settlementTaskNextAction(row({ payable_finance_reviewed: 0 }), "FINANCE_ACCOUNTING").label).toBe("财务签核费用");
  });

  it("moves from reconciliation through invoice, cash, documents and review", () => {
    expect(settlementTaskNextAction(row(), "FINANCE_ACCOUNTING").label).toBe("生成对账单");
    expect(settlementTaskNextAction(row({ reconciliation_count: 1, reconciliation_draft_count: 1 }), "FINANCE_ACCOUNTING").label).toBe("确认对账单");
    expect(settlementTaskNextAction(row({ reconciliation_count: 1, reconciliation_confirmed_count: 1 }), "FINANCE_ACCOUNTING").label).toBe("登记发票");
    expect(settlementTaskNextAction(row({ reconciliation_count: 1, reconciliation_confirmed_count: 1, invoiced_amount: 200 }), "CASHIER").label).toBe("登记流水并核销");
    expect(settlementTaskNextAction(row({ reconciliation_count: 1, reconciliation_confirmed_count: 1, invoiced_amount: 200, settled_amount: 200 }), "FINANCE_ACCOUNTING").label).toBe("归集账单与凭证");
    expect(settlementTaskNextAction(row({ reconciliation_count: 1, reconciliation_confirmed_count: 1, invoiced_amount: 200, settled_amount: 200, billing_document_count: 1, payment_receipt_count: 1 }), "FINANCE_ACCOUNTING").label).toBe("完成复盘");
  });
});
