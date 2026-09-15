import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";

export type FrozenWorkflowFieldActionPolicyInput = {
  context: LockedWorkflowStageContext;
  moduleCode: string;
  fieldKey: string;
};

export type FrozenWorkflowFieldActionPolicy = {
  source: "frozen" | "legacy";
  status: "editable" | "read_only" | "hidden" | "invalid" | "legacy_fallback";
  configured: boolean;
  configurationValid: boolean;
  visible: boolean;
  editable: boolean;
  legacyFallbackAllowed: boolean;
  stageRelation: "before" | "current" | "after" | "invalid" | "legacy";
  targetStepKey: string | null;
  targetStepName: string | null;
  isRequired: boolean;
  reason: string | null;
};

function invalidPolicy(input: {
  configured?: boolean;
  visible?: boolean;
  targetStepKey?: string | null;
  targetStepName?: string | null;
  isRequired?: boolean;
  reason: string;
}): FrozenWorkflowFieldActionPolicy {
  return {
    source: "frozen",
    status: "invalid",
    configured: input.configured ?? false,
    configurationValid: false,
    visible: input.visible ?? false,
    editable: false,
    legacyFallbackAllowed: false,
    stageRelation: "invalid",
    targetStepKey: input.targetStepKey ?? null,
    targetStepName: input.targetStepName ?? null,
    isRequired: input.isRequired ?? false,
    reason: input.reason,
  };
}

function hiddenPolicy(input: {
  configured: boolean;
  targetStepKey?: string | null;
  targetStepName?: string | null;
  reason: string;
}): FrozenWorkflowFieldActionPolicy {
  return {
    source: "frozen",
    status: "hidden",
    configured: input.configured,
    configurationValid: true,
    visible: false,
    editable: false,
    legacyFallbackAllowed: false,
    stageRelation: "invalid",
    targetStepKey: input.targetStepKey ?? null,
    targetStepName: input.targetStepName ?? null,
    isRequired: false,
    reason: input.reason,
  };
}

export function frozenWorkflowFieldActionPolicy(
  input: FrozenWorkflowFieldActionPolicyInput,
): FrozenWorkflowFieldActionPolicy {
  if (!input.context.locked) {
    return {
      source: "legacy",
      status: "legacy_fallback",
      configured: false,
      configurationValid: true,
      visible: false,
      editable: false,
      legacyFallbackAllowed: true,
      stageRelation: "legacy",
      targetStepKey: null,
      targetStepName: null,
      isRequired: false,
      reason: null,
    };
  }

  const currentCandidates = input.context.steps.filter(
    (step) => step.stepKey === input.context.currentStepKey,
  );
  if (!input.context.currentStepKey || currentCandidates.length !== 1) {
    return invalidPolicy({
      reason: "冻结工作流实例绑定异常：当前节点无法唯一定位",
    });
  }
  const current = currentCandidates[0];

  const sameKeyFields = input.context.fields.filter(
    (candidate) => candidate.fieldKey === input.fieldKey,
  );
  const wrongModuleFields = sameKeyFields.filter(
    (candidate) => candidate.moduleCode !== input.moduleCode,
  );
  if (wrongModuleFields.length) {
    return invalidPolicy({
      configured: true,
      visible: sameKeyFields.some((field) => field.isActive),
      isRequired: sameKeyFields.some((field) => field.isRequired),
      reason: `冻结字段“${input.fieldKey}”绑定到错误模块，不能由 ${input.moduleCode} 办理`,
    });
  }

  const configuredFields = sameKeyFields.filter(
    (candidate) => candidate.moduleCode === input.moduleCode,
  );
  if (configuredFields.length === 0) {
    return hiddenPolicy({
      configured: false,
      reason: "当前冻结工作流未配置该字段",
    });
  }
  if (configuredFields.length > 1) {
    return invalidPolicy({
      configured: true,
      visible: configuredFields.some((field) => field.isActive),
      isRequired: configuredFields.some((field) => field.isRequired),
      reason: `冻结字段“${input.fieldKey}”存在重复配置`,
    });
  }

  const field = configuredFields[0];
  if (!field.isActive) {
    const target = input.context.steps.find(
      (step) => step.stepKey === field.stepKey,
    );
    return hiddenPolicy({
      configured: true,
      targetStepKey: field.stepKey || null,
      targetStepName: target?.stepName ?? null,
      reason: "当前冻结工作流已隐藏该字段",
    });
  }
  if (!field.stepKey) {
    return invalidPolicy({
      configured: true,
      visible: true,
      isRequired: field.isRequired,
      reason: `冻结字段“${input.fieldKey}”缺少目标节点`,
    });
  }
  const targetCandidates = input.context.steps.filter(
    (step) => step.stepKey === field.stepKey,
  );
  if (targetCandidates.length !== 1) {
    return invalidPolicy({
      configured: true,
      visible: true,
      targetStepKey: field.stepKey,
      isRequired: field.isRequired,
      reason: targetCandidates.length
        ? `冻结字段“${input.fieldKey}”的目标节点配置重复`
        : `冻结字段“${input.fieldKey}”的目标节点不存在`,
    });
  }
  const target = targetCandidates[0];
  const targetModulePlacements = input.context.modulePlacements.filter(
    (placement) =>
      placement.moduleCode === input.moduleCode &&
      placement.stepKey === target.stepKey,
  );
  if (targetModulePlacements.length !== 1) {
    return invalidPolicy({
      configured: true,
      visible: true,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      isRequired: field.isRequired,
      reason: targetModulePlacements.length
        ? `“${target.stepName}”的 ${input.moduleCode} 模块配置重复`
        : `“${target.stepName}”缺少 ${input.moduleCode} 模块配置`,
    });
  }
  if (
    current.stepKey !== target.stepKey &&
    current.sortOrder === target.sortOrder
  ) {
    return invalidPolicy({
      configured: true,
      visible: true,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      isRequired: field.isRequired,
      reason: "冻结工作流节点顺序冲突，不能判断字段是否已到办理时点",
    });
  }

  const stageRelation = current.stepKey === target.stepKey
    ? "current"
    : current.sortOrder < target.sortOrder
      ? "before"
      : "after";
  const editable = stageRelation === "current";
  return {
    source: "frozen",
    status: editable ? "editable" : "read_only",
    configured: true,
    configurationValid: true,
    visible: true,
    editable,
    legacyFallbackAllowed: false,
    stageRelation,
    targetStepKey: target.stepKey,
    targetStepName: target.stepName,
    isRequired: field.isRequired,
    reason: editable
      ? null
      : stageRelation === "before"
        ? `进入“${target.stepName}”后开放办理`
        : `“${target.stepName}”已结束，仅供查看`,
  };
}
