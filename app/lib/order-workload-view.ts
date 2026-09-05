export type OrderWorkloadView = "batches" | "orders";
export type BatchWorkloadRole = "supervisor" | "operation" | "document" | null;
export type BatchAssignmentStatus = {
  key: "pending" | "assigned" | "incomplete" | "rejected" | "draft" | "cancelled";
  label: string;
  actionable: boolean;
};
export type BatchExecutionStatus = {
  key: "pending" | "loading" | "departure" | "transit" | "arrived" | "pickup" | "completed" | "rejected" | "cancelled";
  label: string;
  active: boolean;
};

export function resolveBatchWorkloadRole(input: {
  positionCode?: string | null;
  privileged: boolean;
  canApproveBatches: boolean;
  canViewAssignedBatches: boolean;
}): BatchWorkloadRole {
  if (input.privileged || input.canApproveBatches) return "supervisor";
  if (!input.canViewAssignedBatches) return null;
  if (input.positionCode === "OPERATION") return "operation";
  if (input.positionCode === "DOC") return "document";
  return null;
}

export function resolveOrderWorkloadView(input: {
  requestedView?: string | null;
  canViewBatchWorkload: boolean;
  priorityBatchCount: number;
}): OrderWorkloadView {
  if (!input.canViewBatchWorkload) return "orders";
  if (input.requestedView === "batches" || input.requestedView === "orders") {
    return input.requestedView;
  }
  return input.priorityBatchCount > 0 ? "batches" : "orders";
}

export function orderWorkloadViewHref(
  view: OrderWorkloadView,
  filters: Record<string, string>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value && key !== "page" && key !== "batchPage" && key !== "view") params.set(key, value);
  }
  params.set("view", view);
  return `?${params.toString()}`;
}

export function batchAssignmentStatus(input: {
  approvalStatus: string;
  batchStatus: string;
  operationAssigneeUserId?: string | null;
  documentAssigneeUserId?: string | null;
}): BatchAssignmentStatus {
  if (input.batchStatus === "cancelled") {
    return { key: "cancelled", label: "已取消", actionable: false };
  }
  if (input.approvalStatus === "submitted") {
    return { key: "pending", label: "待分配", actionable: true };
  }
  if (input.approvalStatus === "approved") {
    return input.operationAssigneeUserId && input.documentAssigneeUserId
      ? { key: "assigned", label: "已分配", actionable: false }
      : { key: "incomplete", label: "待补全", actionable: false };
  }
  if (input.approvalStatus === "rejected") {
    return { key: "rejected", label: "已退回", actionable: false };
  }
  return { key: "draft", label: "待提交", actionable: false };
}

export function batchExecutionStatus(input: {
  approvalStatus: string;
  batchStatus: string;
  roadStatus: string;
}): BatchExecutionStatus {
  if (input.batchStatus === "cancelled" || input.roadStatus === "cancelled") {
    return { key: "cancelled", label: "已取消", active: false };
  }
  if (input.approvalStatus === "rejected") {
    return { key: "rejected", label: "已退回", active: false };
  }
  if (input.approvalStatus !== "approved") {
    return { key: "pending", label: "待审核分配", active: false };
  }
  const statuses: Record<string, BatchExecutionStatus> = {
    waiting_loading: { key: "loading", label: "待装车计划", active: true },
    preplanned: { key: "loading", label: "待装车出库", active: true },
    loaded_waiting_exit: { key: "departure", label: "待报关与出境", active: true },
    outbound_in_transit: { key: "transit", label: "出境运输中", active: true },
    overseas_arrived: { key: "arrived", label: "境外仓已入库", active: false },
    waiting_pickup: { key: "pickup", label: "待客户自提", active: false },
    pickup_completed: { key: "completed", label: "已完成", active: false },
  };
  return statuses[input.roadStatus] ?? { key: "pending", label: "待同步", active: true };
}
