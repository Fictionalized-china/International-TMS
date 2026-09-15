import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";

export const settlementActionFieldKeys = {
  create_reconciliation: ["reconciliation_statement"],
  confirm_reconciliation: ["reconciliation_statement"],
  record_invoice: ["invoice_records"],
  allocate_cash: ["cash_records", "writeoff_records"],
} as const;

export type SettlementWorkbenchAction = keyof typeof settlementActionFieldKeys;
export type SettlementLegacyFallback = "deny" | "read_only" | "allow";

export type SettlementWorkbenchActor = {
  organizationId: string;
  userId: string;
  positionCode: string | null;
  roleCodes: string[];
  permissions: string[];
};

export type SettlementOrderActionAccess = {
  action: SettlementWorkbenchAction;
  orderId: string;
  inScope: boolean;
  visible: boolean;
  canWrite: boolean;
  legacy: boolean;
  fieldKeys: readonly string[];
  targetStepKey: string | null;
  targetStepName: string | null;
  reason: string | null;
};

export type SettlementMultiOrderActionAccess = {
  action: SettlementWorkbenchAction;
  visible: boolean;
  canWrite: boolean;
  reason: string | null;
  orders: SettlementOrderActionAccess[];
};

export type SettlementOrderActionInput = {
  orderId: string;
  assignedToActor: boolean;
  workflow: LockedWorkflowStageContext;
};

const mutationPermission: Record<SettlementWorkbenchAction, string> = {
  create_reconciliation: "billing.manage",
  confirm_reconciliation: "billing.manage",
  record_invoice: "billing.manage",
  allocate_cash: "billing.cash.manage",
};

export function hasFullSettlementScope(actor: SettlementWorkbenchActor) {
  return actor.positionCode === "BOSS" ||
    actor.roleCodes.some((code) => code === "owner" || code === "boss") ||
    actor.permissions.includes("billing.scope.all");
}

function decision(input: {
  action: SettlementWorkbenchAction;
  orderId: string;
  inScope: boolean;
  visible: boolean;
  canWrite: boolean;
  legacy?: boolean;
  targetStepKey?: string | null;
  targetStepName?: string | null;
  reason: string | null;
}): SettlementOrderActionAccess {
  return {
    action: input.action,
    orderId: input.orderId,
    inScope: input.inScope,
    visible: input.visible,
    canWrite: input.canWrite,
    legacy: input.legacy ?? false,
    fieldKeys: settlementActionFieldKeys[input.action],
    targetStepKey: input.targetStepKey ?? null,
    targetStepName: input.targetStepName ?? null,
    reason: input.reason,
  };
}

function invalidFrozenConfiguration(input: {
  action: SettlementWorkbenchAction;
  orderId: string;
  reason: string;
  targetStepKey?: string | null;
  targetStepName?: string | null;
}) {
  return decision({
    ...input,
    inScope: true,
    visible: true,
    canWrite: false,
  });
}

