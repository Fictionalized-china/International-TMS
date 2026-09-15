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
import { loadOrderAssignmentManifest } from "./order-assignment-manifest.server";

type BatchOriginalResponsibilityRow = {
  batch_id: string;
  order_id: string;
  order_number: string;
  workflow_instance_id: string | null;
  module_state_id: string | null;
  module_code: string | null;
  module_name: string | null;
  step_key: string | null;
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

/**
 * Mounted-order owners may be selected for the batch-wide handoff. The action
 * still validates their active organization position and complete batch
 * permissions before this optimistic approval update runs.
 */
export function batchInitialResponsibilityAssignmentGuard(_input: {
  operationAssigneeUserId: string;
  documentAssigneeUserId: string;
}) {
  return {
    sql: "1=1",
    values: [] as string[],
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
export async function loadOrdersInitialResponsibilityRestrictions(
  db: D1Database,
  organizationId: string,
  orderIds: readonly string[],
): Promise<BatchInitialResponsibilityRestrictions> {
  const uniqueOrderIds = [...new Set(orderIds.filter(Boolean))];
  if (!uniqueOrderIds.length) {
    const empty = buildBatchInitialResponsibilityRestrictions([]);
    empty.configurationErrors = ["配载单没有可交接职责的挂载订单"];
    return empty;
  }
  const [owners, manifests] = await Promise.all([
    db.prepare(
      `SELECT o.id order_id,o.order_number,ms.module_code,
              CASE WHEN ts.id IS NULL
                THEN ms.responsibility_position_code
                ELSE COALESCE(ts.responsibility_position_code,ms.responsibility_position_code)
              END position_code,
              COALESCE(ts.assignee_user_id,omi.assignee_user_id) assignee_user_id,
              assignee.display_name assignee_name
         FROM transport_orders o
         JOIN workflow_instances wi
           ON wi.id=o.workflow_instance_id
          AND wi.organization_id=o.organization_id
          AND wi.order_id=o.id
         JOIN workflow_instance_step_states ss ON ss.instance_id=wi.id
         JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
         LEFT JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
         LEFT JOIN order_module_instances omi
           ON omi.order_id=o.id
          AND omi.organization_id=o.organization_id
          AND omi.module_code=ms.module_code
         LEFT JOIN users assignee
           ON assignee.id=COALESCE(ts.assignee_user_id,omi.assignee_user_id)
        WHERE o.organization_id=?
          AND o.id IN (${uniqueOrderIds.map(() => "?").join(",")})
          AND ms.status NOT IN ('completed','not_applicable')
          AND (ts.id IS NULL OR ts.status NOT IN ('completed','not_applicable'))
        ORDER BY o.order_number,ss.sort_order,ms.sort_order,ts.sort_order`,
    ).bind(organizationId, ...uniqueOrderIds).all<{
      order_id: string;
      order_number: string;
      module_code: string;
      position_code: string | null;
      assignee_user_id: string | null;
      assignee_name: string | null;
    }>(),
    Promise.all(uniqueOrderIds.map(async (orderId) => ({
      orderId,
      manifest: await loadOrderAssignmentManifest(organizationId, orderId),
    }))),
  ]);
  const configurationErrors: string[] = [];
  for (const { orderId, manifest } of manifests) {
    const orderNumber = owners.results.find((row) => row.order_id === orderId)?.order_number ?? orderId;
    if (!manifest.workflowInstanceId) {
      configurationErrors.push(`${orderNumber} 尚未锁定工作流实例`);
    }
    configurationErrors.push(...manifest.configurationErrors.map((error) => `${orderNumber}：${error}`));
    const positions = new Set(manifest.groups.map((group) => group.positionCode).filter(Boolean));
    for (const [kind, positionCode] of Object.entries(BATCH_RESPONSIBILITY_POSITION_CODES)) {
      if (!positions.has(positionCode)) {
        configurationErrors.push(
          `${orderNumber} 冻结工作流中没有未完成的${kind === "operation" ? "操作" : "单证"}职责（${positionCode}）`,
        );
      }
    }
  }
  const restrictions = buildBatchInitialResponsibilityRestrictions(
    owners.results.map((row) => ({
      orderId: row.order_id,
      orderNumber: row.order_number,
      moduleCode: row.module_code,
      positionCode: row.position_code ?? "",
      assigneeUserId: row.assignee_user_id,
      assigneeName: row.assignee_name,
    })),

  );
  restrictions.configurationErrors = [...new Set(configurationErrors)];
  return restrictions;
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
            ss.step_key,
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
          stepKey: row.step_key ?? "",
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
      const positions = new Set(manifest.groups.map((group) => group.positionCode).filter(Boolean));
      for (const [kind, positionCode] of Object.entries(BATCH_RESPONSIBILITY_POSITION_CODES)) {
        if (!positions.has(positionCode)) {
          configurationErrors.push(
            `${orderNumber} 冻结工作流中没有未完成的${kind === "operation" ? "操作" : "单证"}职责（${positionCode}）`,
          );
        }
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
    const restrictions = buildBatchInitialResponsibilityRestrictions(assignments);
    restrictions.configurationErrors = [...new Set(configurationErrors)];
    return [batchId, restrictions];
  }));
}
