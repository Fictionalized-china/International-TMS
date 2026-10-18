/** Place immediately after a conditional mutation, in the SAME DB.batch. */
export function changedRowGuard(db: D1Database, now: string) {
  return db.prepare("INSERT INTO mutation_commit_guards(id,valid,created_at) SELECT ?,CASE WHEN changes()=1 THEN 1 ELSE NULL END,?")
    .bind(crypto.randomUUID(), now);
}

/** The predicate and its bindings are server-authored, never user-supplied SQL. */
export function predicateGuard(db: D1Database, predicate: string, values: (string | number | null)[], now: string) {
  return db.prepare(`INSERT INTO mutation_commit_guards(id,valid,created_at) SELECT ?,CASE WHEN ${predicate} THEN 1 ELSE NULL END,?`)
    .bind(crypto.randomUUID(), ...values, now);
}

export async function guardedBatch(db: D1Database, statements: D1PreparedStatement[], conflictMessage: string) {
  try { return await db.batch(statements); }
  catch (error) {
    if (String(error).includes("mutation_commit_guards")) throw new Error(conflictMessage);
    throw error;
  }
}
