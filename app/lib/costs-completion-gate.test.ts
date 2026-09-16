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
  it("never completes settlement before the workflow reaches reconciliation", () => {
    const result = evaluateCostsCompletionGate({
      fields: [requiredField("receivable_expenses", true, "应收费用")],
      directions: [
        {
          direction: "receivable",
          hasExpenses: true,
          customerServiceConfirmed: false,
          businessReviewed: false,
          financeReviewed: false,
        },
      ],
      settlementStageReached: false,
    });

    expect(result).toMatchObject({
      complete: false,
      status: "in_progress",
      currentStepCode: "parallel_review",
      blockers: [
        { fieldKey: "settlement_stage", label: "尚未进入对账结算节点" },
      ],
    });
    expect(result.progressPercent).toBeLessThan(100);
  });

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

  it("does not require a direction sign-off when that direction has no expenses", () => {
    const result = evaluateCostsCompletionGate({
      fields: [
        requiredField("customer_service_confirmation", true, "客服确认"),
      ],
      directions: [
        {
          direction: "receivable",
          hasExpenses: true,
          customerServiceConfirmed: true,
          businessReviewed: false,
          financeReviewed: false,
        },
        {
          direction: "payable",
          hasExpenses: false,
          customerServiceConfirmed: false,
          businessReviewed: false,
          financeReviewed: false,
        },
      ],
    });

    expect(result).toMatchObject({
      complete: true,
      blockers: [],
    });
  });

  it("still requires enabled settlement signatures when legacy configuration marks them optional", () => {
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
      ],
      directions: [
        {
          direction: "receivable",
          hasExpenses: true,
          customerServiceConfirmed: true,
          businessReviewed: false,
          financeReviewed: false,
        },
      ],
    });

    expect(result).toMatchObject({
      complete: false,
      status: "in_progress",
      blockers: [{ fieldKey: "business_review", direction: "receivable" }],
    });
  });

  it("does not block on hidden settlement signatures", () => {
    const result = evaluateCostsCompletionGate({
      fields: [
        {
          ...requiredField("finance_review", false, "财务审核"),
          isActive: false,
        },
      ],
      directions: [
        {
          direction: "receivable",
          hasExpenses: true,
          customerServiceConfirmed: true,
          businessReviewed: true,
          financeReviewed: false,
        },
      ],
    });

    expect(result.complete).toBe(true);
  });

  it("uses the locked field placement instead of a hard-coded settlement step", () => {
    const result = evaluateCostsCompletionGate({
      fields: [
        {
          ...requiredField("reconciliation_statement", false, "对账单"),
          stepKey: "customer_defined_settlement",
        },
      ],
      directions: [],
    });

    expect(result).toMatchObject({
      complete: false,
      status: "not_started",
      blockers: [{ fieldKey: "reconciliation_statement", label: "对账单" }],
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
      blockers: [{ fieldKey: "invoice_records", label: "开票/收票记录" }],
    });
  });

  it("keeps a required cash gate open until the direction balance is fully settled", () => {
    const result = evaluateCostsCompletionGate({
      fields: [
        requiredField("cash_records", true, "收付款流水"),
        {
          ...requiredField("writeoff_records", false, "核销记录"),
          isRequired: false,
        },
      ],
      directions: [
        {
          direction: "receivable",
          hasExpenses: true,
          outstandingBalance: 125,
          customerServiceConfirmed: true,
          businessReviewed: true,
          financeReviewed: true,
        },
        {
          direction: "payable",
          hasExpenses: false,
          outstandingBalance: 0,
          customerServiceConfirmed: false,
          businessReviewed: false,
          financeReviewed: false,
        },
      ],
    });

    expect(result).toMatchObject({
      complete: false,
      blockers: [
        {
          fieldKey: "cash_records",
          direction: "receivable",
        },
      ],
    });
    expect(result.blockingReason).toContain("收付款流水");
    expect(result.blockingReason).toContain("应收");
  });
});
