import { describe, expect, it } from "vitest";
import {
  frozenExpenseWarningMode,
  frozenWorkflowModuleStage,
  type FrozenWorkflowModuleRow,
} from "./order-detail-workflow-settlement";

function row(overrides: Partial<FrozenWorkflowModuleRow>): FrozenWorkflowModuleRow {
  return {
    step_key: "custom_settlement",
    step_sort_order: 70,
    module_code: "costs",
    module_required: 1,
    required_field_count: 2,
    optional_field_count: 0,
    ...overrides,
  };
}

describe("order detail frozen settlement placement", () => {
  it("opens settlement at a custom costs step without canonical step keys", () => {
    const rows = [
      row({ step_key: "customer_pickup", step_sort_order: 60, module_code: "tracking" }),
      row({}),
      row({ step_key: "archive", step_sort_order: 80, module_code: "review" }),
    ];

    expect(frozenExpenseWarningMode(rows, "custom_settlement")).toBe("settlement");
    expect(frozenWorkflowModuleStage(rows, "custom_settlement", "costs")).toMatchObject({
      configured: true,
      gateConfigured: true,
      currentStepHasModule: true,
      reached: true,
      targetStepKey: "custom_settlement",
    });
  });

  it("keeps settlement hidden before the frozen costs placement and opens it afterwards", () => {
    const rows = [
      row({ step_key: "pickup", step_sort_order: 10, module_code: "tracking" }),
      row({ step_key: "tenant_named_cost_control", step_sort_order: 20 }),
      row({ step_key: "archive", step_sort_order: 30, module_code: "review" }),
    ];

    expect(frozenExpenseWarningMode(rows, "pickup")).toBe("hidden");
    expect(frozenExpenseWarningMode(rows, "archive")).toBe("settlement");
    expect(frozenWorkflowModuleStage(rows, "archive", "costs")).toMatchObject({
      currentStepHasModule: false,
      reached: true,
      targetStepKey: "tenant_named_cost_control",
    });
  });

  it("does not infer settlement from legacy canonical step names when costs is absent", () => {
    const rows = [
      row({ step_key: "reconciliation", step_sort_order: 70, module_code: "tracking", module_required: 0, required_field_count: 0 }),
      row({ step_key: "completion_review", step_sort_order: 80, module_code: "review", module_required: 1, required_field_count: 1 }),
    ];

    expect(frozenExpenseWarningMode(rows, "reconciliation")).toBe("hidden");
    expect(frozenExpenseWarningMode(rows, "completion_review")).toBe("hidden");
  });

  it("uses frozen required fields as a gate even when the module itself is optional", () => {
    const rows = [row({ module_required: 0, required_field_count: 1 })];

    expect(frozenWorkflowModuleStage(rows, "custom_settlement", "costs")).toMatchObject({
      configured: true,
      gateConfigured: true,
      reached: true,
    });
  });

  it("does not leak a later required settlement gate into an earlier optional costs node", () => {
    const rows = [
      row({
        step_key: "order_creation",
        step_sort_order: 20,
        module_required: 0,
        required_field_count: 0,
        optional_field_count: 1,
      }),
      row({
        step_key: "reconciliation",
        step_sort_order: 70,
        module_required: 1,
        required_field_count: 3,
        optional_field_count: 0,
      }),
    ];

    expect(frozenExpenseWarningMode(rows, "order_creation")).toBe("pre_entry");
    expect(frozenWorkflowModuleStage(rows, "order_creation", "costs").gateConfigured).toBe(false);
    expect(frozenExpenseWarningMode(rows, "reconciliation")).toBe("settlement");
    expect(frozenWorkflowModuleStage(rows, "reconciliation", "costs").gateConfigured).toBe(true);
  });

  it("keeps an optional field-only costs module visible without inventing a blocking gate", () => {
    const rows = [row({ module_required: 0, required_field_count: 0, optional_field_count: 3 })];

    expect(frozenWorkflowModuleStage(rows, "custom_settlement", "costs")).toMatchObject({
      configured: true,
      gateConfigured: false,
      currentStepHasModule: true,
      reached: true,
    });
    expect(frozenExpenseWarningMode(rows, "custom_settlement")).toBe("pre_entry");
  });

  it("fails closed when the current step is not part of the frozen rows", () => {
    const rows = [row({})];

    expect(frozenExpenseWarningMode(rows, "missing_step")).toBe("hidden");
    expect(frozenWorkflowModuleStage(rows, "missing_step", "costs")).toMatchObject({
      configured: true,
      currentStepHasModule: false,
      reached: false,
    });
  });
});
