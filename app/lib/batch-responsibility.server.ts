import {
  BATCH_RESPONSIBILITY_POSITION_CODES,
  buildBatchInitialResponsibilityRestrictions,
  type BatchInitialResponsibilityRestrictions,
  type BatchOriginalResponsibilityAssignment,
} from "./batch-responsibility";
import {
  buildOrderAssignmentManifest,
  type WorkflowAssignmentSnapshotRow,
} from "./order-assignment-manifest";

type BatchOriginalResponsibilityRow = {
  batch_id: string;
  order_id: string;
  order_number: string;
  workflow_instance_id: string | null;
  module_state_id: string | null;
  module_code: string | null;
  module_name: string | null;
  step_sort_order: number | null;
  module_sort_order: number | null;
  module_required: number | null;
  module_status: string | null;
  module_position_code: string | null;
  module_assignee_user_id: string | null;
  task_state_id: string | null;
  task_key: string | null;
  task_name: string | null;
  task_sort_order: number | null;
  task_required: number | null;
  task_status: string | null;
  task_position_code: string | null;
  task_assignee_user_id: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
};

const effectivePositionSql = (taskAlias: string, moduleAlias: string) =>
  `CASE WHEN ${taskAlias}.id IS NULL
    THEN ${moduleAlias}.responsibility_position_code
    ELSE COALESCE(${taskAlias}.responsibility_position_code,${moduleAlias}.responsibility_position_code)
  END`;

const activeFrozenTaskSql = (taskAlias: string) =>
  `(${taskAlias}.id IS NULL OR ${taskAlias}.status NOT IN ('completed','not_applicable'))`;

/**
 * The optimistic approval update repeats the exact frozen-snapshot ownership
 * rule used to build the UI restrictions. A forged request, or an assignee
 * change racing between loader and action, therefore cannot reuse a former
 * mounted-order owner.
 */
export function batchInitialResponsibilityAssignmentGuard(input: {
  operationAssigneeUserId: string;
  documentAssigneeUserId: string;
}) {
  const initialPosition = effectivePositionSql("initial_task", "initial_module");
  return {
    sql: `NOT EXISTS(
      SELECT 1
        FROM transport_batch_orders initial_batch_order
        JOIN transport_orders initial_order
          ON initial_order.id=initial_batch_order.order_id
         AND initial_order.organization_id=initial_batch_order.organization_id
        JOIN workflow_instances initial_instance
          ON initial_instance.id=initial_order.workflow_instance_id
         AND initial_instance.organization_id=initial_order.organization_id
         AND initial_instance.order_id=initial_order.id
        JOIN workflow_instance_step_states initial_step
          ON initial_step.instance_id=initial_instance.id
        JOIN workflow_instance_module_states initial_module
          ON initial_module.instance_step_state_id=initial_step.id
        LEFT JOIN workflow_instance_task_states initial_task
          ON initial_task.instance_module_state_id=initial_module.id
        LEFT JOIN order_module_instances initial_order_module
          ON initial_order_module.organization_id=initial_order.organization_id
         AND initial_order_module.order_id=initial_order.id
         AND initial_order_module.module_code=initial_module.module_code
       WHERE initial_batch_order.batch_id=transport_batches.id
         AND initial_batch_order.organization_id=transport_batches.organization_id
         AND initial_batch_order.status!='removed'
         AND initial_module.status NOT IN ('completed','not_applicable')
         AND ${activeFrozenTaskSql("initial_task")}
         AND (
           (${initialPosition}='${BATCH_RESPONSIBILITY_POSITION_CODES.operation}'
             AND COALESCE(initial_task.assignee_user_id,initial_order_module.assignee_user_id)=?)
           OR
           (${initialPosition}='${BATCH_RESPONSIBILITY_POSITION_CODES.document}'
             AND COALESCE(initial_task.assignee_user_id,initial_order_module.assignee_user_id)=?)
         )
    )`,
    values: [input.operationAssigneeUserId, input.documentAssigneeUserId],
  };
}

/**
 * Reads former owners from each mounted order's frozen workflow instance.
 * Mutable workflow definitions and static module-name lists are intentionally
 * absent: changing a published workflow changes the next order snapshot, and
 * the PZ gate/UI follows that snapshot automatically.
 */
export async function loadBatchInitialResponsibilityRestrictions(
  db: D1Database,
  organizationId: string,
  batchId: string,
) {
  const byBatch = await loadBatchesInitialResponsibilityRestrictions(
    db,
    organizationId,
    [batchId],
  );
  return byBatch[batchId] ?? buildBatchInitialResponsibilityRestrictions([]);
}

