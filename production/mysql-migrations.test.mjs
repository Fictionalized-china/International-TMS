import { describe, expect, it } from "vitest";
import {
  evaluateMysqlSchema,
  requiredMysqlSchemaChecksum,
  requiredMysqlSchemaColumns,
  requiredMysqlSchemaVersion,
} from "./mysql-migrations.mjs";

const columns = requiredMysqlSchemaColumns.map(([table_name, column_name]) => ({ table_name, column_name }));

describe("MySQL runtime schema readiness", () => {
  it("accepts the tracked migration with all required columns", () => {
    expect(evaluateMysqlSchema({
      appliedMigrations: [{ version: requiredMysqlSchemaVersion, checksum: requiredMysqlSchemaChecksum }],
      columns,
    })).toMatchObject({ ready: true, migrationState: "ready", version: requiredMysqlSchemaVersion });
  });

  it("rejects an untracked schema even when columns happen to exist", () => {
    expect(evaluateMysqlSchema({ appliedMigrations: [], columns })).toMatchObject({
      ready: false,
      migrationState: "missing",
      requiredVersion: requiredMysqlSchemaVersion,
    });
  });

  it("reports missing required columns", () => {
    const result = evaluateMysqlSchema({
      appliedMigrations: [{ version: requiredMysqlSchemaVersion, checksum: "wrong" }],
      columns: columns.slice(0, 1),
    });
    expect(result.ready).toBe(false);
    expect(result.missingColumns).toEqual(
      requiredMysqlSchemaColumns.slice(1).map(([tableName, columnName]) => `${tableName}.${columnName}`),
    );
    expect(result.migrationState).toBe("checksum_mismatch");
  });
});
