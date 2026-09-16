export type WorkflowAssignmentSnapshotRow = {
  moduleStateId: string;
  moduleCode: string;
  moduleName: string;
  stepKey: string;
  stepSortOrder: number;
  moduleSortOrder: number;
  moduleRequired: boolean;
  moduleStatus: string;
  moduleCompletionMode: string;
  modulePositionCode: string | null;
  moduleAssigneeUserId: string | null;
  taskStateId: string | null;
  taskKey: string | null;
  taskName: string | null;
  taskSortOrder: number | null;
  taskRequired: boolean | null;
  taskStatus: string | null;
  taskPositionCode: string | null;
  taskAssigneeUserId: string | null;
};

export type OrderAssignmentManifestModule = {
  moduleCode: string;
  moduleName: string;
  required: boolean;
  primaryOwner: boolean;
  moduleStateIds: string[];
  taskStateIds: string[];
  taskKeys: string[];
  taskNames: string[];
  workflowNodes: OrganizationAssigneeWorkflowNode[];
};

export type OrderAssignmentManifestGroup = {
  key: string;
  positionCode: string | null;
  assignmentMode: "person" | "site_queue";
  required: boolean;
  assignmentState: "unassigned" | "partial" | "assigned" | "mixed";
  assigneeUserId: string | null;
  modules: OrderAssignmentManifestModule[];
};

export type OrderAssignmentManifest = {
  groups: OrderAssignmentManifestGroup[];
  configurationErrors: string[];
};

export const physicalWarehouseQueuePositionCodes = [
  "WAREHOUSE",
  "OVERSEAS_WAREHOUSE",
] as const;

export function orderAssignmentMode(positionCode: string | null) {
  return positionCode && physicalWarehouseQueuePositionCodes.includes(
    positionCode as (typeof physicalWarehouseQueuePositionCodes)[number],
  ) ? "site_queue" as const : "person" as const;
}

