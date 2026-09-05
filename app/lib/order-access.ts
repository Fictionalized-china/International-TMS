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
    const retainsModuleAssignment = ["OPERATION", "DOC", "FINANCE_ACCOUNTING"].includes(
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
    conditions.push(`(
      ${alias}.current_assignee_user_id=?
      OR ${currentSpecificAssignment}
      ${positionPool}
      ${retainedModuleAssignment}
      ${retainedSupervisorAssignment}
    )`);
    values.push(user.userId, user.userId);
    if (user.positionCode) values.push(user.positionCode);
    if (retainedModuleAssignment) values.push(user.userId, user.userId);
    if (retainedSupervisorAssignment) values.push(user.userId);
  }

  return {
    sql: conditions.length ? `(${conditions.join(" OR ")})` : "0=1",
    values,
  };
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
  return {
    sql: `EXISTS(
      SELECT 1
      FROM transport_batch_orders access_batch_order
      JOIN transport_orders access_order
        ON access_order.id=access_batch_order.order_id
       AND access_order.organization_id=access_batch_order.organization_id
      WHERE access_batch_order.batch_id=${alias}.id
        AND access_batch_order.organization_id=${alias}.organization_id
        AND access_batch_order.status!='removed'
        AND ${orderVisibility.sql}
    )`,
    values: orderVisibility.values,
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
    ["OPERATION", "DOC", "FINANCE_ACCOUNTING"].includes(user.positionCode ?? "") &&
    order.lifecycle_assignee_user_ids?.includes(user.userId)
  ) return true;
  if (order.assignee_user_id) return order.assignee_user_id === user.userId;
  return Boolean(user.positionCode && order.responsible_position_code === user.positionCode);
}
