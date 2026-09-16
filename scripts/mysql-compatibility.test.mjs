import { describe, expect, it } from "vitest";
import {
  findSelfReferencingMutations,
  findUnaliasedDerivedTables,
  findUnsupportedLimitInSubqueries,
  findValuesTableCtes,
} from "./mysql-compatibility.mjs";

describe("MySQL source compatibility checks", () => {
  it("detects LIMIT directly inside an IN subquery", () => {
    const failures = findUnsupportedLimitInSubqueries(
      "SELECT * FROM contacts WHERE customer_id IN (SELECT id FROM customers ORDER BY created_at DESC LIMIT 200)",
    );
    expect(failures).toEqual([{ index: 41, line: 1 }]);
  });

  it("accepts a limited derived table join", () => {
    expect(findUnsupportedLimitInSubqueries(
      "SELECT * FROM contacts JOIN (SELECT id FROM customers ORDER BY created_at DESC LIMIT 200) recent ON recent.id=contacts.customer_id",
    )).toEqual([]);
  });

  it("does not mistake a nested scalar subquery LIMIT for the unsupported form", () => {
    expect(findUnsupportedLimitInSubqueries(
      "SELECT * FROM contacts WHERE id IN (SELECT customer_id FROM links WHERE value=(SELECT value FROM settings LIMIT 1))",
    )).toEqual([]);
  });

  it("detects a derived table without a MySQL alias", () => {
    expect(findUnaliasedDerivedTables("SELECT COUNT(*) FROM (SELECT id FROM orders) WHERE id IS NOT NULL"))
      .toEqual([{ index: 16, line: 1 }]);
  });

  it("accepts plain and AS-prefixed derived table aliases", () => {
    expect(findUnaliasedDerivedTables(
      "SELECT * FROM (SELECT id FROM orders) recent JOIN (SELECT id FROM customers) AS clients ON clients.id=recent.id",
    )).toEqual([]);
  });

  it("detects a VALUES table used directly as a CTE body", () => {
    expect(findValuesTableCtes(
      "WITH module_codes(module_code) AS (VALUES ('loading'),('tracking')) SELECT * FROM module_codes",
    )).toEqual([{ index: 5, line: 1 }]);
  });

  it("accepts a portable SELECT UNION ALL CTE", () => {
    expect(findValuesTableCtes(
      "WITH module_codes AS (SELECT 'loading' module_code UNION ALL SELECT 'tracking') SELECT * FROM module_codes",
    )).toEqual([]);
  });

  it("flags an UPDATE whose subquery re-reads the target table", () => {
    const source = [
      "const statement = env.DB.prepare(",
      "  `UPDATE shipments SET status=? WHERE organization_id=? AND id=(",
      "     SELECT latest.id FROM shipments latest WHERE latest.order_id=? LIMIT 1)`,",
      ").bind(values);",
    ].join("\n");
    expect(findSelfReferencingMutations(source)).toEqual([{ index: 36, line: 2 }]);
  });

  it("flags a DELETE whose sub-SELECT joins the target table", () => {
    const source = "await run(`DELETE FROM warehouse_dispatch_items WHERE package_id IN (SELECT p.id FROM warehouse_packages p JOIN warehouse_dispatch_items di ON di.package_id=p.id)`);";
    expect(findSelfReferencingMutations(source)).toHaveLength(1);
  });

  it("accepts correlated references that stay out of subquery FROM clauses", () => {
    const source = "`UPDATE transport_batch_orders SET status='removed' WHERE EXISTS (SELECT 1 FROM transport_batches b WHERE b.id=transport_batch_orders.batch_id)`";
    expect(findSelfReferencingMutations(source)).toEqual([]);
  });

  it("ignores SQL string literals that merely mention the table name", () => {
    const source = "`UPDATE shipments SET current_location='FROM shipments dock' WHERE id=?`";
    expect(findSelfReferencingMutations(source)).toEqual([]);
  });

  it("ignores prose in comments that resembles the forbidden pattern", () => {
    const source = [
      "// TODO: avoid UPDATE shipments ... FROM shipments (fixed already)",
      "const value = 1;",
    ].join("\n");
    expect(findSelfReferencingMutations(source)).toEqual([]);
  });

  it("still detects a self reference after interpolations with nested backticks", () => {
    const source = "const sql = `UPDATE shipments SET notes=${`'x'`} WHERE id IN (SELECT id FROM shipments)`;";
    expect(findSelfReferencingMutations(source)).toHaveLength(1);
  });
});
