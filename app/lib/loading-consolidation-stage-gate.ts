export type LoadingConsolidationStageStep = {
  stepKey: string;
  stepName: string;
  sortOrder: number;
};

export type LoadingConsolidationStageAccess = {
  available: boolean;
  targetStepKey: string | null;
  targetStepName: string | null;
  reason: string | null;
};

export function loadingConsolidationStageAccess(input: {
  currentStepKey: string | null;
  steps: readonly LoadingConsolidationStageStep[];
  loadingStepKeys: readonly string[];
}): LoadingConsolidationStageAccess {
  const current = input.steps.find((step) => step.stepKey === input.currentStepKey);
  if (!current) {
    return {
      available: false,
      targetStepKey: null,
      targetStepName: null,
      reason: "冻结工作流当前节点无效，请联系管理员修复后再配载",
    };
  }

  const loadingSteps = input.steps
    .filter((step) => input.loadingStepKeys.includes(step.stepKey))
    .sort((left, right) => left.sortOrder - right.sortOrder);
  if (!loadingSteps.length) {
    return {
      available: false,
      targetStepKey: null,
      targetStepName: null,
      reason: "当前冻结工作流未启用装车与出库模块，不能生成配载单",
    };
  }

  const currentLoadingStep = loadingSteps.find((step) => step.stepKey === current.stepKey);
  if (currentLoadingStep) {
    return {
      available: true,
      targetStepKey: currentLoadingStep.stepKey,
      targetStepName: currentLoadingStep.stepName,
      reason: null,
    };
  }

  const nextLoadingStep = loadingSteps.find((step) => step.sortOrder > current.sortOrder);
  if (nextLoadingStep) {
    return {
      available: false,
      targetStepKey: nextLoadingStep.stepKey,
      targetStepName: nextLoadingStep.stepName,
      reason: `当前处于“${current.stepName}”，进入“${nextLoadingStep.stepName}”后开放货物配载`,
    };
  }

  const previousLoadingStep = [...loadingSteps]
    .reverse()
    .find((step) => step.sortOrder < current.sortOrder);
  return {
    available: false,
    targetStepKey: previousLoadingStep?.stepKey ?? loadingSteps[0].stepKey,
    targetStepName: previousLoadingStep?.stepName ?? loadingSteps[0].stepName,
    reason: previousLoadingStep
      ? `“${previousLoadingStep.stepName}”办理节点已结束，不能重新生成配载单`
      : "当前冻结工作流未开放货物配载",
  };
}

export type LoadingConsolidationCandidateFacts = {
  business_type: string;
  package_count: number;
  cargo_ready: number;
  has_exception: number;
  active_dispatch: number;
  active_batch_id: string | null;
  active_batch_number: string | null;
  overseas_warehouse_id: string | null;
};

export function loadingConsolidationCandidateBlockers(
  candidate: LoadingConsolidationCandidateFacts,
  workflowAccess: Pick<LoadingConsolidationStageAccess, "available" | "reason"> | undefined,
) {
  const reasons: string[] = [];
  if (candidate.business_type !== "ltl") reasons.push("整车订单");
  if (!candidate.package_count) reasons.push("当前仓无在库货物");
  if (!candidate.cargo_ready) reasons.push("未确认货齐");
  if (candidate.has_exception) reasons.push("存在未结异常");
  if (candidate.active_batch_id) reasons.push(`已加入 ${candidate.active_batch_number}`);
  if (candidate.active_dispatch) reasons.push("已生成装车任务");
  if (!candidate.overseas_warehouse_id) reasons.push("未设置境外目的仓");
  if (!workflowAccess?.available) {
    reasons.push(
      workflowAccess?.reason || "无法确认订单当前冻结工作流是否允许配载，请刷新后重试",
    );
  }
  return reasons;
}