export function resolveSettlementOrderActionAccess(input: SettlementOrderActionInput & {
  action: SettlementWorkbenchAction;
  actor: SettlementWorkbenchActor;
  legacyFallback: SettlementLegacyFallback;
}): SettlementOrderActionAccess {
  const inScope = hasFullSettlementScope(input.actor) || input.assignedToActor;
  if (!inScope) {
    return decision({
      action: input.action,
      orderId: input.orderId,
      inScope: false,
      visible: false,
      canWrite: false,
      reason: "该订单不在当前账号的结算范围内",
    });
  }

  const canRead = input.actor.permissions.includes("billing.view") &&
    input.actor.permissions.includes("billing.sensitive.view");
  if (!canRead) {
    return decision({
      action: input.action,
      orderId: input.orderId,
      inScope: true,
      visible: false,
      canWrite: false,
      reason: "当前账号缺少费用结算与敏感费用查看权限",
    });
  }

  const requiredPermission = mutationPermission[input.action];
  const hasMutationPermission = input.actor.permissions.includes(requiredPermission);
  if (!input.workflow.locked) {
    if (input.legacyFallback === "deny") {
      return decision({
        action: input.action,
        orderId: input.orderId,
        inScope: true,
        visible: false,
        canWrite: false,
        legacy: true,
        reason: "历史订单未绑定冻结工作流，且未明确开放兼容办理",
      });
    }
    if (input.legacyFallback === "read_only") {
      return decision({
        action: input.action,
        orderId: input.orderId,
        inScope: true,
        visible: true,
        canWrite: false,
        legacy: true,
        reason: "历史订单未绑定冻结工作流，本项仅可查看",
      });
    }
    return decision({
      action: input.action,
      orderId: input.orderId,
      inScope: true,
      visible: true,
      canWrite: hasMutationPermission,
      legacy: true,
      reason: hasMutationPermission ? null : `当前账号缺少 ${requiredPermission} 权限`,
    });
  }

  const requestedKeys = settlementActionFieldKeys[input.action];
  const configured = requestedKeys.map((fieldKey) => ({
    fieldKey,
    matches: input.workflow.fields.filter(
      (field) => field.moduleCode === "costs" && field.fieldKey === fieldKey,
    ),
  }));
  const duplicate = configured.find((item) => item.matches.length > 1);
  if (duplicate) {
    return invalidFrozenConfiguration({
      action: input.action,
      orderId: input.orderId,
      reason: `冻结工作流中的费用字段“${duplicate.fieldKey}”配置重复，结算操作已阻止`,
    });
  }

  const activeFields = configured.flatMap((item) =>
    item.matches.filter((field) => field.isActive),
  );
  if (!activeFields.length) {
    return decision({
      action: input.action,
      orderId: input.orderId,
      inScope: true,
      visible: false,
      canWrite: false,
      reason: "当前冻结工作流未启用该结算办理项",
    });
  }

  const targetStepKeys = [...new Set(activeFields.map((field) => field.stepKey))];
  if (targetStepKeys.length !== 1) {
    return invalidFrozenConfiguration({
      action: input.action,
      orderId: input.orderId,
      reason: "冻结工作流中的关联费用字段未配置在同一办理节点，结算操作已阻止",
    });
  }
  const targetStepKey = targetStepKeys[0];
  const targetMatches = input.workflow.steps.filter((step) => step.stepKey === targetStepKey);
  if (targetMatches.length !== 1) {
    return invalidFrozenConfiguration({
      action: input.action,
      orderId: input.orderId,
      targetStepKey,
      reason: "冻结工作流中的结算目标节点配置无效，结算操作已阻止",
    });
  }
  const target = targetMatches[0];
  const placed = input.workflow.modulePlacements.some(
    (placement) => placement.moduleCode === "costs" && placement.stepKey === target.stepKey,
  );
  if (!placed) {
    return invalidFrozenConfiguration({
      action: input.action,
      orderId: input.orderId,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      reason: `冻结工作流在“${target.stepName}”缺少费用模块配置，结算操作已阻止`,
    });
  }

  const currentMatches = input.workflow.steps.filter(
    (step) => step.stepKey === input.workflow.currentStepKey,
  );
  if (currentMatches.length !== 1) {
    return invalidFrozenConfiguration({
      action: input.action,
      orderId: input.orderId,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      reason: "冻结工作流当前节点配置无效，结算操作已阻止",
    });
  }
  const current = currentMatches[0];
  if (current.stepKey !== target.stepKey) {
    if (current.sortOrder === target.sortOrder) {
      return invalidFrozenConfiguration({
        action: input.action,
        orderId: input.orderId,
        targetStepKey: target.stepKey,
        targetStepName: target.stepName,
        reason: "冻结工作流的当前节点与结算节点顺序冲突，结算操作已阻止",
      });
    }
    const reason = current.sortOrder < target.sortOrder
      ? `当前处于“${current.stepName}”，进入“${target.stepName}”后开放`
      : `当前已离开“${target.stepName}”，本项仅可查看历史`;
    return decision({
      action: input.action,
      orderId: input.orderId,
      inScope: true,
      visible: true,
      canWrite: false,
      targetStepKey: target.stepKey,
      targetStepName: target.stepName,
      reason,
    });
  }

  return decision({
    action: input.action,
    orderId: input.orderId,
    inScope: true,
    visible: true,
    canWrite: hasMutationPermission,
    targetStepKey: target.stepKey,
    targetStepName: target.stepName,
    reason: hasMutationPermission ? null : `当前账号缺少 ${requiredPermission} 权限`,
  });
}

export function resolveSettlementMultiOrderActionAccess(input: {
  action: SettlementWorkbenchAction;
  actor: SettlementWorkbenchActor;
  legacyFallback: SettlementLegacyFallback;
  orders: SettlementOrderActionInput[];
}): SettlementMultiOrderActionAccess {
  if (!input.orders.length) {
    return closedSettlementMultiOrderActionAccess(input.action, "结算记录未关联到有效订单");
  }
  const orders = input.orders.map((order) => resolveSettlementOrderActionAccess({
    ...order,
    action: input.action,
    actor: input.actor,
    legacyFallback: input.legacyFallback,
  }));
  const outOfScope = orders.find((order) => !order.inScope);
  if (outOfScope) {
    return {
      action: input.action,
      visible: false,
      canWrite: false,
      reason: "至少一票订单不在当前账号的结算范围内",
      orders,
    };
  }
  const hidden = orders.find((order) => !order.visible);
  if (hidden) {
    return {
      action: input.action,
      visible: false,
      canWrite: false,
      reason: `${hidden.orderId}：${hidden.reason ?? "当前结算办理项不可见"}`,
      orders,
    };
  }
  const blocked = orders.find((order) => !order.canWrite);
  return {
    action: input.action,
    visible: true,
    canWrite: !blocked,
    reason: blocked ? `${blocked.orderId}：${blocked.reason ?? "当前不可办理"}` : null,
    orders,
  };
}

export function closedSettlementMultiOrderActionAccess(
  action: SettlementWorkbenchAction,
  reason: string,
): SettlementMultiOrderActionAccess {
  return { action, visible: false, canWrite: false, reason, orders: [] };
}
