export type AccessControlSchemaStatus = {
  ready: boolean;
  missing: string[];
};

export async function inspectAccessControlSchema(db: D1Database): Promise<AccessControlSchemaStatus> {
  const [overrideTable, roleColumns, definitionFieldColumns, instanceFieldColumns] = await Promise.all([
    db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).bind("membership_permission_overrides").first<{ name: string }>(),
    db.prepare("PRAGMA table_info(roles)").all<{ name: string }>(),
    db.prepare("PRAGMA table_info(workflow_step_fields)").all<{ name: string }>(),
    db.prepare("PRAGMA table_info(workflow_instance_fields)").all<{ name: string }>(),
  ]);
  const missing: string[] = [];
  if (!overrideTable) missing.push("账号权限覆盖表");
  if (!roleColumns.results.some((column) => column.name === "status")) missing.push("角色状态字段");
  if (!definitionFieldColumns.results.some((column) => column.name === "handler_position_codes")) {
    missing.push("工作流字段填写岗位配置");
  }
  if (!instanceFieldColumns.results.some((column) => column.name === "handler_position_codes")) {
    missing.push("订单字段填写岗位快照");
  }
  return { ready: missing.length === 0, missing };
}
