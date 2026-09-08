export type WorkflowNodeAccessOverride = {
  stepKey: string;
  moduleCode: string;
  effect: "allow" | "deny";
};

export type WorkflowNodeOperationSource =
  | "administrator"
  | "assigned"
  | "responsibility_position"
  | "account_override"
  | "denied";

export type WorkflowNodeOperationAccess = {
  allowed: boolean;
  source: WorkflowNodeOperationSource;
  reason: string | null;
};

type WorkflowNodeOperationUser = {
  userId: string;
  positionCode: string | null;
  roleCodes: readonly string[];
  permissionOverrides?: readonly { code: string; effect: "allow" | "deny" }[];
  workflowAccessOverrides?: readonly WorkflowNodeAccessOverride[];
};

export function isWorkflowAccessAdministrator(
  user: Pick<WorkflowNodeOperationUser, "positionCode" | "roleCodes">,
) {
  return (
    ["BOSS", "DEVELOPER"].includes(user.positionCode ?? "") ||
    user.roleCodes.some((code) => ["owner", "boss", "developer"].includes(code))
  );
}

function nodeOverride(
  user: WorkflowNodeOperationUser,
  stepKey: string | null,
  moduleCode: string,
) {
  if (!stepKey) return null;
  return user.workflowAccessOverrides?.find(
    (item) => item.stepKey === stepKey && item.moduleCode === moduleCode,
  )?.effect ?? null;
}

/**
 * Resolve the actor side of a frozen workflow-node gate.  Workflow ownership
 * is authoritative; static module permissions are only an explicit account
 * denial boundary and no longer have to be granted a second time.
 */
export function resolveWorkflowNodeOperationAccess(input: {
  user: WorkflowNodeOperationUser;
  orderStatus: string;
  stepKey: string | null;
  moduleCode: string;
  moduleEnabled: boolean;
  moduleAssigneeUserId: string | null;
  taskAssigneeUserIds: readonly string[];
  responsibilityPositionCodes: readonly string[];
}): WorkflowNodeOperationAccess {
  if (!input.moduleEnabled) {
    return { allowed: false, source: "denied", reason: "当前冻结工作流未启用该模块" };
  }
  if (["completed", "cancelled"].includes(input.orderStatus)) {
    return { allowed: false, source: "denied", reason: "订单已经结束，当前节点仅供查看" };
  }
  if (isWorkflowAccessAdministrator(input.user)) {
    return { allowed: true, source: "administrator", reason: null };
  }

  const modulePermission = `order.module.${input.moduleCode}.manage`;
  const moduleDenied = input.user.permissionOverrides?.some(
    (item) => item.code === modulePermission && item.effect === "deny",
  );
  const accountNodeOverride = nodeOverride(
    input.user,
    input.stepKey,
    input.moduleCode,
  );
  if (moduleDenied || accountNodeOverride === "deny") {
    return {
      allowed: false,
      source: "denied",
      reason: accountNodeOverride === "deny"
        ? "当前账号已被明确禁止办理该工作流节点"
        : "当前账号已被明确禁止办理该业务模块",
    };
  }

  const assignedUserIds = new Set(
    [input.moduleAssigneeUserId, ...input.taskAssigneeUserIds].filter(
      (userId): userId is string => Boolean(userId),
    ),
  );
  if (assignedUserIds.size > 0) {
    return assignedUserIds.has(input.user.userId)
      ? { allowed: true, source: "assigned", reason: null }
      : { allowed: false, source: "denied", reason: "当前节点已经分配给其他账号" };
  }

  if (accountNodeOverride === "allow") {
    return { allowed: true, source: "account_override", reason: null };
  }
  if (
    input.user.positionCode &&
    input.responsibilityPositionCodes.includes(input.user.positionCode)
  ) {
    return { allowed: true, source: "responsibility_position", reason: null };
  }
  return {
    allowed: false,
    source: "denied",
    reason: "当前账号不属于该节点的责任岗位，也未被指定为负责人",
  };
}
