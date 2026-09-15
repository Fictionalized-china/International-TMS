import { describe, expect, it } from "vitest";
import {
  frozenWorkflowFieldActionPolicy,
  type FrozenWorkflowFieldActionPolicyInput,
} from "./workflow-field-action-policy";

function input(
  currentStepKey = "tracking",
  overrides: Partial<FrozenWorkflowFieldActionPolicyInput> = {},
): FrozenWorkflowFieldActionPolicyInput {
  return {
    context: {
      locked: true,
      currentStepKey,
      steps: [
        { stepKey: "customs", stepName: "报关放行", sortOrder: 10 },
        { stepKey: "tracking", stepName: "实际出境及运踪", sortOrder: 20 },
        { stepKey: "overseas", stepName: "境外仓入库", sortOrder: 30 },
      ],
      modulePlacements: [
        { moduleCode: "tracking", stepKey: "tracking" },
      ],
      fields: [
        {
          moduleCode: "tracking",
          fieldKey: "tracking_milestone",
          stepKey: "tracking",
          isActive: true,
          isRequired: true,
        },
      ],
    },
    moduleCode: "tracking",
    fieldKey: "tracking_milestone",
    ...overrides,
  };
}

describe("frozen workflow field action policy", () => {
  it("allows editing only at the field's exact frozen target step", () => {
    expect(frozenWorkflowFieldActionPolicy(input())).toEqual({
      source: "frozen",
      status: "editable",
      configured: true,
      configurationValid: true,
      visible: true,
      editable: true,
      legacyFallbackAllowed: false,
      stageRelation: "current",
      targetStepKey: "tracking",
      targetStepName: "实际出境及运踪",
      isRequired: true,
      reason: null,
    });
  });

  it.each([
    ["customs", "before"],
    ["overseas", "after"],
  ] as const)(
    "keeps a configured field read-only when the current step is %s its target",
    (currentStepKey, stageRelation) => {
      expect(frozenWorkflowFieldActionPolicy(input(currentStepKey))).toMatchObject({
        source: "frozen",
        status: "read_only",
        configurationValid: true,
        visible: true,
        editable: false,
        legacyFallbackAllowed: false,
        stageRelation,
      });
    },
  );

  it("keeps a field hidden when the frozen snapshot deactivates it", () => {
    const hidden = input();
    hidden.context = {
      ...hidden.context,
      fields: hidden.context.fields.map((field) => ({
        ...field,
        isActive: false,
        isRequired: false,
      })),
    };

    expect(frozenWorkflowFieldActionPolicy(hidden)).toMatchObject({
      source: "frozen",
      status: "hidden",
      configured: true,
      configurationValid: true,
      visible: false,
      editable: false,
      legacyFallbackAllowed: false,
    });
  });

  it("allows legacy fallback only when the order is truly unbound", () => {
    const legacy = input();
    legacy.context = {
      locked: false,
      currentStepKey: null,
      steps: [],
      modulePlacements: [],
      fields: [],
    };

    expect(frozenWorkflowFieldActionPolicy(legacy)).toEqual({
      source: "legacy",
      status: "legacy_fallback",
      configured: false,
      configurationValid: true,
      visible: false,
      editable: false,
      legacyFallbackAllowed: true,
      stageRelation: "legacy",
      targetStepKey: null,
      targetStepName: null,
      isRequired: false,
      reason: null,
    });
  });

  it.each([
    {
      name: "duplicate field placement",
      reason: "重复",
      mutate(value: FrozenWorkflowFieldActionPolicyInput) {
        value.context = {
          ...value.context,
          fields: [...value.context.fields, { ...value.context.fields[0] }],
        };
      },
    },
    {
      name: "missing target step",
      reason: "节点",
      mutate(value: FrozenWorkflowFieldActionPolicyInput) {
        value.context = {
          ...value.context,
          fields: value.context.fields.map((field) => ({
            ...field,
            stepKey: "missing-step",
          })),
        };
      },
    },
    {
      name: "field owned by another module",
      reason: "模块",
      mutate(value: FrozenWorkflowFieldActionPolicyInput) {
        value.context = {
          ...value.context,
          fields: value.context.fields.map((field) => ({
            ...field,
            moduleCode: "customs",
          })),
        };
      },
    },
    {
      name: "broken frozen binding",
      reason: "绑定",
      mutate(value: FrozenWorkflowFieldActionPolicyInput) {
        value.context = {
          locked: true,
          currentStepKey: null,
          steps: [],
          modulePlacements: [],
          fields: [],
        };
      },
    },
  ])("fails closed for $name", ({ mutate, reason }) => {
    const invalid = input();
    mutate(invalid);
    const result = frozenWorkflowFieldActionPolicy(invalid);

    expect(result).toMatchObject({
      source: "frozen",
      status: "invalid",
      configurationValid: false,
      editable: false,
      legacyFallbackAllowed: false,
      stageRelation: "invalid",
    });
    expect(result.reason).toContain(reason);
  });

  it("treats a field absent from a valid frozen snapshot as hidden without falling back", () => {
    const absent = input();
    absent.context = { ...absent.context, fields: [] };

    expect(frozenWorkflowFieldActionPolicy(absent)).toMatchObject({
      source: "frozen",
      status: "hidden",
      configured: false,
      configurationValid: true,
      visible: false,
      editable: false,
      legacyFallbackAllowed: false,
    });
  });

  it.each([
    {
      name: "missing module placement",
      reason: "模块",
      mutate(value: FrozenWorkflowFieldActionPolicyInput) {
        value.context = { ...value.context, modulePlacements: [] };
      },
    },
    {
      name: "duplicate module placement",
      reason: "重复",
      mutate(value: FrozenWorkflowFieldActionPolicyInput) {
        value.context = {
          ...value.context,
          modulePlacements: [
            ...value.context.modulePlacements,
            { ...value.context.modulePlacements[0] },
          ],
        };
      },
    },
    {
      name: "duplicate target step",
      reason: "重复",
      mutate(value: FrozenWorkflowFieldActionPolicyInput) {
        value.context = {
          ...value.context,
          currentStepKey: "customs",
          steps: [
            ...value.context.steps,
            { stepKey: "tracking", stepName: "重复运踪", sortOrder: 21 },
          ],
        };
      },
    },
    {
      name: "duplicate current step",
      reason: "绑定",
      mutate(value: FrozenWorkflowFieldActionPolicyInput) {
        value.context = {
          ...value.context,
          steps: [
            ...value.context.steps,
            { stepKey: "tracking", stepName: "重复运踪", sortOrder: 21 },
          ],
        };
      },
    },
    {
      name: "ambiguous equal sort order",
      reason: "顺序冲突",
      mutate(value: FrozenWorkflowFieldActionPolicyInput) {
        value.context = {
          ...value.context,
          currentStepKey: "customs",
          steps: value.context.steps.map((step) =>
            step.stepKey === "customs" ? { ...step, sortOrder: 20 } : step,
          ),
        };
      },
    },
  ])("rejects $name in the frozen graph", ({ mutate, reason }) => {
    const invalid = input();
    mutate(invalid);
    const result = frozenWorkflowFieldActionPolicy(invalid);

    expect(result).toMatchObject({
      source: "frozen",
      status: "invalid",
      configurationValid: false,
      editable: false,
      legacyFallbackAllowed: false,
    });
    expect(result.reason).toContain(reason);
  });

  it("preserves optional mode without weakening the exact-step gate", () => {
    const optional = input();
    optional.context = {
      ...optional.context,
      fields: optional.context.fields.map((field) => ({
        ...field,
        isRequired: false,
      })),
    };

    expect(frozenWorkflowFieldActionPolicy(optional)).toMatchObject({
      status: "editable",
      editable: true,
      isRequired: false,
    });
  });
});
