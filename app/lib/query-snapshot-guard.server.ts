import { predicateGuard } from "./mutation-guard.server";

type Value = string | number | null;
/** Internal, server-authored SELECT only. Preserve the entire result set,
 * including membership, inside the transaction that consumes its decision. */
export function querySnapshotGuards(db: D1Database, sql: string, values: Value[], rows: readonly Record<string, unknown>[], now: string) {
  const source = `(${sql}) snapshot_row`;
  const statements = [predicateGuard(db, `(SELECT COUNT(*) FROM ${source})=?`, [...values, rows.length], now)];
  for (const row of rows) {
    const bindings: Value[] = [...values];
    // Let the optimizer use the primary/member index before evaluating the
    // case-exact snapshot. Otherwise every child can rescan a whole PZ.
    const identityKey=typeof row.id==='string'?"id":typeof row.order_id==='string'?"order_id":null;
    const identity=identityKey?`snapshot_row.${identityKey}=? AND `:"";
    if(identityKey)bindings.push(row[identityKey] as string);
    const predicate = Object.entries(row).map(([key, raw]) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw new Error("内部快照字段无效");
      const value = raw == null ? null : raw;
      if (typeof value !== "string" && typeof value !== "number" && value !== null) throw new Error("内部快照值无效");
      bindings.push(value, value);
      return `(snapshot_row.${key} IS NULL AND ? IS NULL OR ${typeof value === "number" || /(_at|_on)$/.test(key) ? `snapshot_row.${key}=?` : `HEX(snapshot_row.${key})=HEX(?)`})`;
    }).join(" AND ");
    statements.push(predicateGuard(db, `(SELECT COUNT(*) FROM ${source} WHERE ${identity}${predicate})=1`, bindings, now));
  }
  return statements;
}
