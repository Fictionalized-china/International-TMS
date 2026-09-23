export const analyticsPermissions = {
  business: "analytics.business.view",
  receivable: "analytics.receivable.view",
  payable: "analytics.payable.view",
  profit: "analytics.profit.view",
  export: "data.export",
} as const;

export function analyticsVisibility(permissions: readonly string[]) {
  const granted = new Set(permissions);
  return {
    canView: granted.has(analyticsPermissions.business),
    canViewReceivable: granted.has(analyticsPermissions.receivable),
    canViewPayable: granted.has(analyticsPermissions.payable),
    canViewProfit: granted.has(analyticsPermissions.profit),
    canExport: granted.has(analyticsPermissions.export),
  };
}
