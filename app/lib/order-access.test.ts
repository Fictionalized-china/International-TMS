import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  assignedBatchViewPermission,
  batchCostsManageScopeSql,
  batchVisibilitySql,
  canAccessBatchWorkspace,
  canEditCurrentOrderWorkspace,
  canOperateEnabledOrderModule,
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

  it("keeps a customer-service handler's assigned order visible after settlement handoff", () => {
    const customerService = {
      ...baseUser,
      positionCode: "CS",
      roleCodes: ["pos_customer_service"],
    };
    expect(canSeeScopedOrder(customerService, {
      assignee_user_id: "user-b",
      responsible_position_code: "FINANCE_ACCOUNTING",
      lifecycle_assignee_user_ids: ["user-a"],
    })).toBe(true);
    expect(canOperateCurrentOrder(customerService, {
      status: "in_execution",
      current_assignee_user_id: "user-b",
    })).toBe(false);
    const scoped = orderVisibilitySql(customerService);
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

  it("lets the assigned review owner operate an enabled module after the order-level handoff is cleared", () => {
    expect(canOperateEnabledOrderModule({
      user: {
        ...baseUser,
        positionCode: "FINANCE_ACCOUNTING",
        roleCodes: ["pos_finance"],
        permissions: ["order.module.review.manage"],
      },
      orderStatus: "in_execution",
      moduleCode: "review",
      moduleEnabled: true,
      moduleAssigneeUserId: "user-a",
      taskAssigneeUserIds: [],
      responsibilityPositionCodes: ["FINANCE_ACCOUNTING"],
    })).toBe(true);
  });

  it("does not let module permission bypass the configured owner or a disabled module", () => {
    const input = {
      user: {
        ...baseUser,
        positionCode: "FINANCE_ACCOUNTING",
        roleCodes: ["pos_finance"],
        permissions: ["order.module.review.manage"],
      },
      orderStatus: "in_execution",
      moduleCode: "review",
      moduleEnabled: true,
      moduleAssigneeUserId: "user-b",
      taskAssigneeUserIds: [] as string[],
      responsibilityPositionCodes: ["FINANCE_ACCOUNTING"],
    };
    expect(canOperateEnabledOrderModule(input)).toBe(false);
    expect(canOperateEnabledOrderModule({
      ...input,
      moduleEnabled: false,
      moduleAssigneeUserId: "user-a",
    })).toBe(false);
    expect(canOperateEnabledOrderModule({
      ...input,
      moduleAssigneeUserId: "user-a",
      user: { ...input.user, permissions: [] },
    })).toBe(false);
  });

  it("uses the workflow-instance responsibility pool only while the module is unassigned", () => {
    const input = {
      user: {
        ...baseUser,
        positionCode: "OPERATION",
        permissions: ["order.module.exceptions.manage"],
      },
      orderStatus: "in_execution",
      moduleCode: "exceptions",
      moduleEnabled: true,
      moduleAssigneeUserId: null,
      taskAssigneeUserIds: [] as string[],
      responsibilityPositionCodes: ["OPERATION"],
    };
    expect(canOperateEnabledOrderModule(input)).toBe(true);
    expect(canOperateEnabledOrderModule({
      ...input,
      taskAssigneeUserIds: ["user-b"],
    })).toBe(false);
    expect(canOperateEnabledOrderModule({
      ...input,
      responsibilityPositionCodes: ["DOC"],
    })).toBe(false);
  });

  it("keeps the current workspace editable for an authorized scoped module owner", () => {
    expect(canEditCurrentOrderWorkspace({
      orderCompleted: false,
      viewingCurrentStep: true,
      canOperateCurrentNode: false,
      canOperateParallelCosts: false,
      canSubmitCurrentDraft: false,
      canOperateScopedModule: true,
    })).toBe(true);
    expect(canEditCurrentOrderWorkspace({
      orderCompleted: true,
      viewingCurrentStep: true,
      canOperateCurrentNode: false,
      canOperateParallelCosts: false,
      canSubmitCurrentDraft: false,
      canOperateScopedModule: true,
    })).toBe(false);
    expect(canEditCurrentOrderWorkspace({
      orderCompleted: false,
      viewingCurrentStep: false,
      canOperateCurrentNode: false,
      canOperateParallelCosts: false,
      canSubmitCurrentDraft: false,
      canOperateScopedModule: true,
    })).toBe(true);
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

  it("opens only frozen costs batches to an authorized customer-service cost owner", () => {
    const customerService = {
      ...baseUser,
      positionCode: "CS",
      roleCodes: ["pos_customer_service"],
      permissions: ["order.view", "order.scope.assigned", "order.module.costs.manage"],
    };
    expect(canAccessBatchWorkspace(customerService)).toBe(true);
    const visibility = batchVisibilitySql(customerService, "batch");
    expect(visibility.sql).toContain("workflow_instance_module_states cost_module_state");
    expect(visibility.sql).toContain("candidate_cost_module.module_code='costs'");
    expect(visibility.sql).toContain("candidate_cost_step.instance_id=cost_instance.id");
    expect(visibility.sql).not.toContain("workflow_step_modules");
    expect(visibility.sql).toContain("cost_module_instance.assignee_user_id=?");
    expect(visibility.sql).toContain("cost_task_state.assignee_user_id=?");
    expect(visibility.sql).toContain("cost_module_state.responsibility_position_code=?");
    expect(visibility.values).toContain("CS");
  });

  it("requires one customer-service account to own frozen costs responsibility for every active batch order", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE transport_batches(id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
      CREATE TABLE transport_batch_orders(
        batch_id TEXT NOT NULL, order_id TEXT NOT NULL,
        organization_id TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE transport_orders(
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
        workflow_instance_id TEXT NOT NULL
      );
      CREATE TABLE workflow_instances(
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
        order_id TEXT NOT NULL, current_step_key TEXT NOT NULL
      );
      CREATE TABLE workflow_instance_step_states(
        id TEXT PRIMARY KEY, instance_id TEXT NOT NULL,
        step_key TEXT NOT NULL, sort_order INTEGER NOT NULL
      );
      CREATE TABLE workflow_instance_module_states(
        id TEXT PRIMARY KEY, instance_step_state_id TEXT NOT NULL,
        module_code TEXT NOT NULL, sort_order INTEGER NOT NULL,
        responsibility_position_code TEXT
      );
      CREATE TABLE workflow_instance_task_states(
        instance_module_state_id TEXT NOT NULL, status TEXT NOT NULL,
        assignee_user_id TEXT, responsibility_position_code TEXT
      );
      CREATE TABLE order_module_instances(
        organization_id TEXT NOT NULL, order_id TEXT NOT NULL,
        module_code TEXT NOT NULL, enabled INTEGER NOT NULL,
        assignee_user_id TEXT
      );

      INSERT INTO transport_batches VALUES ('batch-1','org-a');
      INSERT INTO transport_batch_orders VALUES
        ('batch-1','order-1','org-a','loaded'),
        ('batch-1','order-2','org-a','loaded');
      INSERT INTO transport_orders VALUES
        ('order-1','org-a','instance-1'),
        ('order-2','org-a','instance-2');
      INSERT INTO workflow_instances VALUES
        ('instance-1','org-a','order-1','settlement'),
        ('instance-2','org-a','order-2','settlement');
      INSERT INTO workflow_instance_step_states VALUES
        ('step-1','instance-1','settlement',100),
        ('step-2','instance-2','settlement',100);
      INSERT INTO workflow_instance_module_states VALUES
        ('costs-1','step-1','costs',10,'CS'),
        ('costs-2','step-2','costs',10,'CS');
      INSERT INTO order_module_instances VALUES
        ('org-a','order-1','costs',1,'user-a'),
        ('org-a','order-2','costs',1,'user-b');
    `);
    const customerService = {
      ...baseUser,
      positionCode: "CS",
      roleCodes: ["pos_customer_service"],
      permissions: ["order.view", "order.scope.assigned", "order.module.costs.manage"],
    };
    const scope = batchCostsManageScopeSql(customerService, "batch");
    const visibility = batchVisibilitySql(customerService, "batch");
    expect(visibility.sql).not.toContain("access_batch_order");
    expect(visibility).toEqual(scope);
    const query = database.prepare(
      `SELECT batch.id FROM transport_batches batch WHERE batch.id='batch-1' AND ${visibility.sql}`,
    );

    expect(query.all(...visibility.values)).toEqual([]);
    expect(batchVisibilitySql({
      ...customerService,
      permissions: [...customerService.permissions, assignedBatchViewPermission],
    }, "batch").sql).toContain("access_batch_order");
    database.prepare(
      "UPDATE order_module_instances SET assignee_user_id='user-a' WHERE order_id='order-2'",
    ).run();
    expect(query.all(...visibility.values)).toEqual([{ id: "batch-1" }]);
    database.close();
  });

  it("does not open the batch workspace to a cost position without the cost permission", () => {
    expect(canAccessBatchWorkspace({
      positionCode: "CS",
      roleCodes: ["pos_customer_service"],
      permissions: ["order.view", "order.scope.assigned"],
    })).toBe(false);
  });
});
