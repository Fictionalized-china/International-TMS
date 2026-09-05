import { isAllowedRepeatedRequiredModulePlacement } from "./workflow-required-module-placements";

export type OrderBusinessWorkflowModuleFact = {
  module_code: string;
  enabled: number;
  is_required: number;
  status: string;
};

export type OrderBusinessWorkflowPlacement = {
  step_key: string;
  sort_order: number;
  module_code: string;
  module_required: number;
  module_state_status: string | null;
};

/**
 * Choose the execution frontier from the frozen instance/module placement.
 * A module moved to another node must move the order's gate with it; the
 * canonical page sequence is only a legacy fallback for unbound orders.
 */
export function resolveConfiguredOrderBusinessTarget(input: {
  modules: readonly OrderBusinessWorkflowModuleFact[];
  placements: readonly OrderBusinessWorkflowPlacement[];
  currentStepKey: string | null;
  completionStepKey?: string;
}) {
  const requiredPlacements = new Map<string, string[]>();
  for (const placement of input.placements) {
    if (placement.module_required !== 1) continue;
    const stepKeys = requiredPlacements.get(placement.module_code) ?? [];
    stepKeys.push(placement.step_key);
    requiredPlacements.set(placement.module_code, stepKeys);
  }
  const duplicateRequiredModuleCodes = [...requiredPlacements]
    .filter(
      ([moduleCode, stepKeys]) =>
        stepKeys.length > 1 &&
        !isAllowedRepeatedRequiredModulePlacement(moduleCode, stepKeys),
    )
    .map(([moduleCode]) => moduleCode);
  if (duplicateRequiredModuleCodes.length) {
    return {
      stepKey: input.currentStepKey,
      unresolvedModuleCodes: duplicateRequiredModuleCodes,
    };
  }

  const pendingModuleCodes = new Set(
    input.modules
      .filter(
        (module) =>
          module.enabled === 1 &&
          module.is_required === 1 &&
          module.status !== "completed",
      )
      .map((module) => module.module_code),
  );
  if (!pendingModuleCodes.size)
    return {
      stepKey: input.completionStepKey ?? "completion_review",
      unresolvedModuleCodes: [] as string[],
    };

  const ordered = [...input.placements].sort(
    (left, right) => left.sort_order - right.sort_order,
  );
  const placedPendingModuleCodes = new Set(
    ordered
      .filter(
        (placement) =>
          placement.module_required === 1 &&
          placement.module_state_status !== "completed" &&
          pendingModuleCodes.has(placement.module_code),
      )
      .map((placement) => placement.module_code),
  );
  const unresolvedModuleCodes = [...pendingModuleCodes].filter(
    (moduleCode) => !placedPendingModuleCodes.has(moduleCode),
  );
  if (unresolvedModuleCodes.length) {
    return {
      stepKey: input.currentStepKey,
      unresolvedModuleCodes,
    };
  }
  const target = ordered.find(
    (placement) =>
      placement.module_required === 1 &&
      placement.module_state_status !== "completed" &&
      pendingModuleCodes.has(placement.module_code),
  );
  if (target) {
    return { stepKey: target.step_key, unresolvedModuleCodes: [] as string[] };
  }

  return { stepKey: input.currentStepKey, unresolvedModuleCodes: [] as string[] };
}
