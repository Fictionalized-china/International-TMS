import {
  organizationAssigneeCanHandle,
  type OrganizationAssigneeMember,
} from "./organization-assignee";
import { assignedBatchViewPermission } from "./order-access";

export const BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS: Record<
  BatchResponsibilityKind,
  readonly (readonly string[])[]
> = {
  operation: [
    [assignedBatchViewPermission],
    ["order.module.tracking.manage"],
    ["order.module.exceptions.manage"],
  ],
  document: [
    [assignedBatchViewPermission],
    ["order.module.documents.manage"],
    ["order.module.customs.manage"],
  ],
};

export function batchResponsibilityPermissionDisabledReasons(
  members: readonly OrganizationAssigneeMember[],
  kind: BatchResponsibilityKind,
) {
  const requirementLabel = kind === "operation"
    ? "\u914d\u8f7d\u5355\u67e5\u770b\u3001\u8fd0\u8e2a\u529e\u7406\u548c\u5f02\u5e38\u5904\u7406\u6743\u9650"
    : "\u914d\u8f7d\u5355\u67e5\u770b\u3001\u6587\u4ef6\u529e\u7406\u548c\u62a5\u5173\u529e\u7406\u6743\u9650";
  const responsibilityLabel = kind === "operation" ? "\u64cd\u4f5c" : "\u5355\u8bc1";
  return Object.fromEntries(
    members
      .filter((member) => !organizationAssigneeCanHandle(
        member,
        BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS[kind],
      ))
      .map((member) => [
        member.id,
        `\u8be5\u8d26\u53f7\u672a\u540c\u65f6\u5177\u5907${requirementLabel}\uff0c\u4e0d\u80fd\u6307\u6d3e\u4e3a\u6574\u6279${responsibilityLabel}\u8d1f\u8d23\u4eba`,
      ]),
  );
}

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
  return `${userName}是挂载订单 ${orderNumbers.join("、")} 的现有${responsibilityLabel}负责人；如被选中，将继续作为整张 PZ 的统一${responsibilityLabel}负责人。`;
}

/**
 * Keep the mounted orders' current owners for display and audit context. They
 * remain valid candidates for the batch-wide handoff when their account,
 * position and permissions satisfy the ordinary assignment checks.
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
  _restrictions: BatchInitialResponsibilityRestrictions,
  _kind: BatchResponsibilityKind,
) {
  return {} as Record<string, string>;
}

export function findBatchInitialResponsibilityConflict(
  _restrictions: BatchInitialResponsibilityRestrictions,
  _selection: {
    operationAssigneeUserId: string;
    documentAssigneeUserId: string;
  },
): { kind: BatchResponsibilityKind; userId: string; reason: string } | null {
  return null;
}
export function eligibleBatchInitialResponsibilityCandidates(
  members: readonly OrganizationAssigneeMember[],
  _restrictions: BatchInitialResponsibilityRestrictions,
  kind: BatchResponsibilityKind,
) {
  const positionCode = BATCH_RESPONSIBILITY_POSITION_CODES[kind];
  return members.filter(
    (member) =>
      member.position_code === positionCode &&
      organizationAssigneeCanHandle(
        member,
        BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS[kind],
      ),
  );
}

export function batchInitialResponsibilityReadiness(
  members: readonly OrganizationAssigneeMember[],
  restrictions: BatchInitialResponsibilityRestrictions,
) {
  return {
    operation: eligibleBatchInitialResponsibilityCandidates(members, restrictions, "operation"),
    document: eligibleBatchInitialResponsibilityCandidates(members, restrictions, "document"),
    configurationErrors: restrictions.configurationErrors,
  };
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
