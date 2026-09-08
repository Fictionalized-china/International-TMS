export function canManageAccessConfiguration(user: {
  permissions: readonly string[];
  positionCode: string | null;
  roleCodes: readonly string[];
}) {
  return user.permissions.includes("role.manage") ||
    ["BOSS", "DEVELOPER", "HR_ADMIN"].includes(user.positionCode ?? "") ||
    user.roleCodes.some((code) =>
      ["owner", "boss", "developer", "pos_hr_admin"].includes(code),
    );
}
