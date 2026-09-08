import { describe, expect, it } from "vitest";
import { inspectAccessControlSchema } from "./access-control-schema.server";

function schemaDb(input: { overrideTable: boolean; workflowOverrideTable: boolean; roleColumns: string[] }) {
  return {
    prepare(sql: string) {
      if (sql.includes("sqlite_master")) {
        return {
          bind(tableName: string) {
            const present = tableName === "membership_permission_overrides"
              ? input.overrideTable
              : input.workflowOverrideTable;
            return { first: async () => present ? { name: tableName } : null };
          },
        };
      }
      return { all: async () => ({ results: input.roleColumns.map((name) => ({ name })) }) };
    },
  } as unknown as D1Database;
}

describe("access-control schema guard", () => {
  it("allows permission management only after both schema changes exist", async () => {
    await expect(inspectAccessControlSchema(schemaDb({ overrideTable: true, workflowOverrideTable: true, roleColumns: ["id", "status"] })))
      .resolves.toEqual({ ready: true, missing: [] });
  });

  it("reports every missing access-control schema item without throwing", async () => {
    await expect(inspectAccessControlSchema(schemaDb({ overrideTable: false, workflowOverrideTable: false, roleColumns: ["id"] })))
      .resolves.toEqual({ ready: false, missing: ["账户权限覆盖表", "工作流节点账号资格表", "角色状态字段"] });
  });
});
