import {
  workflowFieldPolicy,
  type WorkflowFieldMode,
  type WorkflowFieldPolicyLike,
} from "./workflow-field-catalog";
import type { LoadingBatchWorkflowOrder } from "./loading-batch-field-policy";

export type WarehouseOutboundFieldPolicy = {
  isActive: boolean;
  isRequired: boolean;
  mode: WorkflowFieldMode;
};

export type WarehouseOutboundWorkflowPolicy = {
  handoverNotes: WarehouseOutboundFieldPolicy;
  scanConfirmation: WarehouseOutboundFieldPolicy;
};

function aggregateFieldPolicy(
  fieldsByOrder: readonly (readonly WorkflowFieldPolicyLike[])[],
  fieldKey: string,
  fallbackMode: WorkflowFieldMode,
): WarehouseOutboundFieldPolicy {
  const policies = fieldsByOrder.length
    ? fieldsByOrder.map((fields) =>
        workflowFieldPolicy(fields, fieldKey, fallbackMode),
      )
    : [workflowFieldPolicy([], fieldKey, fallbackMode)];
  const isRequired = policies.some(
    (policy) => policy.isActive && policy.isRequired,
  );
  const isActive = isRequired || policies.some((policy) => policy.isActive);
  return {
    isActive,
    isRequired,
    mode: !isActive ? "hidden" : isRequired ? "required" : "optional",
  };
}

// A PZ batch follows the strictest policy among every attached order. This is
// deliberately a pure function so the loader UI and action gate share exactly
// the same aggregation rule.
export function resolveWarehouseOutboundWorkflowPolicy(
  fieldsByOrder: readonly (readonly WorkflowFieldPolicyLike[])[],
): WarehouseOutboundWorkflowPolicy {
  return {
    handoverNotes: aggregateFieldPolicy(
      fieldsByOrder,
      "loading_handover_notes",
      "optional",
    ),
    scanConfirmation: aggregateFieldPolicy(
      fieldsByOrder,
      "loading_scan_confirmation",
      "required",
    ),
  };
}

/**
 * Resolves execution fields for orders at or before port loading. Once every
 * attached order has moved past this stage, old loading fields must not reopen
 * a completed gate. An actually empty order set still uses legacy-safe catalog
 * fallbacks because there is no workflow snapshot to evaluate.
 */
export function resolveWarehouseOutboundWorkflowPolicyForOrders(
  orders: readonly LoadingBatchWorkflowOrder[],
): WarehouseOutboundWorkflowPolicy {
  const applicableOrders = orders.filter(
    (order) => order.appliesToCurrentOrFuture,
  );
  if (orders.length > 0 && applicableOrders.length === 0) {
    return resolveWarehouseOutboundWorkflowPolicy([
      [
        {
          fieldKey: "loading_handover_notes",
          isActive: false,
          isRequired: false,
        },
        {
          fieldKey: "loading_scan_confirmation",
          isActive: false,
          isRequired: false,
        },
      ],
    ]);
  }
  return resolveWarehouseOutboundWorkflowPolicy(
    applicableOrders.map((order) => order.fields),
  );
}
