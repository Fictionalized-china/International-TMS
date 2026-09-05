import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";

const declarationMutationFieldKeys = new Set([
  "customs_declarations",
  "declaration_stage",
  "declaration_status",
  "declaration_number",
  "declaration_type",
  "declaration_title",
  "declaring_company",
  "declared_at",
  "declared_amount",
  "declaration_currency",
  "declaration_gross_weight",
  "declaration_change_flags",
  "declaration_change_reason",
]);

export type FrozenCustomsCapability = {
  visible: boolean;
  stageReady: boolean;
  targetStepKey: string | null;
  targetStepName: string | null;
  reason: string | null;
};

export type BatchOrderCustomsAccess = {
  orderId: string;
  businessType: string | null;
  dispatched: boolean;
  canManageDeclarations: boolean;
  canRelease: boolean;
  declarationAccess: FrozenCustomsCapability;
  releaseAccess: FrozenCustomsCapability;
};

export type BatchCustomsAccess = {
  total: number;
  dispatched: number;
  allDispatched: boolean;
  orders: BatchOrderCustomsAccess[];
};

function closedCapability(reason: string): FrozenCustomsCapability {
  return {
    visible: false,
    stageReady: false,
    targetStepKey: null,
    targetStepName: null,
    reason,
  };
}

function fieldCapability(input: {
  workflow: LockedWorkflowStageContext;
  fieldKey: string;
  label: string;
  requireDeclarationFieldAlignment?: boolean;
}): FrozenCustomsCapability {
  const { workflow } = input;
  if (!workflow.locked) {
    return closedCapability("订单缺少冻结工作流实例，报关操作已阻止");
  }

  const matches = workflow.fields.filter(
    (field) => field.moduleCode === "customs" && field.fieldKey === input.fieldKey,
  );
  if (matches.length !== 1) {
    return closedCapability(
      matches.length
        ? `冻结工作流中的“${input.label}”字段配置重复，报关操作已阻止`
        : `冻结工作流未配置“${input.label}”，报关操作已阻止`,
    );
  }
  const field = matches[0];
  if (!field.isActive) {
    return closedCapability(`冻结工作流已隐藏“${input.label}”，本票仅可查看历史`);
  }

  const targetSteps = workflow.steps.filter((step) => step.stepKey === field.stepKey);
  if (targetSteps.length !== 1) {
    return {
      ...closedCapability(`冻结工作流中的“${input.label}”节点配置无效，报关操作已阻止`),
      visible: true,
      targetStepKey: field.stepKey,
    };
  }
  const target = targetSteps[0];
  const moduleAtTarget = workflow.modulePlacements.some(
    (placement) => placement.moduleCode === "customs" && placement.stepKey === target.stepKey,
  );
  if (!moduleAtTarget) {
    return {
      visible: true,
      stageReady: false,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      reason: `冻结工作流在“${target.stepName}”缺少报关模块配置`,
    };
  }

  if (input.requireDeclarationFieldAlignment) {
    const mutationFields = workflow.fields.filter(
      (candidate) =>
        candidate.moduleCode === "customs" &&
        candidate.isActive &&
        declarationMutationFieldKeys.has(candidate.fieldKey),
    );
    const duplicate = mutationFields.find(
      (candidate, index) =>
        mutationFields.findIndex((other) => other.fieldKey === candidate.fieldKey) !== index,
    );
    if (duplicate) {
      return {
        visible: true,
        stageReady: false,
        targetStepKey: target.stepKey,
        targetStepName: target.stepName,
        reason: `冻结工作流中的报关字段“${duplicate.fieldKey}”配置重复，报关操作已阻止`,
      };
    }
    const misplaced = mutationFields.find(
      (candidate) => candidate.stepKey !== target.stepKey,
    );
    if (misplaced) {
      return {
        visible: true,
        stageReady: false,
        targetStepKey: target.stepKey,
        targetStepName: target.stepName,
        reason: `冻结工作流中的报关字段未集中在同一办理节点，请先修正工作流配置`,
      };
    }
  }

  const current = workflow.steps.find(
    (step) => step.stepKey === workflow.currentStepKey,
  );
  if (!current) {
    return {
      visible: true,
      stageReady: false,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      reason: "冻结工作流当前节点无效，报关操作已阻止",
    };
  }
  if (current.stepKey !== target.stepKey) {
    return {
      visible: true,
      stageReady: false,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      reason: `当前处于“${current.stepName}”，仅在“${target.stepName}”办理${input.label}`,
    };
  }
  return {
    visible: true,
    stageReady: true,
    targetStepKey: target.stepKey,
    targetStepName: target.stepName,
    reason: null,
  };
}

export function resolveBatchOrderCustomsAccess(input: {
  orderId: string;
  businessType?: string | null;
  dispatched: boolean;
  allDispatched: boolean;
  workflow: LockedWorkflowStageContext;
}): BatchOrderCustomsAccess {
  const declarationStage = fieldCapability({
    workflow: input.workflow,
    fieldKey: "customs_declarations",
    label: "报关申报明细",
    requireDeclarationFieldAlignment: true,
  });
  const releaseStage = fieldCapability({
    workflow: input.workflow,
    fieldKey: "customs_release",
    label: "海关放行",
  });
  const dispatchReason = input.allDispatched && input.dispatched
    ? null
    : "全部有效挂载订单完成装车出库后，才开放报关申报与放行";
  const declarationAccess = dispatchReason
    ? { ...declarationStage, stageReady: false, reason: declarationStage.reason ?? dispatchReason }
    : declarationStage;
  const releaseAccess = dispatchReason
    ? { ...releaseStage, stageReady: false, reason: releaseStage.reason ?? dispatchReason }
    : releaseStage;
  return {
    orderId: input.orderId,
    businessType: input.businessType ?? null,
    dispatched: input.dispatched,
    canManageDeclarations: declarationAccess.stageReady,
    canRelease: releaseAccess.stageReady,
    declarationAccess,
    releaseAccess,
  };
}
