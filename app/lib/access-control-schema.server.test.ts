import { describe, expect, it } from "vitest";
import { inspectAccessControlSchema } from "./access-control-schema.server";

function schemaDb(input: {
  overrideTable: boolean;
  roleColumns: string[];
  definitionFieldColumns: string[];
  instanceFieldColumns: string[];
}) {
  return {
    prepare(sql: string) {
      if (sql.includes("sqlite_master")) {
        return {
          bind(tableName: string) {
            const present = tableName === "membership_permission_overrides" && input.overrideTable;
            return { first: async () => present ? { name: tableName } : null };
          },
        };
      }
      const columns = sql.includes("workflow_step_fields")
        ? input.definitionFieldColumns
        : sql.includes("workflow_instance_fields")
          ? input.instanceFieldColumns
          : input.roleColumns;
      return { all: async () => ({ results: columns.map((name) => ({ name })) }) };
    },
  } as unknown as D1Database;
}

describe("access-control schema guard", () => {
  it("allows permission management only after the security and field-position schema exists", async () => {
    await expect(inspectAccessControlSchema(schemaDb({
      overrideTable: true,
      roleColumns: ["id", "status"],
      definitionFieldColumns: ["id", "handler_position_codes"],
      instanceFieldColumns: ["id", "handler_position_codes"],
    })))
      .resolves.toEqual({ ready: true, missing: [] });
  });

  it("reports every missing access-control schema item without throwing", async () => {
    await expect(inspectAccessControlSchema(schemaDb({
      overrideTable: false,
      roleColumns: ["id"],
      definitionFieldColumns: ["id"],
      instanceFieldColumns: ["id"],
    })))
      .resolves.toEqual({
        ready: false,
        missing: ["账号权限覆盖表", "角色状态字段", "工作流字段填写岗位配置", "订单字段填写岗位快照"],
      });
  });
});
