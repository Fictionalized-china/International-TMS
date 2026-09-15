export type WorkflowTaskCompletionScope = {
  actorUserId: string;
  actorPositionCodes: readonly string[];
  taskAssigneeUserId?: string | null;
  moduleAssigneeUserId?: string | null;
  responsibilityPositionCode?: string | null;
};

/**
 * Resolve the one authoritative owner for a manual workflow task.
 *
 * A frozen task-level personal assignment overrides the module owner; a module
 * owner overrides the frozen responsibility position.  Falling through to a
 * wider position after a personal owner was assigned would silently let a
 * colleague complete somebody else's task, so that is deliberately denied.
 */
export function canCompleteWorkflowTask(
  scope: WorkflowTaskCompletionScope,
): boolean {
  if (scope.taskAssigneeUserId)
    return scope.taskAssigneeUserId === scope.actorUserId;
  if (scope.moduleAssigneeUserId)
    return scope.moduleAssigneeUserId === scope.actorUserId;
  if (!scope.responsibilityPositionCode) return false;
  return scope.actorPositionCodes.includes(scope.responsibilityPositionCode);
}

