import {
  workflowInstanceCapabilityStageAccess,
  type LockedWorkflowStageContext,
} from "./workflow-instance-stage-gate";

export type OrderDocumentAccessUser = {
  userId?: string | null;
  positionCode?: string | null;
  roleCodes?: readonly string[];
};

export type SettlementDocumentOwners = {
  customerServiceAssigneeUserId?: string | null;
  financeAssigneeUserId?: string | null;
};

const settlementDocumentOpenSteps = new Set([
  "reconciliation",
  "completion_review",
]);

export type SettlementDocumentStageInput = {
  orderStatus: string;
  fieldKey: string;
  workflow: LockedWorkflowStageContext;
};

export function settlementDocumentStageAccess(
  input: SettlementDocumentStageInput,
) {
  const access = workflowInstanceCapabilityStageAccess({
    context: input.workflow,
    moduleCode: "costs",
    fieldKeys: [input.fieldKey],
  });
  if (access.configured && !access.visible) {
    return {
      allowed: false,
      visible: false,
      targetStepKey: null,
      targetStepName: null,
      reason: access.reason,
    };
  }
  if (["completed", "cancelled"].includes(input.orderStatus)) {
    return {
      allowed: false,
      visible: true,
      targetStepKey: null,
      targetStepName: null,
      reason: "订单已完成或取消，结算单据仅供查看",
    };
  }
  if (access.configured) {
    return {
      allowed: access.available,
      visible: access.visible,
      targetStepKey: access.targetStepKey,
      targetStepName: access.targetStepName,
      reason: access.reason,
    };
  }
  const allowed = settlementDocumentOpenSteps.has(
    input.workflow.currentStepKey ?? "",
  );
  return {
    allowed,
    visible: true,
    targetStepKey: null,
    targetStepName: null,
    reason: allowed
      ? null
      : "进入当前工作流的结算单据节点后自动开放",
  };
}

export function isSettlementDocumentStageOpen(
  currentStepKeyOrInput: string | null | undefined | SettlementDocumentStageInput,
  orderStatus?: string,
) {
  if (typeof currentStepKeyOrInput === "object" && currentStepKeyOrInput) {
    return settlementDocumentStageAccess(currentStepKeyOrInput).allowed;
  }
  return (
    settlementDocumentOpenSteps.has(currentStepKeyOrInput ?? "") &&
    !["completed", "cancelled"].includes(orderStatus ?? "")
  );
}

export function hasOrderDocumentSystemOverride(user: OrderDocumentAccessUser) {
  return (
    ["BOSS", "DEVELOPER"].includes(user.positionCode ?? "") ||
    (user.roleCodes ?? []).some((code) =>
      ["boss", "developer", "owner"].includes(code),
    )
  );
}

export function canUploadOrderModuleDocument(
  user: OrderDocumentAccessUser,
  moduleCode: string,
  canManageModule: boolean,
  owners?: SettlementDocumentOwners | null,
) {
  if (moduleCode !== "costs") return canManageModule;
  if (hasOrderDocumentSystemOverride(user)) return true;
  if (!user.userId || !owners) return false;
  return (
    (user.positionCode === "CS" &&
      user.userId === owners.customerServiceAssigneeUserId) ||
    (user.positionCode === "FINANCE_ACCOUNTING" &&
      user.userId === owners.financeAssigneeUserId)
  );
}

export function canReviewOrderModuleDocument(
  user: OrderDocumentAccessUser,
  moduleCode: string,
  canManageModule: boolean,
  owners?: SettlementDocumentOwners | null,
) {
  if (moduleCode !== "costs") return canManageModule;
  if (hasOrderDocumentSystemOverride(user)) return true;
  return Boolean(
    user.userId &&
      owners &&
      user.positionCode === "FINANCE_ACCOUNTING" &&
      user.userId === owners.financeAssigneeUserId,
  );
}
