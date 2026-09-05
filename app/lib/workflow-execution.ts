export type WorkflowExecutionStepSelection = {
  step_key: string;
  sort_order: number;
  existing_status: string;
  module_count: number;
  pending_required: number;
};

export type WorkflowExecutionModuleCompletion = {
  existingStepStatus: string;
  stepSortOrder: number;
  targetSortOrder: number;
  sourceModuleStatus: string;
  completionMode: string;
  taskCount: number;
  pendingRequired: number;
  hasMissingRequiredFields: boolean;
};

export function workflowExecutionModuleIsComplete(
  input: WorkflowExecutionModuleCompletion,
) {
  if (input.existingStepStatus === "completed") return true;

  const taskComplete = input.completionMode === "automatic"
    ? input.taskCount === 0 || input.pendingRequired === 0
    : input.taskCount > 0 && input.pendingRequired === 0;
  if (taskComplete && !input.hasMissingRequiredFields) return true;

  // Once a later business node has real module state, a completed historical
  // module must not pull the order backwards because of legacy/incomplete field
  // snapshots. Current-node fields still remain hard gates.
  return input.stepSortOrder < input.targetSortOrder && input.sourceModuleStatus === "completed";
}

export function selectWorkflowExecutionCurrentStep<
  T extends WorkflowExecutionStepSelection,
>(
  steps: T[],
  targetStepKey: string,
  targetSortOrder: number,
): T | null {
  const reachable = steps.filter((item) => item.sort_order <= targetSortOrder);
  const blockingStep = reachable.find(
    (item) =>
      item.existing_status !== "completed" &&
      (item.module_count === 0 || item.pending_required > 0),
  );
  if (blockingStep) return blockingStep;

  // Optional-only target nodes still need to become active. Falling back to a
  // stale active snapshot here left completed reconciliation orders stranded.
  return (
    reachable.find((item) => item.step_key === targetStepKey) ??
    reachable[reachable.length - 1] ??
    steps.find((item) => item.existing_status === "active") ??
    steps[0] ??
    null
  );
}
