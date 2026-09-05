import { beforeEach, describe, expect, it, vi } from "vitest";

type DefinitionState = {
  id: string;
  organizationId: string;
  code: string;
  templateFamilyId: string | null;
  lifecycleStatus: string;
  validationStatus: string;
  status: string;
  versionNumber: number;
};

const database = vi.hoisted(() => {
  const prepared: Array<{ sql: string; values: unknown[] }> = [];
  const definitions = new Map<string, DefinitionState>();
  const definitionKey = (organizationId: string, code: string) => `${organizationId}:${code}`;
  const seedDefinition = (definition: DefinitionState) => {
    definitions.set(definitionKey(definition.organizationId, definition.code), definition);
  };
  const DB = {
    prepare(sql: string) {
      const record = { sql, values: [] as unknown[] };
      prepared.push(record);
      const statement = {
        bind(...values: unknown[]) {
          record.values = values;
          const placeholderCount = (sql.match(/\?/g) ?? []).length;
          if (placeholderCount !== values.length) {
            throw new Error(
              `SQL bind mismatch: expected ${placeholderCount}, received ${values.length}: ${sql}`,
            );
          }
          return statement;
        },
        async first() {
          if (sql.includes("SELECT id,lifecycle_status,validation_status,template_family_id")) {
            const [organizationId, code] = record.values as [string, string];
            const definition = definitions.get(definitionKey(organizationId, code));
            return definition
              ? {
                  id: definition.id,
                  lifecycle_status: definition.lifecycleStatus,
                  validation_status: definition.validationStatus,
                  template_family_id: definition.templateFamilyId,
                }
              : null;
          }
          if (
            sql.includes("SELECT id FROM workflow_definitions") &&
            sql.includes("validation_status='valid'") &&
            sql.includes("template_family_id=?")
          ) {
            const [organizationId, code, familyId] = record.values as [string, string, string];
            return [...definitions.values()]
              .filter((definition) =>
                definition.organizationId === organizationId &&
                definition.lifecycleStatus === "published" &&
                definition.validationStatus === "valid" &&
                definition.status === "active" &&
                (definition.code === code || definition.templateFamilyId === familyId),
              )
              .sort((left, right) => right.versionNumber - left.versionNumber)
              .map((definition) => ({ id: definition.id }))[0] ?? null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO workflow_definitions")) {
            const [id, organizationId, code, , templateFamilyId] = record.values as string[];
            const key = definitionKey(organizationId, code);
            if (!definitions.has(key)) {
              definitions.set(key, {
                id,
                organizationId,
                code,
                templateFamilyId,
                lifecycleStatus: "draft",
                validationStatus: "pending",
                status: "active",
                versionNumber: 1,
              });
            }
          }
          return { success: true };
        },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      return statements.map(() => ({ success: true }));
    },
  };
  return { DB, definitions, prepared, seedDefinition };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: database.DB } }));

import {
  ensureDefaultWorkflow,
  ensureWorkflowForBusinessType,
} from "./business-workflow.server";

const definition = (input: Partial<DefinitionState> & Pick<DefinitionState, "id" | "code">): DefinitionState => ({
  organizationId: "org-new",
  templateFamilyId: input.id,
  lifecycleStatus: "draft",
  validationStatus: "pending",
  status: "active",
  versionNumber: 1,
  ...input,
});

describe("new-organization standard workflow bootstrap", () => {
  beforeEach(() => {
    database.prepared.length = 0;
    database.definitions.clear();
  });

  it("creates complete editable drafts without malformed D1 binds or premature publication", async () => {
    await expect(ensureDefaultWorkflow("org-new")).resolves.toBe("org-new:tms-default");

    const definitionInserts = database.prepared.filter((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO workflow_definitions"),
    );
    expect(definitionInserts).toHaveLength(3);
    expect(definitionInserts.map((entry) => entry.values[2])).toEqual([
      "tms-road-pending",
      "tms-default",
      "tms-ftl-standard",
    ]);
    expect(definitionInserts.map((entry) => entry.values[5])).toEqual([
      "ltl",
      "ltl",
      "ftl",
    ]);
    expect(definitionInserts.every((entry) => entry.values[0] === entry.values[4])).toBe(true);
    expect(definitionInserts.every((entry) =>
      entry.sql.includes("'draft','pending'") &&
      !entry.sql.includes("'published','valid'"),
    )).toBe(true);

    const moduleInserts = database.prepared.filter((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO workflow_step_modules"),
    );
    const taskInserts = database.prepared.filter((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO workflow_module_tasks"),
    );
    const fieldInserts = database.prepared.filter((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO workflow_step_fields"),
    );
    expect(moduleInserts).toHaveLength(48);
    expect(taskInserts).toHaveLength(48);
    expect(fieldInserts.length).toBeGreaterThan(0);
    expect(database.prepared.some((entry) => /^\s*UPDATE\s+workflow_/i.test(entry.sql))).toBe(false);
  });

  it("uses the real id of an existing draft instead of assuming the deterministic id", async () => {
    database.seedDefinition(definition({ id: "actual-default-id", code: "tms-default" }));

    await expect(ensureDefaultWorkflow("org-new")).resolves.toBe("actual-default-id");

    const defaultStepInsert = database.prepared.find((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO workflow_steps") &&
      entry.values[1] === "actual-default-id",
    );
    expect(defaultStepInsert?.values[0]).toBe("actual-default-id:step:quotation");
    expect(database.prepared.some((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO workflow_step_modules") &&
      entry.values.includes("actual-default-id"),
    )).toBe(true);
  });

  it("never edits an existing published definition while creating missing drafts", async () => {
    database.seedDefinition(definition({
      id: "published-pending-id",
      code: "tms-road-pending",
      lifecycleStatus: "published",
      validationStatus: "valid",
    }));

    await ensureDefaultWorkflow("org-new");

    expect(database.prepared.some((entry) =>
      /^\s*UPDATE\s+workflow_/i.test(entry.sql) ||
      (entry.sql.includes("INSERT OR IGNORE INTO workflow_steps") && entry.values[1] === "published-pending-id"),
    )).toBe(false);
  });

  it("rejects business execution until the matching workflow is published and valid", async () => {
    database.seedDefinition(definition({
      id: "invalid-ftl-id",
      code: "tms-ftl-standard",
      lifecycleStatus: "published",
      validationStatus: "invalid",
    }));

    await expect(ensureWorkflowForBusinessType("org-new", "ftl")).rejects.toThrow(
      /尚未发布且校验通过整车工作流.*工作流配置/,
    );
    expect(database.definitions.get("org-new:tms-ftl-standard")).toMatchObject({
      lifecycleStatus: "published",
      validationStatus: "invalid",
    });
  });

  it("selects a valid published version through the actual template family", async () => {
    database.seedDefinition(definition({
      id: "actual-default-id",
      code: "tms-default",
      templateFamilyId: "actual-default-id",
      lifecycleStatus: "retired",
      validationStatus: "valid",
      status: "disabled",
    }));
    database.seedDefinition(definition({
      id: "published-v2-id",
      code: "tms-default-v2",
      templateFamilyId: "actual-default-id",
      lifecycleStatus: "published",
      validationStatus: "valid",
      versionNumber: 2,
    }));

    await expect(ensureWorkflowForBusinessType("org-new", "ltl")).resolves.toBe("published-v2-id");
    expect(database.prepared.filter((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO workflow_definitions"),
    )).toHaveLength(0);
  });
});
