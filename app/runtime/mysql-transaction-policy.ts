type MysqlErrorLike = {
  code?: unknown;
  errno?: unknown;
  cause?: unknown;
};

export function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export function mysqlPoolQueueLimit(value: string | undefined): number {
  // A completed consolidation order fans out into workflow, document, cargo,
  // tracking and embedded-module reads.  The previous default of 24 could be
  // exhausted by one detail request and made unrelated portal reads fail.
  return readBoundedInteger(value, 256, 64, 2000);
}

export function isRetryableMysqlTransactionError(
  error: unknown,
  depth = 0,
): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  const candidate = error as MysqlErrorLike;
  if (
    candidate.code === "ER_LOCK_DEADLOCK" ||
    candidate.code === "ER_LOCK_WAIT_TIMEOUT" ||
    candidate.errno === 1213 ||
    candidate.errno === 1205
  ) {
    return true;
  }
  return isRetryableMysqlTransactionError(candidate.cause, depth + 1);
}

export function mysqlTransactionRetryDelayMs(attempt: number): number {
  return Math.min(250, 25 * 2 ** Math.max(0, attempt));
}
