import { env } from "cloudflare:workers";
import { isActiveOrganizationAssigneeForPositions } from "./organization-assignee.server";
import {
  buildOrderAssignmentManifest,
  nextRequiredOrderAssignmentGroup,
  type OrderAssignmentManifest,
  type OrderAssignmentManifestGroup,
  type WorkflowAssignmentSnapshotRow,
} from "./order-assignment-manifest";

type WorkflowAssignmentSnapshotDbRow = {
  module_state_id: string;
  module_code: string;
  module_name: string;
  step_sort_order: number;
  module_sort_order: number;
  module_required: number;
  module_status: string;
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
};

export type LoadedOrderAssignmentManifest = OrderAssignmentManifest & {
  workflowInstanceId: string | null;
};

export type OrderAssignmentManifestSelection = {
  groupKey: string;
  assigneeUserId: string;
};

export type ResolvedOrderAssignmentGroup = {
  group: OrderAssignmentManifestGroup;
  assigneeUserId: string;
  selectedNow: boolean;
};

export type OrderAssignmentManifestOptions = {
  excludeModuleCodes?: readonly string[];
};

const defaultExcludedModuleCodes = ["assignment"] as const;

function mapSnapshotRow(row: WorkflowAssignmentSnapshotDbRow): WorkflowAssignmentSnapshotRow {
  return {
    moduleStateId: row.module_state_id,
    moduleCode: row.module_code,
    moduleName: row.module_name,
    stepSortOrder: Number(row.step_sort_order),
    moduleSortOrder: Number(row.module_sort_order),
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
  };
}

export async function loadOrderAssignmentManifest(
  organizationId: string,
  orderId: string,
  options: OrderAssignmentManifestOptions = {},
): Promise<LoadedOrderAssignmentManifest> {
  const order = await env.DB.prepare(
    "SELECT workflow_instance_id FROM transport_orders WHERE organization_id=? AND id=?",
  ).bind(organizationId, orderId).first<{ workflow_instance_id: string | null }>();
  if (!order) throw new Error("订单不存在");
  if (!order.workflow_instance_id) {
    return { workflowInstanceId: null, groups: [], configurationErrors: [] };
  }
  const rows = await env.DB.prepare(
    `SELECT ms.id module_state_id,ms.module_code,ms.display_name module_name,
            ss.sort_order step_sort_order,ms.sort_order module_sort_order,
            ms.is_required module_required,ms.status module_status,
            ms.responsibility_position_code module_position_code,
            omi.assignee_user_id module_assignee_user_id,
            ts.id task_state_id,ts.task_key,ts.name task_name,ts.sort_order task_sort_order,
            ts.is_required task_required,ts.status task_status,
            COALESCE(ts.responsibility_position_code,ms.responsibility_position_code) task_position_code,
            ts.assignee_user_id task_assignee_user_id
       FROM workflow_instance_module_states ms
       JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
       LEFT JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
       LEFT JOIN order_module_instances omi
         ON omi.organization_id=? AND omi.order_id=? AND omi.module_code=ms.module_code
      WHERE ss.instance_id=?
      ORDER BY ss.sort_order,ms.sort_order,ts.sort_order,ms.id,ts.id`,
  ).bind(organizationId, orderId, order.workflow_instance_id)
    .all<WorkflowAssignmentSnapshotDbRow>();
  const excluded = new Set(options.excludeModuleCodes ?? defaultExcludedModuleCodes);
  const manifest = buildOrderAssignmentManifest(
    rows.results.map(mapSnapshotRow).filter((row) => !excluded.has(row.moduleCode)),
  );
  return { workflowInstanceId: order.workflow_instance_id, ...manifest };
}

export type OrderDispatchResponsibilityPolicy = {
  source: "workflow_instance" | "legacy";
  workflowInstanceId: string | null;
  groupKey: string | null;
  positionCode: string;
};

export async function loadOrderDispatchResponsibilityPolicy(
  organizationId: string,
  orderId: string,
): Promise<OrderDispatchResponsibilityPolicy> {
  const manifest = await loadOrderAssignmentManifest(organizationId, orderId);
  if (!manifest.workflowInstanceId) {
    return {
      source: "legacy",
      workflowInstanceId: null,
      groupKey: null,
      positionCode: "OPERATION",
    };
  }
  const nextGroup = nextRequiredOrderAssignmentGroup(manifest.groups);
  if (!nextGroup?.positionCode) {
    throw new Error(
      "当前锁定工作流未配置后续必办人工责任岗位，请修正工作流后重新创建订单。",
    );
  }
  return {
    source: "workflow_instance",
    workflowInstanceId: manifest.workflowInstanceId,
    groupKey: nextGroup.key,
    positionCode: nextGroup.positionCode,
  };
}

