import { beforeEach, describe, expect, it, vi } from "vitest";

type RecordedStatement = {
  sql: string;
  bindings: unknown[];
  bind: (...bindings: unknown[]) => RecordedStatement;
  first: <T>() => Promise<T | null>;
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
          async first<T>() {
            return { position_codes: "SALES" } as T;
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
  assignmentCoverageIsComplete,
  assignmentManagedModuleCodes,
  confirmedBatchCostAllocationPresenceSql,
  defaultWorkflowFieldHandlerPositionCodes,
  ftlOutboundWorkflowFieldValues,
  mergeWorkflowFieldCatalogBaseline,
  synchronizeWorkflowFieldDefinitionForInstances,
  synchronizeWorkflowFieldHandlerPositionsForInstances,
  synchronizeWorkflowFieldPolicyForInstances,
  workflowFieldPolicyAppliesToStepStatus,
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

  it("does not recreate a catalog field at its default step after it was placed elsewhere", () => {
    const rows = mergeWorkflowFieldCatalogBaseline(
      [
        {
          id: "moved-finance-review",
          workflow_id: "workflow-1",
          step_key: "custom_settlement",
          step_name: "自定义结算",
          module_code: "costs",
          field_key: "finance_review",
          label: "财务审核",
          field_type: "select",
          is_required: 1,
          is_active: 1,
          sort_order: 10,
          options_text: null,
          help_text: null,
        },
      ],
      "workflow-1",
      "costs",
    );

    expect(
      rows.filter((field) => field.field_key === "finance_review"),
    ).toEqual([
      expect.objectContaining({
        id: "moved-finance-review",
        step_key: "custom_settlement",
      }),
    ]);
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

  it("counts cost allocation presence only for this order's confirmed expense-backed line", () => {
    expect(confirmedBatchCostAllocationPresenceSql).toContain("line.organization_id=ca.organization_id");
    expect(confirmedBatchCostAllocationPresenceSql).toContain("line.order_id=bo.order_id");
    expect(confirmedBatchCostAllocationPresenceSql).toContain("line.expense_id IS NOT NULL");
    expect(confirmedBatchCostAllocationPresenceSql).toContain("ca.organization_id=bo.organization_id");
    expect(confirmedBatchCostAllocationPresenceSql).toContain("ca.status='confirmed'");
  });

  it("only requires the modules that are actually assigned on the task-assignment page", () => {
    expect(assignmentManagedModuleCodes).toEqual([
      "transport",
      "tracking",
      "exceptions",
      "documents",
      "customs",
      "costs",
    ]);
    expect(assignmentManagedModuleCodes).not.toContain("warehouse");
    expect(assignmentManagedModuleCodes).not.toContain("loading");
    expect(assignmentManagedModuleCodes).not.toContain("overseas_warehouse");
    expect(assignmentCoverageIsComplete(5, 5)).toBe(true);
    expect(assignmentCoverageIsComplete(4, 5)).toBe(false);
    expect(assignmentCoverageIsComplete(0, 0)).toBe(false);
  });

  it("applies a changed rule to active and future nodes, but freezes completed history", () => {
    expect(workflowFieldPolicyAppliesToStepStatus("active")).toBe(true);
    expect(workflowFieldPolicyAppliesToStepStatus("pending")).toBe(true);
    expect(workflowFieldPolicyAppliesToStepStatus("not_started")).toBe(true);
    expect(workflowFieldPolicyAppliesToStepStatus("completed")).toBe(false);
    expect(workflowFieldPolicyAppliesToStepStatus("not_applicable")).toBe(false);
  });

  it("falls back from a field module to the configured responsibility of its node", async () => {
    await expect(defaultWorkflowFieldHandlerPositionCodes({
      workflowId: "workflow-1",
      stepId: "quotation-step",
      moduleCode: "cargo",
    })).resolves.toBe("SALES");

    const statement = database.prepared.at(-1)!;
    expect(statement.sql).toContain("SELECT COALESCE(");
    expect(statement.sql).toContain("WHERE workflow_id=? AND step_id=? AND is_active=1");
    expect(statement.bindings).toEqual([
      "workflow-1", "quotation-step", "cargo",
      "workflow-1", "quotation-step", "cargo",
      "workflow-1", "quotation-step",
      "workflow-1", "quotation-step",
    ]);
  });

  it("updates and inserts definition snapshots only while the target node is open", async () => {
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
      expect(statement.sql).toContain("workflow_instance_step_states target_state");
      expect(statement.sql).toContain("target_state.status NOT IN ('completed','not_applicable')");
      expect(statement.sql).not.toContain("current_step.sort_order<=target_step.sort_order");
    }
    expect(updateStatement.sql).toContain(
      "WHERE workflow_id=? AND step_key=? AND field_key=? AND module_code=?",
    );
    expect(updateStatement.bindings.slice(-4)).toEqual([
      "workflow-1",
      "order_creation",
      "document_consignment_letter",
      "consignment",
    ]);
    expect(insertStatement.bindings.at(-1)).toBe("workflow-1");
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
    expect(updateStatement.bindings.slice(-4)).toEqual([
      "workflow-1",
      "old_step",
      "old_key",
      "consignment",
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
    expect(statement.sql).toContain("workflow_instance_step_states target_state");
    expect(statement.sql).toContain("target_state.step_key=workflow_instance_fields.step_key");
    expect(statement.sql).toContain("target_state.status NOT IN ('completed','not_applicable')");
    expect(statement.sql).not.toContain("current_step.sort_order<=target_step.sort_order");
    expect(statement.bindings).toEqual([
      0,
      1,
      "workflow-1",
      "document_consignment_letter",
      "consignment",
    ]);
  });

  it("synchronizes handler positions only into open node snapshots", async () => {
    await synchronizeWorkflowFieldHandlerPositionsForInstances({
      workflowId: "workflow-1",
      stepKey: "order_creation",
      fieldKey: "document_consignment_letter",
      moduleCode: "consignment",
      handlerPositionCodes: "DOC,SALES",
    });

    const [statement] = database.prepared;
    expect(statement.sql).toContain("SET handler_position_codes=?");
    expect(statement.sql).toContain("target_state.status NOT IN ('completed','not_applicable')");
    expect(statement.bindings).toEqual([
      "DOC,SALES",
      "workflow-1",
      "order_creation",
      "document_consignment_letter",
      "consignment",
    ]);
  });
});
