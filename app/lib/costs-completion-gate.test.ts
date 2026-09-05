import { describe, expect, it } from "vitest";
import {
  evaluateCostsCompletionGate,
  type CostsCompletionFieldState,
} from "./costs-completion-gate";

function requiredField(
  fieldKey: string,
  present: boolean,
  label = fieldKey,
): CostsCompletionFieldState {
  return {
    moduleCode: "costs",
    stepKey: "reconciliation",
    fieldKey,
    label,
    isActive: true,
    isRequired: true,
    present,
  };
}

describe("costs completion gate", () => {
  it("completes only when every configured required gate is satisfied", () => {
    const result = evaluateCostsCompletionGate({
      fields: [
        requiredField("customer_service_confirmation", true, "客服确认"),
        requiredField("business_review", true, "业务审核"),
        requiredField("finance_review", true, "财务审核"),
        requiredField("reconciliation_statement", true, "对账单"),
      ],
      directions: [
        {
          direction: "receivable",
          hasExpenses: true,
          customerServiceConfirmed: true,
          businessReviewed: true,
          financeReviewed: true,
        },
        {
          direction: "payable",
          hasExpenses: true,
          customerServiceConfirmed: true,
          businessReviewed: true,
          financeReviewed: true,
        },
      ],
    });

    expect(result).toMatchObject({
      complete: true,
      status: "completed",
      progressPercent: 100,
      currentStepCode: "settled",
      blockingReason: null,
      blockers: [],
    });
  });

  it("requires both directions for every configured required sign-off", () => {
    const result = evaluateCostsCompletionGate({
      fields: [
        requiredField("customer_service_confirmation", true, "客服确认"),
        requiredField("business_review", true, "业务审核"),
        requiredField("finance_review", true, "财务审核"),
      ],
      directions: [
        {
          direction: "receivable",
          hasExpenses: true,
          customerServiceConfirmed: true,
          businessReviewed: true,
          financeReviewed: true,
        },
        {
          direction: "payable",
          hasExpenses: true,
          customerServiceConfirmed: false,
          businessReviewed: true,
          financeReviewed: true,
        },
      ],
    });

    expect(result.complete).toBe(false);
    expect(result.status).toBe("in_progress");
    expect(result.currentStepCode).toBe("parallel_review");
    expect(result.blockers).toEqual([
      {
        fieldKey: "customer_service_confirmation",
        label: "客服确认（应付）",
        direction: "payable",
      },
    ]);
  });

  it("does not block on optional, hidden, or non-reconciliation fields", () => {
    const result = evaluateCostsCompletionGate({
      fields: [
        {
          ...requiredField("business_review", false, "业务审核"),
          isRequired: false,
        },
        {
          ...requiredField("finance_review", false, "财务审核"),
          isActive: false,
        },
        {
          ...requiredField("pre_receivable_expenses", false, "报价应收"),
          stepKey: "order_creation",
        },
      ],
      directions: [],
    });

    expect(result).toMatchObject({
      complete: true,
      status: "completed",
      progressPercent: 100,
      blockingReason: null,
      blockers: [],
    });
  });

  it("derives progress and the blocking reason from configured required field presence", () => {
    const result = evaluateCostsCompletionGate({
      fields: [
        requiredField("reconciliation_statement", true, "对账单"),
        requiredField("invoice_records", false, "开票/收票记录"),
      ],
      directions: [],
    });

    expect(result).toMatchObject({
      complete: false,
      status: "in_progress",
      progressPercent: 50,
      currentStepCode: "parallel_review",
      blockingReason: "待补齐必填项：开票/收票记录",
      blockers: [
        { fieldKey: "invoice_records", label: "开票/收票记录" },
      ],
    });
  });
});
