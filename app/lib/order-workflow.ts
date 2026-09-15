export type OrderWorkflowTransition = {
  action_code: string;
  action_name: string;
  from_status: string;
  to_status: string;
  target_step_code: string;
  target_step_name: string;
  requires_assignee: number;
  sort_order: number;
};

const workflowActionPositionCodes: Record<string, readonly string[]> = {
  submit: ["SALES"],
  cancel_draft: ["SALES"],
  approve: ["BUSINESS_SUPERVISOR"],
  reject: ["BUSINESS_SUPERVISOR"],
  cancel_submitted: ["BUSINESS_SUPERVISOR"],
  dispatch: ["OPERATION_SUPERVISOR"],
  cancel_confirmed: ["OPERATION_SUPERVISOR"],
  complete: ["FINANCE_ACCOUNTING"],
};

const workflowTargetAssigneePermissionRequirements: Record<
  string,
  readonly (readonly string[])[]
> = {
  submit: [["order.view"]],
  approve: [
    ["order.view"],
    ["order.module.assignment.manage"],
    ["transport.batch.approve"],
  ],
};

export function orderWorkflowTargetAssigneeRequirements(actionCode: string) {
  return workflowTargetAssigneePermissionRequirements[actionCode] ?? [];
}

export function canRunOrderWorkflowAction(input: {
  actionCode: string;
  positionCode: string | null | undefined;
  currentAssigneeUserId: string | null | undefined;
  salespersonUserId?: string | null | undefined;
  currentUserId: string;
  bypassAssigneeRestriction?: boolean;
}) {
  if (input.bypassAssigneeRestriction) return true;
  const allowedPositions = workflowActionPositionCodes[input.actionCode];
  if (!allowedPositions?.includes(input.positionCode ?? "")) return false;
  if (["submit", "cancel_draft"].includes(input.actionCode)) {
    return Boolean(input.salespersonUserId) && input.salespersonUserId === input.currentUserId;
  }
  return Boolean(input.currentAssigneeUserId) && input.currentAssigneeUserId === input.currentUserId;
}

export function shouldRefreshOrderModulesBeforeWorkflowGate(input: {
  actionCode: string;
  allowPendingAssignment?: boolean;
}) {
  // A pending assignment is validated prospectively and committed atomically
  // with dispatch. Refreshing here would still inspect the pre-commit owner.
  return !(input.actionCode === "dispatch" && input.allowPendingAssignment);
}

export function dispatchedOrderWorkflowNeedsReconciliation(input: {
  orderStatus: string;
  currentStepCode: string | null | undefined;
  workflowStepKey: string | null | undefined;
}) {
  if (input.orderStatus !== "in_execution") return false;
  return (
    input.workflowStepKey === "task_assignment" ||
    (input.workflowStepKey != null && (
      input.currentStepCode === "module:assignment" ||
      input.currentStepCode === "task_assignment"
    ))
  );
}

export function assignmentModuleBlocksDispatch(module: {
  enabled: number;
  isRequired: number;
} | null | undefined) {
  return Boolean(module?.enabled && module.isRequired);
}

export function statusLabel(status: string) {
  return ({
    draft: "草稿",
    submitted: "待审批",
    confirmed: "待派单",
    in_execution: "执行中",
    completed: "已完成",
    cancelled: "已取消",
  } as Record<string, string>)[status] ?? status;
}

export function isAssignedOrderApprover(input: {
  status: string;
  currentAssigneeUserId: string | null | undefined;
  currentUserId: string;
}) {
  return (
    input.status === "submitted" &&
    Boolean(input.currentAssigneeUserId) &&
    input.currentAssigneeUserId === input.currentUserId
  );
}

export function canSubmitSalesOrderForApproval(input: {
  status: string;
  positionCode: string | null | undefined;
  permissions: string[];
  salespersonUserId: string | null | undefined;
  currentUserId: string;
}) {
  return (
    input.status === "draft" &&
    input.positionCode === "SALES" &&
    input.permissions.includes("order.scope.sales_own") &&
    input.permissions.includes("quote.manage") &&
    Boolean(input.salespersonUserId) &&
    input.salespersonUserId === input.currentUserId
  );
}