export function orderAssignmentPermissionRequirements(input: {
  assignmentMode: "person" | "site_queue";
  positionCode: string | null;
  moduleCodes: readonly string[];
}): string[][] {
  if (input.assignmentMode === "site_queue") return [];
  // Node responsibility now grants the business operation itself. Keep only
  // cross-cutting safety capabilities that are not represented by a workflow
  // module and therefore must not be inferred from node ownership.
  const requirements: string[][] = [["order.view"]];
  if (
    input.positionCode === "FINANCE_ACCOUNTING" &&
    input.moduleCodes.includes("review")
  ) requirements.push(["billing.expense.approve"]);
  const seen = new Set<string>();
  return requirements.filter((alternatives) => {
    const key = [...alternatives].sort().join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function orderAssignmentGroupPermissionRequirements(
  group: Pick<OrderAssignmentManifestGroup, "assignmentMode" | "positionCode" | "modules">,
): string[][] {
  return orderAssignmentPermissionRequirements({
    assignmentMode: group.assignmentMode,
    positionCode: group.positionCode,
    moduleCodes: group.modules.map((module) => module.moduleCode),
  });
}

export function orderAssignmentAssigneeFieldName(groupKey: string) {
  return `assignmentAssignee:${encodeURIComponent(groupKey)}`;
}

export function orderAssignmentCandidateConfigurationErrors(
  groups: readonly OrderAssignmentManifestGroup[],
  members: readonly Pick<
    OrganizationAssigneeMember,
    "position_code" | "permission_codes" | "permission_override_entries"
  >[],
) {
  return groups.flatMap((group) => {
    if (
      !group.required ||
      group.assignmentMode !== "person" ||
      !group.positionCode
    ) return [];
    const workflowNodes = group.modules.flatMap((module) => module.workflowNodes);
    const safetyRequirements = orderAssignmentGroupPermissionRequirements(group);
    if (!members.some((member) =>
      organizationAssigneeCanHandleWorkflowNodes(
        member,
        group.positionCode!,
        workflowNodes,
      ) && organizationAssigneeCanHandle(member, safetyRequirements)
    )) {
      return [
        `${group.positionCode} 责任暂无符合节点资格的有效个人账户`,
      ];
    }
    return [];
  });
}

export function missingRequiredOrderAssignmentGroupKeys(
  groups: readonly OrderAssignmentManifestGroup[],
  assigneeUserIds: Readonly<Record<string, string | null | undefined>>,
) {
  return groups
    .filter((group) =>
      group.required &&
      group.assignmentMode === "person" &&
      !(assigneeUserIds[group.key] || group.assigneeUserId),
    )
    .map((group) => group.key);
}

export function nextRequiredOrderAssignmentGroup(
  groups: readonly OrderAssignmentManifestGroup[],
) {
  return groups.find((group) =>
    group.required &&
    group.assignmentMode === "person" &&
    Boolean(group.positionCode),
  ) ?? null;
}

export function buildOrderAssignmentManifest(
  rows: readonly WorkflowAssignmentSnapshotRow[],
): OrderAssignmentManifest {
  const groupMap = new Map<string, OrderAssignmentManifestGroup>();
  const assignmentIds = new Map<string, Array<string | null>>();
  const modulePositionMatches = new Map<string, boolean>();

  const orderedRows = [...rows].sort((left, right) =>
    left.stepSortOrder - right.stepSortOrder ||
    left.moduleSortOrder - right.moduleSortOrder ||
    (left.taskSortOrder ?? -1) - (right.taskSortOrder ?? -1) ||
    left.moduleStateId.localeCompare(right.moduleStateId) ||
    (left.taskStateId ?? "").localeCompare(right.taskStateId ?? ""),
  );
  for (const row of orderedRows) {
    if (
      row.moduleCompletionMode === "automatic" ||
      ["completed", "not_applicable"].includes(row.moduleStatus) ||
      (row.taskStatus && ["completed", "not_applicable"].includes(row.taskStatus))
    ) continue;
    const positionCode = row.taskStateId
      ? row.taskPositionCode ?? row.modulePositionCode
      : row.modulePositionCode;
    const key = positionCode ? `position:${positionCode}` : `unconfigured:${row.moduleStateId}`;
    const required = row.moduleRequired && (row.taskStateId ? row.taskRequired !== false : true);
    let group = groupMap.get(key);
    if (!group) {
      group = {
        key,
        positionCode,
        assignmentMode: orderAssignmentMode(positionCode),
        required,
        assignmentState: "unassigned",
        assigneeUserId: null,
        modules: [],
      };
      groupMap.set(key, group);
      assignmentIds.set(key, []);
    }
    group.required ||= required;
    let module = group.modules.find((item) => item.moduleCode === row.moduleCode);
    if (!module) {
      module = {
        moduleCode: row.moduleCode,
        moduleName: row.moduleName,
        required,
        primaryOwner: false,
        moduleStateIds: [],
        taskStateIds: [],
        taskKeys: [],
        taskNames: [],
        workflowNodes: [],
      };
      group.modules.push(module);
    }
    module.required ||= required;
    const moduleGroupKey = `${key}\u0000${row.moduleCode}`;
    modulePositionMatches.set(
      moduleGroupKey,
      Boolean(modulePositionMatches.get(moduleGroupKey)) ||
        Boolean(positionCode && positionCode === row.modulePositionCode),
    );
    if (!module.moduleStateIds.includes(row.moduleStateId))
      module.moduleStateIds.push(row.moduleStateId);
    if (row.taskStateId && !module.taskStateIds.includes(row.taskStateId))
      module.taskStateIds.push(row.taskStateId);
    if (row.taskKey && !module.taskKeys.includes(row.taskKey))
      module.taskKeys.push(row.taskKey);
    if (row.taskName && !module.taskNames.includes(row.taskName))
      module.taskNames.push(row.taskName);
    if (!module.workflowNodes.some(
      (node) => node.stepKey === row.stepKey && node.moduleCode === row.moduleCode,
    )) {
      module.workflowNodes.push({ stepKey: row.stepKey, moduleCode: row.moduleCode });
    }
    const effectiveAssigneeUserId = row.taskStateId
      ? row.taskAssigneeUserId ?? (
          positionCode === row.modulePositionCode ? row.moduleAssigneeUserId : null
        )
      : row.moduleAssigneeUserId;
    assignmentIds.get(key)?.push(effectiveAssigneeUserId);
  }

  for (const [key, group] of groupMap) {
    if (group.assignmentMode === "site_queue") {
      group.assignmentState = "assigned";
      group.assigneeUserId = null;
      continue;
    }
    const assignments = assignmentIds.get(key) ?? [];
    const assigned = assignments.filter((userId): userId is string => Boolean(userId));
    const unique = [...new Set(assigned)];
    group.assignmentState = assigned.length === 0
      ? "unassigned"
      : assigned.length < assignments.length
        ? "partial"
        : unique.length === 1
          ? "assigned"
          : "mixed";
    group.assigneeUserId = group.assignmentState === "assigned" ? unique[0] : null;
  }

  const groups = [...groupMap.values()];
  const moduleCandidates = new Map<
    string,
    Array<{ group: OrderAssignmentManifestGroup; module: OrderAssignmentManifestModule }>
  >();
  for (const group of groups) {
    for (const module of group.modules) {
      const candidates = moduleCandidates.get(module.moduleCode) ?? [];
      candidates.push({ group, module });
      moduleCandidates.set(module.moduleCode, candidates);
    }
  }
  for (const candidates of moduleCandidates.values()) {
    const primary = candidates.find(({ group, module }) =>
      modulePositionMatches.get(`${group.key}\u0000${module.moduleCode}`),
    ) ?? candidates.find(({ module }) => module.required) ?? candidates[0];
    if (primary) primary.module.primaryOwner = true;
  }
  return {
    groups,
    configurationErrors: groups
      .filter((group) => group.required && !group.positionCode)
      .map((group) => `${group.modules.map((module) => module.moduleName).join("、")}未配置责任岗位`),
  };
}
import {
  organizationAssigneeCanHandle,
  organizationAssigneeCanHandleWorkflowNodes,
  type OrganizationAssigneeMember,
  type OrganizationAssigneeWorkflowNode,
} from "./organization-assignee";
