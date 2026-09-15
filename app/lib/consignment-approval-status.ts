export type ConsignmentApprovalHistoryEntry = {
  actionCode: string;
  actionName: string;
  actorName: string | null;
  assigneeName: string | null;
  notes: string | null;
  occurredAt: string;
};

export type ConsignmentApprovalStatusRow = {
  key: "submission" | "approval" | "assignment";
  node: string;
  status: "completed" | "active" | "pending" | "returned";
  statusLabel: string;
  owner: string;
  updatedAt: string | null;
  note: string;
};

function latestByAction(
  history: ConsignmentApprovalHistoryEntry[],
  ...actionCodes: string[]
) {
  return history
    .filter((item) => actionCodes.includes(item.actionCode))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0] ?? null;
}

function happenedAfter(
  candidate: ConsignmentApprovalHistoryEntry | null,
  reference: ConsignmentApprovalHistoryEntry | null,
) {
  return Boolean(candidate && (!reference || candidate.occurredAt > reference.occurredAt));
}

export function consignmentApprovalStatusRows(input: {
  orderStatus: string;
  currentAssigneeName?: string | null;
  history: ConsignmentApprovalHistoryEntry[];
}): ConsignmentApprovalStatusRow[] {
  const submitted = latestByAction(input.history, "submit");
  const approved = latestByAction(input.history, "approve");
  const returned = latestByAction(input.history, "reject", "cancel_submitted");
  const latestSubmissionReturned = happenedAfter(returned, submitted);
  const currentApproval = approved && (!submitted || approved.occurredAt > submitted.occurredAt)
    ? approved
    : null;
  const workflowAdvanced = ["confirmed", "in_execution", "completed"].includes(input.orderStatus);
  const assignmentAdvanced = ["in_execution", "completed"].includes(input.orderStatus);

  const submissionStatus = submitted && !latestSubmissionReturned ? "completed" : latestSubmissionReturned ? "returned" : "pending";
  const approvalStatus = currentApproval && !happenedAfter(returned, currentApproval)
    ? "completed"
    : input.orderStatus === "submitted"
      ? "active"
      : latestSubmissionReturned
        ? "returned"
        : workflowAdvanced
          ? "completed"
          : "pending";

  return [
    {
      key: "submission",
      node: "资料提交",
      status: submissionStatus,
      statusLabel: latestSubmissionReturned ? "已退回" : submitted ? "已提交" : "未提交",
      owner: submitted?.actorName || "—",
      updatedAt: latestSubmissionReturned ? returned?.occurredAt ?? null : submitted?.occurredAt ?? null,
      note: latestSubmissionReturned
        ? returned?.notes || returned?.actionName || "审批已退回，等待重新提交"
        : submitted?.notes || (submitted ? "委托资料已送交业务主管审核" : "等待业务岗提交委托资料"),
    },
    {
      key: "approval",
      node: "委托审核",
      status: approvalStatus,
      statusLabel: approvalStatus === "completed"
        ? "已通过"
        : approvalStatus === "active"
          ? "待审批"
          : approvalStatus === "returned"
            ? "已退回"
            : "未开始",
      owner: currentApproval?.actorName || submitted?.assigneeName || (input.orderStatus === "submitted" ? input.currentAssigneeName : null) || "待指定",
      updatedAt: currentApproval?.occurredAt || (latestSubmissionReturned ? returned?.occurredAt ?? null : submitted?.occurredAt ?? null),
      note: currentApproval?.notes || (approvalStatus === "active"
        ? "资料已冻结，等待指定业务主管审核"
        : approvalStatus === "completed"
          ? "审批已通过"
          : latestSubmissionReturned
            ? "等待业务岗修订后重新提交"
            : "等待前序资料提交"),
    },
    {
      key: "assignment",
      node: "任务分配",
      status: assignmentAdvanced ? "completed" : workflowAdvanced ? "active" : "pending",
      statusLabel: assignmentAdvanced ? "已进入后续节点" : workflowAdvanced ? "待分配" : "未开始",
      owner: currentApproval?.assigneeName || "待审批通过后指定",
      updatedAt: currentApproval?.occurredAt ?? null,
      note: assignmentAdvanced
        ? "任务分配已完成，订单正在后续节点办理"
        : workflowAdvanced
          ? "委托审核已通过，等待操作主管分配后续负责人"
          : "委托审核通过后自动开放",
    },
  ];
}
