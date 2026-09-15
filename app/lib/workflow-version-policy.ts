export type WorkflowVersionSwitchDecisionInput = {
  affectedOrderCount: number;
  completedOrderCount: number;
  hasActualExit: boolean;
};

export function workflowVersionSwitchDecision(input: WorkflowVersionSwitchDecisionInput) {
  if (input.hasActualExit) {
    return {
      allowed: false,
      reason: "订单或所属配载单已经实际出境，工作流版本已锁定；如需补充资料，请创建审计补录任务。",
    } as const;
  }
  if (input.completedOrderCount > 0) {
    return {
      allowed: false,
      reason: "受影响订单中存在已完成订单，不能再切换工作流版本。",
    } as const;
  }
  if (input.affectedOrderCount < 1) {
    return { allowed: false, reason: "没有找到可切换的订单。" } as const;
  }
  return { allowed: true, reason: null } as const;
}

export function workflowStepStatusAfterVersionSwitch(input: {
  targetStepKey: string;
  targetSortOrder: number;
  currentStepKey: string;
  currentSortOrder: number;
  previousStatus: string | null;
  instanceCompleted: boolean;
}) {
  if (
    input.instanceCompleted ||
    input.previousStatus === "completed" ||
    input.targetSortOrder < input.currentSortOrder
  ) {
    return "completed" as const;
  }
  if (input.targetStepKey === input.currentStepKey) return "active" as const;
  return "pending" as const;
}
