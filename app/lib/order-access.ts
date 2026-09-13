import { isProtectedAccessRole } from "./permission-blocks";
import {
  resolveWorkflowNodeOperationAccess,
} from "./workflow-node-access";

export type OrderAccessUser = {
  userId: string;
  organizationId: string;
  positionCode: string | null;
  permissions: string[];
  roleCodes: string[];
  permissionOverrides?: Array<{ code: string; effect: "allow" | "deny" }>;
  departmentId?: string | null;
  departmentCode?: string | null;
  dataScope?: "self" | "department" | "warehouse" | "region" | "company";
  warehouseIds?: readonly string[];
  regionCountryCodes?: readonly string[];
};

export function canViewAllOrders(user: OrderAccessUser) {
  return isProtectedAccessRole(user.roleCodes) || user.dataScope === "company" || (
    user.dataScope === undefined && user.permissions.includes("order.scope.all")
  );
}

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(",");
}

/**
 * Position data scope controls read visibility only. Exact creator/current/module
 * assignments remain independently visible so reassignment never strands work,
 * while mutation continues to be checked by the workflow responsibility gates.
 */
function configuredPositionScopeSql(user: OrderAccessUser, alias: string) {
  if (!user.dataScope || user.dataScope === "self") return null;
  if (user.dataScope === "company") return { sql: "1=1", values: [] as string[] };

  if (user.dataScope === "department" && user.departmentId) {
    return {
      sql: `EXISTS(
        SELECT 1 FROM memberships scope_member
        WHERE scope_member.organization_id=${alias}.organization_id
          AND scope_member.department_id=? AND scope_member.status='active'
          AND (
            scope_member.user_id IN (
              ${alias}.salesperson_user_id,${alias}.created_by_user_id,
              ${alias}.current_assignee_user_id,${alias}.operation_supervisor_user_id
            )
            OR EXISTS(
              SELECT 1 FROM order_module_instances scope_module
              WHERE scope_module.organization_id=${alias}.organization_id
                AND scope_module.order_id=${alias}.id
                AND scope_module.assignee_user_id=scope_member.user_id
            )
            OR EXISTS(
              SELECT 1 FROM order_tasks scope_task
              WHERE scope_task.organization_id=${alias}.organization_id
                AND scope_task.order_id=${alias}.id
                AND scope_task.assignee_user_id=scope_member.user_id
            )
          )
      )`,
      values: [user.departmentId],
    };
  }

  if (user.dataScope === "warehouse" && user.warehouseIds?.length) {
    const ids = [...new Set(user.warehouseIds)];
    const marker = placeholders(ids);
    return {
      sql: `(
        ${alias}.overseas_warehouse_id IN (${marker})
        OR EXISTS(
          SELECT 1 FROM shipments scope_shipment
          JOIN warehouse_receipts scope_receipt
            ON scope_receipt.organization_id=scope_shipment.organization_id
           AND scope_receipt.shipment_id=scope_shipment.id
          WHERE scope_shipment.organization_id=${alias}.organization_id
            AND scope_shipment.order_id=${alias}.id
            AND scope_receipt.warehouse_id IN (${marker})
        )
        OR EXISTS(
          SELECT 1 FROM order_cargo_packages scope_package
          WHERE scope_package.organization_id=${alias}.organization_id
            AND scope_package.order_id=${alias}.id
            AND scope_package.received_warehouse_id IN (${marker})
        )
        OR EXISTS(
          SELECT 1 FROM order_transport_assignments scope_transport
          WHERE scope_transport.organization_id=${alias}.organization_id
            AND scope_transport.order_id=${alias}.id
            AND scope_transport.destination_warehouse_id IN (${marker})
        )
        OR EXISTS(
          SELECT 1 FROM transport_batch_orders scope_batch_order
          JOIN transport_batches scope_batch
            ON scope_batch.id=scope_batch_order.batch_id
           AND scope_batch.organization_id=scope_batch_order.organization_id
          WHERE scope_batch_order.organization_id=${alias}.organization_id
            AND scope_batch_order.order_id=${alias}.id
            AND scope_batch_order.status!='removed'
            AND scope_batch.warehouse_id IN (${marker})
        )
      )`,
      values: [...ids, ...ids, ...ids, ...ids, ...ids],
    };
  }

  if (user.dataScope === "region" && user.regionCountryCodes?.length) {
    const countries = [...new Set(user.regionCountryCodes.map((code) => code.toUpperCase()))];
    const marker = placeholders(countries);
    return {
      sql: `(
        upper(${alias}.origin_country) IN (${marker})
        OR upper(${alias}.destination_country) IN (${marker})
        OR EXISTS(
          SELECT 1 FROM warehouses scope_warehouse
          WHERE scope_warehouse.organization_id=${alias}.organization_id
            AND scope_warehouse.id=${alias}.overseas_warehouse_id
            AND upper(scope_warehouse.country_code) IN (${marker})
        )
      )`,
      values: [...countries, ...countries, ...countries],
    };
  }
  return { sql: "0=1", values: [] as string[] };
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
 * Configuration authority never grants business-operation authority. An
 * account may operate only while it is the explicitly assigned handler.
 */
export function canOperateCurrentOrder(
  user: Pick<OrderAccessUser, "userId" | "roleCodes" | "positionCode">,
  order: { status: string; current_assignee_user_id?: string | null },
) {
  if (["completed", "cancelled"].includes(order.status)) return false;
  return Boolean(
    order.current_assignee_user_id &&
    order.current_assignee_user_id === user.userId,
  );
}

/**
 * SQL counterpart of canOperateCurrentOrder for list-level "待我办理"
 * filters. Keep this deliberately narrower than visibility: historical
 * collaborators and unassigned position pools may continue to read an order,
 * but only an account explicitly assigned to the order, current module or a
 * current unfinished task belongs in the work queue.
 */
export function currentOrderActionSql(user: Pick<OrderAccessUser, "userId">, alias = "o") {
  return {
    sql: `${alias}.status NOT IN ('completed','cancelled') AND (
      ${alias}.current_assignee_user_id=?
      OR EXISTS(
        SELECT 1
        FROM workflow_instances action_instance
        JOIN workflow_instance_step_states action_step
          ON action_step.instance_id=action_instance.id
         AND action_step.step_key=action_instance.current_step_key
        JOIN workflow_instance_module_states action_module
          ON action_module.instance_step_state_id=action_step.id
         AND action_module.status!='completed'
        JOIN order_module_instances action_module_instance
          ON action_module_instance.organization_id=action_instance.organization_id
         AND action_module_instance.order_id=action_instance.order_id
         AND action_module_instance.module_code=action_module.module_code
         AND action_module_instance.enabled=1
        WHERE action_instance.organization_id=${alias}.organization_id
          AND action_instance.order_id=${alias}.id
          AND action_module_instance.assignee_user_id=?
      )
      OR EXISTS(
        SELECT 1
        FROM workflow_instances action_task_instance
        JOIN workflow_instance_step_states action_task_step
          ON action_task_step.instance_id=action_task_instance.id
         AND action_task_step.step_key=action_task_instance.current_step_key
        JOIN workflow_instance_module_states action_task_module
          ON action_task_module.instance_step_state_id=action_task_step.id
         AND action_task_module.status!='completed'
        JOIN workflow_instance_task_states action_task
          ON action_task.instance_module_state_id=action_task_module.id
         AND action_task.status!='completed'
        WHERE action_task_instance.organization_id=${alias}.organization_id
          AND action_task_instance.order_id=${alias}.id
          AND action_task.assignee_user_id=?
      )
    )`,
    values: [user.userId, user.userId, user.userId],
  };
}

export type EnabledOrderModuleActionInput = {
  user: Pick<OrderAccessUser, "userId" | "positionCode" | "permissions" | "roleCodes">;
  orderStatus: string;
  stepKey?: string | null;
  moduleCode: string;
  moduleEnabled: boolean;
  moduleAssigneeUserId: string | null;
  taskAssigneeUserIds: readonly string[];
  responsibilityPositionCodes: readonly string[];
};

/**
 * Optional/collaborative modules do not always own the order-level handoff.
 * Their mutations are therefore authorized from the frozen workflow instance:
 * the module must be enabled and the account must either be the explicit
 * module/task owner, belong to the configured responsibility pool while the
 * work is unassigned. The account inherits its operation capability from the
 * current position profile; per-account permission exceptions are not used.
 */
export function canOperateEnabledOrderModule(
  input: EnabledOrderModuleActionInput,
) {
  return resolveWorkflowNodeOperationAccess({
    ...input,
    stepKey: input.stepKey ?? null,
  }).allowed;
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

  const configuredScope = configuredPositionScopeSql(user, alias);
  if (configuredScope) {
    conditions.push(configuredScope.sql);
    values.push(...configuredScope.values);
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
  responsible_position_code?: string | null;
  department_ids?: readonly (string | null | undefined)[];
  warehouse_ids?: readonly (string | null | undefined)[];
  origin_country?: string | null;
  destination_country?: string | null;
}) {
  if (canViewAllOrders(user)) return true;
  if (
    user.dataScope === "department" &&
    order.department_ids?.some((departmentId) => Boolean(
      departmentId && departmentId === user.departmentId,
    ))
  ) return true;
  if (
    user.dataScope === "warehouse" &&
    order.warehouse_ids?.some((warehouseId) => Boolean(
      warehouseId && user.warehouseIds?.includes(warehouseId),
    ))
  ) return true;
  if (user.dataScope === "region") {
    const countries = new Set(user.regionCountryCodes?.map((code) => code.toUpperCase()) ?? []);
    if ([order.origin_country, order.destination_country]
      .some((code) => Boolean(code && countries.has(code.toUpperCase())))) return true;
  }
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
  if (order.assignee_user_id) return order.assignee_user_id === user.userId;
  return Boolean(user.positionCode && order.responsible_position_code === user.positionCode);
}
