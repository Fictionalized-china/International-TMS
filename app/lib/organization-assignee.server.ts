import { env } from "cloudflare:workers";
import {
  organizationAssigneeCanHandle,
  organizationAssigneeCanHandleWorkflowNodes,
  type OrganizationAssigneeWorkflowNode,
  type OrganizationAssigneeMember,
} from "./organization-assignee";
import { isProtectedAccessPosition, positionRoleCodeSql } from "./position-role";

const activeOrganizationAssigneeBaseSql = `
  FROM memberships m
  JOIN users u ON u.id=m.user_id AND u.status='active'
  JOIN departments d
    ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.status='active'
  JOIN positions p
    ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
   AND p.department_code=d.code`;

export async function listActiveOrganizationAssignees(organizationId: string) {
  const roleCodeSql = positionRoleCodeSql("p.code");
  const rows = await env.DB.prepare(
    `SELECT u.id,u.display_name,m.id membership_id,
       d.id department_id,d.code department_code,d.name department_name,
       p.id position_id,p.code position_code,p.name position_name,
       GROUP_CONCAT(DISTINCT CASE
         WHEN p.code IN ('BOSS','DEVELOPER') THEN '*'
         ELSE rp.permission_code END) permission_codes,
       NULL permission_override_entries
     ${activeOrganizationAssigneeBaseSql}
     JOIN roles r
       ON r.organization_id=m.organization_id
      AND r.code=${roleCodeSql}
      AND r.status='active'
     LEFT JOIN role_permissions rp ON rp.role_id=r.id
     WHERE m.organization_id=? AND m.status='active'
     GROUP BY u.id,u.display_name,m.id,d.id,d.code,d.name,p.id,p.code,p.name
     ORDER BY d.sort_order,p.sort_order,u.display_name`,
  ).bind(organizationId).all<OrganizationAssigneeMember>();
  return rows.results.map((member) => ({
    ...member,
    permission_codes: isProtectedAccessPosition(member.position_code)
      ? "*"
      : member.permission_codes,
  }));
}

export async function isActiveOrganizationAssigneeForWorkflowNodes(input: {
  organizationId: string;
  userId: string;
  responsibilityPositionCode: string;
  nodes: readonly OrganizationAssigneeWorkflowNode[];
  permissionRequirements?: readonly (readonly string[])[];
}) {
  if (!input.userId || !input.responsibilityPositionCode || !input.nodes.length) return false;
  const member = (await listActiveOrganizationAssignees(input.organizationId)).find(
    (candidate) => candidate.id === input.userId,
  );
  return Boolean(
    member &&
    organizationAssigneeCanHandleWorkflowNodes(
      member,
      input.responsibilityPositionCode,
      input.nodes,
    ) &&
    organizationAssigneeCanHandle(member, input.permissionRequirements ?? []),
  );
}

export async function listActiveOrganizationAssigneeCandidates(input: {
  organizationId: string;
  positionCodes: readonly string[];
  permissionRequirements?: readonly (readonly string[])[];
  excludedUserIds?: readonly string[];
}) {
  const positionCodes = new Set(input.positionCodes);
  const excludedUserIds = new Set(input.excludedUserIds ?? []);
  const requirements = input.permissionRequirements ?? [];
  return (await listActiveOrganizationAssignees(input.organizationId)).filter(
    (member) =>
      Boolean(member.position_code && positionCodes.has(member.position_code)) &&
      !excludedUserIds.has(member.id) &&
      organizationAssigneeCanHandle(member, requirements),
  );
}

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

export async function isActiveOrganizationAssigneeForPositions(
  organizationId: string,
  userId: string,
  positionCodes: readonly string[],
  permissionRequirements: readonly (readonly string[])[] = [],
) {
  if (!userId || !positionCodes.length) return false;
  const activeMember = (await listActiveOrganizationAssignees(organizationId)).find(
    (candidate) =>
      candidate.id === userId &&
      Boolean(candidate.position_code && positionCodes.includes(candidate.position_code)),
  );
  return Boolean(
    activeMember && organizationAssigneeCanHandle(activeMember, permissionRequirements),
  );
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
