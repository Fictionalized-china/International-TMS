import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    binding: {
      workflow_instance_id: "instance-1",
      matched_instance_id: "instance-1",
      workflow_id: "workflow-1",
    } as { workflow_instance_id: string | null; matched_instance_id: string | null; workflow_id: string | null } | null,
    snapshotFields: [] as Record<string, unknown>[],
    liveFields: [] as Record<string, unknown>[],
    placements: [{
      step_key: "outbound_transport",
      step_name: "Outbound",
      sort_order: 20,
    }] as Record<string, unknown>[],
  };
  const sql: string[] = [];
  const DB = {
    prepare(query: string) {
      sql.push(query);
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (query.includes("SELECT o.workflow_instance_id,wi.id matched_instance_id,wi.workflow_id")) {
            return state.binding;
          }
          if (query.includes("SELECT o.*,wi.id bound_instance_id")) {
            return { id: "order-1", workflow_instance_id: state.binding?.workflow_instance_id };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM workflow_instance_fields f")) {
            return { results: state.snapshotFields };
          }
          if (query.includes("FROM workflow_step_fields f")) {
            return { results: state.liveFields };
          }
          if (query.includes("FROM workflow_instance_module_states")) {
            return { results: state.placements };
          }
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };
  return { state, sql, DB };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));

import {
  frozenWorkflowFieldScopeMarkerKey,
  runtimeWorkflowFieldPolicy,
} from "./workflow-field-runtime";
import { workflowFieldsForStep } from "./order-workflow-field-presentation";
import { loadOrderModuleWorkflowFields } from "./workflow-fields.server";

describe("frozen workflow field loading", () => {
  beforeEach(() => {
    harness.sql.length = 0;
    harness.state.binding = {
      workflow_instance_id: "instance-1",
      matched_instance_id: "instance-1",
      workflow_id: "workflow-1",
    };
    harness.state.snapshotFields = [];
    harness.state.liveFields = [];
    harness.state.placements = [{
      step_key: "outbound_transport",
      step_name: "Outbound",
      sort_order: 20,
    }];
  });

  it("represents a zero-row frozen module as an explicit all-hidden policy", async () => {
    const fields = await loadOrderModuleWorkflowFields(
      "org-1",
      "order-1",
      "customs",
    );

    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => !field.isActive && !field.isRequired)).toBe(true);
    expect(runtimeWorkflowFieldPolicy(
      fields,
      "document_commercial_invoice",
      true,
    )).toMatchObject({ visible: false, required: false, configured: false });
    expect(harness.sql.some((query) => query.includes("FROM workflow_step_fields f"))).toBe(false);
  });

  it("fails closed when the order keeps a dangling frozen instance id", async () => {
    harness.state.binding = {
      workflow_instance_id: "foreign-instance",
      matched_instance_id: null,
      workflow_id: null,
    };
    harness.state.snapshotFields = [{
      id: "foreign-field",
      workflow_id: "foreign-workflow",
      step_key: "outbound_transport",
      step_name: "Outbound",
      module_code: "customs",
      field_key: "document_commercial_invoice",
      label: "Foreign invoice",
      field_type: "attachment",
      is_required: 1,
      is_active: 1,
      sort_order: 10,
      options_text: null,
      help_text: null,
    }];
    harness.state.placements = [];

    const fields = await loadOrderModuleWorkflowFields("org-1", "order-1", "customs");
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.some((field) => field.label === "Foreign invoice")).toBe(false);
    expect(runtimeWorkflowFieldPolicy(
      fields,
      "document_commercial_invoice",
      true,
    )).toMatchObject({ visible: false, required: false, configured: false });
    expect(harness.sql.some((query) => query.includes("FROM workflow_step_fields f"))).toBe(false);
    expect(harness.sql.join("\n")).toContain("wi.organization_id=o.organization_id");
    expect(harness.sql.join("\n")).toContain("wi.order_id=o.id");
  });

  it("does not add mutable baseline fields to a populated frozen snapshot", async () => {
    harness.state.snapshotFields = [{
      id: "field-1",
      workflow_id: "workflow-1",
      step_key: "outbound_transport",
      step_name: "Outbound",
      module_code: "customs",
      field_key: "document_commercial_invoice",
      label: "Invoice",
      field_type: "attachment",
      is_required: 0,
      is_active: 1,
      sort_order: 10,
      options_text: null,
      help_text: null,
    }];

    const fields = await loadOrderModuleWorkflowFields("org-1", "order-1", "customs");
    expect(fields.filter((field) => field.fieldKey !== frozenWorkflowFieldScopeMarkerKey)).toHaveLength(1);
    expect(runtimeWorkflowFieldPolicy(fields, "document_packing_list", true))
      .toMatchObject({ visible: false, required: false, configured: false });
  });

  it("keeps a zero-field module closed at its custom frozen placement", async () => {
    harness.state.placements = [{
      step_key: "custom_document_gate",
      step_name: "Custom document gate",
      sort_order: 45,
    }];

    const fields = await loadOrderModuleWorkflowFields("org-1", "order-1", "customs");
    const scoped = workflowFieldsForStep(fields, "custom_document_gate");
    expect(scoped.map((field) => field.fieldKey)).toEqual([
      frozenWorkflowFieldScopeMarkerKey,
    ]);
    expect(runtimeWorkflowFieldPolicy(scoped, "document_commercial_invoice", true))
      .toMatchObject({ visible: false, required: false, configured: false });
  });

  it("closes a repeated module occurrence that has no fields of its own", async () => {
    harness.state.placements = [
      { step_key: "customs_prepare", step_name: "Prepare", sort_order: 30 },
      { step_key: "customs_release", step_name: "Release", sort_order: 40 },
    ];
    harness.state.snapshotFields = [{
      id: "field-prepare",
      workflow_id: "workflow-1",
      step_key: "customs_prepare",
      step_name: "Prepare",
      module_code: "customs",
      field_key: "document_commercial_invoice",
      label: "Invoice",
      field_type: "attachment",
      is_required: 1,
      is_active: 1,
      sort_order: 10,
      options_text: null,
      help_text: null,
    }];

    const fields = await loadOrderModuleWorkflowFields("org-1", "order-1", "customs");
    const prepare = workflowFieldsForStep(fields, "customs_prepare");
    const release = workflowFieldsForStep(fields, "customs_release");
    expect(runtimeWorkflowFieldPolicy(prepare, "document_commercial_invoice", true))
      .toMatchObject({ visible: true, required: true, configured: true });
    expect(release.map((field) => field.fieldKey)).toEqual([
      frozenWorkflowFieldScopeMarkerKey,
    ]);
    expect(runtimeWorkflowFieldPolicy(release, "document_commercial_invoice", true))
      .toMatchObject({ visible: false, required: false, configured: false });
  });

  it("keeps catalog fallback only for an explicitly unbound legacy order", async () => {
    harness.state.binding = {
      workflow_instance_id: null,
      matched_instance_id: null,
      workflow_id: "workflow-1",
    };

    const fields = await loadOrderModuleWorkflowFields("org-1", "order-1", "customs");
    expect(runtimeWorkflowFieldPolicy(
      fields,
      "document_commercial_invoice",
      true,
    )).toMatchObject({ visible: true, required: true, configured: true });
    expect(harness.sql.some((query) => query.includes("FROM workflow_step_fields f"))).toBe(true);
  });
});
