import { describe, expect, it } from "vitest";

import {
  selectWorkflowExecutionCurrentStep,
  workflowExecutionModuleIsComplete,
} from "./workflow-execution";

const step = (
  stepKey: string,
  sortOrder: number,
  existingStatus: string,
  pendingRequired: number,
  moduleCount = 1,
) => ({
  step_key: stepKey,
  sort_order: sortOrder,
  existing_status: existingStatus,
  module_count: moduleCount,
  pending_required: pendingRequired,
});

describe("selectWorkflowExecutionCurrentStep", () => {
  it("advances from a stale active step to an optional-only target step", () => {
    const current = selectWorkflowExecutionCurrentStep(
      [
        step("reconciliation", 100, "active", 0),
        step("completion_review", 110, "pending", 0, 2),
      ],
      "completion_review",
      110,
    );

    expect(current?.step_key).toBe("completion_review");
  });

  it("keeps the earliest reachable step with an unfinished required module", () => {
    const current = selectWorkflowExecutionCurrentStep(
      [
        step("outbound_transport", 80, "active", 1),
        step("reconciliation", 100, "pending", 0),
      ],
      "reconciliation",
      100,
    );

    expect(current?.step_key).toBe("outbound_transport");
  });

  it("selects the target when the target itself still has required work", () => {
    const current = selectWorkflowExecutionCurrentStep(
      [
        step("overseas_pickup", 90, "completed", 0),
        step("reconciliation", 100, "pending", 1),
      ],
      "reconciliation",
      100,
    );

    expect(current?.step_key).toBe("reconciliation");
  });
});

describe("workflowExecutionModuleIsComplete", () => {
  it("does not let missing required fields pass at the current target step", () => {
    expect(workflowExecutionModuleIsComplete({
      existingStepStatus: "active",
      stepSortOrder: 80,
      targetSortOrder: 80,
      sourceModuleStatus: "completed",
      completionMode: "all_tasks",
      taskCount: 1,
      pendingRequired: 0,
      hasMissingRequiredFields: true,
    })).toBe(false);
  });

  it("does not rewind a completed historical module after a later real node is reached", () => {
    expect(workflowExecutionModuleIsComplete({
      existingStepStatus: "active",
      stepSortOrder: 80,
      targetSortOrder: 90,
      sourceModuleStatus: "completed",
      completionMode: "all_tasks",
      taskCount: 1,
      pendingRequired: 0,
      hasMissingRequiredFields: true,
    })).toBe(true);
  });

  it("completes a normally satisfied current-step module", () => {
    expect(workflowExecutionModuleIsComplete({
      existingStepStatus: "active",
      stepSortOrder: 80,
      targetSortOrder: 80,
      sourceModuleStatus: "in_progress",
      completionMode: "all_tasks",
      taskCount: 1,
      pendingRequired: 0,
      hasMissingRequiredFields: false,
    })).toBe(true);
  });
});
