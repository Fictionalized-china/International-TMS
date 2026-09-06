import { isProtectedAccessRole } from "./permission-blocks";

export type OrderAccessUser = {
  userId: string;
  organizationId: string;
  positionCode: string | null;
  permissions: string[];
  roleCodes: string[];
};

export function canViewAllOrders(user: OrderAccessUser) {
  return isProtectedAccessRole(user.roleCodes) || user.permissions.includes("order.scope.all");
}

export const assignedBatchViewPermission = "transport.batch.assigned.view";
export const batchCostsManagePermission = "order.module.costs.manage";

/**
 * Entering the PZ workspace is separate from editing a loading plan.  The
 * assigned-view permission opens the workspace shell; batchVisibilitySql
 * still limits ordinary users to the exact PZ rows assigned to them (or a
 * child order they may already read).
 */
export function canAccessBatchWorkspace(
  user: Pick<OrderAccessUser, "positionCode" | "roleCodes" | "permissions">,
) {
  return (
    ["BOSS", "DEVELOPER"].includes(user.positionCode ?? "") ||
    user.roleCodes.some((code) => ["owner", "boss", "developer"].includes(code)) ||
    user.permissions.some((permission) => [
      assignedBatchViewPermission,
      "transport.batch.approve",
      "order.module.loading.manage",
      batchCostsManagePermission,
    ].includes(permission))
  );
}

/**
 * These execution roles keep a read-only window onto the complete order
 * lifecycle. This does not grant any module/action permission; it only keeps
 * the order and every workflow node visible after responsibility moves on.
 */
export function canReadFullOrderLifecycle(user: Pick<OrderAccessUser, "positionCode">) {
  return ["SALES", "OPERATION_SUPERVISOR", "OPERATION", "DOC", "FINANCE_ACCOUNTING"].includes(
    user.positionCode ?? "",
  );
}

/**
 * Viewing an order and operating its current node are deliberately separate.
 * Boss/developer accounts keep the documented administrative bypass; every
 * other account may operate only while it is the explicitly assigned handler.
 */
export function canOperateCurrentOrder(
  user: Pick<OrderAccessUser, "userId" | "roleCodes" | "positionCode">,
  order: { status: string; current_assignee_user_id?: string | null },
) {
  if (["completed", "cancelled"].includes(order.status)) return false;
  if (
    ["BOSS", "DEVELOPER"].includes(user.positionCode ?? "") ||
    user.roleCodes.some((code) => ["boss", "developer", "owner"].includes(code))
  ) return true;
  return Boolean(
    order.current_assignee_user_id &&
    order.current_assignee_user_id === user.userId,
  );
}

export type EnabledOrderModuleActionInput = {
  user: Pick<OrderAccessUser, "userId" | "positionCode" | "permissions" | "roleCodes">;
  orderStatus: string;
  moduleCode: string;
  moduleEnabled: boolean;
  moduleAssigneeUserId: string | null;
  taskAssigneeUserIds: readonly string[];
  responsibilityPositionCodes: readonly string[];
};

/**
 * Optional/collaborative modules do not always own the order-level handoff.
 * Their mutations are therefore authorized from the frozen workflow instance:
 * the module must be enabled, the account must hold the module permission, and
 * it must either be the explicit module/task owner or belong to the configured
 * responsibility pool while the work is still unassigned.
 */
export function canOperateEnabledOrderModule(
  input: EnabledOrderModuleActionInput,
) {
  if (!input.moduleEnabled || ["completed", "cancelled"].includes(input.orderStatus))
    return false;
  if (!input.user.permissions.includes(`order.module.${input.moduleCode}.manage`))
    return false;
  const assignedUserIds = new Set(
    [input.moduleAssigneeUserId, ...input.taskAssigneeUserIds].filter(
      (userId): userId is string => Boolean(userId),
    ),
  );
  if (assignedUserIds.size > 0) return assignedUserIds.has(input.user.userId);
  return Boolean(
    input.user.positionCode &&
    input.responsibilityPositionCodes.includes(input.user.positionCode),
  );
}

export function canEditCurrentOrderWorkspace(input: {
  orderCompleted: boolean;
  viewingCurrentStep: boolean;
  canOperateCurrentNode: boolean;
  canOperateParallelCosts: boolean;
  canSubmitCurrentDraft: boolean;
  canOperateScopedModule: boolean;
}) {
  if (input.orderCompleted) return false;
  if (input.canOperateScopedModule) return true;
  return input.viewingCurrentStep && (
    input.canOperateCurrentNode ||
    input.canOperateParallelCosts ||
    input.canSubmitCurrentDraft
  );
}

