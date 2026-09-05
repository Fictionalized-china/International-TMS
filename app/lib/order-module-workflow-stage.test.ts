import { describe, expect, it } from "vitest";
import { orderModuleWorkflowStageAccess } from "./order-stage-flow";
import { frozenOrderModuleWorkflowStageAccess } from "./order-module-workflow-stage";

describe("order module workflow stage source", () => {
  it("uses the frozen custom placement for an instance-bound order", () => {
    expect(frozenOrderModuleWorkflowStageAccess("review", {
      locked: true,
      currentStepKey: "custom_review",
      steps: [
        { stepKey: "settlement", stepName: "结算", sortOrder: 80 },
        { stepKey: "custom_review", stepName: "终审归档", sortOrder: 90 },
      ],
      modulePlacements: [
        { moduleCode: "review", stepKey: "custom_review" },
      ],
      fields: [],
    })).toEqual({
      available: true,
      currentStepKey: "custom_review",
      currentStepName: "终审归档",
      requiredStepKey: "custom_review",
      requiredStepName: "终审归档",
      customPlacement: true,
      reason: null,
    });
  });

  it("returns an explicit legacy signal so only orders without a snapshot use definitions", () => {
    const context = {
      locked: false,
      currentStepKey: "reconciliation",
      steps: [],
      modulePlacements: [],
      fields: [],
    } as const;
    expect(frozenOrderModuleWorkflowStageAccess("review", context)).toBeNull();

    expect(orderModuleWorkflowStageAccess(
      "review",
      "completion_review",
      [
        { stepKey: "reconciliation", stepName: "对账结算", sortOrder: 100 },
        { stepKey: "completion_review", stepName: "完成复盘", sortOrder: 110 },
      ],
      "completion_review",
    )).toMatchObject({
      available: true,
      requiredStepKey: "completion_review",
      customPlacement: false,
    });
  });

  it("keeps a configured module closed when it is absent from the frozen snapshot", () => {
    expect(frozenOrderModuleWorkflowStageAccess("review", {
      locked: true,
      currentStepKey: "completion_review",
      steps: [
        { stepKey: "completion_review", stepName: "完成复盘", sortOrder: 110 },
      ],
      modulePlacements: [],
      fields: [],
    })).toMatchObject({
      available: false,
      reason: "当前工作流实例缺少对应的节点配置",
    });
  });
});
