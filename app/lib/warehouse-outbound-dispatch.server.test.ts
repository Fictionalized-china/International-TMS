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
    expect(sql).toContain("SET status='loading'");
    expect(sql).toContain("SET status='dispatched'");
    expect(sql).toContain("UPDATE transport_batch_packages");
    expect(sql).toContain("WHERE organization_id=? AND batch_id=?");
    expect(sql).toContain("package_id IN");
    expect(sql).toContain("p.label_kind='oul'");
    const sourceMarkUpdate = harness.queries.find(
      (query) => query.includes("UPDATE warehouse_packages") && query.includes("source_order_package_id IN"),
    );
    expect(sourceMarkUpdate).toContain("JOIN transport_batch_packages pending_batch_package");
    expect(sourceMarkUpdate).toContain("pending_batch_package.status NOT IN ('departed','arrived')");
    expect(sourceMarkUpdate).not.toMatch(/(?:FROM|JOIN)\s+warehouse_packages\b/i);
  });

  it("reports a concurrent retry as a stable no-op so callers cannot repeat post-commit effects", async () => {
    const harness = dbHarness(0);
    const result = await completeWarehouseDispatchTransaction({ db: harness.db, ...input });

    expect(result).toEqual({ transitioned: false });
    expect(harness.batches).toHaveLength(1);
  });
});
