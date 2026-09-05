import {
  canonicalModuleUnlockStep,
  type OrderModuleWorkflowStageAccess,
} from "./order-stage-flow";
import type { OrderModuleCode } from "./order-modules";
import {
  workflowInstanceCapabilityStageAccess,
  type LockedWorkflowStageContext,
} from "./workflow-instance-stage-gate";

/**
 * Resolve module availability from the frozen execution snapshot. Returning
 * null is an explicit legacy signal: only callers receiving null may consult
 * the old workflow definition tables.
 */
export function frozenOrderModuleWorkflowStageAccess(
  moduleCode: OrderModuleCode,
  context: LockedWorkflowStageContext,
): OrderModuleWorkflowStageAccess | null {
  if (!context.locked) return null;
  const capability = workflowInstanceCapabilityStageAccess({
    context,
    moduleCode,
  });
  const canonicalStepKey = canonicalModuleUnlockStep(moduleCode);
  const requiredStepKey = capability.targetStepKey ?? canonicalStepKey;
  const current = context.steps.find(
    (step) => step.stepKey === context.currentStepKey,
  );
  return {
    available: capability.available,
    currentStepKey: context.currentStepKey,
    currentStepName: current?.stepName ?? null,
    requiredStepKey,
    requiredStepName:
      capability.targetStepName ?? capability.targetStepKey ?? canonicalStepKey,
    customPlacement: Boolean(
      capability.targetStepKey && capability.targetStepKey !== canonicalStepKey,
    ),
    reason: capability.reason,
  };
}
