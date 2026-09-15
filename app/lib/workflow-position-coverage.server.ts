import { workflowPositionCoverageBlocker } from "./workflow-position-coverage";

export async function loadWorkflowPositionRemovalBlocker(
  db: D1Database,
  organizationId: string,
  membershipId: string,
) {
  const member = await db.prepare(
    `SELECT m.status,p.code position_code,p.name position_name
     FROM memberships m
     LEFT JOIN positions p
       ON p.id=m.position_id AND p.organization_id=m.organization_id
     WHERE m.id=? AND m.organization_id=?`,
  ).bind(membershipId, organizationId).first<{
    status: string;
    position_code: string | null;
    position_name: string | null;
  }>();
  if (!member || member.status !== "active" || !member.position_code) return null;

  const [otherMembers, assignments] = await Promise.all([
    db.prepare(
      `SELECT COUNT(DISTINCT other.user_id) total
       FROM memberships other
       JOIN users other_user ON other_user.id=other.user_id
       JOIN positions position
         ON position.id=other.position_id
        AND position.organization_id=other.organization_id
       WHERE other.organization_id=?
         AND other.id<>?
         AND other.status='active'
         AND other_user.status='active'
         AND position.status='active'
         AND position.code=?`,
    ).bind(organizationId, membershipId, member.position_code).first<{ total: number }>(),
    db.prepare(
      `SELECT DISTINCT wd.name workflow_name,s.name step_name,m.display_name module_name
       FROM workflow_definitions wd
       JOIN workflow_steps s
         ON s.workflow_id=wd.id AND s.is_active=1
       JOIN workflow_step_modules m
         ON m.workflow_id=wd.id AND m.step_id=s.id AND m.is_active=1
       JOIN workflow_module_tasks t
         ON t.workflow_id=wd.id AND t.step_module_id=m.id
        AND t.is_active=1 AND t.task_type!='system'
       WHERE wd.organization_id=?
         AND wd.lifecycle_status='published'
         AND wd.status='active'
         AND m.completion_mode!='automatic'
         AND COALESCE(t.responsibility_position_code,m.responsibility_position_code)=?
       ORDER BY wd.name,s.sort_order,m.sort_order`,
    ).bind(organizationId, member.position_code).all<{
      workflow_name: string;
      step_name: string;
      module_name: string;
    }>(),
  ]);

  return workflowPositionCoverageBlocker({
    positionName: member.position_name ?? member.position_code,
    otherActiveMembers: Number(otherMembers?.total ?? 0),
    assignments: assignments.results,
  });
}
