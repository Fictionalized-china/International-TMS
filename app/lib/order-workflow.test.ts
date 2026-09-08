import { describe, expect, it } from "vitest";
import {
  assignmentModuleBlocksDispatch,
  canRunOrderWorkflowAction,
  canSubmitSalesOrderForApproval,
  isAssignedOrderApprover,
  orderWorkflowTargetAssigneeRequirements,
  shouldRefreshOrderModulesBeforeWorkflowGate,
} from "./order-workflow";

describe("assigned order approval", () => {
  it("allows only the assigned user while the order is submitted", () => {
    expect(
      isAssignedOrderApprover({
        status: "submitted",
        currentAssigneeUserId: "reviewer-1",
        currentUserId: "reviewer-1",
      }),
    ).toBe(true);
    expect(
      isAssignedOrderApprover({
        status: "submitted",
        currentAssigneeUserId: "reviewer-1",
        currentUserId: "reviewer-2",
      }),
    ).toBe(false);
  });

  it("does not allow approval outside the submitted state", () => {
    expect(
      isAssignedOrderApprover({
        status: "confirmed",
        currentAssigneeUserId: "reviewer-1",
        currentUserId: "reviewer-1",
      }),
    ).toBe(false);
    expect(
      isAssignedOrderApprover({
        status: "submitted",
        currentAssigneeUserId: null,
        currentUserId: "reviewer-1",
      }),
    ).toBe(false);
  });
});

describe("sales order submission", () => {
  it("allows a salesperson with own-order and quotation permissions to submit a draft", () => {
    expect(canSubmitSalesOrderForApproval({
      status: "draft",
      positionCode: "SALES",
      permissions: ["order.scope.sales_own", "quote.manage"],
      salespersonUserId: "sales-1",
      currentUserId: "sales-1",
    })).toBe(true);
  });

  it("does not turn assigned access or a non-draft order into submission authority", () => {
    expect(canSubmitSalesOrderForApproval({
      status: "draft",
      positionCode: "OPERATION",
      permissions: ["order.scope.assigned", "order.manage"],
      salespersonUserId: "sales-1",
      currentUserId: "operation-1",
    })).toBe(false);
    expect(canSubmitSalesOrderForApproval({
      status: "submitted",
      positionCode: "SALES",
      permissions: ["order.scope.sales_own", "quote.manage"],
      salespersonUserId: "sales-1",
      currentUserId: "sales-1",
    })).toBe(false);
  });

  it("does not let one salesperson submit another salesperson's draft", () => {
    expect(canSubmitSalesOrderForApproval({
      status: "draft",
      positionCode: "SALES",
      permissions: ["order.scope.sales_own", "quote.manage"],
      salespersonUserId: "sales-2",
      currentUserId: "sales-1",
    })).toBe(false);
  });
});

describe("workflow action ownership", () => {
  it("uses the bound salesperson instead of a stale current assignee for submission", () => {
    expect(canRunOrderWorkflowAction({
      actionCode: "submit",
      positionCode: "SALES",
      currentAssigneeUserId: "stale-user",
      salespersonUserId: "sales-1",
      currentUserId: "sales-1",
    })).toBe(true);
    expect(canRunOrderWorkflowAction({
      actionCode: "submit",
      positionCode: "SALES",
      currentAssigneeUserId: "sales-1",
      salespersonUserId: "sales-2",
      currentUserId: "sales-1",
    })).toBe(false);
  });

  it("keeps a business supervisor read-only outside an assigned approval", () => {
    expect(canRunOrderWorkflowAction({
      actionCode: "approve",
      positionCode: "BUSINESS_SUPERVISOR",
      currentAssigneeUserId: "supervisor-1",
      currentUserId: "supervisor-1",
    })).toBe(true);
    expect(canRunOrderWorkflowAction({
      actionCode: "approve",
      positionCode: "BUSINESS_SUPERVISOR",
      currentAssigneeUserId: "supervisor-2",
      currentUserId: "supervisor-1",
    })).toBe(false);
    expect(canRunOrderWorkflowAction({
      actionCode: "reject",
      positionCode: "BUSINESS_SUPERVISOR",
      currentAssigneeUserId: "supervisor-1",
      currentUserId: "supervisor-1",
    })).toBe(true);
    expect(canRunOrderWorkflowAction({
      actionCode: "reject",
      positionCode: "BUSINESS_SUPERVISOR",
      currentAssigneeUserId: "supervisor-2",
      currentUserId: "supervisor-1",
    })).toBe(false);
    expect(canRunOrderWorkflowAction({
      actionCode: "dispatch",
      positionCode: "BUSINESS_SUPERVISOR",
      currentAssigneeUserId: "supervisor-1",
      currentUserId: "supervisor-1",
    })).toBe(false);
    expect(canRunOrderWorkflowAction({
      actionCode: "complete",
      positionCode: "BUSINESS_SUPERVISOR",
      currentAssigneeUserId: "supervisor-1",
      currentUserId: "supervisor-1",
    })).toBe(false);
  });

  it("allows only the assigned role at each other macro step", () => {
    expect(canRunOrderWorkflowAction({
      actionCode: "dispatch",
      positionCode: "OPERATION_SUPERVISOR",
      currentAssigneeUserId: "operation-supervisor-1",
      currentUserId: "operation-supervisor-1",
    })).toBe(true);
    expect(canRunOrderWorkflowAction({
      actionCode: "complete",
      positionCode: "FINANCE_ACCOUNTING",
      currentAssigneeUserId: "finance-1",
      currentUserId: "finance-1",
    })).toBe(true);
  });
});

describe("workflow target assignee permissions", () => {
  it("requires approval recipients to be able to open and finish their next work", () => {
    expect(orderWorkflowTargetAssigneeRequirements("submit")).toEqual([["order.view"]]);
    expect(orderWorkflowTargetAssigneeRequirements("approve")).toEqual([
      ["order.view"],
      ["order.module.assignment.manage"],
      ["transport.batch.approve"],
    ]);
  });

  it("does not invent extra target permissions for actions with a frozen dispatch policy", () => {
    expect(orderWorkflowTargetAssigneeRequirements("dispatch")).toEqual([]);
  });
});

describe("workflow gate module refresh", () => {
  it("lets the bound workflow decide whether assignment blocks dispatch", () => {
    expect(assignmentModuleBlocksDispatch({ enabled: 1, isRequired: 1 })).toBe(true);
    expect(assignmentModuleBlocksDispatch({ enabled: 1, isRequired: 0 })).toBe(false);
    expect(assignmentModuleBlocksDispatch({ enabled: 0, isRequired: 1 })).toBe(false);
    expect(assignmentModuleBlocksDispatch(null)).toBe(false);
  });

  it("preserves the explicit operation owner during pending assignment dispatch", () => {
    expect(shouldRefreshOrderModulesBeforeWorkflowGate({
      actionCode: "dispatch",
      allowPendingAssignment: true,
    })).toBe(false);
  });

  it("refreshes modules for ordinary workflow transitions", () => {
    expect(shouldRefreshOrderModulesBeforeWorkflowGate({
      actionCode: "dispatch",
      allowPendingAssignment: false,
    })).toBe(true);
    expect(shouldRefreshOrderModulesBeforeWorkflowGate({
      actionCode: "approve",
    })).toBe(true);
  });
});
