export type LockedWorkflowStepPlacement = {
  stepKey: string;
  stepName: string;
  sortOrder: number;
};

export type LockedWorkflowModulePlacement = {
  moduleCode: string;
  stepKey: string;
};

export type LockedWorkflowFieldPlacement = {
  moduleCode: string;
  fieldKey: string;
  stepKey: string;
  isActive: boolean;
  isRequired: boolean;
};

export type LockedWorkflowStageContext = {
  locked: boolean;
  currentStepKey: string | null;
  steps: readonly LockedWorkflowStepPlacement[];
  modulePlacements: readonly LockedWorkflowModulePlacement[];
  fields: readonly LockedWorkflowFieldPlacement[];
};

export type WorkflowInstanceCapabilityStageAccess = {
  configured: boolean;
  visible: boolean;
  available: boolean;
  targetStepKey: string | null;
  targetStepName: string | null;
  reason: string | null;
};

/**
 * Resolve an operation gate only from the order's frozen workflow snapshot.
 * `fieldKeys` should contain one field for a concrete action. Passing no field
 * keys resolves the module placement itself.
 */
export function workflowInstanceCapabilityStageAccess(input: {
  context: LockedWorkflowStageContext;
  moduleCode: string;
  fieldKeys?: readonly string[];
}): WorkflowInstanceCapabilityStageAccess {
  const { context } = input;
  if (!context.locked) {
    return {
      configured: false,
      visible: true,
      available: false,
      targetStepKey: null,
      targetStepName: null,
      reason: null,
    };
  }

  const requestedFieldKeys = new Set(input.fieldKeys ?? []);
  const fieldScoped = requestedFieldKeys.size > 0;
  const configuredFields = fieldScoped
    ? context.fields.filter(
        (field) =>
          field.moduleCode === input.moduleCode &&
          requestedFieldKeys.has(field.fieldKey),
      )
    : [];
  const activeFields = configuredFields.filter((field) => field.isActive);

  if (fieldScoped && activeFields.length === 0) {
    return {
      configured: true,
      visible: false,
      available: false,
      targetStepKey: null,
      targetStepName: null,
      reason: "当前工作流实例已隐藏该办理项",
    };
  }

  const candidateStepKeys = fieldScoped
    ? activeFields.map((field) => field.stepKey)
    : context.modulePlacements
        .filter((placement) => placement.moduleCode === input.moduleCode)
        .map((placement) => placement.stepKey);
  const candidateSteps = context.steps
    .filter((step) => candidateStepKeys.includes(step.stepKey))
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const target = candidateSteps[0] ?? null;
  if (!target) {
    return {
      configured: true,
      visible: true,
      available: false,
      targetStepKey: candidateStepKeys[0] ?? null,
      targetStepName: null,
      reason: "当前工作流实例缺少对应的节点配置",
    };
  }

  const modulePlacedAtTarget = context.modulePlacements.some(
    (placement) =>
      placement.moduleCode === input.moduleCode &&
      placement.stepKey === target.stepKey,
  );
  if (!modulePlacedAtTarget) {
    return {
      configured: true,
      visible: true,
      available: false,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      reason: `工作流实例在“${target.stepName}”缺少 ${input.moduleCode} 模块配置`,
    };
  }

  const current = context.steps.find(
    (step) => step.stepKey === context.currentStepKey,
  );
  if (!current) {
    return {
      configured: true,
      visible: true,
      available: false,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      reason: "当前工作流实例节点无法在锁定快照中定位",
    };
  }

  const available = current.sortOrder >= target.sortOrder;
  return {
    configured: true,
    visible: true,
    available,
    targetStepKey: target.stepKey,
    targetStepName: target.stepName,
    reason: available
      ? null
      : `当前处于“${current.stepName}”，进入“${target.stepName}”后自动开放`,
  };
}

