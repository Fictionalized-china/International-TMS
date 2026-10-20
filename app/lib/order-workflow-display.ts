export type DisplayableWorkflowStep<Row = unknown> = {
  step_key: string;
  name: string;
  sort_order: number;
  rows?: Row[];
};

export type DisplayWorkflowStep<T extends DisplayableWorkflowStep> = T & {
  member_step_keys: string[];
};

const REVIEW_ASSIGNMENT_KEYS = ["consignment_approval", "task_assignment"] as const;

export function hasReviewAssignmentWorkspace(steps: readonly DisplayableWorkflowStep[]) {
  const approvalIndex = steps.findIndex((step) => step.step_key === REVIEW_ASSIGNMENT_KEYS[0]);
  return approvalIndex >= 0 && steps[approvalIndex + 1]?.step_key === REVIEW_ASSIGNMENT_KEYS[1];
}

/** Keep both checkpoint links on the currently actionable part of the same page. */
export function resolveReviewAssignmentStep(
  steps: readonly DisplayableWorkflowStep[],
  selectedStepKey: string,
  currentStepKey: string | null | undefined,
) {
  if (hasReviewAssignmentWorkspace(steps) &&
    REVIEW_ASSIGNMENT_KEYS.some((key) => key === selectedStepKey) &&
    REVIEW_ASSIGNMENT_KEYS.some((key) => key === currentStepKey)) {
    return currentStepKey!;
  }
  return selectedStepKey;
}

/**
 * These two persisted checkpoints remain separate for approval and assignment
 * guards, but appear as one operator-facing stage. The active persisted key is
 * kept as the group's link target so submitting approval opens assignment next.
 */
export function displayWorkflowSteps<T extends DisplayableWorkflowStep>(
  steps: T[],
  activeStepKey: string | null | undefined,
): DisplayWorkflowStep<T>[] {
  const approvalIndex = steps.findIndex((step) => step.step_key === REVIEW_ASSIGNMENT_KEYS[0]);
  const assignmentIndex = steps.findIndex((step) => step.step_key === REVIEW_ASSIGNMENT_KEYS[1]);
  if (approvalIndex < 0 || assignmentIndex < 0 || assignmentIndex !== approvalIndex + 1) {
    return steps.map((step) => ({ ...step, member_step_keys: [step.step_key] }));
  }

  const approval = steps[approvalIndex];
  const assignment = steps[assignmentIndex];
  const selectedKey = REVIEW_ASSIGNMENT_KEYS.includes(activeStepKey as typeof REVIEW_ASSIGNMENT_KEYS[number])
    ? activeStepKey!
    : assignment.step_key;
  const merged = {
    ...approval,
    step_key: selectedKey,
    name: "审核分配",
    sort_order: Math.min(approval.sort_order, assignment.sort_order),
    ...(approval.rows || assignment.rows
      ? { rows: [...(approval.rows ?? []), ...(assignment.rows ?? [])] }
      : {}),
    member_step_keys: [...REVIEW_ASSIGNMENT_KEYS],
  } as DisplayWorkflowStep<T>;
  return [
    ...steps.slice(0, approvalIndex).map((step) => ({ ...step, member_step_keys: [step.step_key] })),
    merged,
    ...steps.slice(assignmentIndex + 1).map((step) => ({ ...step, member_step_keys: [step.step_key] })),
  ];
}
