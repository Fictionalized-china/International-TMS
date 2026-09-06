import { env } from "cloudflare:workers";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";
import type { LoadingBatchWorkflowOrder } from "./loading-batch-field-policy";

type StageRow = {
  order_id: string;
  order_status: string;
  bound_instance_id: string | null;
  matched_instance_id: string | null;
  matched_instance_status: string | null;
  current_step_state_id: string | null;
  current_step_key: string | null;
  current_step_name: string | null;
  current_step_status: string | null;
  current_step_sort_order: number | null;
  target_module_state_id: string | null;
  target_module_status: string | null;
  target_step_key: string | null;
  target_step_name: string | null;
  target_step_sort_order: number | null;
  applies_to_current_or_future: number;
};

type FieldRow = {
  order_id: string;
  step_key: string;
  field_key: string;
  is_active: number;
  is_required: number;
};

type LoadingStageResolution = Pick<
  LoadingBatchWorkflowOrder,
  | "usesFrozenSnapshot"
  | "appliesToCurrentOrFuture"
  | "loadingStageAvailable"
  | "loadingTargetStepKey"
  | "loadingTargetStepName"
  | "loadingStageReason"
>;

function invalidFrozenLoadingStage(reason: string): LoadingStageResolution {
  return {
    usesFrozenSnapshot: true,
    appliesToCurrentOrFuture: false,
    loadingStageAvailable: false,
    loadingTargetStepKey: null,
    loadingTargetStepName: null,
    loadingStageReason: reason,
  };
}

function resolveLoadingStage(rows: readonly StageRow[]): LoadingStageResolution {
  const binding = rows[0];
  if (["completed", "cancelled"].includes(binding.order_status)) {
    return invalidFrozenLoadingStage(
      binding.order_status === "cancelled"
        ? "订单已取消，不能办理装车与出库"
        : "订单已完成，当前仅可查看装车与出库历史",
    );
  }
  if (binding.bound_instance_id === null) {
    return {
      usesFrozenSnapshot: false,
      appliesToCurrentOrFuture: true,
      loadingStageAvailable: true,
      loadingTargetStepKey: null,
      loadingTargetStepName: null,
      loadingStageReason: null,
    };
  }
  if (
    !binding.bound_instance_id.trim() ||
    !binding.matched_instance_id ||
    binding.matched_instance_status !== "active"
  ) {
    return invalidFrozenLoadingStage(
      "订单绑定的冻结工作流实例无效，请联系管理员修复后再办理装车与出库",
    );
  }
  const currentSteps = new Map(
    rows
      .filter((row) => row.current_step_state_id)
      .map((row) => [row.current_step_state_id as string, row]),
  );
  if (currentSteps.size !== 1) {
    return invalidFrozenLoadingStage(
      "冻结工作流当前节点无法唯一定位，请联系管理员修复后再办理装车与出库",
    );
  }
  const targetModules = new Map(
    rows
      .filter((row) => row.target_module_state_id)
      .map((row) => [row.target_module_state_id as string, row]),
  );
  if (targetModules.size === 0) {
    return invalidFrozenLoadingStage(
      "当前冻结工作流未配置装车与出库模块，不能继续办理",
    );
  }
  if (targetModules.size !== 1) {
    return invalidFrozenLoadingStage(
      "冻结工作流中的装车与出库模块存在重复节点配置，请联系管理员修复",
    );
  }

  const current = [...currentSteps.values()][0];
  const target = [...targetModules.values()][0];
  if (
    !current.current_step_key ||
    current.current_step_status !== "active" ||
    current.current_step_sort_order === null ||
    !target.target_step_key ||
    !target.target_step_name ||
    target.target_step_sort_order === null
  ) {
    return invalidFrozenLoadingStage(
      "冻结工作流中的装车与出库节点无效，请联系管理员修复",
    );
  }
  const targetBase = {
    usesFrozenSnapshot: true,
    loadingTargetStepKey: target.target_step_key,
    loadingTargetStepName: target.target_step_name,
  } as const;
  if (["completed", "not_applicable"].includes(target.target_module_status ?? "")) {
    return {
      ...targetBase,
      appliesToCurrentOrFuture: false,
      loadingStageAvailable: false,
      loadingStageReason: `“${target.target_step_name}”办理节点已结束，当前仅可查看历史记录`,
    };
  }
  if (current.current_step_key === target.target_step_key) {
    if (!["active", "pending"].includes(target.target_module_status ?? "")) {
      return {
        ...targetBase,
        appliesToCurrentOrFuture: false,
        loadingStageAvailable: false,
        loadingStageReason: target.target_module_status === "blocked"
          ? `“${target.target_step_name}”办理模块当前被阻断，请先处理异常`
          : `“${target.target_step_name}”办理模块状态无效，请刷新或联系管理员修复`,
      };
    }
    return {
      ...targetBase,
      appliesToCurrentOrFuture: true,
      loadingStageAvailable: true,
      loadingStageReason: null,
    };
  }
  if (current.current_step_sort_order === target.target_step_sort_order) {
    return {
      ...targetBase,
      appliesToCurrentOrFuture: false,
      loadingStageAvailable: false,
      loadingStageReason: "冻结工作流节点顺序冲突，不能判断装车与出库办理时点",
    };
  }
  if (current.current_step_sort_order < target.target_step_sort_order) {
    return {
      ...targetBase,
      appliesToCurrentOrFuture: true,
      loadingStageAvailable: false,
      loadingStageReason: `当前处于“${current.current_step_name ?? current.current_step_key}”，进入“${target.target_step_name}”后开放装车与出库办理`,
    };
  }
  return {
    ...targetBase,
    appliesToCurrentOrFuture: false,
    loadingStageAvailable: false,
    loadingStageReason: `“${target.target_step_name}”办理节点已结束，当前仅可查看历史记录`,
  };
}

