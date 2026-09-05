import { describe, expect, it } from "vitest";
import {
  resolveFrozenWorkflowCurrentOwner,
  resolveFrozenSettlementNotificationAssignees,
  type FrozenWorkflowCurrentOwnerRow,
} from "./order-workflow-current-owner";

function row(
  overrides: Partial<FrozenWorkflowCurrentOwnerRow> = {},
): FrozenWorkflowCurrentOwnerRow {
  return {
    step_key: "custom-border-handoff",
    step_name: "自定义口岸交接",
    module_state_id: "module-loading",
    module_code: "loading",
    module_name: "配载与车辆",
    module_sort_order: 20,
    module_required: 1,
    module_state_status: "pending",
    module_instance_id: "order-module-loading",
    module_instance_enabled: 1,
    module_instance_status: "not_started",
    module_current_step_name: "待办理",
    module_assignee_user_id: "operation-1",
    task_state_id: "task-loading",
    task_sort_order: 10,
    task_required: 1,
    task_type: "form",
    task_status: "active",
    task_assignee_user_id: null,
    ...overrides,
  };
}

describe("frozen workflow current owner", () => {
  it("uses the frozen current step instead of canonical module order", () => {
    const result = resolveFrozenWorkflowCurrentOwner([
      row({
        step_key: "custom-border-handoff",
        step_name: "口岸资料前置",
        module_code: "customs",
        module_name: "报关与文件",
        module_state_id: "module-customs",
        module_instance_id: "order-module-customs",
        module_assignee_user_id: "document-2",
      }),
    ]);

    expect(result).toMatchObject({
      stepKey: "custom-border-handoff",
      stepName: "口岸资料前置",
      primaryModuleCode: "customs",
      primaryAssigneeUserId: "document-2",
    });
  });

  it("prefers the required module and its explicit required task owner", () => {
    const result = resolveFrozenWorkflowCurrentOwner([
      row({
        module_state_id: "optional-review",
        module_code: "review",
        module_name: "旁路复核",
        module_required: 0,
        module_sort_order: 10,
        module_instance_id: "order-module-review",
        module_assignee_user_id: "reviewer-1",
        task_state_id: "optional-task",
        task_required: 0,
      }),
      row({
        task_state_id: "required-task",
        task_assignee_user_id: "operation-2",
      }),
    ]);

    expect(result?.primaryModuleCode).toBe("loading");
    expect(result?.primaryAssigneeUserId).toBe("operation-2");
    expect(result?.notificationAssigneeUserIds).toEqual([
      "reviewer-1",
      "operation-2",
    ]);
  });

  it("does not select a completed snapshot module while current work remains", () => {
    const result = resolveFrozenWorkflowCurrentOwner([
      row({
        module_state_id: "completed-transport",
        module_code: "transport",
        module_name: "国内运输",
        module_sort_order: 10,
        module_state_status: "completed",
        module_instance_id: "order-module-transport",
        module_instance_status: "completed",
        module_assignee_user_id: "old-operation",
        task_state_id: "completed-task",
        task_status: "completed",
      }),
      row({
        module_assignee_user_id: "current-operation",
      }),
    ]);

    expect(result?.primaryModuleCode).toBe("loading");
    expect(result?.primaryAssigneeUserId).toBe("current-operation");
    expect(result?.activeModuleInstanceIds).toEqual(["order-module-loading"]);
  });

  it("returns a frozen step with no owner instead of inventing a static fallback", () => {
    const result = resolveFrozenWorkflowCurrentOwner([
      row({
        module_state_id: null,
        module_code: null,
        module_name: null,
        module_instance_id: null,
        module_instance_enabled: null,
        module_assignee_user_id: null,
        task_state_id: null,
      }),
    ]);

    expect(result).toEqual({
      stepKey: "custom-border-handoff",
      stepName: "自定义口岸交接",
      primaryModuleCode: null,
      primaryModuleName: null,
      primaryAssigneeUserId: null,
      activeModuleInstanceIds: [],
      notificationAssigneeUserIds: [],
    });
  });

  it("does not notify settlement reviewers whose frozen actions are hidden", () => {
    expect(resolveFrozenSettlementNotificationAssignees({
      baseAssigneeUserIds: ["customer-service-1"],
      activeFieldKeys: ["customer_service_confirmation"],
      salespersonUserId: "sales-1",
      financeAssigneeUserId: "finance-1",
    })).toEqual(["customer-service-1"]);
  });

  it("notifies every active frozen settlement action owner regardless of requiredness", () => {
    expect(resolveFrozenSettlementNotificationAssignees({
      baseAssigneeUserIds: ["customer-service-1", "finance-1"],
      // The frozen field query intentionally selects active fields only. An
      // active optional action is still executable and therefore receives a
      // hand-off notification just like an active required action.
      activeFieldKeys: [
        "customer_service_confirmation",
        "business_review",
        "finance_review",
      ],
      salespersonUserId: "sales-1",
      financeAssigneeUserId: "finance-1",
    })).toEqual([
      "customer-service-1",
      "finance-1",
      "sales-1",
    ]);
  });
});
