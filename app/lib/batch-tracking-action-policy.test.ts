import { describe, expect, it } from "vitest";
import { aggregateBatchTrackingActionPolicies } from "./batch-tracking-action-policy";
import type { FrozenWorkflowFieldActionPolicy } from "./workflow-field-action-policy";

function policy(
  status: FrozenWorkflowFieldActionPolicy["status"],
): FrozenWorkflowFieldActionPolicy {
  const editable = status === "editable";
  const hidden = status === "hidden";
  const invalid = status === "invalid";
  const legacy = status === "legacy_fallback";
  return {
    source: legacy ? "legacy" : "frozen",
    status,
    configured: !legacy,
    configurationValid: !invalid,
    visible: !hidden && !legacy,
    editable,
    legacyFallbackAllowed: legacy,
    stageRelation: legacy
      ? "legacy"
      : invalid || hidden
        ? "invalid"
        : editable
          ? "current"
          : "before",
    targetStepKey: legacy ? null : "tracking",
    targetStepName: legacy ? null : "实际出境及运踪",
    isRequired: true,
    reason: editable || legacy ? null : `${status} reason`,
  };
}

describe("batch tracking action aggregation", () => {
  it("enables one batch action when every participating order is editable", () => {
    expect(aggregateBatchTrackingActionPolicies([
      { orderId: "order-1", orderNumber: "SO-001", policy: policy("editable") },
      { orderId: "order-2", orderNumber: "SO-002", policy: policy("editable") },
      { orderId: "order-hidden", orderNumber: "SO-003", policy: policy("hidden") },
    ])).toEqual({
      status: "editable",
      configurationValid: true,
      visible: true,
      editable: true,
      participatingOrderIds: ["order-1", "order-2"],
      editableOrderIds: ["order-1", "order-2"],
      readOnlyOrderIds: [],
      hiddenOrderIds: ["order-hidden"],
      invalidOrderIds: [],
      legacyFallbackOrderIds: [],
      reason: null,
    });
  });

  it("keeps the whole batch read-only when one participating order is before or after its field step", () => {
    const result = aggregateBatchTrackingActionPolicies([
      { orderId: "order-1", orderNumber: "SO-001", policy: policy("editable") },
      { orderId: "order-2", orderNumber: "SO-002", policy: policy("read_only") },
    ]);

    expect(result).toMatchObject({
      status: "read_only",
      configurationValid: true,
      visible: true,
      editable: false,
      participatingOrderIds: ["order-1", "order-2"],
      editableOrderIds: ["order-1"],
      readOnlyOrderIds: ["order-2"],
    });
    expect(result.reason).toContain("SO-002");
  });

  it("fails the batch closed when any frozen order has invalid configuration", () => {
    const result = aggregateBatchTrackingActionPolicies([
      { orderId: "order-1", policy: policy("editable") },
      { orderId: "order-invalid", orderNumber: "SO-BAD", policy: policy("invalid") },
    ]);

    expect(result).toMatchObject({
      status: "invalid",
      configurationValid: false,
      editable: false,
      invalidOrderIds: ["order-invalid"],
      legacyFallbackOrderIds: [],
    });
    expect(result.reason).toContain("SO-BAD");
  });

  it("requests legacy resolution instead of silently opening a truly unbound order", () => {
    const result = aggregateBatchTrackingActionPolicies([
      { orderId: "order-1", policy: policy("editable") },
      { orderId: "legacy-order", orderNumber: "SO-LEGACY", policy: policy("legacy_fallback") },
    ]);

    expect(result).toMatchObject({
      status: "legacy_fallback",
      configurationValid: true,
      editable: false,
      legacyFallbackOrderIds: ["legacy-order"],
    });
    expect(result.reason).toContain("SO-LEGACY");
  });

  it("hides the batch action when every frozen order hides the field", () => {
    expect(aggregateBatchTrackingActionPolicies([
      { orderId: "order-1", policy: policy("hidden") },
      { orderId: "order-2", policy: policy("hidden") },
    ])).toMatchObject({
      status: "hidden",
      configurationValid: true,
      visible: false,
      editable: false,
      participatingOrderIds: [],
      hiddenOrderIds: ["order-1", "order-2"],
    });
  });

  it("fails closed for an empty batch instead of manufacturing an editable action", () => {
    expect(aggregateBatchTrackingActionPolicies([])).toMatchObject({
      status: "invalid",
      configurationValid: false,
      visible: false,
      editable: false,
    });
  });
});
