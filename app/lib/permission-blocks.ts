export type PermissionOverride = {
  code: string;
  effect: "allow" | "deny";
};

export function isProtectedAccessRole(roleCodes: string[]) {
  return roleCodes.some((code) => code === "owner" || code === "boss");
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