export function orderVisibilitySql(user: OrderAccessUser, alias = "o") {
  if (canViewAllOrders(user)) return { sql: "1=1", values: [] as string[] };

  const conditions: string[] = [];
  const values: string[] = [];
  if (user.permissions.includes("order.scope.sales_own")) {
    conditions.push(`(
      ${alias}.salesperson_user_id=? OR ${alias}.created_by_user_id=? OR EXISTS(
        SELECT 1 FROM customers access_customer
        WHERE access_customer.id=${alias}.customer_id
          AND access_customer.organization_id=${alias}.organization_id
          AND access_customer.sales_owner_user_id=?
      )
    )`);
    values.push(user.userId, user.userId, user.userId);
  }

  if (user.permissions.includes("order.scope.assigned")) {
    const currentAssignmentJoins = `
        FROM workflow_instances access_instance
        JOIN workflow_instance_step_states step_state
          ON step_state.instance_id=access_instance.id
         AND step_state.step_key=access_instance.current_step_key
        JOIN workflow_instance_module_states module_state
          ON module_state.instance_step_state_id=step_state.id
        JOIN workflow_instance_task_states task_state
          ON task_state.instance_module_state_id=module_state.id
        LEFT JOIN order_module_instances module_instance
          ON module_instance.organization_id=access_instance.organization_id
         AND module_instance.order_id=access_instance.order_id
         AND module_instance.module_code=module_state.module_code
        WHERE access_instance.organization_id=${alias}.organization_id
          AND access_instance.order_id=${alias}.id
          AND task_state.status!='completed'`;
    const currentSpecificAssignment = `EXISTS(
      SELECT 1 ${currentAssignmentJoins}
        AND COALESCE(task_state.assignee_user_id,module_instance.assignee_user_id)=?
    )`;
    const positionPool = user.positionCode
      ? `OR (
        ${alias}.current_assignee_user_id IS NULL AND EXISTS(
          SELECT 1 ${currentAssignmentJoins}
            AND COALESCE(task_state.assignee_user_id,module_instance.assignee_user_id) IS NULL
            AND COALESCE(task_state.responsibility_position_code,module_state.responsibility_position_code)=?
        )
      )`
      : "";
    const retainsModuleAssignment = ["OPERATION", "DOC", "CS", "FINANCE_ACCOUNTING"].includes(
      user.positionCode ?? "",
    );
    const retainedModuleAssignment = retainsModuleAssignment
      ? `OR EXISTS(
          SELECT 1 FROM order_module_instances retained_module
          WHERE retained_module.organization_id=${alias}.organization_id
            AND retained_module.order_id=${alias}.id
            AND retained_module.assignee_user_id=?
        ) OR EXISTS(
          SELECT 1 FROM order_tasks retained_task
          WHERE retained_task.organization_id=${alias}.organization_id
            AND retained_task.order_id=${alias}.id
            AND retained_task.task_type='module_owner'
            AND retained_task.assignee_user_id=?
        )`
      : "";
    const retainedSupervisorAssignment = user.positionCode === "OPERATION_SUPERVISOR"
      ? `OR ${alias}.operation_supervisor_user_id=?`
      : "";
    const retainedWarehouseDifference = user.positionCode === "WAREHOUSE"
      ? `OR EXISTS(
          SELECT 1
          FROM warehouse_receipt_differences retained_difference
          JOIN warehouse_receipts retained_receipt
            ON retained_receipt.id=retained_difference.receipt_id
           AND retained_receipt.organization_id=retained_difference.organization_id
          JOIN warehouse_user_access retained_warehouse_access
            ON retained_warehouse_access.organization_id=retained_receipt.organization_id
           AND retained_warehouse_access.warehouse_id=retained_receipt.warehouse_id
           AND retained_warehouse_access.user_id=?
          WHERE retained_difference.organization_id=${alias}.organization_id
            AND retained_difference.order_id=${alias}.id
        )`
      : "";
    conditions.push(`(
      ${alias}.current_assignee_user_id=?
      OR ${currentSpecificAssignment}
      ${positionPool}
      ${retainedModuleAssignment}
      ${retainedSupervisorAssignment}
      ${retainedWarehouseDifference}
    )`);
    values.push(user.userId, user.userId);
    if (user.positionCode) values.push(user.positionCode);
    if (retainedModuleAssignment) values.push(user.userId, user.userId);
    if (retainedSupervisorAssignment) values.push(user.userId);
    if (retainedWarehouseDifference) values.push(user.userId);
  }

  return {
    sql: conditions.length ? `(${conditions.join(" OR ")})` : "0=1",
    values,
  };
}

