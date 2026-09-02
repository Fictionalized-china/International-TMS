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
    const positionPool = user.positionCode
      ? `OR (
          COALESCE(task_state.assignee_user_id,module_instance.assignee_user_id) IS NULL
          AND COALESCE(task_state.responsibility_position_code,module_state.responsibility_position_code)=?
        )`
      : "";
    conditions.push(`(
      ${alias}.current_assignee_user_id=? OR (
        ${alias}.current_assignee_user_id IS NULL AND EXISTS(
        SELECT 1
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
          AND task_state.status!='completed'
          AND (
            COALESCE(task_state.assignee_user_id,module_instance.assignee_user_id)=?
            ${positionPool}
          )
        )
      )
    )`);
    values.push(user.userId, user.userId);
    if (user.positionCode) values.push(user.positionCode);
  }

  return {
    sql: conditions.length ? `(${conditions.join(" OR ")})` : "0=1",
    values,
  };
}

export function canSeeScopedOrder(user: OrderAccessUser, order: {
  salesperson_user_id?: string | null;
  created_by_user_id?: string | null;
  customer_sales_owner_user_id?: string | null;
  assignee_user_id?: string | null;
  responsible_position_code?: string | null;
}) {
  if (canViewAllOrders(user)) return true;
  if (user.permissions.includes("order.scope.sales_own") && [
    order.salesperson_user_id,
    order.created_by_user_id,
    order.customer_sales_owner_user_id,
  ].includes(user.userId)) return true;
  if (!user.permissions.includes("order.scope.assigned")) return false;
  if (order.assignee_user_id) return order.assignee_user_id === user.userId;
  return Boolean(user.positionCode && order.responsible_position_code === user.positionCode);
}
