import { describe, expect, it } from "vitest";
import {
  workflowInstanceCapabilityStageAccess,
  type LockedWorkflowStageContext,
} from "./workflow-instance-stage-gate";

function context(
  currentStepKey: string,
  fieldOverrides: Partial<LockedWorkflowStageContext["fields"][number]> = {},
): LockedWorkflowStageContext {
  return {
    locked: true,
    currentStepKey,
    steps: [
      { stepKey: "pickup", stepName: "客户提货", sortOrder: 10 },
      {
        stepKey: "custom_settlement",
        stepName: "自定义结算",
        sortOrder: 20,
      },
      { stepKey: "archive", stepName: "复盘归档", sortOrder: 30 },
    ],
    modulePlacements: [
      { moduleCode: "costs", stepKey: "custom_settlement" },
    ],
    fields: [
      {
        moduleCode: "costs",
        fieldKey: "finance_review",
        stepKey: "custom_settlement",
        isActive: true,
        isRequired: true,
        ...fieldOverrides,
      },
    ],
  };
}

describe("locked workflow instance stage gate", () => {
  it("opens a configured capability when its custom field placement is reached", () => {
    expect(
      workflowInstanceCapabilityStageAccess({
        context: context("custom_settlement"),
        moduleCode: "costs",
        fieldKeys: ["finance_review"],
      }),
    ).toMatchObject({
      configured: true,
      visible: true,
      available: true,
      targetStepKey: "custom_settlement",
      targetStepName: "自定义结算",
    });
  });

  it("keeps the capability closed before the configured custom placement", () => {
    const result = workflowInstanceCapabilityStageAccess({
      context: context("pickup"),
      moduleCode: "costs",
      fieldKeys: ["finance_review"],
    });

    expect(result).toMatchObject({
      configured: true,
      visible: true,
      available: false,
      targetStepKey: "custom_settlement",
    });
    expect(result.reason).toContain("自定义结算");
  });

  it("does not expose a field hidden by the locked workflow snapshot", () => {
    expect(
      workflowInstanceCapabilityStageAccess({
        context: context("archive", {
          isActive: false,
          isRequired: false,
        }),
        moduleCode: "costs",
        fieldKeys: ["finance_review"],
      }),
    ).toMatchObject({
      configured: true,
      visible: false,
      available: false,
    });
  });

  it("fails closed when a visible field has no module placement at its step", () => {
    const broken = context("archive");
    broken.modulePlacements = [];

    const result = workflowInstanceCapabilityStageAccess({
      context: broken,
      moduleCode: "costs",
      fieldKeys: ["finance_review"],
    });

    expect(result).toMatchObject({
      configured: true,
      visible: true,
      available: false,
    });
    expect(result.reason).toContain("模块");
  });

  it("marks a legacy order without a locked snapshot for caller fallback", () => {
    expect(
      workflowInstanceCapabilityStageAccess({
        context: {
          locked: false,
          currentStepKey: "reconciliation",
          steps: [],
          modulePlacements: [],
          fields: [],
        },
        moduleCode: "costs",
        fieldKeys: ["finance_review"],
      }),
    ).toMatchObject({
      configured: false,
      visible: true,
      available: false,
    });
  });
});
