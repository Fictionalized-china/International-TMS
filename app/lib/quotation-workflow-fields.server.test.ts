import { beforeEach, describe, expect, it, vi } from "vitest";

type RecordedStatement = {
  sql: string;
  bindings: unknown[];
  bind: (...bindings: unknown[]) => RecordedStatement;
  all: <T>() => Promise<{ results: T[] }>;
};

const database = vi.hoisted(() => {
  const prepared: RecordedStatement[] = [];
  const maxBoundParameters = 100;

  return {
    prepared,
    maxBoundParameters,
    DB: {
      prepare(sql: string) {
        const statement: RecordedStatement = {
          sql,
          bindings: [],
          bind(...bindings: unknown[]) {
            statement.bindings = bindings;
            if (bindings.length > maxBoundParameters) {
              throw new Error(
                "D1_ERROR: too many SQL variables at offset 377: SQLITE_ERROR",
              );
            }
            return statement;
          },
          async all<T>() {
            const quotationIds = statement.bindings.slice(1).map(String);
            if (sql.includes("FROM workflow_instances wi")) {
              return {
                results: quotationIds.map((quotationId) => ({
                  quotation_id: quotationId,
                  id: `definition-field-${quotationId}`,
                  workflow_id: "workflow-1",
                  module_code: "consignment",
                  field_key: `field-${quotationId}`,
                  label: `字段 ${quotationId}`,
                  field_type: "text",
                  is_required: 0,
                  is_active: 1,
                  sort_order: 10,
                  options_text: null,
                  help_text: null,
                })) as T[],
              };
            }

            if (sql.includes("FROM quotation_workflow_field_values")) {
              return {
                results: quotationIds.map((quotationId) => ({
                  id: `value-${quotationId}`,
                  quotation_id: quotationId,
                  field_id: `definition-field-${quotationId}`,
                  field_key: `field-${quotationId}`,
                  value_text: `value for ${quotationId}`,
                  file_name: null,
                  content_type: null,
                  size_bytes: null,
                })) as T[],
              };
            }

            return { results: [] as T[] };
          },
        };
        prepared.push(statement);
        return statement;
      },
    },
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: database.DB } }));

import {
  listQuotationWorkflowFieldValues,
  listQuotationWorkflowInstanceFields,
} from "./quotation-workflow-fields.server";

const organizationId = "org-1";

function quotationIds(count = 205) {
  return Array.from(
    { length: count },
    (_, index) => `quote-${String(index).padStart(3, "0")}`,
  );
}

function expectSafeCompleteQueries(expectedIds: string[], expectedMinimumQueries = 2) {
  expect(database.prepared.length).toBeGreaterThanOrEqual(expectedMinimumQueries);
  for (const statement of database.prepared) {
    expect(statement.bindings.length).toBeLessThanOrEqual(
      database.maxBoundParameters,
    );
    expect(statement.sql.match(/\?/g) ?? []).toHaveLength(statement.bindings.length);
    expect(statement.bindings[0]).toBe(organizationId);
  }

  const queriedIds = database.prepared.flatMap((statement) =>
    statement.bindings.slice(1).map(String),
  );
  expect(queriedIds).toEqual(expectedIds);
  expect(new Set(queriedIds).size).toBe(expectedIds.length);
}

describe("quotation workflow field D1 binding safety", () => {
  beforeEach(() => {
    database.prepared.length = 0;
  });

  it("loads instance fields for 205 quotations without exceeding the D1 bind limit", async () => {
    const ids = quotationIds();

    const fields = await listQuotationWorkflowInstanceFields(
      organizationId,
      ids,
    );

    expect(fields.map((field) => field.quotation_id)).toEqual(ids);
    expect(new Set(fields.map((field) => field.quotation_id)).size).toBe(
      ids.length,
    );
    expectSafeCompleteQueries(ids);
  });

  it("loads field values for 205 quotations without exceeding the D1 bind limit", async () => {
    const ids = quotationIds();

    const values = await listQuotationWorkflowFieldValues(organizationId, ids);

    expect(values.map((value) => value.quotation_id)).toEqual(ids);
    expect(new Set(values.map((value) => value.quotation_id)).size).toBe(
      ids.length,
    );
    expectSafeCompleteQueries(ids);
  });

  it("does not prepare a query for empty quotation id lists", async () => {
    await expect(
      listQuotationWorkflowInstanceFields(organizationId, []),
    ).resolves.toEqual([]);
    await expect(
      listQuotationWorkflowFieldValues(organizationId, []),
    ).resolves.toEqual([]);

    expect(database.prepared).toHaveLength(0);
  });

  it("deduplicates quotation ids before querying and returns one result per id", async () => {
    const ids = ["quote-001", "quote-001", "quote-002"];

    const fields = await listQuotationWorkflowInstanceFields(organizationId, ids);

    expect(fields.map((field) => field.quotation_id)).toEqual([
      "quote-001",
      "quote-002",
    ]);
    expectSafeCompleteQueries(["quote-001", "quote-002"], 1);
  });
});
