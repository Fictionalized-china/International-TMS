import { describe, expect, it } from "vitest";
import {
  assignedBatchViewPermission,
  batchVisibilitySql,
  canAccessBatchWorkspace,
  canOperateCurrentOrder,
  canReadFullOrderLifecycle,
  canSeeScopedOrder,
  orderVisibilitySql,
} from "./order-access";

const baseUser = {
  userId: "user-a",
  organizationId: "org-a",
  positionCode: "OPERATION",
  roleCodes: ["pos_operation"],
  permissions: ["order.view", "order.scope.assigned"],
};

describe("order access", () => {
  it("shows an unassigned current task to its responsible position pool", () => {
    expect(canSeeScopedOrder(baseUser, {
      assignee_user_id: null,
      responsible_position_code: "OPERATION",
    })).toBe(true);
  });

  it("removes a claimed task from other accounts in the same position", () => {
    expect(canSeeScopedOrder(baseUser, {
      assignee_user_id: "user-b",
      responsible_position_code: "OPERATION",
    })).toBe(false);
    const scopedSql = orderVisibilitySql(baseUser).sql;
    expect(scopedSql).toContain("current_assignee_user_id IS NULL AND EXISTS");
  });

  it("lets only a specifically assigned settlement collaborator see the current order", () => {
    const customerService = {
      ...baseUser,
      positionCode: "CS",
      roleCodes: ["pos_customer_service"],
    };
    expect(canSeeScopedOrder(customerService, {
      assignee_user_id: "another-current-owner",
      current_module_assignee_user_ids: ["user-a"],
      responsible_position_code: "CS",
    })).toBe(true);
    expect(canSeeScopedOrder(customerService, {
      assignee_user_id: "another-current-owner",
      current_module_assignee_user_ids: ["another-cs"],
      responsible_position_code: "CS",
    })).toBe(false);

    const scoped = orderVisibilitySql(customerService);
    expect(scoped.sql).toContain("OR EXISTS(");
    expect(scoped.sql).toContain("COALESCE(task_state.assignee_user_id,module_instance.assignee_user_id)=?");
    expect(scoped.values.slice(0, 3)).toEqual(["user-a", "user-a", "CS"]);
  });

  it("keeps an operator's assigned order visible after the current node moves on", () => {
    expect(canSeeScopedOrder(baseUser, {
      assignee_user_id: "user-b",
      responsible_position_code: "DOC",
      lifecycle_assignee_user_ids: ["user-a", "user-c"],
    })).toBe(true);
    const scoped = orderVisibilitySql(baseUser);
    expect(scoped.sql).toContain("retained_module.assignee_user_id=?");
    expect(scoped.sql).toContain("retained_task.assignee_user_id=?");
    expect(scoped.values.slice(-2)).toEqual(["user-a", "user-a"]);
  });

  it("keeps an operation supervisor's dispatched order visible as read-only", () => {
    const supervisor = {
      ...baseUser,
      positionCode: "OPERATION_SUPERVISOR",
      roleCodes: ["pos_operation_supervisor"],
    };
    expect(canSeeScopedOrder(supervisor, {
      operation_supervisor_user_id: "user-a",
      assignee_user_id: "user-b",
      responsible_position_code: "OPERATION",
    })).toBe(true);
    expect(canOperateCurrentOrder(supervisor, {
      status: "in_execution",
      current_assignee_user_id: "user-b",
    })).toBe(false);
    const scoped = orderVisibilitySql(supervisor);
    expect(scoped.sql).toContain("o.operation_supervisor_user_id=?");
    expect(scoped.values.at(-1)).toBe("user-a");
  });

  it("keeps a document handler's assigned order visible after customs release", () => {
    const documentUser = { ...baseUser, positionCode: "DOC", roleCodes: ["pos_doc"] };
    expect(canSeeScopedOrder(documentUser, {
      assignee_user_id: "user-b",
      responsible_position_code: "OPERATION",
      lifecycle_assignee_user_ids: ["user-a"],
    })).toBe(true);
    expect(canOperateCurrentOrder(documentUser, {
      status: "in_execution",
      current_assignee_user_id: "user-b",
    })).toBe(false);
    const scoped = orderVisibilitySql(documentUser);
    expect(scoped.sql).toContain("retained_module.assignee_user_id=?");
    expect(scoped.sql).toContain("retained_task.assignee_user_id=?");
    expect(scoped.values.slice(-2)).toEqual(["user-a", "user-a"]);
  });

  it("keeps an assigned finance reviewer's order visible as read-only after both finance reviews", () => {
    const financeUser = {
      ...baseUser,
      positionCode: "FINANCE_ACCOUNTING",
      roleCodes: ["pos_finance"],
      permissions: ["order.view", "order.scope.assigned", "billing.expense.approve"],
    };
    expect(canSeeScopedOrder(financeUser, {
      assignee_user_id: "user-b",
      responsible_position_code: "CUSTOMER_SERVICE",
      lifecycle_assignee_user_ids: ["user-a"],
    })).toBe(true);
    expect(canOperateCurrentOrder(financeUser, {
      status: "in_execution",
      current_assignee_user_id: "user-b",
    })).toBe(false);
    const scoped = orderVisibilitySql(financeUser);
    expect(scoped.sql).toContain("retained_module.assignee_user_id=?");
    expect(scoped.sql).toContain("retained_task.assignee_user_id=?");
    expect(scoped.values.slice(-2)).toEqual(["user-a", "user-a"]);
  });

  it("does not widen historical assignment visibility for unrelated positions", () => {
    expect(canSeeScopedOrder({ ...baseUser, positionCode: "CUSTOMER_SERVICE" }, {
      assignee_user_id: "user-b",
      responsible_position_code: "DOC",
      lifecycle_assignee_user_ids: ["user-a"],
    })).toBe(false);
  });

  it("keeps a sales user's own order visible for the full lifecycle", () => {
    expect(canSeeScopedOrder({
      ...baseUser,
      positionCode: "SALES",
      permissions: ["order.view", "order.scope.sales_own"],
    }, {
      salesperson_user_id: "user-a",
      assignee_user_id: "user-b",
      responsible_position_code: "TRACKING",
    })).toBe(true);
  });

  it("marks lifecycle collaboration roles as full-lifecycle read roles", () => {
    expect(canReadFullOrderLifecycle({ positionCode: "SALES" })).toBe(true);
    expect(canReadFullOrderLifecycle({ positionCode: "OPERATION_SUPERVISOR" })).toBe(true);
    expect(canReadFullOrderLifecycle({ positionCode: "OPERATION" })).toBe(true);
    expect(canReadFullOrderLifecycle({ positionCode: "DOC" })).toBe(true);
    expect(canReadFullOrderLifecycle({ positionCode: "FINANCE_ACCOUNTING" })).toBe(true);
  });

  it("separates current-node operation from full-lifecycle visibility", () => {
    expect(canOperateCurrentOrder(baseUser, {
      status: "in_execution",
      current_assignee_user_id: "user-a",
    })).toBe(true);
    expect(canOperateCurrentOrder(baseUser, {
      status: "in_execution",
      current_assignee_user_id: "user-b",
    })).toBe(false);
    expect(canOperateCurrentOrder(baseUser, {
      status: "completed",
      current_assignee_user_id: "user-a",
    })).toBe(false);
  });

  it("keeps the boss and developer current-node bypass", () => {
    expect(canOperateCurrentOrder({ ...baseUser, positionCode: "BOSS" }, {
      status: "in_execution",
      current_assignee_user_id: "user-b",
    })).toBe(true);
    expect(canOperateCurrentOrder({ ...baseUser, positionCode: "DEVELOPER" }, {
      status: "in_execution",
      current_assignee_user_id: null,
    })).toBe(true);
  });

  it("grants owner and all-scope accounts every order", () => {
    expect(orderVisibilitySql({ ...baseUser, roleCodes: ["owner"] }).sql).toBe("1=1");
    expect(canSeeScopedOrder({
      ...baseUser,
      permissions: ["order.view", "order.scope.all"],
    }, {})).toBe(true);
  });

  it("limits operation and document PZ views to their exact batch assignment", () => {
    const operationVisibility = batchVisibilitySql({
      ...baseUser,
      permissions: [...baseUser.permissions, assignedBatchViewPermission],
    }, "batch");
    expect(operationVisibility).toEqual({
      sql: "batch.operation_assignee_user_id=?",
      values: ["user-a"],
    });

    const documentVisibility = batchVisibilitySql({
      ...baseUser,
      positionCode: "DOC",
      roleCodes: ["pos_doc"],
      permissions: [...baseUser.permissions, assignedBatchViewPermission],
    }, "batch");
    expect(documentVisibility).toEqual({
      sql: "batch.document_assignee_user_id=?",
      values: ["user-a"],
    });
  });

  it("keeps child-order batch visibility for warehouse work without the office PZ permission", () => {
    const visibility = batchVisibilitySql(baseUser, "batch");
    expect(visibility.sql).toContain("access_batch_order.batch_id=batch.id");
    expect(visibility.sql).toContain("access_order.current_assignee_user_id");
    expect(visibility.values).toEqual(["user-a", "user-a", "OPERATION", "user-a", "user-a"]);
  });

  it("opens the batch workspace through a narrow view permission without granting loading edits", () => {
    expect(canAccessBatchWorkspace({
      positionCode: "OPERATION",
      roleCodes: ["pos_operation"],
      permissions: [assignedBatchViewPermission],
    })).toBe(true);
    expect(canAccessBatchWorkspace({
      positionCode: "OPERATION",
      roleCodes: ["pos_operation"],
      permissions: ["order.view"],
    })).toBe(false);
    expect(canAccessBatchWorkspace({
      positionCode: "OPERATION_SUPERVISOR",
      roleCodes: ["pos_operation_supervisor"],
      permissions: ["transport.batch.approve"],
    })).toBe(true);
  });
});
