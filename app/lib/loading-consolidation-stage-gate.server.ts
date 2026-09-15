import {
  loadingConsolidationStageAccess,
  type LoadingConsolidationStageAccess,
} from "./loading-consolidation-stage-gate";
import { loadLockedWorkflowStageContext } from "./workflow-instance-stage-gate.server";

type LoadingConsolidationBindingRow = {
  order_status: string;
  bound_instance_id: string | null;
  matched_instance_id: string | null;
  matched_instance_status: string | null;
};

export type OrderLoadingConsolidationWorkflowAccess = LoadingConsolidationStageAccess & {
  orderId: string;
  configured: boolean;
  legacyFallback: boolean;
};

function denied(
  orderId: string,
  reason: string,
  configured = true,
): OrderLoadingConsolidationWorkflowAccess {
  return {
    orderId,
    configured,
    available: false,
    targetStepKey: null,
    targetStepName: null,
    reason,
    legacyFallback: false,
  };
}

/** Candidate filtering counterpart of loadLoadingConsolidationWorkflowAccess. */
export function loadingConsolidationWorkflowAccessSql(orderAlias: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(orderAlias)) {
    throw new Error("Invalid SQL order alias");
  }
  return `(${orderAlias}.status NOT IN ('completed','cancelled') AND (
    ${orderAlias}.workflow_instance_id IS NULL
    OR EXISTS(
      SELECT 1
      FROM workflow_instances gate_instance
      JOIN workflow_instance_step_states gate_current_step
        ON gate_current_step.instance_id=gate_instance.id
       AND gate_current_step.step_key=gate_instance.current_step_key
      JOIN workflow_instance_module_states gate_module
        ON gate_module.instance_step_state_id=gate_current_step.id
       AND gate_module.module_code='loading'
       AND gate_module.status NOT IN ('completed','not_applicable')
      WHERE gate_instance.id=${orderAlias}.workflow_instance_id
        AND gate_instance.organization_id=${orderAlias}.organization_id
        AND gate_instance.order_id=${orderAlias}.id
        AND gate_instance.status='active'
    )
  ))`;
}

/**
 * Resolve PZ creation from the order's exact frozen workflow binding.
 * Only a SQL NULL workflow pointer is allowed to use the legacy path.
 */
export async function loadLoadingConsolidationWorkflowAccess(
  db: D1Database,
  organizationId: string,
  orderId: string,
): Promise<OrderLoadingConsolidationWorkflowAccess> {
  const binding = await db.prepare(
    `SELECT o.status order_status,o.workflow_instance_id bound_instance_id,
            wi.id matched_instance_id,wi.status matched_instance_status
       FROM transport_orders o
       LEFT JOIN workflow_instances wi
         ON wi.id=o.workflow_instance_id
        AND wi.organization_id=o.organization_id
        AND wi.order_id=o.id
      WHERE o.organization_id=? AND o.id=?`,
  ).bind(organizationId, orderId).first<LoadingConsolidationBindingRow>();

  if (!binding) return denied(orderId, "订单不存在或不属于当前组织");
  if (["completed", "cancelled"].includes(binding.order_status)) {
    return denied(
      orderId,
      binding.order_status === "cancelled"
        ? "订单已取消，不能生成配载单"
        : "订单已完成，不能重新生成配载单",
      binding.bound_instance_id !== null,
    );
  }
  if (binding.bound_instance_id === null) {
    return {
      orderId,
      configured: false,
      available: true,
      targetStepKey: null,
      targetStepName: null,
      reason: null,
      legacyFallback: true,
    };
  }
  if (
    !binding.bound_instance_id.trim() ||
    !binding.matched_instance_id ||
    binding.matched_instance_status !== "active"
  ) {
    return denied(orderId, "订单绑定的冻结工作流实例无效，请联系管理员修复后再配载");
  }

  const context = await loadLockedWorkflowStageContext(
    db,
    organizationId,
    orderId,
    "loading",
  );
  const access = loadingConsolidationStageAccess({
    currentStepKey: context.currentStepKey,
    steps: context.steps,
    loadingStepKeys: context.modulePlacements
      .filter((placement) => placement.moduleCode === "loading")
      .map((placement) => placement.stepKey),
  });
  return {
    orderId,
    configured: true,
    ...access,
    legacyFallback: false,
  };
}

export async function loadLoadingConsolidationWorkflowAccesses(
  db: D1Database,
  organizationId: string,
  orderIds: readonly string[],
): Promise<OrderLoadingConsolidationWorkflowAccess[]> {
  const accesses: OrderLoadingConsolidationWorkflowAccess[] = [];
  // Keep D1 reads sequential: a cross-page selection can contain many orders.
  for (const orderId of [...new Set(orderIds.filter(Boolean))]) {
    accesses.push(await loadLoadingConsolidationWorkflowAccess(db, organizationId, orderId));
  }
  return accesses;
}