export async function loadBatchesInitialResponsibilityRestrictions(
  db: D1Database,
  organizationId: string,
  batchIds: readonly string[],
): Promise<Record<string, BatchInitialResponsibilityRestrictions>> {
  const uniqueBatchIds = [...new Set(batchIds.filter(Boolean))];
  if (!uniqueBatchIds.length) return {};
  const rows = await db.prepare(
    `SELECT bo.batch_id,bo.order_id,o.order_number,wi.id workflow_instance_id,
            ms.id module_state_id,ms.module_code,ms.display_name module_name,
            ss.sort_order step_sort_order,ms.sort_order module_sort_order,
            ms.is_required module_required,ms.status module_status,
            ms.responsibility_position_code module_position_code,
            omi.assignee_user_id module_assignee_user_id,
            ts.id task_state_id,ts.task_key,ts.name task_name,ts.sort_order task_sort_order,
            ts.is_required task_required,ts.status task_status,
            COALESCE(ts.responsibility_position_code,ms.responsibility_position_code) task_position_code,
            ts.assignee_user_id task_assignee_user_id,
            COALESCE(ts.assignee_user_id,omi.assignee_user_id) assignee_user_id,
            assignee.display_name assignee_name
       FROM transport_batch_orders bo
       JOIN transport_orders o
         ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       LEFT JOIN workflow_instances wi
         ON wi.id=o.workflow_instance_id
        AND wi.organization_id=o.organization_id
        AND wi.order_id=o.id
       LEFT JOIN workflow_instance_step_states ss ON ss.instance_id=wi.id
       LEFT JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
       LEFT JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
       LEFT JOIN order_module_instances omi
         ON omi.order_id=o.id
        AND omi.organization_id=o.organization_id
        AND omi.module_code=ms.module_code
       LEFT JOIN users assignee
         ON assignee.id=COALESCE(ts.assignee_user_id,omi.assignee_user_id)
      WHERE bo.organization_id=?
        AND bo.batch_id IN (${uniqueBatchIds.map(() => "?").join(",")})
        AND bo.status!='removed'
      ORDER BY bo.sequence_no,ss.sort_order,ms.sort_order,ts.sort_order`,
  ).bind(organizationId, ...uniqueBatchIds).all<BatchOriginalResponsibilityRow>();

  return Object.fromEntries(uniqueBatchIds.map((batchId) => {
    const batchRows = rows.results.filter((row) => row.batch_id === batchId);
    const assignments: BatchOriginalResponsibilityAssignment[] = [];
    const configurationErrors: string[] = [];
    const positions = new Set<string>();
    const orderIds = [...new Set(batchRows.map((row) => row.order_id))];
    for (const orderId of orderIds) {
      const orderRows = batchRows.filter((row) => row.order_id === orderId);
      const orderNumber = orderRows[0]?.order_number ?? orderId;
      if (!orderRows[0]?.workflow_instance_id) {
        configurationErrors.push(`${orderNumber} 尚未锁定工作流实例`);
        continue;
      }
      const snapshotRows = orderRows
        .filter((row): row is BatchOriginalResponsibilityRow & { module_state_id: string; module_code: string; module_name: string; module_status: string } =>
          Boolean(row.module_state_id && row.module_code && row.module_name && row.module_status),
        )
        .map((row): WorkflowAssignmentSnapshotRow => ({
          moduleStateId: row.module_state_id,
          moduleCode: row.module_code,
          moduleName: row.module_name,
          stepSortOrder: Number(row.step_sort_order ?? 0),
          moduleSortOrder: Number(row.module_sort_order ?? 0),
          moduleRequired: Boolean(row.module_required),
          moduleStatus: row.module_status,
          modulePositionCode: row.module_position_code,
          moduleAssigneeUserId: row.module_assignee_user_id,
          taskStateId: row.task_state_id,
          taskKey: row.task_key,
          taskName: row.task_name,
          taskSortOrder: row.task_sort_order === null ? null : Number(row.task_sort_order),
          taskRequired: row.task_required === null ? null : Boolean(row.task_required),
          taskStatus: row.task_status,
          taskPositionCode: row.task_position_code,
          taskAssigneeUserId: row.task_assignee_user_id,
        }));
      const manifest = buildOrderAssignmentManifest(snapshotRows);
      configurationErrors.push(...manifest.configurationErrors.map((error) => `${orderNumber}：${error}`));
      for (const group of manifest.groups) {
        if (group.positionCode) positions.add(group.positionCode);
      }
      for (const row of orderRows) {
        if (!row.module_code || !row.module_status) continue;
        if (["completed", "not_applicable"].includes(row.module_status)) continue;
        if (row.task_status && ["completed", "not_applicable"].includes(row.task_status)) continue;
        const positionCode = row.task_state_id
          ? row.task_position_code ?? row.module_position_code
          : row.module_position_code;
        if (!positionCode || !row.assignee_user_id) continue;
        assignments.push({
          orderId: row.order_id,
          orderNumber: row.order_number,
          moduleCode: row.module_code,
          positionCode,
          assigneeUserId: row.assignee_user_id,
          assigneeName: row.assignee_name,
        });
      }
    }
    for (const [kind, positionCode] of Object.entries(BATCH_RESPONSIBILITY_POSITION_CODES)) {
      if (!positions.has(positionCode)) {
        configurationErrors.push(
          `挂载订单冻结工作流中没有未完成的${kind === "operation" ? "操作" : "单证"}职责（${positionCode}）`,
        );
      }
    }
    const restrictions = buildBatchInitialResponsibilityRestrictions(assignments);
    restrictions.configurationErrors = [...new Set(configurationErrors)];
    return [batchId, restrictions];
  }));
}
