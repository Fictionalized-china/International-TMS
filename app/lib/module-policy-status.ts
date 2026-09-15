export const workflowFieldBlockerPrefixes = [
  "请先补齐必填字段：",
  "请先补齐当前工作流要求的字段：",
  "请填写当前模板要求的字段：",
  "待补录必填字段：",
] as const;

export const documentRequirementBlockerPrefix = "必填文件待审核通过：";

export function isWorkflowFieldManagedBlocker(reason: string | null) {
  return Boolean(
    reason && workflowFieldBlockerPrefixes.some((prefix) => reason.startsWith(prefix)),
  );
}

export function isDocumentRequirementManagedBlocker(reason: string | null) {
  return Boolean(reason?.startsWith(documentRequirementBlockerPrefix));
}

export function reconcileWorkflowFieldBlocker(input: {
  status: string;
  blockingReason: string | null;
  startedAt: string | null;
  missingLabels: readonly string[];
  blockerPrefix?: string;
}) {
  if (["completed", "not_applicable"].includes(input.status)) {
    return { status: input.status, blockingReason: input.blockingReason, changed: false };
  }
  const managed = isWorkflowFieldManagedBlocker(input.blockingReason);
  if (input.missingLabels.length) {
    if (input.blockingReason && !managed) {
      return { status: input.status, blockingReason: input.blockingReason, changed: false };
    }
    const blockingReason = `${input.blockerPrefix ?? workflowFieldBlockerPrefixes[0]}${input.missingLabels.join("、")}`;
    return {
      status: "blocked",
      blockingReason,
      changed: input.status !== "blocked" || input.blockingReason !== blockingReason,
    };
  }
  if (!managed) {
    return { status: input.status, blockingReason: input.blockingReason, changed: false };
  }
  return {
    status: input.status === "blocked" ? (input.startedAt ? "in_progress" : "not_started") : input.status,
    blockingReason: null,
    changed: true,
  };
}

export function reconcileDocumentsModuleState(input: {
  status: string;
  blockingReason: string | null;
  requiredLabels: readonly string[];
  incompleteLabels: readonly string[];
  optionalPendingLabels: readonly string[];
}) {
  if (input.status === "not_applicable") {
    return {
      status: input.status,
      blockingReason: input.blockingReason,
      stepCode: null,
      stepName: null,
      progress: 0,
      complete: false,
      changed: false,
    };
  }
  const managed = isDocumentRequirementManagedBlocker(input.blockingReason) ||
    isWorkflowFieldManagedBlocker(input.blockingReason);
  if (input.blockingReason && !managed) {
    return {
      status: input.status,
      blockingReason: input.blockingReason,
      stepCode: null,
      stepName: null,
      progress: null,
      complete: false,
      changed: false,
    };
  }
  const complete = input.incompleteLabels.length === 0;
  const blockingReason = complete
    ? null
    : `${documentRequirementBlockerPrefix}${input.incompleteLabels.join("、")}`;
  const approvedCount = Math.max(
    0,
    input.requiredLabels.length - input.incompleteLabels.length,
  );
  return {
    status: complete ? "completed" : "blocked",
    blockingReason,
    stepCode: complete ? "archived" : "checking",
    stepName: complete
      ? input.optionalPendingLabels.length
        ? "必填资料齐全，选填文件待审"
        : "必填资料齐全"
      : "必填资料检查",
    progress: complete
      ? 100
      : Math.max(
          25,
          Math.round(25 + 75 * (approvedCount / Math.max(1, input.requiredLabels.length))),
        ),
    complete,
    changed: true,
  };
}
