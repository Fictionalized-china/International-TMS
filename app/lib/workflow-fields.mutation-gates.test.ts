import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    binding: {
      workflow_instance_id: "instance-1",
      matched_instance_id: "instance-1",
      current_step_key: "domestic_transport",
    } as { workflow_instance_id: string | null; matched_instance_id: string | null; current_step_key: string | null } | null,
    steps: [] as Record<string, unknown>[],
    modules: [] as Record<string, unknown>[],
    fields: [] as Record<string, unknown>[],
    selectedField: null as Record<string, unknown> | null,
    writes: 0,
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
          if (query.includes("SELECT o.workflow_instance_id,wi.id matched_instance_id,wi.current_step_key")) {
            return state.binding;
          }
          if (query.includes("SELECT f.id,f.module_code,f.step_key,f.field_key,f.is_active,o.status order_status")) {
            return state.selectedField;
          }
          return null;
        },
        async all() {
          if (query.includes("FROM workflow_instance_step_states")) {
            return { results: state.steps };
          }
          if (query.includes("FROM workflow_instance_module_states")) {
            return { results: state.modules };
          }
          if (query.includes("FROM workflow_instance_fields")) {
            return { results: state.fields };
          }
          return { results: [] };
        },
        async run() {
          if (query.includes("INSERT INTO order_custom_workflow_field_values")) {
            state.writes += 1;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
  return { state, sql, DB };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));

import { saveOrderCustomWorkflowFieldValue } from "./workflow-fields.server";

describe("frozen custom workflow field mutation gates", () => {
  const customField = (moduleCode = "transport", stepKey = "domestic_transport") => ({
    id: "field-custom-note",
    module_code: moduleCode,
    step_key: stepKey,
    field_key: "custom_gate_note",
    is_active: 1,
    is_required: 0,
    order_status: "in_execution",
  });

  const save = () => saveOrderCustomWorkflowFieldValue({
    organizationId: "org-1",
    orderId: "order-1",
    moduleCode: "transport",
    fieldId: "field-custom-note",
    value: "saved value",
    actorUserId: "user-1",
  });

  beforeEach(() => {
    harness.sql.length = 0;
    harness.state.binding = {
      workflow_instance_id: "instance-1",
      matched_instance_id: "instance-1",
      current_step_key: "domestic_transport",
    };
    harness.state.steps = [
      { step_key: "domestic_transport", step_name: "Domestic", sort_order: 10 },
      { step_key: "outbound_transport", step_name: "Outbound", sort_order: 20 },
    ];
    harness.state.modules = [{
      module_code: "transport",
      step_key: "domestic_transport",
    }];
    harness.state.fields = [customField()];
    harness.state.selectedField = customField();
    harness.state.writes = 0;
  });

  it("writes only at the exact open placement in the frozen workflow", async () => {
    await expect(save()).resolves.toBeUndefined();
    expect(harness.state.writes).toBe(1);
    expect(harness.sql.find((query) =>
      query.includes("SELECT f.id,f.module_code,f.step_key,f.field_key,f.is_active,o.status order_status"),
    )).toContain("o.workflow_instance_id=wi.id");
  });

  it("rejects a known field id belonging to another module", async () => {
    harness.state.selectedField = customField("costs");
    await expect(save()).rejects.toThrow("不属于当前模块");
    expect(harness.state.writes).toBe(0);
  });

  it("rejects a future field even when the caller knows its frozen id", async () => {
    harness.state.modules = [{
      module_code: "transport",
      step_key: "outbound_transport",
    }];
    harness.state.fields = [customField("transport", "outbound_transport")];
    harness.state.selectedField = customField("transport", "outbound_transport");
    await expect(save()).rejects.toThrow();
    expect(harness.state.writes).toBe(0);
  });

  it.each(["completed", "cancelled"])("rejects custom field writes after the order is %s", async (status) => {
    harness.state.selectedField = { ...customField(), order_status: status };
    await expect(save()).rejects.toThrow("仅供查看");
    expect(harness.state.writes).toBe(0);
  });

  it("fails closed for a legacy order without a frozen field snapshot", async () => {
    harness.state.binding = {
      workflow_instance_id: null,
      matched_instance_id: null,
      current_step_key: "domestic_transport",
    };
    await expect(save()).rejects.toThrow("冻结的自定义字段快照");
    expect(harness.state.writes).toBe(0);
  });
});
