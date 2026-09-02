import { env } from "cloudflare:workers";

export async function isActiveOrganizationAssignee(
  organizationId: string,
  userId: string,
) {
  if (!userId) return false;
  const member = await env.DB.prepare(
    `SELECT 1
       FROM memberships m
       JOIN users u ON u.id=m.user_id AND u.status='active'
       JOIN departments d
         ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.status='active'
       JOIN positions p
         ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
        AND p.department_code=d.code
      WHERE m.organization_id=? AND m.user_id=? AND m.status='active'`,
  )
    .bind(organizationId, userId)
    .first();
  return Boolean(member);
}

export async function listActiveOrganizationAssigneeIds(organizationId: string) {
  const members = await env.DB.prepare(
    `SELECT m.user_id id
       FROM memberships m
       JOIN users u ON u.id=m.user_id AND u.status='active'
       JOIN departments d
         ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.status='active'
       JOIN positions p
         ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
        AND p.department_code=d.code
      WHERE m.organization_id=? AND m.status='active'`,
  )
    .bind(organizationId)
    .all<{ id: string }>();
  return new Set(members.results.map((member) => member.id));
}

export async function requireActiveOrganizationAssignee(
  organizationId: string,
  userId: string,
) {
  if (!(await isActiveOrganizationAssignee(organizationId, userId))) {
    throw new Error("请选择部门、岗位下的有效个人账户");
  }
}
