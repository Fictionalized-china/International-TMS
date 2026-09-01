import {
  workflowFieldPolicy,
  type WorkflowFieldMode,
  type WorkflowFieldPolicyLike,
} from "./workflow-field-catalog";

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
