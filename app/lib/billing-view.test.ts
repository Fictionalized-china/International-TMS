import { describe, expect, it } from "vitest";
import { readBillingView, settlementExpenseGroupKey } from "./billing-view";

describe("billing view", () => {
  it("uses a stable default tab and clamps invalid query values", () => {
    expect(readBillingView(new URLSearchParams("tab=unknown&page=-2&direction=bad"))).toMatchObject({
      tab: "tasks",
      page: 1,
      direction: "",
      historyType: "cash",
    });
    expect(readBillingView(new URLSearchParams("tab=history&historyType=invoices&page=3"))).toMatchObject({
      tab: "history",
      page: 3,
      historyType: "invoices",
    });
  });

  it("supports a role-specific default tab", () => {
    expect(readBillingView(new URLSearchParams(), "cash").tab).toBe("cash");
  });

  it("normalizes currency and preserves valid filters", () => {
    expect(readBillingView(new URLSearchParams(
      "tab=reconciliations&direction=payable&currency=usd&status=unsettled&q=SO-227",
    ))).toMatchObject({
      tab: "reconciliations",
      direction: "payable",
      currency: "USD",
      status: "unsettled",
      query: "SO-227",
    });
  });

  it("groups pending expenses by direction, counterparty and currency", () => {
    expect(settlementExpenseGroupKey({
      direction: "receivable",
      counterparty_name: "测试客户1",
      currency: "CNY",
    })).toBe("receivable\u0000测试客户1\u0000CNY");
  });
});
