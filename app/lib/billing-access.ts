export const settlementWorkbenchPermissions = [
  "billing.view",
  "billing.sensitive.view",
] as const;

export function canAccessSettlementWorkbench(permissions: readonly string[]) {
  return settlementWorkbenchPermissions.every((permission) =>
    permissions.includes(permission),
  );
}

export function canViewAssignedOrderExpenseSummary(input: {
  permissions: readonly string[];
  currentUserId: string;
  salespersonUserId: string | null | undefined;
}) {
  if (input.permissions.includes("billing.sensitive.view")) return true;
  return input.permissions.includes("billing.assigned_expense.review") &&
    Boolean(input.salespersonUserId) &&
    input.currentUserId === input.salespersonUserId;
}

export function canViewFullOrderExpenseDetails(permissions: readonly string[]) {
  return permissions.includes("billing.sensitive.view");
}
