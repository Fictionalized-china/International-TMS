export type OrderDocumentAccessUser = {
  userId?: string | null;
  positionCode?: string | null;
  roleCodes?: readonly string[];
};

export type SettlementDocumentOwners = {
  customerServiceAssigneeUserId?: string | null;
  financeAssigneeUserId?: string | null;
};

const settlementDocumentOpenSteps = new Set([
  "reconciliation",
  "completion_review",
]);

export function isSettlementDocumentStageOpen(
  currentStepKey: string | null | undefined,
  orderStatus: string,
) {
  return (
    settlementDocumentOpenSteps.has(currentStepKey ?? "") &&
    !["completed", "cancelled"].includes(orderStatus)
  );
}

export function hasOrderDocumentSystemOverride(user: OrderDocumentAccessUser) {
  return (
    ["BOSS", "DEVELOPER"].includes(user.positionCode ?? "") ||
    (user.roleCodes ?? []).some((code) =>
      ["boss", "developer", "owner"].includes(code),
    )
  );
}

export function canUploadOrderModuleDocument(
  user: OrderDocumentAccessUser,
  moduleCode: string,
  canManageModule: boolean,
  owners?: SettlementDocumentOwners | null,
) {
  if (moduleCode !== "costs") return canManageModule;
  if (hasOrderDocumentSystemOverride(user)) return true;
  if (!user.userId || !owners) return false;
  return (
    (user.positionCode === "CS" &&
      user.userId === owners.customerServiceAssigneeUserId) ||
    (user.positionCode === "FINANCE_ACCOUNTING" &&
      user.userId === owners.financeAssigneeUserId)
  );
}

export function canReviewOrderModuleDocument(
  user: OrderDocumentAccessUser,
  moduleCode: string,
  canManageModule: boolean,
  owners?: SettlementDocumentOwners | null,
) {
  if (moduleCode !== "costs") return canManageModule;
  if (hasOrderDocumentSystemOverride(user)) return true;
  return Boolean(
    user.userId &&
      owners &&
      user.positionCode === "FINANCE_ACCOUNTING" &&
      user.userId === owners.financeAssigneeUserId,
  );
}
