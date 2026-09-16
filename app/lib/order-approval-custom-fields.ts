export type ApprovalWorkflowField = {
  isActive: boolean;
  isBuiltIn: boolean;
};

export function visibleApprovalCustomFields<T extends ApprovalWorkflowField>(
  fields: readonly T[],
) {
  return fields.filter((field) => field.isActive && !field.isBuiltIn);
}
