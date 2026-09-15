/**
 * Cloudflare D1 accepts at most 100 bound parameters in one SQL statement.
 * Keep a reserve for organization ids, status filters and other fixed binds so
 * callers can safely add an `IN (...)` list without repeating platform limits.
 */
export const D1_MAX_BOUND_PARAMETERS = 100;
export const D1_DEFAULT_DYNAMIC_BINDINGS = 80;

export function chunkD1Values<T>(
  values: readonly T[],
  fixedParameterCount = 0,
): T[][] {
  if (!Number.isInteger(fixedParameterCount) || fixedParameterCount < 0) {
    throw new Error("D1 fixed parameter count must be a non-negative integer");
  }
  const available = D1_MAX_BOUND_PARAMETERS - fixedParameterCount;
  if (available < 1) {
    throw new Error("D1 query has no binding capacity for dynamic values");
  }
  const size = Math.min(D1_DEFAULT_DYNAMIC_BINDINGS, available);
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function d1Placeholders(valueCount: number) {
  if (!Number.isInteger(valueCount) || valueCount < 1) {
    throw new Error("D1 IN condition requires at least one binding");
  }
  if (valueCount > D1_MAX_BOUND_PARAMETERS) {
    throw new Error(
      `D1 statement cannot bind more than ${D1_MAX_BOUND_PARAMETERS} parameters`,
    );
  }
  return Array.from({ length: valueCount }, () => "?").join(",");
}

export function chunkD1Rows<T>(
  rows: readonly T[],
  bindingsPerRow: number,
  fixedParameterCount = 0,
): T[][] {
  if (!Number.isInteger(bindingsPerRow) || bindingsPerRow < 1) {
    throw new Error("D1 bindings per row must be a positive integer");
  }
  if (!Number.isInteger(fixedParameterCount) || fixedParameterCount < 0) {
    throw new Error("D1 fixed parameter count must be a non-negative integer");
  }
  const available = D1_MAX_BOUND_PARAMETERS - fixedParameterCount;
  const rowsPerStatement = Math.floor(available / bindingsPerRow);
  if (rowsPerStatement < 1) {
    throw new Error("D1 statement cannot fit one row of bound parameters");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += rowsPerStatement) {
    chunks.push(rows.slice(index, index + rowsPerStatement));
  }
  return chunks;
}
