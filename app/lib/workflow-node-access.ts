export type WorkflowNodeOperationSource =
  | "assigned"
  | "responsibility_position"
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
};

/**
 * Resolve the actor side of a frozen workflow-node gate. Configuration
 * authority never grants business-operation authority: once assigned, only
 * the assigned account may operate; before assignment, the responsibility
 * position is the candidate pool. Explicit safety denials still win.
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

  const modulePermission = `order.module.${input.moduleCode}.manage`;
  const moduleDenied = input.user.permissionOverrides?.some(
    (item) => item.code === modulePermission && item.effect === "deny",
  );
  if (moduleDenied) {
    return {
      allowed: false,
      source: "denied",
      reason: "当前账号被明确禁止办理该业务模块",
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
