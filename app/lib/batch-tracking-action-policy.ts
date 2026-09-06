import type { FrozenWorkflowFieldActionPolicy } from "./workflow-field-action-policy";

export type BatchTrackingOrderActionPolicy = {
  orderId: string;
  orderNumber?: string | null;
  policy: FrozenWorkflowFieldActionPolicy;
};

export type BatchTrackingActionPolicy = {
  status: FrozenWorkflowFieldActionPolicy["status"];
  configurationValid: boolean;
  visible: boolean;
  editable: boolean;
  participatingOrderIds: string[];
  editableOrderIds: string[];
  readOnlyOrderIds: string[];
  hiddenOrderIds: string[];
  invalidOrderIds: string[];
  legacyFallbackOrderIds: string[];
  reason: string | null;
};

function orderLabel(item: BatchTrackingOrderActionPolicy) {
  return item.orderNumber?.trim() || item.orderId;
}

function resultBase(
  items: readonly BatchTrackingOrderActionPolicy[],
): Omit<
  BatchTrackingActionPolicy,
  "status" | "configurationValid" | "visible" | "editable" | "reason"
> {
  return {
    participatingOrderIds: items
      .filter((item) => item.policy.visible)
      .map((item) => item.orderId),
    editableOrderIds: items
      .filter((item) => item.policy.editable)
      .map((item) => item.orderId),
    readOnlyOrderIds: items
      .filter((item) => item.policy.status === "read_only")
      .map((item) => item.orderId),
    hiddenOrderIds: items
      .filter((item) => item.policy.status === "hidden")
      .map((item) => item.orderId),
    invalidOrderIds: items
      .filter((item) => item.policy.status === "invalid")
      .map((item) => item.orderId),
    legacyFallbackOrderIds: items
      .filter((item) => item.policy.status === "legacy_fallback")
      .map((item) => item.orderId),
  };
}

/**
 * Collapse per-order frozen field gates into one safe PZ action gate. Hidden
 * orders do not participate in the shared write. Any invalid, unresolved
 * legacy, future or historical participant prevents a partial batch write.
 */
export function aggregateBatchTrackingActionPolicies(
  items: readonly BatchTrackingOrderActionPolicy[],
): BatchTrackingActionPolicy {
  const base = resultBase(items);
  if (items.length === 0) {
    return {
      ...base,
      status: "invalid",
      configurationValid: false,
      visible: false,
      editable: false,
      reason: "配载单没有可核验的挂载订单，不能办理批量运踪",
    };
  }

  const invalid = items.find((item) => item.policy.status === "invalid");
  if (invalid) {
    return {
      ...base,
      status: "invalid",
      configurationValid: false,
      visible: base.participatingOrderIds.length > 0,
      editable: false,
      reason: `订单 ${orderLabel(invalid)} 的冻结工作流配置异常：${invalid.policy.reason ?? "运踪字段无法解析"}`,
    };
  }

  const legacy = items.find(
    (item) => item.policy.status === "legacy_fallback",
  );
  if (legacy) {
    return {
      ...base,
      status: "legacy_fallback",
      configurationValid: true,
      visible: base.participatingOrderIds.length > 0,
      editable: false,
      reason: `订单 ${orderLabel(legacy)} 未绑定冻结工作流，需先应用历史订单兼容策略`,
    };
  }

  if (base.participatingOrderIds.length === 0) {
    return {
      ...base,
      status: "hidden",
      configurationValid: true,
      visible: false,
      editable: false,
      reason: "挂载订单的冻结工作流均未开放该运踪字段",
    };
  }

  const readOnly = items.find(
    (item) => item.policy.status === "read_only",
  );
  if (readOnly) {
    return {
      ...base,
      status: "read_only",
      configurationValid: true,
      visible: true,
      editable: false,
      reason: `订单 ${orderLabel(readOnly)} 当前仅可查看：${readOnly.policy.reason ?? "未处于该字段的办理节点"}`,
    };
  }

  return {
    ...base,
    status: "editable",
    configurationValid: true,
    visible: true,
    editable: true,
    reason: null,
  };
}
