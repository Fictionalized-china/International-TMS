import { beforeEach, describe, expect, it, vi } from "vitest";

type RecordedStatement = {
  sql: string;
  bindings: unknown[];
  bind: (...bindings: unknown[]) => RecordedStatement;
  run: () => Promise<{ meta: { changes: number } }>;
};

const database = vi.hoisted(() => {
  const prepared: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  return {
    prepared,
    batches,
    DB: {
      prepare(sql: string) {
        const statement: RecordedStatement = {
          sql,
          bindings: [],
          bind(...bindings: unknown[]) {
            statement.bindings = bindings;
            return statement;
          },
          async run() {
            return { meta: { changes: 0 } };
          },
        };
        prepared.push(statement);
        return statement;
      },
      async batch(statements: RecordedStatement[]) {
        batches.push(statements);
        return [];
      },
    },
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: database.DB } }));

import {
  ftlOutboundWorkflowFieldValues,
  mergeWorkflowFieldCatalogBaseline,
  synchronizeWorkflowFieldDefinitionForInstances,
  synchronizeWorkflowFieldPolicyForInstances,
  workflowFieldPolicyAppliesAtStage,
} from "./workflow-fields.server";

describe("stage-aware workflow field synchronization", () => {
  beforeEach(() => {
    database.prepared.length = 0;
    database.batches.length = 0;
  });

  it("fills missing standard fields from the business baseline without overriding configured rows", () => {
    const rows = mergeWorkflowFieldCatalogBaseline(
      [
        {
          id: "configured-customer",
          workflow_id: "workflow-1",
          step_key: "order_creation",
          step_name: "委托资料补充",
          module_code: "consignment",
          field_key: "customer_id",
          label: "委托客户",
          field_type: "customer",
          is_required: 0,
          is_active: 0,
          sort_order: 10,
          options_text: null,
          help_text: null,
        },
      ],
      "workflow-1",
      "consignment",
    );

    expect(rows.find((field) => field.field_key === "customer_id")).toMatchObject({
      id: "configured-customer",
      is_active: 0,
      is_required: 0,
    });
    expect(rows.find((field) => field.field_key === "quotation_id")).toMatchObject({
      is_active: 1,
      is_required: 0,
    });
    expect(rows.find((field) => field.field_key === "document_consignment_letter")).toMatchObject({
      is_active: 1,
      is_required: 1,
    });
  });

  it("maps one full-truck outbound assignment to both loading field vocabularies", () => {
    expect(ftlOutboundWorkflowFieldValues({
      carrier_id: "carrier-1",
      carrier_name: "境外承运商",
      vehicle_type: "高栏车",
      plate_number: "粤A111XT",
      driver_name: "张伟",
      driver_phone: "13800001111",
      planned_departure_at: "2026-09-02T21:50",
    })).toMatchObject({
      main_carrier_id: "carrier-1",
      main_vehicle_type: "高栏车",
      main_plate_number: "粤A111XT",
      overseas_carrier_name: "境外承运商",
      overseas_vehicle_type: "高栏车",
      overseas_vehicle_count: 1,
      overseas_vehicle_plate: "粤A111XT",
      overseas_driver_name: "张伟",
      overseas_driver_phone: "13800001111",
    });
  });

  it("applies a changed rule only to future and current stages", () => {
    expect(workflowFieldPolicyAppliesAtStage(10, 20)).toBe(true);
    expect(workflowFieldPolicyAppliesAtStage(20, 20)).toBe(true);
    expect(workflowFieldPolicyAppliesAtStage(30, 20)).toBe(false);
  });

  it("updates and inserts definition snapshots only before the target step is passed", async () => {
    await synchronizeWorkflowFieldDefinitionForInstances({
      workflowId: "workflow-1",
      stepKey: "order_creation",
      fieldKey: "document_consignment_letter",
      moduleCode: "consignment",
      label: "委托书",
      fieldType: "attachment",
      isRequired: 1,
      isActive: 1,
      sortOrder: 10,
      optionsText: null,
      helpText: null,
    });

    expect(database.batches).toHaveLength(1);
    const [updateStatement, insertStatement] = database.batches[0];
    for (const statement of [updateStatement, insertStatement]) {
      expect(statement.sql).toContain(
        "current_step.sort_order<=target_step.sort_order",
      );
      expect(statement.sql).toContain("current_step.step_key=wi.current_step_key");
    }
    expect(updateStatement.sql).toContain(
      "WHERE workflow_id=? AND step_key=? AND field_key=? AND module_code=?",
    );
    expect(updateStatement.bindings.slice(-5)).toEqual([
      "workflow-1",
      "order_creation",
      "document_consignment_letter",
      "consignment",
      "order_creation",
    ]);
    expect(updateStatement.bindings.at(-1)).toBe("order_creation");
    expect(insertStatement.bindings.slice(-2)).toEqual([
      "order_creation",
      "workflow-1",
    ]);
  });

  it("matches the previous identity when a definition is structurally edited", async () => {
    await synchronizeWorkflowFieldDefinitionForInstances({
      workflowId: "workflow-1",
      sourceStepKey: "old_step",
      sourceFieldKey: "old_key",
      sourceModuleCode: "consignment",
      stepKey: "new_step",
      fieldKey: "new_key",
      moduleCode: "cargo",
      label: "新字段",
      fieldType: "text",
      isRequired: 0,
      isActive: 1,
      sortOrder: 20,
      optionsText: null,
      helpText: null,
    });

    const [updateStatement] = database.batches[0];
    expect(updateStatement.bindings.slice(-5)).toEqual([
      "workflow-1",
      "old_step",
      "old_key",
      "consignment",
      "new_step",
    ]);
  });

  it("keeps the policy-only synchronization path stage-aware", async () => {
    await synchronizeWorkflowFieldPolicyForInstances({
      workflowId: "workflow-1",
      fieldKey: "document_consignment_letter",
      moduleCode: "consignment",
      isRequired: 0,
      isActive: 1,
    });

    expect(database.prepared).toHaveLength(1);
    const [statement] = database.prepared;
    expect(statement.sql).toContain(
      "target_step.step_key=workflow_instance_fields.step_key",
    );
    expect(statement.sql).toContain(
      "current_step.sort_order<=target_step.sort_order",
    );
    expect(statement.bindings).toEqual([
      0,
      1,
      "workflow-1",
      "document_consignment_letter",
      "consignment",
    ]);
  });
});
