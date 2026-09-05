export type WorkflowAssignmentSnapshotRow = {
  moduleStateId: string;
  moduleCode: string;
  moduleName: string;
  stepSortOrder: number;
  moduleSortOrder: number;
  moduleRequired: boolean;
  moduleStatus: string;
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
};

export type OrderAssignmentManifestGroup = {
  key: string;
  positionCode: string | null;
  required: boolean;
  assignmentState: "unassigned" | "partial" | "assigned" | "mixed";
  assigneeUserId: string | null;
  modules: OrderAssignmentManifestModule[];
};

export type OrderAssignmentManifest = {
  groups: OrderAssignmentManifestGroup[];
  configurationErrors: string[];
};

export function orderAssignmentAssigneeFieldName(groupKey: string) {
  return `assignmentAssignee:${encodeURIComponent(groupKey)}`;
}

export function missingRequiredOrderAssignmentGroupKeys(
  groups: readonly OrderAssignmentManifestGroup[],
  assigneeUserIds: Readonly<Record<string, string | null | undefined>>,
) {
  return groups
    .filter((group) =>
      group.required &&
      !(assigneeUserIds[group.key] || group.assigneeUserId),
    )
    .map((group) => group.key);
}

export function nextRequiredOrderAssignmentGroup(
  groups: readonly OrderAssignmentManifestGroup[],
) {
  return groups.find((group) => group.required && Boolean(group.positionCode)) ?? null;
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
    const effectiveAssigneeUserId = row.taskStateId
      ? row.taskAssigneeUserId ?? (
          positionCode === row.modulePositionCode ? row.moduleAssigneeUserId : null
        )
      : row.moduleAssigneeUserId;
    assignmentIds.get(key)?.push(effectiveAssigneeUserId);
  }

  for (const [key, group] of groupMap) {
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