export async function validateOrderAssignmentManifestSelections(input: {
  organizationId: string;
  orderId: string;
  selections: readonly OrderAssignmentManifestSelection[];
  excludeModuleCodes?: readonly string[];
}): Promise<{
  manifest: LoadedOrderAssignmentManifest;
  resolvedGroups: ResolvedOrderAssignmentGroup[];
}> {
  const manifest = await loadOrderAssignmentManifest(
    input.organizationId,
    input.orderId,
    { excludeModuleCodes: input.excludeModuleCodes },
  );
  if (!manifest.workflowInstanceId)
    throw new Error("订单尚未锁定工作流实例，不能按配置确认派单");
  if (manifest.configurationErrors.length)
    throw new Error(`工作流责任配置不完整：${manifest.configurationErrors.join("；")}`);

  const selectionsByGroup = new Map<string, string>();
  for (const selection of input.selections) {
    if (!selection.groupKey || !selection.assigneeUserId) continue;
    if (selectionsByGroup.has(selection.groupKey))
      throw new Error("同一责任岗位不能重复提交多个负责人");
    selectionsByGroup.set(selection.groupKey, selection.assigneeUserId);
  }
  const knownGroups = new Set(manifest.groups.map((group) => group.key));
  const unknown = [...selectionsByGroup.keys()].find((key) => !knownGroups.has(key));
  if (unknown) throw new Error("提交了不属于当前锁定工作流的责任分配组");

  const resolvedGroups: ResolvedOrderAssignmentGroup[] = [];
  for (const group of manifest.groups) {
    const selectedAssignee = selectionsByGroup.get(group.key);
    const assigneeUserId = selectedAssignee ?? group.assigneeUserId;
    if (!assigneeUserId) {
      if (group.required) {
        const scope = group.modules.map((module) => module.moduleName).join("、");
        throw new Error(`请为${scope}选择${group.positionCode ?? "已配置岗位"}的具体个人账户`);
      }
      continue;
    }
    if (!group.positionCode)
      throw new Error("当前责任分配组没有配置岗位，无法选择个人账户");
    if (!(await isActiveOrganizationAssigneeForPositions(
      input.organizationId,
      assigneeUserId,
      [group.positionCode],
    ))) {
      throw new Error(`${group.positionCode}负责人必须是该岗位下的有效个人账户`);
    }
    resolvedGroups.push({
      group,
      assigneeUserId,
      selectedNow: Boolean(selectedAssignee),
    });
  }
  return { manifest, resolvedGroups };
}

export type ResolvedOrderModuleAssignmentTarget = {
  workflowInstanceId: string;
  groupKey: string;
  positionCode: string;
  primaryOwner: boolean;
  moduleStateIds: string[];
  taskStateIds: string[];
};

export async function resolveOrderModuleAssignmentTarget(input: {
  organizationId: string;
  orderId: string;
  moduleCode: string;
  assigneeUserId: string;
  responsibilityPositionCode?: string | null;
}): Promise<ResolvedOrderModuleAssignmentTarget | null> {
  const manifest = await loadOrderAssignmentManifest(
    input.organizationId,
    input.orderId,
    { excludeModuleCodes: [] },
  );
  if (!manifest.workflowInstanceId) return null;
  const candidates = manifest.groups.filter((group) =>
    group.modules.some((module) => module.moduleCode === input.moduleCode),
  );
  if (!candidates.length)
    throw new Error("当前锁定工作流没有该模块的待分配责任");
  const target = input.responsibilityPositionCode
    ? candidates.find((group) => group.positionCode === input.responsibilityPositionCode)
    : candidates.length === 1
      ? candidates[0]
      : null;
  if (!target) {
    if (input.responsibilityPositionCode)
      throw new Error("提交的责任岗位不属于当前模块的锁定工作流配置");
    throw new Error("该模块包含多个责任岗位，请按工作流分配组分别指定负责人");
  }
  if (!target.positionCode)
    throw new Error("当前模块未配置责任岗位，不能分配个人账户");
  if (!(await isActiveOrganizationAssigneeForPositions(
    input.organizationId,
    input.assigneeUserId,
    [target.positionCode],
  ))) {
    throw new Error(`${target.positionCode}负责人必须是该岗位下的有效个人账户`);
  }
  const module = target.modules.find((item) => item.moduleCode === input.moduleCode);
  if (!module) throw new Error("当前模块没有可分配的工作流任务");
  return {
    workflowInstanceId: manifest.workflowInstanceId,
    groupKey: target.key,
    positionCode: target.positionCode,
    primaryOwner: module.primaryOwner,
    moduleStateIds: module.moduleStateIds,
    taskStateIds: module.taskStateIds,
  };
}

