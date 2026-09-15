import type { WorkflowInstanceCapabilityStageAccess } from "./workflow-instance-stage-gate";

export type WarehousePhysicalModuleCode = "warehouse" | "overseas_warehouse";
export type WarehousePhysicalWorkflowActor = {
  userId: string;
  positionCode: string | null;
};

export type WarehousePhysicalWorkflowAccess = WorkflowInstanceCapabilityStageAccess & {
  legacyFallback: boolean;
};

type BindingRow = {
  workflow_instance_id: string | null;
  matched_instance_id: string | null;
  matched_instance_status: string | null;
  current_step_key: string | null;
  order_status: string;
};

type ModulePlacementRow = {
  id: string;
  step_key: string;
  step_name: string;
  sort_order: number;
  module_status: string;
  responsibility_position_code: string | null;
  module_assignee_user_id: string | null;
};

type TaskOwnerRow = {
  assignee_user_id: string | null;
  responsibility_position_code: string | null;
};

function nonBlank(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function actorOwnsFrozenModule(
  actor: WarehousePhysicalWorkflowActor,
  module: ModulePlacementRow,
  tasks: readonly TaskOwnerRow[],
) {
  if (!actor.positionCode) return false;
  const queuePositions = tasks.length
    ? tasks.map((task) =>
        task.responsibility_position_code ?? module.responsibility_position_code
      )
    : [module.responsibility_position_code];
  return queuePositions.includes(actor.positionCode);
}

/**
 * Warehouse scans are physical mutations, so a bound order must derive its
 * availability from the unfinished frozen module state and the physical
 * site's frozen responsibility-position queue. Overseas receiving is the
 * arrival event that closes the preceding transport node, so it may use the
 * next configured overseas-warehouse module before pickup becomes current.
 * Only a real SQL NULL binding keeps the historic warehouse behaviour.
 */
export async function loadWarehousePhysicalWorkflowAccess(
  db: D1Database,
  organizationId: string,
  orderId: string,
  moduleCode: WarehousePhysicalModuleCode,
  actor: WarehousePhysicalWorkflowActor,
): Promise<WarehousePhysicalWorkflowAccess> {
  const binding = await db.prepare(
    `SELECT o.workflow_instance_id,o.status order_status,
            wi.id matched_instance_id,wi.status matched_instance_status,wi.current_step_key
     FROM transport_orders o
     LEFT JOIN workflow_instances wi
       ON wi.id=o.workflow_instance_id
      AND wi.organization_id=o.organization_id
      AND wi.order_id=o.id
     WHERE o.organization_id=? AND o.id=?`,
  ).bind(organizationId, orderId).first<BindingRow>();
  if (!binding) {
    return {
      configured: true,
      visible: false,
      available: false,
      targetStepKey: null,
      targetStepName: null,
      reason: "订单不存在或不属于当前组织",
      legacyFallback: false,
    };
  }
  if (["completed", "cancelled"].includes(binding.order_status)) {
    return {
      configured: binding.workflow_instance_id !== null,
      visible: true,
      available: false,
      targetStepKey: binding.current_step_key,
      targetStepName: null,
      reason: binding.order_status === "cancelled"
        ? "订单已取消，仓库办理已关闭"
        : "订单已完成，当前仅可查看历史记录",
      legacyFallback: binding.workflow_instance_id === null,
    };
  }
  if (binding.workflow_instance_id === null) {
    return {
      configured: false,
      visible: true,
      available: true,
      targetStepKey: null,
      targetStepName: null,
      reason: null,
      legacyFallback: true,
    };
  }
  if (
    !nonBlank(binding.workflow_instance_id) ||
    !binding.matched_instance_id ||
    binding.matched_instance_status !== "active"
  ) {
    return {
      configured: true,
      visible: true,
      available: false,
      targetStepKey: binding.current_step_key,
      targetStepName: null,
      reason: "订单绑定的冻结工作流实例无效，请联系管理员修复后再办理",
      legacyFallback: false,
    };
  }

  const placements = await db.prepare(
    `SELECT ms.id,ss.step_key,ss.step_name,ss.sort_order,
            ms.status module_status,ms.responsibility_position_code,
            omi.assignee_user_id module_assignee_user_id
     FROM workflow_instance_step_states ss
     JOIN workflow_instance_module_states ms
       ON ms.instance_step_state_id=ss.id AND ms.module_code=?
     LEFT JOIN order_module_instances omi
       ON omi.organization_id=? AND omi.order_id=?
      AND omi.module_code=ms.module_code AND omi.enabled=1
     WHERE ss.instance_id=?
     ORDER BY ss.sort_order,ms.sort_order,ms.id`,
  ).bind(
    moduleCode,
    organizationId,
    orderId,
    binding.matched_instance_id,
  ).all<ModulePlacementRow>();
  const current = placements.results.find(
    (placement) => placement.step_key === binding.current_step_key,
  );
  if (!current) {
    const currentStep = await db.prepare(
      `SELECT step_name,sort_order
       FROM workflow_instance_step_states
       WHERE instance_id=? AND step_key=?`,
    ).bind(
      binding.matched_instance_id,
      binding.current_step_key,
    ).first<{ step_name: string; sort_order: number }>();
    if (!currentStep) {
      return {
        configured: true,
        visible: true,
        available: false,
        targetStepKey: null,
        targetStepName: null,
        reason: "冻结工作流当前节点无效，请联系管理员修复后再办理",
        legacyFallback: false,
      };
    }
    const next = placements.results.find(
      (placement) => placement.sort_order > currentStep.sort_order,
    );
    const previous = [...placements.results]
      .reverse()
      .find((placement) => placement.sort_order < currentStep.sort_order);
    // The overseas warehouse scan is the physical arrival event that closes
    // the preceding transport/tracking node. It must therefore be available
    // from the preceding transport phase before the configured pickup node, while
    // still deriving its owner and placement from the frozen workflow.
    if (moduleCode === "overseas_warehouse" && next && next.module_status !== "completed") {
      const tasks = await db.prepare(
        `SELECT assignee_user_id,responsibility_position_code
         FROM workflow_instance_task_states
         WHERE instance_module_state_id=? AND status!='completed'
         ORDER BY sort_order,id`,
      ).bind(next.id).all<TaskOwnerRow>();
      if (!actorOwnsFrozenModule(actor, next, tasks.results)) {
        return {
          configured: true,
          visible: true,
          available: false,
          targetStepKey: next.step_key,
          targetStepName: next.step_name,
          reason: `当前账号不是“${next.step_name}”冻结任务的负责人，仅可查看`,
          legacyFallback: false,
        };
      }
      return {
        configured: true,
        visible: true,
        available: true,
        targetStepKey: next.step_key,
        targetStepName: next.step_name,
        reason: null,
        legacyFallback: false,
      };
    }
    return {
      configured: true,
      visible: true,
      available: false,
      targetStepKey: next?.step_key ?? previous?.step_key ?? null,
      targetStepName: next?.step_name ?? previous?.step_name ?? null,
      reason: next
        ? `当前处于“${currentStep.step_name}”，进入“${next.step_name}”后自动开放`
        : previous
          ? `“${previous.step_name}”办理节点已结束，当前仅可查看历史记录`
          : "当前冻结工作流未配置对应的仓库办理模块",
      legacyFallback: false,
    };
  }
  if (current.module_status === "completed") {
    return {
      configured: true,
      visible: true,
      available: false,
      targetStepKey: current.step_key,
      targetStepName: current.step_name,
      reason: `“${current.step_name}”已完成，当前仅可查看历史记录`,
      legacyFallback: false,
    };
  }
  const tasks = await db.prepare(
    `SELECT assignee_user_id,responsibility_position_code
     FROM workflow_instance_task_states
     WHERE instance_module_state_id=? AND status!='completed'
     ORDER BY sort_order,id`,
  ).bind(current.id).all<TaskOwnerRow>();
  if (!actorOwnsFrozenModule(actor, current, tasks.results)) {
    return {
      configured: true,
      visible: true,
      available: false,
      targetStepKey: current.step_key,
      targetStepName: current.step_name,
      reason: `当前账号不是“${current.step_name}”冻结任务的负责人，仅可查看`,
      legacyFallback: false,
    };
  }
  return {
    configured: true,
    visible: true,
    available: true,
    targetStepKey: current.step_key,
    targetStepName: current.step_name,
    reason: null,
    legacyFallback: false,
  };
}

/**
 * Active candidate queues use the same frozen placement and position-queue
 * rule as the action loader. Overseas receiving also includes its next frozen
 * module because the arrival scan is what advances transport into pickup.
 * Route-level warehouse context independently enforces the selected physical
 * site. `orderAlias` is source-code only.
 */
export function warehousePhysicalWorkflowAccessSql(
  orderAlias: string,
  moduleCode: WarehousePhysicalModuleCode,
  actor: WarehousePhysicalWorkflowActor,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(orderAlias)) {
    throw new Error("Invalid SQL order alias");
  }
  const queueOwnerSql = actor.positionCode
    ? `AND (
        (
          EXISTS(
            SELECT 1 FROM workflow_instance_task_states gate_any_task
            WHERE gate_any_task.instance_module_state_id=gate_module.id
              AND gate_any_task.status!='completed'
          )
          AND EXISTS(
            SELECT 1 FROM workflow_instance_task_states gate_position_task
            WHERE gate_position_task.instance_module_state_id=gate_module.id
              AND gate_position_task.status!='completed'
              AND COALESCE(
                gate_position_task.responsibility_position_code,
                gate_module.responsibility_position_code
              )=?
          )
        )
        OR (
          NOT EXISTS(
            SELECT 1 FROM workflow_instance_task_states gate_any_task
            WHERE gate_any_task.instance_module_state_id=gate_module.id
              AND gate_any_task.status!='completed'
          )
          AND gate_module.responsibility_position_code=?
        )
      )`
    : "AND 0=1";
  const modulePlacementJoin = moduleCode === "overseas_warehouse"
    ? `JOIN workflow_instance_step_states gate_module_step
          ON gate_module_step.instance_id=gate_instance.id
         AND gate_module_step.sort_order>=gate_current_step.sort_order
       JOIN workflow_instance_module_states gate_module
          ON gate_module.instance_step_state_id=gate_module_step.id
         AND gate_module.module_code=?
         AND gate_module.status!='completed'`
    : `JOIN workflow_instance_module_states gate_module
          ON gate_module.instance_step_state_id=gate_current_step.id
         AND gate_module.module_code=?
         AND gate_module.status!='completed'`;
  return {
    sql: `(${orderAlias}.status NOT IN ('completed','cancelled') AND (
      ${orderAlias}.workflow_instance_id IS NULL
      OR EXISTS(
        SELECT 1
        FROM workflow_instances gate_instance
        JOIN workflow_instance_step_states gate_current_step
          ON gate_current_step.instance_id=gate_instance.id
         AND gate_current_step.step_key=gate_instance.current_step_key
        ${modulePlacementJoin}
        WHERE gate_instance.id=${orderAlias}.workflow_instance_id
          AND gate_instance.organization_id=${orderAlias}.organization_id
          AND gate_instance.order_id=${orderAlias}.id
          AND gate_instance.status='active'
          ${queueOwnerSql}
      )
    ))`,
    values: actor.positionCode
      ? [moduleCode, actor.positionCode, actor.positionCode]
      : [moduleCode],
  };
}

/** Historical queues may show a reached frozen module after it is complete. */
export function warehousePhysicalWorkflowVisibilitySql(
  orderAlias: string,
  moduleCode: WarehousePhysicalModuleCode,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(orderAlias)) {
    throw new Error("Invalid SQL order alias");
  }
  return {
    sql: `(
      ${orderAlias}.workflow_instance_id IS NULL
      OR EXISTS(
        SELECT 1
        FROM workflow_instances gate_instance
        JOIN workflow_instance_step_states gate_current_step
          ON gate_current_step.instance_id=gate_instance.id
         AND gate_current_step.step_key=gate_instance.current_step_key
        JOIN workflow_instance_step_states gate_target_step
          ON gate_target_step.instance_id=gate_instance.id
        JOIN workflow_instance_module_states gate_module
          ON gate_module.instance_step_state_id=gate_target_step.id
         AND gate_module.module_code=?
        WHERE gate_instance.id=${orderAlias}.workflow_instance_id
          AND gate_instance.organization_id=${orderAlias}.organization_id
          AND gate_instance.order_id=${orderAlias}.id
          AND gate_current_step.sort_order>=gate_target_step.sort_order
      )
    )`,
    values: [moduleCode],
  };
}
