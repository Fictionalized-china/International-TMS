import { describe, expect, it } from "vitest";
import {
  loadLoadingConsolidationWorkflowAccess,
  loadingConsolidationWorkflowAccessSql,
} from "./loading-consolidation-stage-gate.server";

function databaseFor(binding: unknown) {
  const sql: string[] = [];
  const DB = {
    prepare(statementSql: string) {
      sql.push(statementSql);
      return {
        bind() {
          return {
            async first() {
              return binding;
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { DB, sql };
}

describe("loading consolidation workflow access loader", () => {
  it("allows only a real SQL NULL workflow binding through legacy compatibility", async () => {
    const database = databaseFor({
      order_status: "in_execution",
      bound_instance_id: null,
      matched_instance_id: null,
      matched_instance_status: null,
    });

    await expect(loadLoadingConsolidationWorkflowAccess(
      database.DB,
      "org-1",
      "legacy-order",
    )).resolves.toEqual({
      orderId: "legacy-order",
      configured: false,
      available: true,
      targetStepKey: null,
      targetStepName: null,
      reason: null,
      legacyFallback: true,
    });
    expect(database.sql).toHaveLength(1);
  });

  it.each([
    ["empty pointer", "", null],
    ["cross-order pointer", "instance-other-order", null],
    ["inactive instance", "instance-1", "completed"],
  ])("fails closed for a non-null %s", async (
    _label,
    boundInstanceId,
    matchedInstanceStatus,
  ) => {
    const database = databaseFor({
      order_status: "in_execution",
      bound_instance_id: boundInstanceId,
      matched_instance_id: matchedInstanceStatus ? "instance-1" : null,
      matched_instance_status: matchedInstanceStatus,
    });

    const result = await loadLoadingConsolidationWorkflowAccess(
      database.DB,
      "org-1",
      "order-1",
    );

    expect(result.available).toBe(false);
    expect(result.legacyFallback).toBe(false);
    expect(result.reason).toContain("冻结工作流实例无效");
    expect(database.sql).toHaveLength(1);
    expect(database.sql[0]).toContain("wi.organization_id=o.organization_id");
    expect(database.sql[0]).toContain("wi.order_id=o.id");
  });

  it.each(["completed", "cancelled"])(
    "keeps a terminal %s order read-only even without a workflow binding",
    async (orderStatus) => {
      const database = databaseFor({
        order_status: orderStatus,
        bound_instance_id: null,
        matched_instance_id: null,
        matched_instance_status: null,
      });

      const result = await loadLoadingConsolidationWorkflowAccess(
        database.DB,
        "org-1",
        "terminal-order",
      );

      expect(result.available).toBe(false);
      expect(result.legacyFallback).toBe(false);
      expect(result.reason).toContain(orderStatus === "cancelled" ? "已取消" : "已完成");
      expect(database.sql).toHaveLength(1);
    },
  );

  it("exposes the same fail-closed predicate for candidate list filters", () => {
    const sql = loadingConsolidationWorkflowAccessSql("o");

    expect(sql).toContain("o.status NOT IN ('completed','cancelled')");
    expect(sql).toContain("o.workflow_instance_id IS NULL");
    expect(sql).toContain("gate_instance.id=o.workflow_instance_id");
    expect(sql).toContain("gate_instance.organization_id=o.organization_id");
    expect(sql).toContain("gate_instance.order_id=o.id");
    expect(sql).toContain("gate_instance.status='active'");
    expect(sql).toContain("gate_module.module_code='loading'");
    expect(sql).toContain("gate_module.status NOT IN ('completed','not_applicable')");
  });
});
