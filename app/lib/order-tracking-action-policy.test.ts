import { describe, expect, it } from "vitest";
import type { FrozenWorkflowFieldActionPolicy } from "./workflow-field-action-policy";
import {
  orderTrackingActionForMilestone,
  orderTrackingActionFieldKey,
  resolveOrderTrackingActionAccess,
  type OrderTrackingActionAccessMap,
} from "./order-tracking-action-policy";

function policy(
  overrides: Partial<FrozenWorkflowFieldActionPolicy> = {},
): FrozenWorkflowFieldActionPolicy {
  return {
    source: "frozen",
    status: "editable",
    configured: true,
    configurationValid: true,
    visible: true,
    editable: true,
    legacyFallbackAllowed: false,
    stageRelation: "current",
    targetStepKey: "outbound_transport",
    targetStepName: "实际出境及运踪",
    isRequired: true,
    reason: null,
    ...overrides,
  };
}

describe("ordinary-order tracking action policy", () => {
  it.each([
    ["exported", "actual_exit_at"],
    ["actual_exit", "actual_exit_at"],
    ["exit", "actual_exit_at"],
    ["border_arrived", "tracking_milestone"],
    ["customs_cleared", "tracking_milestone"],
  ] as const)("maps milestone %s to frozen field %s", (milestoneCode, fieldKey) => {
    expect(orderTrackingActionFieldKey(milestoneCode)).toBe(fieldKey);
  });

  it("allows an assigned permitted actor only at the exact frozen field node", () => {
    expect(resolveOrderTrackingActionAccess({
      fieldKey: "tracking_milestone",
      policy: policy(),
      canOperate: true,
      legacyCompatibility: "deny",
    })).toMatchObject({
      fieldKey: "tracking_milestone",
      source: "frozen",
      status: "editable",
      visible: true,
      editable: true,
      required: true,
      reason: null,
    });
  });

  it.each([
    ["before", "进入“实际出境及运踪”后开放办理"],
    ["after", "“实际出境及运踪”已结束，仅供查看"],
  ] as const)("keeps a %s frozen field read-only with the shared reason", (stageRelation, reason) => {
    expect(resolveOrderTrackingActionAccess({
      fieldKey: "tracking_milestone",
      policy: policy({
        status: "read_only",
        editable: false,
        stageRelation,
        reason,
      }),
      canOperate: true,
      legacyCompatibility: "deny",
    })).toMatchObject({
      visible: true,
      editable: false,
      status: "read_only",
      reason,
    });
  });

  it("preserves frozen hidden, optional, and invalid field state", () => {
    expect(resolveOrderTrackingActionAccess({
      fieldKey: "actual_exit_at",
      policy: policy({
        status: "hidden",
        visible: false,
        editable: false,
        stageRelation: "invalid",
        isRequired: false,
        reason: "当前冻结工作流已隐藏该字段",
      }),
      canOperate: true,
      legacyCompatibility: "deny",
    })).toMatchObject({ visible: false, editable: false, required: false, status: "hidden" });

    expect(resolveOrderTrackingActionAccess({
      fieldKey: "actual_exit_at",
      policy: policy({ isRequired: false }),
      canOperate: true,
      legacyCompatibility: "deny",
    })).toMatchObject({ visible: true, editable: true, required: false });

    expect(resolveOrderTrackingActionAccess({
      fieldKey: "actual_exit_at",
      policy: policy({
        status: "invalid",
        configurationValid: false,
        editable: false,
        stageRelation: "invalid",
        reason: "冻结字段配置重复",
      }),
      canOperate: true,
      legacyCompatibility: "deny",
    })).toMatchObject({
      visible: true,
      editable: false,
      configurationValid: false,
      status: "invalid",
      reason: "冻结字段配置重复",
    });
  });

  it("does not let module visibility replace assignment and mutation permission", () => {
    const result = resolveOrderTrackingActionAccess({
      fieldKey: "tracking_milestone",
      policy: policy(),
      canOperate: false,
      legacyCompatibility: "deny",
    });
    expect(result).toMatchObject({
      visible: true,
      editable: false,
      status: "not_authorized",
    });
    expect(result.reason).toContain("已分配的运踪负责人");
  });

  it("fails a truly unbound legacy order closed unless compatibility is explicit", () => {
    const legacy = policy({
      source: "legacy",
      status: "legacy_fallback",
      configured: false,
      visible: false,
      editable: false,
      legacyFallbackAllowed: true,
      stageRelation: "legacy",
      targetStepKey: null,
      targetStepName: null,
      isRequired: false,
    });
    expect(resolveOrderTrackingActionAccess({
      fieldKey: "tracking_milestone",
      policy: legacy,
      canOperate: true,
      legacyCompatibility: "deny",
    })).toMatchObject({
      status: "legacy_fallback",
      visible: false,
      editable: false,
    });

    expect(resolveOrderTrackingActionAccess({
      fieldKey: "tracking_milestone",
      policy: legacy,
      canOperate: true,
      legacyCompatibility: { visible: true, required: true },
    })).toMatchObject({
      status: "editable",
      visible: true,
      editable: true,
      required: true,
    });
  });

  it("fails closed when no frozen field policy can be resolved", () => {
    expect(resolveOrderTrackingActionAccess({
      fieldKey: "actual_exit_at",
      policy: null,
      canOperate: true,
      legacyCompatibility: "deny",
    })).toMatchObject({
      status: "invalid",
      configurationValid: false,
      visible: false,
      editable: false,
    });
  });

  it("selects the same action gate the POST must use for the chosen milestone", () => {
    const tracking = resolveOrderTrackingActionAccess({
      fieldKey: "tracking_milestone",
      policy: policy(),
      canOperate: true,
      legacyCompatibility: "deny",
    });
    const exit = resolveOrderTrackingActionAccess({
      fieldKey: "actual_exit_at",
      policy: policy({ status: "read_only", editable: false, reason: "实际出境只读" }),
      canOperate: true,
      legacyCompatibility: "deny",
    });
    const actions: OrderTrackingActionAccessMap = {
      tracking_milestone: tracking,
      actual_exit_at: exit,
    };

    expect(orderTrackingActionForMilestone(actions, "border_arrived")).toBe(tracking);
    expect(orderTrackingActionForMilestone(actions, "exported")).toBe(exit);
  });
});
