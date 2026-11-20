import type { OrderModuleCode } from "./order-modules";

/** Local to one read phase; never reused after a write or across requests. */
export async function loadWorkflowFieldGroups<T>(
  moduleCodes: readonly OrderModuleCode[],
  load: (moduleCode: OrderModuleCode) => Promise<T[]>,
): Promise<Map<OrderModuleCode, T[]>> {
  const codes = [...new Set(moduleCodes)];
  const groups = new Map<OrderModuleCode, T[]>();
  // Bound module fan-out for the six-connection production pool. Individual
  // modules may issue their own parallel reads; do not fan out every module.
  for (let index = 0; index < codes.length; index += 3) {
    const chunk = codes.slice(index, index + 3);
    const values = await Promise.all(chunk.map(load));
    chunk.forEach((code, offset) => groups.set(code, values[offset]));
  }
  return groups;
}

type GateField = { stepKey: string; isActive: boolean; isRequired: boolean; present: boolean };

export async function loadWorkflowPlacementBlockers(
  placements: readonly { id: string; step_key: string; module_code: string }[],
  load: (moduleCode: OrderModuleCode) => Promise<GateField[]>,
): Promise<Set<string>> {
  const groups = await loadWorkflowFieldGroups(
    placements.map(item => item.module_code as OrderModuleCode), load,
  );
  // A required field gates its workflow step, not only the module placement
  // that happens to share its module code.  This fails closed for a frozen
  // legacy configuration whose field was attached to the step but whose
  // matching module placement is missing.  Publication validation prevents
  // new configurations from entering that shape; existing orders still must
  // not silently advance past the required fact.
  const blockedStepKeys = new Set(
    [...groups.values()].flat().filter(
      field => field.isActive && field.isRequired && !field.present,
    ).map(field => field.stepKey),
  );
  return new Set(
    placements
      .filter(item => blockedStepKeys.has(item.step_key))
      .map(item => item.id),
  );
}
