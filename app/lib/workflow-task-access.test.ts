import { describe, expect, it } from "vitest";
import { canCompleteWorkflowTask } from "./workflow-task-access";

describe("canCompleteWorkflowTask", () => {
  const base = {
    actorUserId: "user-a",
    actorPositionCodes: ["OPERATION"],
    responsibilityPositionCode: "OPERATION",
  } as const;

  it("allows the explicitly assigned task owner", () => {
    expect(canCompleteWorkflowTask({ ...base, taskAssigneeUserId: "user-a" })).toBe(true);
  });

  it("does not fall back to the matching position when another task owner exists", () => {
    expect(canCompleteWorkflowTask({ ...base, taskAssigneeUserId: "user-b" })).toBe(false);
  });

  it("uses the module owner only when the task has no personal owner", () => {
    expect(canCompleteWorkflowTask({ ...base, moduleAssigneeUserId: "user-a" })).toBe(true);
    expect(canCompleteWorkflowTask({ ...base, moduleAssigneeUserId: "user-b" })).toBe(false);
  });

  it("uses the frozen responsibility position only before a personal assignment", () => {
    expect(canCompleteWorkflowTask(base)).toBe(true);
    expect(canCompleteWorkflowTask({ ...base, actorPositionCodes: ["DOC"] })).toBe(false);
  });

  it("fails closed when the frozen task has no responsibility", () => {
    expect(canCompleteWorkflowTask({ ...base, responsibilityPositionCode: null })).toBe(false);
  });
});