/**
 * Cost allocation mutates every active child order in the batch. Therefore a
 * permission on one child order is never sufficient: every mounted order must
 * authorize the same account from its frozen costs responsibility. Select the
 * same applicable costs module that loadOrderModuleActionScope uses: the latest
 * configured module at or before the current step, otherwise the first future
 * one. Mutable workflow templates never participate in this decision.
 */
export function batchCostsManageScopeSql(user: OrderAccessUser, alias = "b") {
  if (!user.permissions.includes(batchCostsManagePermission))
    return { sql: "0=1", values: [] as string[] };
  const positionPoolSql = user.positionCode
    ? `OR (
          cost_module_instance.assignee_user_id IS NULL
          AND NOT EXISTS(
            SELECT 1 FROM workflow_instance_task_states assigned_cost_task
            WHERE assigned_cost_task.instance_module_state_id=cost_module_state.id
              AND assigned_cost_task.status!='completed'
              AND assigned_cost_task.assignee_user_id IS NOT NULL
          )
          AND (
            cost_module_state.responsibility_position_code=?
            OR EXISTS(
              SELECT 1 FROM workflow_instance_task_states responsible_cost_task
              WHERE responsible_cost_task.instance_module_state_id=cost_module_state.id
                AND responsible_cost_task.status!='completed'
                AND responsible_cost_task.responsibility_position_code=?
            )
          )
        )`
    : "";
  return {
    sql: `(EXISTS(
      SELECT 1
      FROM transport_batch_orders present_cost_batch_order
      WHERE present_cost_batch_order.batch_id=${alias}.id
        AND present_cost_batch_order.organization_id=${alias}.organization_id
        AND present_cost_batch_order.status!='removed'
    ) AND NOT EXISTS(
      SELECT 1
      FROM transport_batch_orders cost_batch_order
      JOIN transport_orders cost_order
        ON cost_order.id=cost_batch_order.order_id
       AND cost_order.organization_id=cost_batch_order.organization_id
      WHERE cost_batch_order.batch_id=${alias}.id
        AND cost_batch_order.organization_id=${alias}.organization_id
        AND cost_batch_order.status!='removed'
        AND NOT EXISTS(
      SELECT 1
      FROM workflow_instances cost_instance
      JOIN workflow_instance_module_states cost_module_state
        ON cost_instance.id=cost_order.workflow_instance_id
       AND cost_instance.organization_id=cost_order.organization_id
       AND cost_instance.order_id=cost_order.id
       AND cost_module_state.id=(
          SELECT candidate_cost_module.id
          FROM workflow_instance_step_states candidate_cost_step
          JOIN workflow_instance_module_states candidate_cost_module
            ON candidate_cost_module.instance_step_state_id=candidate_cost_step.id
           AND candidate_cost_module.module_code='costs'
          LEFT JOIN workflow_instance_step_states current_cost_step
            ON current_cost_step.instance_id=cost_instance.id
           AND current_cost_step.step_key=cost_instance.current_step_key
          WHERE candidate_cost_step.instance_id=cost_instance.id
          ORDER BY
            CASE
              WHEN current_cost_step.sort_order IS NULL THEN 0
              WHEN candidate_cost_step.sort_order<=current_cost_step.sort_order THEN 0 ELSE 1 END,
            CASE
              WHEN current_cost_step.sort_order IS NULL THEN -candidate_cost_step.sort_order
              WHEN candidate_cost_step.sort_order<=current_cost_step.sort_order
                THEN -candidate_cost_step.sort_order ELSE candidate_cost_step.sort_order END,
            candidate_cost_module.sort_order,candidate_cost_module.id
          LIMIT 1
        )
      JOIN order_module_instances cost_module_instance
        ON cost_module_instance.organization_id=cost_order.organization_id
       AND cost_module_instance.order_id=cost_order.id
       AND cost_module_instance.module_code='costs'
       AND cost_module_instance.enabled=1
      WHERE (
          cost_module_instance.assignee_user_id=?
          OR EXISTS(
            SELECT 1 FROM workflow_instance_task_states cost_task_state
            WHERE cost_task_state.instance_module_state_id=cost_module_state.id
              AND cost_task_state.status!='completed'
              AND cost_task_state.assignee_user_id=?
          )
          ${positionPoolSql}
        )
      )
    ))`,
    values: user.positionCode
      ? [user.userId, user.userId, user.positionCode, user.positionCode]
      : [user.userId, user.userId],
  };
}

