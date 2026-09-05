export type BatchResponsibilityKind = "operation" | "document";

export const BATCH_RESPONSIBILITY_POSITION_CODES: Record<
  BatchResponsibilityKind,
  "OPERATION" | "DOC"
> = {
  operation: "OPERATION",
  document: "DOC",
};

export type BatchOriginalResponsibilityAssignment = {
  orderId: string;
  orderNumber: string;
  moduleCode: string;
  positionCode: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
};

export type BatchInitialAssigneeRestriction = {
  userId: string;
  userName: string;
  orderNumbers: string[];
  moduleCodes: string[];
  reason: string;
};

export type BatchInitialResponsibilityRestrictions = Record<
  BatchResponsibilityKind,
  BatchInitialAssigneeRestriction[]
> & {
  configurationErrors: string[];
};

export type BatchResponsibilityManifest = {
  workflowInstanceId: string | null;
  configurationErrors: string[];
  groups: Array<{
    positionCode: string | null;
    modules: Array<{
      moduleCode: string;
      primaryOwner: boolean;
      taskStateIds: string[];
    }>;
  }>;
};

export type BatchResponsibilityTransferTarget = {
  orderId: string;
  workflowInstanceId: string;
  positionCode: "OPERATION" | "DOC";
  assigneeUserId: string;
  moduleCodes: string[];
  primaryModuleCodes: string[];
  taskStateIds: string[];
};

export function buildConfiguredBatchResponsibilityTargets(input: {
  orderId: string;
  manifest: BatchResponsibilityManifest;
  operationAssigneeUserId: string;
  documentAssigneeUserId: string;
}): BatchResponsibilityTransferTarget[] {
  if (!input.manifest.workflowInstanceId) {
    throw new Error("挂载订单尚未锁定工作流实例，不能按配置交接配载单职责");
  }
  if (input.manifest.configurationErrors.length) {
    throw new Error(`挂载订单工作流责任配置不完整：${input.manifest.configurationErrors.join("；")}`);
  }
  return input.manifest.groups.flatMap((group) => {
    if (
      group.positionCode !== BATCH_RESPONSIBILITY_POSITION_CODES.operation &&
      group.positionCode !== BATCH_RESPONSIBILITY_POSITION_CODES.document
    ) return [];
    return [{
      orderId: input.orderId,
      workflowInstanceId: input.manifest.workflowInstanceId!,
      positionCode: group.positionCode,
      assigneeUserId: group.positionCode === BATCH_RESPONSIBILITY_POSITION_CODES.operation
        ? input.operationAssigneeUserId
        : input.documentAssigneeUserId,
      moduleCodes: [...new Set(group.modules.map((module) => module.moduleCode))],
      primaryModuleCodes: [...new Set(
        group.modules.filter((module) => module.primaryOwner).map((module) => module.moduleCode),
      )],
      taskStateIds: [...new Set(group.modules.flatMap((module) => module.taskStateIds))],
    }];
  });
}

function responsibilityKindForPosition(positionCode: string): BatchResponsibilityKind | null {
  if (positionCode === BATCH_RESPONSIBILITY_POSITION_CODES.operation) return "operation";
  if (positionCode === BATCH_RESPONSIBILITY_POSITION_CODES.document) return "document";
  return null;
}

function restrictionReason(
  kind: BatchResponsibilityKind,
  userName: string,
  orderNumbers: readonly string[],
) {
  const responsibilityLabel = kind === "operation" ? "操作" : "单证";
  return `${userName}是挂载订单 ${orderNumbers.join("、")} 的原${responsibilityLabel}负责人；PZ 首次统一分配必须更换新${responsibilityLabel}负责人。`;
}

/**
 * A PZ handoff deliberately changes the people who own shared downstream work.
 * Every former downstream owner from every mounted order is therefore excluded,
 * not just the owner found on the first order.
 */
export function buildBatchInitialResponsibilityRestrictions(
  assignments: readonly BatchOriginalResponsibilityAssignment[],
): BatchInitialResponsibilityRestrictions {
  const grouped: Record<BatchResponsibilityKind, Map<string, Omit<BatchInitialAssigneeRestriction, "reason">>> = {
    operation: new Map(),
    document: new Map(),
  };

  for (const assignment of assignments) {
    const kind = responsibilityKindForPosition(assignment.positionCode);
    if (!kind || !assignment.assigneeUserId) continue;
    const existing = grouped[kind].get(assignment.assigneeUserId);
    if (existing) {
      if (!existing.orderNumbers.includes(assignment.orderNumber)) {
        existing.orderNumbers.push(assignment.orderNumber);
      }
      if (!existing.moduleCodes.includes(assignment.moduleCode)) {
        existing.moduleCodes.push(assignment.moduleCode);
      }
      continue;
    }
    grouped[kind].set(assignment.assigneeUserId, {
      userId: assignment.assigneeUserId,
      userName: assignment.assigneeName?.trim() || assignment.assigneeUserId,
      orderNumbers: [assignment.orderNumber],
      moduleCodes: [assignment.moduleCode],
    });
  }

  return {
    operation: Array.from(grouped.operation.values(), (item) => ({
      ...item,
      reason: restrictionReason("operation", item.userName, item.orderNumbers),
    })),
    document: Array.from(grouped.document.values(), (item) => ({
      ...item,
      reason: restrictionReason("document", item.userName, item.orderNumbers),
    })),
    configurationErrors: [],
  };
}

export function batchInitialResponsibilityDisabledReasons(
  restrictions: BatchInitialResponsibilityRestrictions,
  kind: BatchResponsibilityKind,
) {
  return Object.fromEntries(
    restrictions[kind].map((restriction) => [restriction.userId, restriction.reason]),
  );
}

export function findBatchInitialResponsibilityConflict(
  restrictions: BatchInitialResponsibilityRestrictions,
  selection: {
    operationAssigneeUserId: string;
    documentAssigneeUserId: string;
  },
): { kind: BatchResponsibilityKind; userId: string; reason: string } | null {
  for (const kind of ["operation", "document"] as const) {
    const selectedUserId = kind === "operation"
      ? selection.operationAssigneeUserId
      : selection.documentAssigneeUserId;
    const restriction = restrictions[kind].find((item) => item.userId === selectedUserId);
    if (restriction) return { kind, userId: selectedUserId, reason: restriction.reason };
  }
  return null;
}

export function batchRequiresSupervisorApproval(batchNumber: string) {
  return batchNumber.startsWith("PZ-");
}

export function canOrdinaryReassignBatchResponsibility(input: {
  batchNumber: string;
  approvalStatus: string;
  roadStatus: string;
  actualDepartureAt: string | null;
}) {
  return (
    batchRequiresSupervisorApproval(input.batchNumber) &&
    input.approvalStatus === "approved" &&
    !input.actualDepartureAt &&
    !["outbound_in_transit", "overseas_arrived", "waiting_pickup", "pickup_completed"].includes(input.roadStatus)
  );
}

export function batchSharedResponsibilityIsActive(roadStatus: string) {
  return !["overseas_arrived", "waiting_pickup", "pickup_completed"].includes(roadStatus);
}
