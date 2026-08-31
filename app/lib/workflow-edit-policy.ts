export type EditableWorkflowFieldMode = "required" | "optional" | "hidden";

const structureMutationIntents = new Set([
  "definition",
  "create",
  "delete",
  "step",
  "field_update",
  "field_delete",
  "module_add",
  "module_update",
  "module_delete",
  "task_create",
  "task_update",
  "task_delete",
]);

export function workflowEditCapabilities(instanceCount: number) {
  const usedByOrders = Number.isFinite(instanceCount) && instanceCount > 0;
  return {
    usedByOrders,
    structureEditable: !usedByOrders,
    fieldPolicyEditable: true,
  } as const;
}

export function workflowIntentAllowedForUsage(intent: string, instanceCount: number) {
  return !workflowEditCapabilities(instanceCount).usedByOrders || !structureMutationIntents.has(intent);
}

export function workflowFieldPlacementLock(input:{
  instanceCount:number;
  currentStepId:string|null;
  targetStepId:string;
  currentSortOrder:number|null;
  targetSortOrder:number;
}) {
  if (!workflowEditCapabilities(input.instanceCount).usedByOrders || !input.currentStepId) return null;
  if (input.currentStepId !== input.targetStepId) return "position" as const;
  if (input.currentSortOrder !== input.targetSortOrder) return "sort" as const;
  return null;
}

export function editableWorkflowFieldMode(value: string): EditableWorkflowFieldMode | null {
  return value === "required" || value === "optional" || value === "hidden" ? value : null;
}

export function editableWorkflowFieldFlags(mode: EditableWorkflowFieldMode) {
  return {
    isRequired: mode === "required" ? 1 : 0,
    isActive: mode === "hidden" ? 0 : 1,
    preservesStoredValue: mode === "hidden",
  } as const;
}

export function normalizeWorkflowStepRequiredFlag(value: unknown) {
  return value === 0 ? 0 : 1;
}

export function parseWorkflowSortOrder(value: string, max = 999) {
  const digits = String(Math.max(1, max)).length;
  if (!new RegExp(`^\\d{1,${digits}}$`).test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

export function workflowInsertionSortOrder(previous: number | null, next: number | null) {
  if (previous === null && next === null) return 10;
  if (previous === null) return next !== null && next > 1 ? Math.max(1, next - 10) : null;
  if (next === null) return previous <= 989 ? previous + 10 : null;
  if (next - previous <= 1) return null;
  return Math.floor((previous + next) / 2);
}

export function normalizedWorkflowSortOrders(count: number) {
  return Array.from({ length: Math.max(0, count) }, (_, index) => (index + 1) * 10);
}