export function frozenWorkflowTaskAssignmentStatements(input: {
  organizationId: string;
  orderId: string;
  assigneeUserId: string;
  now: string;
  target: ResolvedOrderModuleAssignmentTarget;
}): D1PreparedStatement[] {
  if (!input.target.taskStateIds.length) return [];
  const placeholders = input.target.taskStateIds.map(() => "?").join(",");
  return [
    env.DB.prepare(
      `UPDATE workflow_instance_task_states
          SET assignee_user_id=?,updated_at=?
        WHERE id IN (${placeholders}) AND status!='completed'
          AND instance_module_state_id IN (
            SELECT ms.id
              FROM workflow_instance_module_states ms
              JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
              JOIN workflow_instances wi ON wi.id=ss.instance_id
             WHERE wi.id=? AND wi.organization_id=? AND wi.order_id=?
          )`,
    ).bind(
      input.assigneeUserId,
      input.now,
      ...input.target.taskStateIds,
      input.target.workflowInstanceId,
      input.organizationId,
      input.orderId,
    ),
  ];
}

export async function applyOrderAssignmentManifest(input: {
  organizationId: string;
  orderId: string;
  actorUserId: string;
  selections: readonly OrderAssignmentManifestSelection[];
  excludeModuleCodes?: readonly string[];
  dueAt?: string | null;
  notes?: string | null;
  now?: string;
}) {
  const { manifest, resolvedGroups } = await validateOrderAssignmentManifestSelections({
    organizationId: input.organizationId,
    orderId: input.orderId,
    selections: input.selections,
    excludeModuleCodes: input.excludeModuleCodes,
  });
  const workflowInstanceId = manifest.workflowInstanceId;
  if (!workflowInstanceId)
    throw new Error("订单尚未锁定工作流实例，不能确认派单");
  const now = input.now ?? new Date().toISOString();
  const assignedModuleCodes = [...new Set(
    resolvedGroups.flatMap(({ group }) => group.modules.map((module) => module.moduleCode)),
  )];
  const statements: D1PreparedStatement[] = assignedModuleCodes.map((moduleCode) =>
    env.DB.prepare(
      `UPDATE order_tasks SET status='cancelled',updated_at=?
        WHERE organization_id=? AND order_id=? AND module_code=?
          AND task_type='module_owner' AND status IN ('pending','in_progress')`,
    ).bind(now, input.organizationId, input.orderId, moduleCode),
  );

  for (const resolved of resolvedGroups) {
    for (const module of resolved.group.modules) {
      const target: ResolvedOrderModuleAssignmentTarget = {
        workflowInstanceId,
        groupKey: resolved.group.key,
        positionCode: resolved.group.positionCode!,
        primaryOwner: module.primaryOwner,
        moduleStateIds: module.moduleStateIds,
        taskStateIds: module.taskStateIds,
      };
      statements.push(...frozenWorkflowTaskAssignmentStatements({
        organizationId: input.organizationId,
        orderId: input.orderId,
        assigneeUserId: resolved.assigneeUserId,
        now,
        target,
      }));
      if (module.primaryOwner) {
        statements.push(
          env.DB.prepare(
            `UPDATE order_module_instances SET assignee_user_id=?,blocking_reason=NULL,updated_at=?
              WHERE organization_id=? AND order_id=? AND module_code=? AND enabled=1`,
          ).bind(
            resolved.assigneeUserId,
            now,
            input.organizationId,
            input.orderId,
            module.moduleCode,
          ),
        );
      }
      const taskTitle = `${module.moduleName}处理任务（${resolved.group.positionCode}）`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO order_tasks(
             id,organization_id,order_id,module_code,task_type,title,status,
             assignee_user_id,assigned_by_user_id,due_at,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?)`,
        ).bind(
          crypto.randomUUID(),
          input.organizationId,
          input.orderId,
          module.moduleCode,
          "module_owner",
          taskTitle,
          resolved.assigneeUserId,
          input.actorUserId,
          input.dueAt || null,
          now,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO order_module_history(
             id,organization_id,order_id,module_instance_id,action_code,action_name,
             from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
           )
           SELECT ?,?,?,omi.id,'assign','按锁定工作流分配负责人',
                  omi.current_step_code,COALESCE(omi.current_step_code,'assigned'),
                  COALESCE(omi.current_step_name,omi.module_name),?,?,?
             FROM order_module_instances omi
            WHERE omi.organization_id=? AND omi.order_id=? AND omi.module_code=?`,
        ).bind(
          crypto.randomUUID(),
          input.organizationId,
          input.orderId,
          input.actorUserId,
          input.notes || `责任岗位：${resolved.group.positionCode}`,
          now,
          input.organizationId,
          input.orderId,
          module.moduleCode,
        ),
      );
    }
  }
  if (statements.length) await env.DB.batch(statements);
  const nextGroup = nextRequiredOrderAssignmentGroup(manifest.groups);
  const primaryAssigneeUserId = nextGroup
    ? resolvedGroups.find(({ group }) => group.key === nextGroup.key)?.assigneeUserId ?? null
    : null;
  return {
    assignedGroupCount: resolvedGroups.length,
    assignedModuleCodes,
    primaryAssigneeUserId,
  };
}
