import { chunkD1Rows, d1Placeholders } from "./d1-bindings";

export type WorkflowStateWrite = {
  id: string;
  status: "pending" | "active" | "completed";
};

// Preserve the caller's transaction and state calculations. These statements
// only combine independent projection writes; they never authorize a mutation.
export function workflowModuleStateStatements(
  db: D1Database, instanceId: string, updates: WorkflowStateWrite[], now: string,
) {
  return chunkD1Rows(updates, 3, 2).map(rows => db.prepare(
    `UPDATE workflow_instance_module_states
        SET status=CASE id ${rows.map(() => "WHEN ? THEN ?").join(" ")} ELSE status END,
            updated_at=?
      WHERE id IN (${d1Placeholders(rows.length)})
        AND instance_step_state_id IN (
          SELECT id FROM workflow_instance_step_states WHERE instance_id=?
        )`,
  ).bind(...rows.flatMap(row => [row.id, row.status]), now, ...rows.map(row => row.id), instanceId));
}

export function workflowStepStateStatements(
  db: D1Database, instanceId: string, updates: WorkflowStateWrite[], now: string,
) {
  // Per row: status CASE (2), WHERE id (1), and at most one membership in
  // each timestamp CASE (2). Reserve timestamps and the instance scope.
  return chunkD1Rows(updates, 5, 4).map(rows => {
    const active = rows.filter(row => row.status === "active").map(row => row.id);
    const completed = rows.filter(row => row.status === "completed").map(row => row.id);
    return db.prepare(
      `UPDATE workflow_instance_step_states
          SET status=CASE id ${rows.map(() => "WHEN ? THEN ?").join(" ")} ELSE status END,
              started_at=${active.length ? `CASE WHEN id IN (${d1Placeholders(active.length)}) THEN COALESCE(started_at,?) ELSE started_at END` : "started_at"},
              completed_at=${completed.length ? `CASE WHEN id IN (${d1Placeholders(completed.length)}) THEN COALESCE(completed_at,?) ELSE NULL END` : "NULL"},
              updated_at=?
        WHERE instance_id=? AND id IN (${d1Placeholders(rows.length)})`,
    ).bind(
      ...rows.flatMap(row => [row.id, row.status]),
      ...(active.length ? [...active, now] : []),
      ...(completed.length ? [...completed, now] : []),
      now, instanceId, ...rows.map(row => row.id),
    );
  });
}
