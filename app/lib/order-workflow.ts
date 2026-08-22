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
