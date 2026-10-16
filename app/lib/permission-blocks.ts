export type PermissionOverride = {
  code: string;
  effect: "allow" | "deny";
};

export function isProtectedAccessRole(roleCodes: readonly string[] | null | undefined) {
  return (roleCodes ?? []).some((code) => code === "owner" || code === "boss");
}

/**
 * The boss account is the system-level demonstration and emergency operator.
 * It may stand in for a configured position or assignee, while business data
 * gates (required fields, status, sequence and amount checks) remain active.
 */
export function isBossBusinessActor(actor: {
  positionCode?: string | null;
  roleCodes?: readonly string[] | null;
}) {
  return actor.positionCode === "BOSS" || isProtectedAccessRole(actor.roleCodes);
}
export function effectivePermissionCodes(input: {
  inherited: Iterable<string>;
  overrides: Iterable<PermissionOverride>;
  allPermissions?: Iterable<string>;
  protectedRole?: boolean;
}) {
  if (input.protectedRole) {
    return [...new Set(input.allPermissions ?? input.inherited)].sort();
  }

  const effective = new Set(input.inherited);
  const denied = new Set<string>();
  for (const override of input.overrides) {
    if (override.effect === "deny") denied.add(override.code);
    else effective.add(override.code);
  }
  for (const code of denied) effective.delete(code);
  return [...effective].sort();
}
