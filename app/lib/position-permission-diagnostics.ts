export type PositionPermissionDiagnosticInput = {
  positionCode: string | null;
  expectedRoleCode: string | null;
  actualRoleCodes: Iterable<string>;
  legacyOverrideCount: number;
};

export type PositionPermissionDiagnostic = {
  status: "consistent" | "conflict";
  issues: string[];
  unexpectedRoleCodes: string[];
};

/**
 * Runtime authorization is position-owned. This diagnostic only reports stale
 * role bridges or retired account-level overrides; it never merges them into
 * the effective permission set.
 */
export function diagnosePositionPermission(
  input: PositionPermissionDiagnosticInput,
): PositionPermissionDiagnostic {
  const actualRoleCodes = [...new Set(input.actualRoleCodes)].filter(Boolean).sort();
  const issues: string[] = [];

  if (!input.positionCode || !input.expectedRoleCode) {
    issues.push("未绑定有效岗位");
  }

  if (input.expectedRoleCode && !actualRoleCodes.includes(input.expectedRoleCode)) {
    issues.push(`缺少岗位角色 ${input.expectedRoleCode}`);
  }

  const unexpectedRoleCodes = actualRoleCodes.filter(
    (code) => code !== input.expectedRoleCode,
  );
  if (unexpectedRoleCodes.length) {
    issues.push(`存在非岗位角色 ${unexpectedRoleCodes.join("、")}`);
  }

  if (input.legacyOverrideCount > 0) {
    issues.push(`存在 ${input.legacyOverrideCount} 条已停用的账号级权限覆盖`);
  }

  return {
    status: issues.length ? "conflict" : "consistent",
    issues,
    unexpectedRoleCodes,
  };
}
