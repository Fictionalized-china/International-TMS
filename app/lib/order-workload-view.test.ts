import { describe, expect, it } from "vitest";
import {
  batchAssignmentStatus,
  batchExecutionStatus,
  orderWorkloadViewHref,
  resolveBatchWorkloadRole,
  resolveOrderWorkloadView,
} from "./order-workload-view";

describe("operation supervisor order workload tabs", () => {
  it("opens pending batch work first for a batch approver", () => {
    expect(resolveOrderWorkloadView({
      requestedView: null,
      canViewBatchWorkload: true,
      priorityBatchCount: 2,
    })).toBe("batches");
  });

  it("opens ordinary orders when there is no pending batch", () => {
    expect(resolveOrderWorkloadView({
      requestedView: null,
      canViewBatchWorkload: true,
      priorityBatchCount: 0,
    })).toBe("orders");
  });

  it("never exposes the batch tab as active without permission", () => {
    expect(resolveOrderWorkloadView({
      requestedView: "batches",
      canViewBatchWorkload: false,
      priorityBatchCount: 3,
    })).toBe("orders");
  });

  it("preserves filters but resets pagination when switching tabs", () => {
    expect(orderWorkloadViewHref("batches", {
      keyword: "深圳",
      status: "submitted",
      page: "3",
      view: "orders",
      type: "",
    })).toBe("?keyword=%E6%B7%B1%E5%9C%B3&status=submitted&view=batches");
  });

  it("distinguishes pending assignment from assigned history", () => {
    expect(batchAssignmentStatus({
      approvalStatus: "submitted",
      batchStatus: "active",
    })).toEqual({ key: "pending", label: "待分配", actionable: true });
    expect(batchAssignmentStatus({
      approvalStatus: "approved",
      batchStatus: "active",
      operationAssigneeUserId: "operation-1",
      documentAssigneeUserId: "document-1",
    })).toEqual({ key: "assigned", label: "已分配", actionable: false });
  });

  it("keeps rejected, incomplete and cancelled history visibly distinct", () => {
    expect(batchAssignmentStatus({ approvalStatus: "rejected", batchStatus: "active" }).label).toBe("已退回");
    expect(batchAssignmentStatus({ approvalStatus: "approved", batchStatus: "active" }).label).toBe("待补全");
    expect(batchAssignmentStatus({ approvalStatus: "approved", batchStatus: "cancelled" }).label).toBe("已取消");
  });

  it("opens the batch workload for operation and document assignees", () => {
    expect(resolveBatchWorkloadRole({ positionCode: "OPERATION", privileged: false, canApproveBatches: false, canViewAssignedBatches: true })).toBe("operation");
    expect(resolveBatchWorkloadRole({ positionCode: "DOC", privileged: false, canApproveBatches: false, canViewAssignedBatches: true })).toBe("document");
    expect(resolveBatchWorkloadRole({ positionCode: "SALES", privileged: false, canApproveBatches: false, canViewAssignedBatches: false })).toBeNull();
  });

  it("does not expose the PZ workload from a position title alone", () => {
    expect(resolveBatchWorkloadRole({
      positionCode: "OPERATION",
      privileged: false,
      canApproveBatches: false,
      canViewAssignedBatches: false,
    })).toBeNull();
    expect(resolveBatchWorkloadRole({
      positionCode: "OPERATION_SUPERVISOR",
      privileged: false,
      canApproveBatches: false,
      canViewAssignedBatches: false,
    })).toBeNull();
  });

  it("shows the post-loading batch as waiting for customs and departure", () => {
    expect(batchExecutionStatus({
      approvalStatus: "approved",
      batchStatus: "loading",
      roadStatus: "loaded_waiting_exit",
    })).toEqual({ key: "departure", label: "待报关与出境", active: true });
    expect(batchExecutionStatus({
      approvalStatus: "approved",
      batchStatus: "arrived",
      roadStatus: "overseas_arrived",
    })).toEqual({ key: "arrived", label: "境外仓已入库", active: false });
  });
});
