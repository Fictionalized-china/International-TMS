import {
  workflowInstanceCapabilityStageAccess,
  type LockedWorkflowStageContext,
} from "./workflow-instance-stage-gate";
import { orderDocumentPlacement } from "./order-documents";

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

export type OrderDocumentWorkflowMutationAccess = {
  allowed: boolean;
  configured: boolean;
  visible: boolean;
  required: boolean;
  mode: "required" | "optional" | "hidden";
  fieldKey: string | null;
  moduleCode: string | null;
  reason: string | null;
};

/**
 * Gate every document mutation by the category-specific field in the order's
 * frozen workflow instance. Required and optional fields are editable at or
 * after their configured node; hidden, missing, duplicate, or unlocked rules
 * fail closed so a forged form cannot revive a field omitted by the UI.
 */
export function orderDocumentWorkflowMutationAccess(input: {
  documentCategory: string;
  workflow: LockedWorkflowStageContext;
}): OrderDocumentWorkflowMutationAccess {
  const placement = orderDocumentPlacement(input.documentCategory);
  if (!placement) {
    return {
      allowed: false,
      configured: false,
      visible: false,
      required: false,
      mode: "hidden",
      fieldKey: null,
      moduleCode: null,
      reason: "该文件类型没有工作流字段配置，不能修改",
    };
  }
  if (!input.workflow.locked) {
    return {
      allowed: false,
      configured: false,
      visible: false,
      required: false,
      mode: "hidden",
      fieldKey: placement.fieldKey,
      moduleCode: placement.moduleCode,
      reason: "订单缺少冻结工作流实例，文件操作已阻止",
    };
  }
  const matchingFields = input.workflow.fields.filter(
    (field) =>
      field.moduleCode === placement.moduleCode &&
      field.fieldKey === placement.fieldKey,
  );
  if (matchingFields.length !== 1) {
    return {
      allowed: false,
      configured: false,
      visible: false,
      required: false,
      mode: "hidden",
      fieldKey: placement.fieldKey,
      moduleCode: placement.moduleCode,
      reason: matchingFields.length
        ? "冻结工作流中的文件字段配置重复，不能修改"
        : "当前冻结工作流未启用该文件字段，不能修改",
    };
  }
  const field = matchingFields[0];
  const mode = !field.isActive
    ? "hidden"
    : field.isRequired
      ? "required"
      : "optional";
  const stage = workflowInstanceCapabilityStageAccess({
    context: input.workflow,
    moduleCode: placement.moduleCode,
    fieldKeys: [placement.fieldKey],
  });
  return {
    allowed: mode !== "hidden" && stage.visible && stage.available,
    configured: true,
    visible: mode !== "hidden" && stage.visible,
    required: mode === "required",
    mode,
    fieldKey: placement.fieldKey,
    moduleCode: placement.moduleCode,
    reason: mode === "hidden"
      ? "当前冻结工作流已隐藏该文件字段，不能修改"
      : stage.reason,
  };
}