/**
 * Loads each order's immutable loading-field snapshot together with its exact
 * frozen loading-node relation. A SQL NULL workflow pointer is the only legacy
 * fallback and uses catalog defaults; a malformed non-null binding fails closed.
 */
export async function loadLoadingBatchWorkflowOrders(
  organizationId: string,
  orderIds: readonly string[],
): Promise<LoadingBatchWorkflowOrder[]> {
  const uniqueOrderIds = [...new Set(orderIds.filter(Boolean))];
  if (!uniqueOrderIds.length) return [];
  const stageRows: StageRow[] = [];
  const fieldRows: FieldRow[] = [];
  for (const chunk of chunkD1Values(uniqueOrderIds, 1)) {
    const placeholders = d1Placeholders(chunk.length);
    const [stages, fields] = await Promise.all([
      env.DB.prepare(
        `SELECT o.id order_id,o.status order_status,
                o.workflow_instance_id bound_instance_id,
                wi.id matched_instance_id,wi.status matched_instance_status,
                current_step.id current_step_state_id,
                current_step.step_key current_step_key,
                current_step.step_name current_step_name,
                current_step.status current_step_status,
                current_step.sort_order current_step_sort_order,
                target_module.id target_module_state_id,
                target_module.status target_module_status,
                target_step.step_key target_step_key,
                target_step.step_name target_step_name,
                target_step.sort_order target_step_sort_order,
                CASE
                  WHEN o.workflow_instance_id IS NULL THEN 1
                  WHEN current_step.sort_order IS NOT NULL
                   AND target_step.sort_order IS NOT NULL
                   AND current_step.sort_order<=target_step.sort_order THEN 1
                  ELSE 0
                END applies_to_current_or_future
         FROM transport_orders o
         LEFT JOIN workflow_instances wi
           ON wi.id=o.workflow_instance_id
          AND wi.organization_id=o.organization_id
          AND wi.order_id=o.id
         LEFT JOIN workflow_instance_step_states current_step
           ON current_step.instance_id=wi.id
          AND current_step.step_key=wi.current_step_key
         LEFT JOIN workflow_instance_module_states target_module
           ON target_module.module_code='loading'
          AND target_module.instance_step_state_id IN (
            SELECT loading_step.id
            FROM workflow_instance_step_states loading_step
            WHERE loading_step.instance_id=wi.id
          )
         LEFT JOIN workflow_instance_step_states target_step
           ON target_step.id=target_module.instance_step_state_id
          AND target_step.instance_id=wi.id
         WHERE o.organization_id=? AND o.id IN (${placeholders})
         ORDER BY o.id,target_step.sort_order,target_module.sort_order,target_module.id`,
      ).bind(organizationId, ...chunk).all<StageRow>(),
      env.DB.prepare(
        `WITH bindings AS (
           SELECT o.id order_id,wi.id instance_id
           FROM transport_orders o
           JOIN workflow_instances wi
             ON wi.id=o.workflow_instance_id
            AND wi.organization_id=o.organization_id
            AND wi.order_id=o.id
           WHERE o.organization_id=? AND o.id IN (${placeholders})
         )
         SELECT b.order_id,f.step_key,f.field_key,f.is_active,f.is_required
         FROM bindings b
         JOIN workflow_instance_fields f
           ON f.instance_id=b.instance_id AND f.module_code='loading'`,
      ).bind(organizationId, ...chunk).all<FieldRow>(),
    ]);
    stageRows.push(...stages.results);
    fieldRows.push(...fields.results);
  }

  const stagesByOrder = new Map<string, StageRow[]>();
  for (const row of stageRows) {
    const rows = stagesByOrder.get(row.order_id) ?? [];
    rows.push(row);
    stagesByOrder.set(row.order_id, rows);
  }
  const fieldsByOrder = new Map<string, FieldRow[]>();
  for (const field of fieldRows) {
    const fields = fieldsByOrder.get(field.order_id) ?? [];
    fields.push(field);
    fieldsByOrder.set(field.order_id, fields);
  }
  return uniqueOrderIds.map((orderId) => {
    const stages = stagesByOrder.get(orderId);
    if (!stages?.length) {
      return {
        orderId,
        currentStepKey: null,
        ...invalidFrozenLoadingStage("订单不存在或不属于当前组织，不能办理装车与出库"),
        fields: [],
      };
    }
    const stage = resolveLoadingStage(stages);
    const frozenFields = fieldsByOrder.get(orderId) ?? [];
    if (stage.usesFrozenSnapshot && stage.loadingTargetStepKey) {
      const misplaced = frozenFields.find(
        (field) => field.step_key !== stage.loadingTargetStepKey,
      );
      if (misplaced) {
        return {
          orderId,
          ...invalidFrozenLoadingStage(
            `冻结工作流装车字段配置在非目标节点（${misplaced.step_key}），请联系管理员修复`,
          ),
          fields: [],
        };
      }
      const duplicateKeys = frozenFields
        .map((field) => field.field_key)
        .filter((fieldKey, index, all) => all.indexOf(fieldKey) !== index);
      if (duplicateKeys.length) {
        return {
          orderId,
          ...invalidFrozenLoadingStage(
            `冻结工作流装车字段存在重复配置（${[...new Set(duplicateKeys)].join("、")}），请联系管理员修复`,
          ),
          fields: [],
        };
      }
    }
    return {
      orderId,
      currentStepKey: stages[0]?.current_step_key ?? null,
      ...stage,
      fields: frozenFields
        .filter(
          (field) =>
            !stage.usesFrozenSnapshot ||
            field.step_key === stage.loadingTargetStepKey,
        )
        .map((field) => ({
        fieldKey: field.field_key,
        isActive: Boolean(field.is_active),
        isRequired: Boolean(field.is_required),
        })),
    };
  });
}
