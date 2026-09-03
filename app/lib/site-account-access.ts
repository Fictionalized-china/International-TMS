export const warehouseOnlyRoleCodes = [
  "warehouse_operator",
  "overseas_warehouse_operator",
] as const;

const warehouseOnlyRoles = new Set<string>(warehouseOnlyRoleCodes);

/**
 * The admin and warehouse sites deliberately use separate admission rules.
 * A warehouse-only membership must never be accepted by the management login.
 */
export function canUseAdminSite(roleCodes: readonly string[]) {
  return roleCodes.some((code) => !warehouseOnlyRoles.has(code));
}
