import { describe, expect, it } from "vitest";
import { duplicateOrDatabaseError, isUniqueConstraintError } from "./db-errors.server";

describe("database error classification", () => {
  it.each([
    { code: "ER_DUP_ENTRY", errno: 1062, message: "Duplicate entry 'x'" },
    { code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: customers.code" },
    { code: "SQLITE_CONSTRAINT_PRIMARYKEY", message: "constraint failed" },
    { cause: { errno: 1062, message: "wrapped" } },
  ])("recognizes unique conflicts", (error) => {
    expect(isUniqueConstraintError(error)).toBe(true);
  });

  it.each([
    { code: "ER_NO_REFERENCED_ROW_2", errno: 1452 },
    { code: "SQLITE_CONSTRAINT_FOREIGNKEY", message: "FOREIGN KEY constraint failed" },
    new Error("connection lost"),
  ])("does not mislabel unrelated database failures", (error) => {
    expect(isUniqueConstraintError(error)).toBe(false);
  });

  it("returns an honest fallback for non-duplicate failures", () => {
    expect(duplicateOrDatabaseError(new Error("timeout"), "代码不能重复"))
      .toBe("数据库操作失败，请稍后重试");
  });
});
