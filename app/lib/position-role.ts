const positionRoleMap: Record<string, string> = {
  BOSS: "boss",
  DEVELOPER: "developer",
  SALES: "pos_sales",
  BUSINESS_SUPERVISOR: "pos_business_supervisor",
  OPERATION_SUPERVISOR: "pos_operation_supervisor",
  OPERATION: "pos_operation",
  DOC: "pos_doc",
  TRACKING: "pos_tracking",
  CS: "pos_customer_service",
  BUSINESS_ROUTE: "pos_business_route",
  LOADING: "pos_front_loading",
  FINANCE_ACCOUNTING: "pos_finance",
  CASHIER: "pos_cashier",
  HR_ADMIN: "pos_hr_admin",
  WAREHOUSE: "warehouse_operator",
  OVERSEAS_WAREHOUSE: "overseas_warehouse_operator",
};

export const protectedAccessPositionCodes = ["BOSS", "DEVELOPER"] as const;

const protectedAccessPositions = new Set<string>(protectedAccessPositionCodes);

export function roleCodeForPosition(positionCode: string) {
  return positionRoleMap[positionCode] ?? positionCode.toLowerCase();
}

export function isProtectedAccessPosition(positionCode: string | null | undefined) {
  return Boolean(positionCode && protectedAccessPositions.has(positionCode));
}

/**
 * Keep the legacy position-to-role storage bridge in one place while runtime
 * authorization is position-owned. `positionCodeSql` must be a trusted column
 * reference supplied by application code, never user input.
 */
export function positionRoleCodeSql(positionCodeSql: string) {
  const branches = Object.entries(positionRoleMap)
    .map(([positionCode, roleCode]) =>
      `WHEN '${positionCode}' THEN '${roleCode}'`,
    )
    .join(" ");
  return `(CASE ${positionCodeSql} ${branches} ELSE lower(${positionCodeSql}) END)`;
}

export const officialPositionRoleCodes = Object.values(positionRoleMap);
