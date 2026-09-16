type DatabaseErrorLike = {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
  cause?: unknown;
};

function asDatabaseError(error: unknown): DatabaseErrorLike | null {
  return typeof error === "object" && error !== null
    ? (error as DatabaseErrorLike)
    : null;
}

export function isUniqueConstraintError(error: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  const candidate = asDatabaseError(error);
  if (!candidate) return false;

  const code = String(candidate.code ?? "").toUpperCase();
  const errno = Number(candidate.errno);
  const message = String(candidate.message ?? "");
  if (
    code === "ER_DUP_ENTRY" ||
    errno === 1062 ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    /UNIQUE constraint failed|duplicate entry/i.test(message)
  ) {
    return true;
  }

  return candidate.cause !== undefined
    ? isUniqueConstraintError(candidate.cause, depth + 1)
    : false;
}

export function duplicateOrDatabaseError(
  error: unknown,
  duplicateMessage: string,
  fallbackMessage = "数据库操作失败，请稍后重试",
): string {
  return isUniqueConstraintError(error) ? duplicateMessage : fallbackMessage;
}
