import { describe, expect, it } from "vitest";
import {
  configuredModuleRequiresCompletion,
  costsModuleReviewBlocker,
  currencyFinance,
  orderCompletionStatus,
  orderReviewModuleState,
  orderReviewSettlementBlockers,
  pickupCompletionReviewBlocker,
} from "./order-review";

describe("order review completion", () => {
  it("only lets enabled required modules create completion blockers", () => {
    expect(configuredModuleRequiresCompletion({ enabled: true, isRequired: true })).toBe(true);
    expect(configuredModuleRequiresCompletion({ enabled: true, isRequired: false })).toBe(false);
    expect(configuredModuleRequiresCompletion({ enabled: false, isRequired: true })).toBe(false);
    expect(configuredModuleRequiresCompletion(null)).toBe(true);
  });

  it("keeps the review blocked by the current configured costs module state", () => {
    expect(costsModuleReviewBlocker({
      enabled: true,
      isRequired: true,
      status: "in_progress",
      blockingReason: "待补齐必填项：客户账单",
    })).toEqual({
      code: "costs_workflow_gate",
      message: "待补齐必填项：客户账单",
      area: "costs",
    });
    expect(costsModuleReviewBlocker({
      enabled: true,
      isRequired: true,
      status: "completed",
      blockingReason: null,
    })).toBeNull();
    expect(costsModuleReviewBlocker({
      enabled: false,
      isRequired: true,
      status: "not_started",
      blockingReason: null,
    })).toBeNull();
    expect(costsModuleReviewBlocker({
      enabled: true,
      isRequired: false,
      status: "in_progress",
      blockingReason: "待补齐必填项：客户账单",
    })).toBeNull();
  });

  it("only requires pickup when both its current module and field are required", () => {
    const requiredField = {
      fieldKey: "pickup_completed_at",
      label: "提货完成时间",
      isActive: true,
      isRequired: true,
    };
    expect(pickupCompletionReviewBlocker({
      module: { enabled: true, isRequired: true },
      fields: [requiredField],
      pickupComplete: false,
    })).toMatchObject({ code: "pickup" });
    expect(pickupCompletionReviewBlocker({
      module: { enabled: true, isRequired: false },
      fields: [requiredField],
      pickupComplete: false,
    })).toBeNull();
    expect(pickupCompletionReviewBlocker({
      module: { enabled: true, isRequired: true },
      fields: [{ ...requiredField, isRequired: false }],
      pickupComplete: false,
    })).toBeNull();
    expect(pickupCompletionReviewBlocker({
      module: { enabled: true, isRequired: true },
      fields: [{ ...requiredField, isActive: false }],
      pickupComplete: false,
    })).toBeNull();
  });

  it("allows review completion when pickup is optional in the current snapshot", () => {
    expect(orderCompletionStatus({
      pickupComplete: false,
      pickupRequired: false,
      blockers: [],
      reviewGenerated: true,
      finance: [],
    })).toBe("completed_settled");
  });

  it("keeps the persisted review module aligned with recalculated completion", () => {
    expect(orderReviewModuleState("in_progress", ["待补齐必填项：客户账单"]))
      .toMatchObject({
        status: "blocked",
        stepCode: "reviewing",
        blockingReason: "待补齐必填项：客户账单",
        completed: false,
      });
    expect(orderReviewModuleState("business_complete_unsettled", []))
      .toMatchObject({
        status: "completed",
        stepCode: "confirmed",
        blockingReason: null,
        completed: true,
      });
    expect(orderReviewModuleState("completed_settled", []))
      .toMatchObject({ status: "completed", completed: true });
  });

  it("keeps an order in progress while a business blocker exists", () => {
    expect(orderCompletionStatus({
      pickupComplete: true,
      blockers: ["应付费用未完成财务锁定"],
      reviewGenerated: true,
      finance: [],
    })).toBe("in_progress");
  });

  it("marks business complete but unsettled while a non-blocking cash balance remains", () => {
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
    })).toBe("business_complete_unsettled");
    expect(finance[0]).toMatchObject({ margin: 300, marginRate: 30, receivableBalance: 400 });
  });

  it("only blocks on active required settlement fields", () => {
    const finance = [currencyFinance({
      currency: "USD",
      receivable: 1000,
      payable: 700,
      received: 600,
      paid: 700,
    })];
    const blockers = orderReviewSettlementBlockers({
      fields: [
        { fieldKey: "receivable_expenses", label: "应收费用", isActive: true, isRequired: false },
        { fieldKey: "payable_expenses", label: "应付费用", isActive: false, isRequired: true },
        { fieldKey: "customer_service_confirmation", label: "客服确认", isActive: true, isRequired: true },
        { fieldKey: "business_review", label: "业务审核", isActive: true, isRequired: false },
        { fieldKey: "finance_review", label: "财务审核", isActive: false, isRequired: true },
        { fieldKey: "cash_records", label: "收付款流水", isActive: true, isRequired: false },
        { fieldKey: "writeoff_records", label: "核销记录", isActive: false, isRequired: true },
      ],
      hasReceivable: true,
      hasPayable: true,
      controls: [
        {
          direction: "receivable",
          confirmed: false,
          businessReviewed: false,
          financeReviewed: false,
        },
        {
          direction: "payable",
          confirmed: true,
          businessReviewed: false,
          financeReviewed: false,
        },
      ],
      finance,
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ code: "receivable_signoffs_pending" });
    expect(blockers[0].message).toContain("客服确认");
    expect(blockers[0].message).not.toMatch(/业务审核|财务审核|核销记录|未收款/);
  });

  it("does not let optional or hidden cash gates turn an unsettled order into a loop", () => {
    const finance = [currencyFinance({
      currency: "CNY",
      receivable: 500,
      payable: 300,
      received: 0,
      paid: 0,
    })];
    const blockers = orderReviewSettlementBlockers({
      fields: [
        { fieldKey: "cash_records", label: "收付款流水", isActive: true, isRequired: false },
        { fieldKey: "writeoff_records", label: "核销记录", isActive: false, isRequired: false },
      ],
      hasReceivable: true,
      hasPayable: true,
      controls: [],
      finance,
    });
    expect(blockers).toEqual([]);
    expect(orderCompletionStatus({
      pickupComplete: true,
      blockers: blockers.map((item) => item.message),
      reviewGenerated: true,
      finance,
    })).toBe("business_complete_unsettled");
  });

  it("keeps an unsettled balance blocking when cash or writeoff is active and required", () => {
    const finance = [currencyFinance({
      currency: "USD",
      receivable: 100,
      payable: 0,
      received: 0,
      paid: 0,
    })];
    const blockers = orderReviewSettlementBlockers({
      fields: [
        { fieldKey: "cash_records", label: "收付款流水", isActive: true, isRequired: true },
        { fieldKey: "writeoff_records", label: "核销记录", isActive: true, isRequired: false },
      ],
      hasReceivable: true,
      hasPayable: false,
      controls: [],
      finance,
    });
    expect(blockers).toEqual([
      expect.objectContaining({
        code: "receivable_balance_USD",
        message: expect.stringContaining("收付款流水"),
      }),
    ]);
    expect(orderCompletionStatus({
      pickupComplete: true,
      blockers: blockers.map((item) => item.message),
      reviewGenerated: true,
      finance,
    })).toBe("in_progress");
  });

  it("keeps legacy hard-coded settlement gates when no workflow snapshot exists", () => {
    const blockers = orderReviewSettlementBlockers({
      fields: [],
      hasReceivable: true,
      hasPayable: true,
      controls: [],
      finance: [],
    });
    expect(blockers.map((item) => item.code)).toEqual([
      "receivable_signoffs_pending",
      "payable_signoffs_pending",
    ]);
    expect(blockers.map((item) => item.message).join("；")).toMatch(
      /客服费用确认.*业务审核.*财务审核/,
    );
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
