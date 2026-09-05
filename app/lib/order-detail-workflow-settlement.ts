export type ExpenseWarningMode = "hidden" | "pre_entry" | "settlement";

export type FrozenWorkflowModuleRow = {
  step_key: string;
  step_sort_order: number;
  module_code: string | null;
  module_required: number | null;
  required_field_count: number;
  optional_field_count: number;
};

export type FrozenWorkflowModuleStage = {
  configured: boolean;
  gateConfigured: boolean;
  currentStepHasModule: boolean;
  reached: boolean;
  targetStepKey: string | null;
  targetStepSortOrder: number | null;
};

/**
 * Resolve a module's placement only from the order's frozen workflow rows.
 * Missing current-step rows fail closed instead of falling back to canonical
 * step names, because a renamed or moved node must immediately drive the UI.
 */
export function frozenWorkflowModuleStage(
  rows: readonly FrozenWorkflowModuleRow[],
  currentStepKey: string | null,
  moduleCode: string,
): FrozenWorkflowModuleStage {
  const placements = rows
    .filter((row) => row.module_code === moduleCode)
    .sort((left, right) => left.step_sort_order - right.step_sort_order);
  const target = placements[0] ?? null;
  const currentPlacement = currentStepKey
    ? placements.find((row) => row.step_key === currentStepKey) ?? null
    : null;
  const currentRows = currentStepKey
    ? rows.filter((row) => row.step_key === currentStepKey)
    : [];
  const currentSortOrder = currentRows.length
    ? Math.min(...currentRows.map((row) => row.step_sort_order))
    : null;

  return {
    configured: Boolean(target),
    gateConfigured: Boolean(
      currentPlacement &&
      (currentPlacement.module_required === 1 || currentPlacement.required_field_count > 0),
    ),
    currentStepHasModule: Boolean(
      currentStepKey && placements.some((row) => row.step_key === currentStepKey),
    ),
    reached: Boolean(
      target && currentSortOrder !== null && currentSortOrder >= target.step_sort_order,
    ),
    targetStepKey: target?.step_key ?? null,
    targetStepSortOrder: target?.step_sort_order ?? null,
  };
}

export function frozenExpenseWarningMode(
  rows: readonly FrozenWorkflowModuleRow[],
  currentStepKey: string | null,
): ExpenseWarningMode {
  if (!currentStepKey) return "hidden";
  const current = rows.find((row) => row.step_key === currentStepKey);
  if (!current) return "hidden";
  const placements = rows
    .filter((row) => row.module_code === "costs")
    .sort((left, right) => left.step_sort_order - right.step_sort_order);
  const settlementGate = placements.find(
    (row) => row.module_required === 1 || row.required_field_count > 0,
  );
  if (
    settlementGate &&
    current.step_sort_order >= settlementGate.step_sort_order
  ) {
    return "settlement";
  }
  const optionalEntry = placements.find(
    (row) => row.module_required !== 1 &&
      row.required_field_count === 0 &&
      row.optional_field_count > 0,
  );
  if (
    optionalEntry &&
    current.step_sort_order >= optionalEntry.step_sort_order
  ) {
    return "pre_entry";
  }
  return "hidden";
}
