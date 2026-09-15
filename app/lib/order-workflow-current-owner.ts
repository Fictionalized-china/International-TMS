import type { OrderModuleCode } from "./order-modules";

export type FrozenWorkflowCurrentOwnerRow = {
  step_key: string;
  step_name: string;
  module_state_id: string | null;
  module_code: OrderModuleCode | null;
  module_name: string | null;
  module_sort_order: number | null;
  module_required: number | null;
  module_state_status: string | null;
  module_instance_id: string | null;
  module_instance_enabled: number | null;
  module_instance_status: string | null;
  module_current_step_name: string | null;
  module_assignee_user_id: string | null;
  task_state_id: string | null;
  task_sort_order: number | null;
  task_required: number | null;
  task_type: string | null;
  task_status: string | null;
  task_assignee_user_id: string | null;
};

export type FrozenWorkflowCurrentOwner = {
  stepKey: string;
  stepName: string;
  primaryModuleCode: OrderModuleCode | null;
  primaryModuleName: string | null;
  primaryAssigneeUserId: string | null;
  activeModuleInstanceIds: string[];
  notificationAssigneeUserIds: string[];
};

export function resolveFrozenSettlementNotificationAssignees(input: {
  baseAssigneeUserIds: readonly string[];
  activeFieldKeys: readonly string[];
  salespersonUserId: string | null;
  financeAssigneeUserId: string | null;
}) {
  const assigneeUserIds = new Set(input.baseAssigneeUserIds);
  const activeFieldKeys = new Set(input.activeFieldKeys);

  // Settlement actions are independent workflow switches. Requiredness only
  // controls completion; every active action still needs its owner notified.
  if (
    activeFieldKeys.has("business_review") &&
    input.salespersonUserId
  ) {
    assigneeUserIds.add(input.salespersonUserId);
  }
  if (
    activeFieldKeys.has("finance_review") &&
    input.financeAssigneeUserId
  ) {
    assigneeUserIds.add(input.financeAssigneeUserId);
  }

  return [...assigneeUserIds];
}

function rowOwner(row: FrozenWorkflowCurrentOwnerRow) {
  return row.task_assignee_user_id ?? row.module_assignee_user_id;
}

function pendingHumanTask(row: FrozenWorkflowCurrentOwnerRow) {
  return Boolean(
    row.task_state_id &&
    row.task_status !== "completed" &&
    row.task_type !== "system",
  );
}

/**
 * Derive the order-level hand-off exclusively from the bound execution
 * snapshot's current step. The mutable template and the canonical module
 * sequence deliberately do not participate in this decision.
 */
export function resolveFrozenWorkflowCurrentOwner(
  rows: readonly FrozenWorkflowCurrentOwnerRow[],
): FrozenWorkflowCurrentOwner | null {
  const first = rows[0];
  if (!first) return null;

  const usableRows = rows.filter(
    (row) =>
      row.module_state_id &&
      row.module_code &&
      row.module_instance_id &&
      row.module_instance_enabled === 1,
  );
  const unfinishedRows = usableRows.filter(
    (row) => row.module_state_status !== "completed",
  );
  const candidateRows = unfinishedRows.length ? unfinishedRows : usableRows;
  const sortedRows = [...candidateRows].sort((left, right) => {
    const required = Number(right.module_required ?? 0) - Number(left.module_required ?? 0);
    if (required) return required;
    const moduleOrder = Number(left.module_sort_order ?? 0) - Number(right.module_sort_order ?? 0);
    if (moduleOrder) return moduleOrder;
    const leftPendingRequired = pendingHumanTask(left) && left.task_required === 1 ? 0 : 1;
    const rightPendingRequired = pendingHumanTask(right) && right.task_required === 1 ? 0 : 1;
    if (leftPendingRequired !== rightPendingRequired)
      return leftPendingRequired - rightPendingRequired;
    return Number(left.task_sort_order ?? 0) - Number(right.task_sort_order ?? 0);
  });
  const primary = sortedRows[0] ?? null;
  const primaryModuleRows = primary
    ? sortedRows.filter((row) => row.module_state_id === primary.module_state_id)
    : [];
  const primaryTask = primaryModuleRows.find(
    (row) => pendingHumanTask(row) && row.task_required === 1,
  ) ?? primaryModuleRows.find(pendingHumanTask) ?? primary;

  const activeModuleInstanceIds = [...new Set(
    unfinishedRows
      .filter((row) => row.module_instance_status === "not_started")
      .map((row) => row.module_instance_id)
      .filter((id): id is string => Boolean(id)),
  )];

  const notificationAssigneeUserIds: string[] = [];
  const rowsByModule = new Map<string, FrozenWorkflowCurrentOwnerRow[]>();
  for (const row of unfinishedRows) {
    if (!row.module_state_id) continue;
    const list = rowsByModule.get(row.module_state_id) ?? [];
    list.push(row);
    rowsByModule.set(row.module_state_id, list);
  }
  for (const moduleRows of rowsByModule.values()) {
    const humanTasks = moduleRows.filter(pendingHumanTask);
    if (humanTasks.length) {
      for (const row of humanTasks) {
        const owner = rowOwner(row);
        if (owner) notificationAssigneeUserIds.push(owner);
      }
    } else {
      const owner = moduleRows[0]?.module_assignee_user_id;
      if (owner) notificationAssigneeUserIds.push(owner);
    }
  }

  return {
    stepKey: first.step_key,
    stepName: first.step_name,
    primaryModuleCode: primary?.module_code ?? null,
    primaryModuleName: primary?.module_name ?? null,
    primaryAssigneeUserId: primaryTask ? rowOwner(primaryTask) : null,
    activeModuleInstanceIds,
    notificationAssigneeUserIds: [...new Set(notificationAssigneeUserIds)],
  };
}
