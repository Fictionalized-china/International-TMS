export type FrozenWorkflowModuleSelectionRow = {
  step_key: string;
  module_code: string | null;
  module_enabled: number | null;
};

/**
 * The workflow snapshot can retain disabled modules so administrators can see
 * the frozen layout. The order workbench must only embed modules enabled for
 * this particular order; otherwise a disabled module appearing first in the
 * configured sort order turns the whole detail route into a 404.
 */
export function enabledWorkflowModuleCodes(
  rows: readonly FrozenWorkflowModuleSelectionRow[],
  selectedStepKey: string,
) {
  return [...new Set(
    rows
      .filter((row) =>
        row.step_key === selectedStepKey &&
        row.module_code &&
        row.module_enabled === 1
      )
      .map((row) => row.module_code as string),
  )];
}

export function resolveEmbeddedWorkflowModuleCode(input: {
  requestedModuleCode: string | null;
  enabledModuleCodes: readonly string[];
}) {
  if (
    input.requestedModuleCode &&
    input.enabledModuleCodes.includes(input.requestedModuleCode)
  ) {
    return input.requestedModuleCode;
  }
  return input.enabledModuleCodes[0] ?? null;
}
