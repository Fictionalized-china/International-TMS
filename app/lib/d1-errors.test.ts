import { describe, expect, it } from "vitest";
import { isMissingSqliteTableError, isSqliteSchemaMismatchError } from "./d1-errors";

describe("D1 schema errors", () => {
  it("recognizes only the requested missing table", () => {
    const error = new Error("D1_ERROR: no such table: membership_permission_overrides: SQLITE_ERROR");
    expect(isMissingSqliteTableError(error, "membership_permission_overrides")).toBe(true);
    expect(isMissingSqliteTableError(error, "other_table")).toBe(false);
  });

  it("does not hide unrelated database failures", () => {
    expect(isMissingSqliteTableError(new Error("SQLITE_BUSY"), "membership_permission_overrides")).toBe(false);
    expect(isMissingSqliteTableError(new Error("no such table: anything"), "bad table name")).toBe(false);
  });

  it("separates database version mismatches from ordinary failures", () => {
    expect(isSqliteSchemaMismatchError(new Error("no such column: roles.status"))).toBe(true);
    expect(isSqliteSchemaMismatchError(new Error("SQLITE_BUSY"))).toBe(false);
  });
});
