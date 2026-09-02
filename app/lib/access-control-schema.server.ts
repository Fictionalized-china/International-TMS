export type AccessControlSchemaStatus = {
  ready: boolean;
  missing: string[];
};

export async function inspectAccessControlSchema(db: D1Database): Promise<AccessControlSchemaStatus> {
  const [overrideTable, roleColumns] = await Promise.all([
    db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).bind("membership_permission_overrides").first<{ name: string }>(),
    db.prepare("PRAGMA table_info(roles)").all<{ name: string }>(),
  ]);
  const missing: string[] = [];
  if (!overrideTable) missing.push("账户权限覆盖表");
  if (!roleColumns.results.some((column) => column.name === "status")) missing.push("角色状态字段");
  return { ready: missing.length === 0, missing };
}
