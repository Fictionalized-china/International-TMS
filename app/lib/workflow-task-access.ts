import { isBossBusinessActor } from "./permission-blocks";

export type WorkflowTaskCompletionScope = {
  actorUserId: string;
  actorPositionCodes: readonly string[];
  actorRoleCodes?: readonly string[];
  taskAssigneeUserId?: string | null;
  moduleAssigneeUserId?: string | null;
  responsibilityPositionCode?: string | null;
};

/**
 * Resolve the one authoritative owner for a manual workflow task.
 *
 * A frozen task-level personal assignment overrides the module owner; a module
 * owner overrides the frozen responsibility position. Ordinary accounts
 * cannot fall through to a wider position after personal assignment; the boss
 * account is an explicit demo/emergency stand-in.
 */
export function canCompleteWorkflowTask(
  scope: WorkflowTaskCompletionScope,
): boolean {
  if (isBossBusinessActor({
    positionCode: scope.actorPositionCodes.includes("BOSS") ? "BOSS" : null,
    roleCodes: scope.actorRoleCodes,
  })) return true;
  if (scope.taskAssigneeUserId)
    return scope.taskAssigneeUserId === scope.actorUserId;
  if (scope.moduleAssigneeUserId)
    return scope.moduleAssigneeUserId === scope.actorUserId;
  if (!scope.responsibilityPositionCode) return false;
  return scope.actorPositionCodes.includes(scope.responsibilityPositionCode);
}

