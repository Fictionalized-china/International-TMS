import { describe, expect, it } from "vitest";
import { currencyFinance, orderCompletionStatus } from "./order-review";

describe("order review completion", () => {
  it("keeps an order in progress while a business blocker exists", () => {
    expect(orderCompletionStatus({
      pickupComplete: true,
      blockers: ["应付费用未完成财务锁定"],
      reviewGenerated: true,
      finance: [],
    })).toBe("in_progress");
  });

  it("keeps completion blocked while any cash balance remains", () => {
    const finance = [currencyFinance({
      currency: "usd",
      receivable: 1000,
      payable: 700,
      received: 600,
      paid: 700,
    })];
    expect(orderCompletionStatus({
      pickupComplete: true,
      blockers: [],
      reviewGenerated: true,
      finance,
    })).toBe("in_progress");
    expect(finance[0]).toMatchObject({ margin: 300, marginRate: 30, receivableBalance: 400 });
  });

  it("marks the order settled only after receivable and payable balances close", () => {
    const finance = [currencyFinance({
      currency: "CNY",
      receivable: 1000,
      payable: 700,
      received: 1000,
      paid: 700,
    })];
    expect(orderCompletionStatus({
      pickupComplete: true,
      blockers: [],
      reviewGenerated: true,
      finance,
    })).toBe("completed_settled");
  });
});
