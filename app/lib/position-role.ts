const positionRoleMap: Record<string, string> = {
  BOSS: "boss",
  DEVELOPER: "developer",
  SALES: "pos_sales",
  OPERATION: "pos_operation",
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

export function roleCodeForPosition(positionCode: string) {
  return positionRoleMap[positionCode] ?? positionCode.toLowerCase();
}

export const officialPositionRoleCodes = Object.values(positionRoleMap);
