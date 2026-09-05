import { describe, expect, it } from "vitest";
import {
  canAccessSettlementWorkbench,
  canViewAssignedOrderExpenseSummary,
  canViewFullOrderExpenseDetails,
} from "./billing-access";

describe("settlement workbench access", () => {
  it("requires both billing and sensitive-finance visibility", () => {
    expect(canAccessSettlementWorkbench([
      "billing.view",
      "billing.sensitive.view",
    ])).toBe(true);
    expect(canAccessSettlementWorkbench(["billing.view"])).toBe(false);
    expect(canAccessSettlementWorkbench(["billing.sensitive.view"])).toBe(false);
    expect(canAccessSettlementWorkbench([])).toBe(false);
  });
});

describe("order expense visibility", () => {
  it("lets the assigned salesperson review only their own order summary", () => {
    expect(canViewAssignedOrderExpenseSummary({
      permissions: ["billing.assigned_expense.review"],
      currentUserId: "sales-a",
      salespersonUserId: "sales-a",
    })).toBe(true);
    expect(canViewAssignedOrderExpenseSummary({
      permissions: ["billing.assigned_expense.review"],
      currentUserId: "sales-b",
      salespersonUserId: "sales-a",
    })).toBe(false);
  });

  it("keeps full expense details behind the sensitive billing permission", () => {
    expect(canViewAssignedOrderExpenseSummary({
      permissions: ["billing.sensitive.view"],
      currentUserId: "finance-a",
      salespersonUserId: "sales-a",
    })).toBe(true);
    expect(canViewFullOrderExpenseDetails(["billing.sensitive.view"])).toBe(true);
    expect(canViewFullOrderExpenseDetails(["billing.assigned_expense.review"])).toBe(false);
  });
});
