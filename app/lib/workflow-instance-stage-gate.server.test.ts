import { describe, expect, it } from "vitest";
import { loadLockedWorkflowStageContext } from "./workflow-instance-stage-gate.server";

type QueryResult = { first?: unknown; results?: unknown[] };

function databaseFor(resultsByMarker: Record<string, QueryResult>) {
  const sql: string[] = [];
  const DB = {
    prepare(statementSql: string) {
      sql.push(statementSql);
      const marker = Object.keys(resultsByMarker).find((candidate) =>
        statementSql.includes(candidate),
      );
      const result = marker ? resultsByMarker[marker] : {};
      return {
        bind() {
          return {
            async first() {
              return result.first ?? null;
            },
            async all() {
              return { results: result.results ?? [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { DB, sql };
}

describe("locked workflow stage context loader", () => {
  it("loads steps, modules and fields only from the frozen order instance", async () => {
    const database = databaseFor({
      "SELECT o.workflow_instance_id": {
        first: {
          workflow_instance_id: "instance-1",
          matched_instance_id: "instance-1",
          current_step_key: "custom_settlement",
        },
      },
      "FROM workflow_instance_step_states": {
        results: [
          {
            step_key: "custom_settlement",
            step_name: "自定义结算",
            sort_order: 80,
          },
        ],
      },
      "FROM workflow_instance_module_states": {
        results: [
          { module_code: "costs", step_key: "custom_settlement" },
        ],
      },
      "FROM workflow_instance_fields": {
        results: [
          {
            module_code: "costs",
            field_key: "finance_review",
            step_key: "custom_settlement",
            is_active: 1,
            is_required: 1,
          },
        ],
      },
    });

    const result = await loadLockedWorkflowStageContext(
      database.DB,
      "organization-1",
      "order-1",
      "costs",
    );

    expect(result).toEqual({
      locked: true,
      currentStepKey: "custom_settlement",
      steps: [
        {
          stepKey: "custom_settlement",
          stepName: "自定义结算",
          sortOrder: 80,
        },
      ],
      modulePlacements: [
        { moduleCode: "costs", stepKey: "custom_settlement" },
      ],
      fields: [
        {
          moduleCode: "costs",
          fieldKey: "finance_review",
          stepKey: "custom_settlement",
          isActive: true,
          isRequired: true,
        },
      ],
    });
    expect(database.sql.join("\n")).not.toMatch(
      /FROM workflow_steps|FROM workflow_step_modules/,
    );
  });

  it("marks orders without a workflow instance as legacy", async () => {
    const database = databaseFor({
      "SELECT o.workflow_instance_id": {
        first: {
          workflow_instance_id: null,
          matched_instance_id: null,
          current_step_key: null,
        },
      },
    });

    await expect(
      loadLockedWorkflowStageContext(
        database.DB,
        "organization-1",
        "legacy-order",
        "costs",
      ),
    ).resolves.toEqual({
      locked: false,
      currentStepKey: null,
      steps: [],
      modulePlacements: [],
      fields: [],
    });
    expect(database.sql).toHaveLength(1);
  });

  it.each([
    ["empty string", "", null],
    ["cross-order reference", "instance-for-other-order", null],
  ])("fails closed for a non-null %s workflow binding", async (
    _label,
    workflowInstanceId,
    matchedInstanceId,
  ) => {
    const database = databaseFor({
      "SELECT o.workflow_instance_id": {
        first: {
          workflow_instance_id: workflowInstanceId,
          matched_instance_id: matchedInstanceId,
          current_step_key: null,
        },
      },
    });

    await expect(loadLockedWorkflowStageContext(
      database.DB,
      "organization-1",
      "order-1",
      "costs",
    )).resolves.toEqual({
      locked: true,
      currentStepKey: null,
      steps: [],
      modulePlacements: [],
      fields: [],
    });
    expect(database.sql).toHaveLength(1);
    expect(database.sql[0]).toContain("wi.order_id=o.id");
  });

  it("validates organization and order ownership in the binding join", async () => {
    const database = databaseFor({
      "SELECT o.workflow_instance_id": {
        first: null,
      },
    });

    await loadLockedWorkflowStageContext(database.DB, "org-1", "order-1", "costs");
    expect(database.sql[0]).toContain("wi.organization_id=o.organization_id");
    expect(database.sql[0]).toContain("wi.order_id=o.id");
  });
});