function frozenCostsBatchVisibilitySql(user: OrderAccessUser, alias: string) {
  return user.permissions.includes(batchCostsManagePermission)
    ? batchCostsManageScopeSql(user, alias)
    : null;
}

export function batchVisibilitySql(user: OrderAccessUser, alias = "b") {
  const exactBatchOwnerColumn = user.permissions.includes(assignedBatchViewPermission)
    ? user.positionCode === "OPERATION"
      ? "operation_assignee_user_id"
      : user.positionCode === "DOC"
        ? "document_assignee_user_id"
        : null
    : user.permissions.includes("transport.batch.approve") && user.positionCode === "OPERATION_SUPERVISOR"
      ? "operation_supervisor_user_id"
      : null;
  if (exactBatchOwnerColumn) {
    return {
      sql: `${alias}.${exactBatchOwnerColumn}=?`,
      values: [user.userId],
    };
  }
  const orderVisibility = orderVisibilitySql(user, "access_order");
  const costsVisibility = frozenCostsBatchVisibilitySql(user, alias);
  const hasIndependentBatchWorkspaceAccess =
    ["BOSS", "DEVELOPER"].includes(user.positionCode ?? "") ||
    user.roleCodes.some((code) => ["owner", "boss", "developer"].includes(code)) ||
    user.permissions.some((permission) => [
      assignedBatchViewPermission,
      "transport.batch.approve",
      "order.module.loading.manage",
    ].includes(permission));
  // An account whose only PZ capability is costs management must not use the
  // ordinary any-child order scope as a back door into the other mounted
  // orders. Independent PZ workspace capabilities retain their existing read
  // visibility, while every cost mutation is checked again by the route.
  if (costsVisibility && !hasIndependentBatchWorkspaceAccess)
    return costsVisibility;
  return {
    sql: `(${costsVisibility ? `${costsVisibility.sql} OR ` : ""}EXISTS(
      SELECT 1
      FROM transport_batch_orders access_batch_order
      JOIN transport_orders access_order
        ON access_order.id=access_batch_order.order_id
       AND access_order.organization_id=access_batch_order.organization_id
      WHERE access_batch_order.batch_id=${alias}.id
        AND access_batch_order.organization_id=${alias}.organization_id
        AND access_batch_order.status!='removed'
        AND ${orderVisibility.sql}
    ))`,
    values: [...(costsVisibility?.values ?? []), ...orderVisibility.values],
  };
}

export function canSeeScopedOrder(user: OrderAccessUser, order: {
  salesperson_user_id?: string | null;
  created_by_user_id?: string | null;
  customer_sales_owner_user_id?: string | null;
  operation_supervisor_user_id?: string | null;
  assignee_user_id?: string | null;
  current_module_assignee_user_ids?: readonly (string | null | undefined)[];
  lifecycle_assignee_user_ids?: readonly (string | null | undefined)[];
  warehouse_difference_handler_user_ids?: readonly (string | null | undefined)[];
  responsible_position_code?: string | null;
}) {
  if (canViewAllOrders(user)) return true;
  if (user.permissions.includes("order.scope.sales_own") && [
    order.salesperson_user_id,
    order.created_by_user_id,
    order.customer_sales_owner_user_id,
  ].includes(user.userId)) return true;
  if (!user.permissions.includes("order.scope.assigned")) return false;
  if (
    user.positionCode === "OPERATION_SUPERVISOR" &&
    order.operation_supervisor_user_id === user.userId
  ) return true;
  if (order.current_module_assignee_user_ids?.includes(user.userId)) return true;
  if (
    ["OPERATION", "DOC", "CS", "FINANCE_ACCOUNTING"].includes(user.positionCode ?? "") &&
    order.lifecycle_assignee_user_ids?.includes(user.userId)
  ) return true;
  if (
    user.positionCode === "WAREHOUSE" &&
    order.warehouse_difference_handler_user_ids?.includes(user.userId)
  ) return true;
  if (order.assignee_user_id) return order.assignee_user_id === user.userId;
  return Boolean(user.positionCode && order.responsible_position_code === user.positionCode);
}
