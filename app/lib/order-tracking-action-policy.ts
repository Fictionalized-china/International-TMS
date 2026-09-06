import { isActualExitTrackingMilestone } from "./batch-tracking.shared";
import type { FrozenWorkflowFieldActionPolicy } from "./workflow-field-action-policy";

export const orderTrackingActionFieldKeys = [
  "tracking_milestone",
  "actual_exit_at",
] as const;

export type OrderTrackingActionFieldKey =
  (typeof orderTrackingActionFieldKeys)[number];

export type OrderTrackingLegacyCompatibility =
  | "deny"
  | { visible: true; required: boolean };

export type OrderTrackingActionAccess = {
  fieldKey: OrderTrackingActionFieldKey;
  source: FrozenWorkflowFieldActionPolicy["source"];
  status: FrozenWorkflowFieldActionPolicy["status"] | "not_authorized";
  configured: boolean;
  configurationValid: boolean;
  visible: boolean;
  editable: boolean;
  required: boolean;
  stageRelation: FrozenWorkflowFieldActionPolicy["stageRelation"];
  targetStepKey: string | null;
  targetStepName: string | null;
  reason: string | null;
};

export type OrderTrackingActionAccessMap = Record<
  OrderTrackingActionFieldKey,
  OrderTrackingActionAccess
>;

const assignmentReason =
  "当前账号不是本单已分配的运踪负责人，或缺少运踪办理权限";

export function orderTrackingActionFieldKey(
  milestoneCode: string,
): OrderTrackingActionFieldKey {
  return isActualExitTrackingMilestone(milestoneCode)
    ? "actual_exit_at"
    : "tracking_milestone";
}

export function resolveOrderTrackingActionAccess(input: {
  fieldKey: OrderTrackingActionFieldKey;
  policy: FrozenWorkflowFieldActionPolicy | null;
  canOperate: boolean;
  legacyCompatibility: OrderTrackingLegacyCompatibility;
}): OrderTrackingActionAccess {
  if (!input.policy) {
    return {
      fieldKey: input.fieldKey,
      source: "frozen",
      status: "invalid",
      configured: false,
      configurationValid: false,
      visible: false,
      editable: false,
      required: false,
      stageRelation: "invalid",
      targetStepKey: null,
      targetStepName: null,
      reason: "冻结工作流字段门禁无法解析，当前运踪操作已关闭",
    };
  }

  const policy = input.policy;
  if (policy.status === "legacy_fallback") {
    if (input.legacyCompatibility === "deny") {
      return {
        fieldKey: input.fieldKey,
        source: policy.source,
        status: policy.status,
        configured: policy.configured,
        configurationValid: policy.configurationValid,
        visible: false,
        editable: false,
        required: false,
        stageRelation: policy.stageRelation,
        targetStepKey: policy.targetStepKey,
        targetStepName: policy.targetStepName,
        reason: "订单未绑定冻结工作流，当前运踪操作已关闭；如需兼容必须显式启用历史订单策略",
      };
    }
    return {
      fieldKey: input.fieldKey,
      source: policy.source,
      status: input.canOperate ? "editable" : "not_authorized",
      configured: false,
      configurationValid: true,
      visible: input.legacyCompatibility.visible,
      editable: input.canOperate,
      required: input.legacyCompatibility.required,
      stageRelation: "legacy",
      targetStepKey: null,
      targetStepName: null,
      reason: input.canOperate ? null : assignmentReason,
    };
  }

  const authorizationBlocked = policy.editable && !input.canOperate;
  return {
    fieldKey: input.fieldKey,
    source: policy.source,
    status: authorizationBlocked ? "not_authorized" : policy.status,
    configured: policy.configured,
    configurationValid: policy.configurationValid,
    visible: policy.visible,
    editable: policy.editable && input.canOperate,
    required: policy.isRequired,
    stageRelation: policy.stageRelation,
    targetStepKey: policy.targetStepKey,
    targetStepName: policy.targetStepName,
    reason: authorizationBlocked ? assignmentReason : policy.reason,
  };
}

export function orderTrackingActionForMilestone(
  actions: OrderTrackingActionAccessMap,
  milestoneCode: string,
) {
  return actions[orderTrackingActionFieldKey(milestoneCode)];
}

/**
 * Departure readiness is a one-way gate. Once port arrival has been persisted,
 * later tracking nodes must rely on their sequence prerequisite instead of
 * reopening a gate whose planning data may already have been archived or
 * projected into a tracking batch.
 */
export function trackingMilestoneNeedsDepartureReadiness(
  milestoneCode: string,
  recordedCodes: Iterable<string>,
) {
  return (
    milestoneCode === "border_arrived" &&
    !new Set(recordedCodes).has("border_arrived")
  );
}
