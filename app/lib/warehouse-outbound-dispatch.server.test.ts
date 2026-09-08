import { describe, expect, it } from "vitest";

import { completeWarehouseDispatchTransaction } from "./warehouse-outbound-dispatch.server";

function dbHarness(compareAndSwapChanges: number) {
  const queries: string[] = [];
  const batches: Array<Array<{ query: string; values: unknown[] }>> = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      const statement = {
        query,
        values: [] as unknown[],
        bind(...values: unknown[]) {
          statement.values = values;
          return statement;
        },
      };
      return statement;
    },
    async batch(statements: Array<{ query: string; values: unknown[] }>) {
      batches.push(statements);
      return statements.map((_, index) => ({
        meta: { changes: index === statements.length - 1 ? compareAndSwapChanges : 0 },
      }));
    },
  } as unknown as D1Database;
  return { db, queries, batches };
}

const input = {
  organizationId: "org-1",
  warehouseId: "warehouse-1",
  dispatchId: "dispatch-1",
  actorUserId: "user-1",
  occurredAt: "2026-09-06T00:00:00.000Z",
  description: "装车出库",
  transportBatchId: "batch-1",
};

describe("completeWarehouseDispatchTransaction", () => {
  it("uses one atomic loading-state CAS and scopes every physical side effect", async () => {
    const harness = dbHarness(1);
    const result = await completeWarehouseDispatchTransaction({ db: harness.db, ...input });

    expect(result).toEqual({ transitioned: true });
    expect(harness.batches).toHaveLength(1);
    const sql = harness.queries.join("\n");
    expect(sql).toContain("organization_id");
    expect(sql).toContain("warehouse_id");
    expect(sql.match(/status='loading'/g)?.length).toBeGreaterThanOrEqual(7);
    expect(harness.queries.at(-1)).toContain(
      "WHERE id=? AND organization_id=? AND status='loading'",
    );
    expect(sql).toContain("p.organization_id=di.organization_id");
    expect(sql).toContain("s.organization_id=p.organization_id");
    expect(sql).toContain("UPDATE warehouse_packing_jobs");
    expect(sql).toContain("job.status='dispatched'");
    expect(sql).toContain("warehouse_packing_job_sources");
    expect(sql).toContain("p.label_kind='oul'");
  });

  it("reports a concurrent retry as a stable no-op so callers cannot repeat post-commit effects", async () => {
    const harness = dbHarness(0);
    const result = await completeWarehouseDispatchTransaction({ db: harness.db, ...input });

    expect(result).toEqual({ transitioned: false });
    expect(harness.batches).toHaveLength(1);
  });
});
