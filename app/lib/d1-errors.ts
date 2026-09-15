export function isMissingSqliteTableError(error: unknown, tableName: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) return false;
  return String(error).toLowerCase().includes(`no such table: ${tableName.toLowerCase()}`);
}

export function isSqliteSchemaMismatchError(error: unknown) {
  return /(?:no such table|no such column):\s*[A-Za-z0-9_.]+/i.test(String(error));
}
