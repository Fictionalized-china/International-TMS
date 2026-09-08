import { env } from "cloudflare:workers";
import { isMissingSqliteTableError } from "./d1-errors";
import {
  satisfiesOrganizationAssigneePermissionRequirements,
  organizationAssigneeCanHandle,
  organizationAssigneeCanHandleWorkflowNodes,
  type OrganizationAssigneeWorkflowNode,
  type OrganizationAssigneeMember,
} from "./organization-assignee";

const activeOrganizationAssigneeBaseSql = `
  FROM memberships m
  JOIN users u ON u.id=m.user_id AND u.status='active'
  JOIN departments d
    ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.status='active'
  JOIN positions p
    ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
   AND p.department_code=d.code
 WHERE m.organization_id=? AND m.status='active'`;

export async function listActiveOrganizationAssignees(organizationId: string) {
  const selectWithOverrides = `SELECT u.id,u.display_name,
      m.id membership_id,
      d.id department_id,d.code department_code,d.name department_name,
      p.id position_id,p.code position_code,p.name position_name,
      (SELECT GROUP_CONCAT(DISTINCT effective_permission.code)
         FROM (
           SELECT rp.permission_code code
             FROM membership_roles effective_mr
             JOIN roles effective_role
               ON effective_role.id=effective_mr.role_id AND effective_role.status='active'
             JOIN role_permissions rp ON rp.role_id=effective_role.id
            WHERE effective_mr.membership_id=m.id
              AND NOT EXISTS (
                SELECT 1 FROM membership_permission_overrides denied
                 WHERE denied.membership_id=m.id
                   AND denied.permission_code=rp.permission_code AND denied.effect='deny'
              )
           UNION
           SELECT allowed.permission_code
             FROM membership_permission_overrides allowed
            WHERE allowed.membership_id=m.id AND allowed.effect='allow'
           UNION
           SELECT '*'
             FROM membership_roles protected_mr
             JOIN roles protected_role
               ON protected_role.id=protected_mr.role_id AND protected_role.status='active'
            WHERE protected_mr.membership_id=m.id
              AND protected_role.code IN ('owner','boss')
         ) effective_permission) permission_codes,
      (SELECT GROUP_CONCAT(permission_override.permission_code||':'||permission_override.effect)
         FROM membership_permission_overrides permission_override
        WHERE permission_override.membership_id=m.id) permission_override_entries,
      (SELECT GROUP_CONCAT(workflow_override.step_key||':'||workflow_override.module_code||':'||workflow_override.effect)
         FROM membership_workflow_access_overrides workflow_override
        WHERE workflow_override.membership_id=m.id) workflow_access_entries
    ${activeOrganizationAssigneeBaseSql}
   ORDER BY d.sort_order,p.sort_order,u.display_name`;
  try {
    return (await env.DB.prepare(selectWithOverrides)
      .bind(organizationId)
      .all<OrganizationAssigneeMember>()).results;
  } catch (error) {
    if (
      !isMissingSqliteTableError(error, "membership_permission_overrides") &&
      !isMissingSqliteTableError(error, "membership_workflow_access_overrides")
    ) throw error;
    const legacyRows = await env.DB.prepare(
      `SELECT u.id,u.display_name,m.id membership_id,
              d.id department_id,d.code department_code,d.name department_name,
              p.id position_id,p.code position_code,p.name position_name,
              (SELECT GROUP_CONCAT(DISTINCT legacy_permission.code)
                 FROM (
                   SELECT CASE WHEN legacy_role.code IN ('owner','boss')
                               THEN '*' ELSE rp.permission_code END code
                     FROM membership_roles legacy_mr
                     JOIN roles legacy_role
                       ON legacy_role.id=legacy_mr.role_id AND legacy_role.status='active'
                     LEFT JOIN role_permissions rp ON rp.role_id=legacy_role.id
                    WHERE legacy_mr.membership_id=m.id
                 ) legacy_permission
                WHERE legacy_permission.code IS NOT NULL) permission_codes
        ${activeOrganizationAssigneeBaseSql}
       ORDER BY d.sort_order,p.sort_order,u.display_name`,
    ).bind(organizationId).all<OrganizationAssigneeMember>();
    return legacyRows.results;
  }
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
  const member = await env.DB.prepare(
    `SELECT m.id membership_id
       FROM memberships m
       JOIN users u ON u.id=m.user_id AND u.status='active'
       JOIN departments d
         ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.status='active'
       JOIN positions p
         ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
        AND p.department_code=d.code
      WHERE m.organization_id=? AND m.user_id=? AND m.status='active'
        AND p.code IN (${positionCodes.map(() => "?").join(",")})`,
  )
    .bind(organizationId, userId, ...positionCodes)
    .first<{ membership_id: string }>();
  if (!member) return false;
  if (!permissionRequirements.length) return true;

  const queryWithOverrides = `SELECT DISTINCT effective.code
    FROM (
      SELECT rp.permission_code code
        FROM membership_roles mr
        JOIN roles r ON r.id=mr.role_id AND r.status='active'
        JOIN role_permissions rp ON rp.role_id=r.id
       WHERE mr.membership_id=?
         AND NOT EXISTS (
           SELECT 1 FROM membership_permission_overrides denied
            WHERE denied.membership_id=mr.membership_id
              AND denied.permission_code=rp.permission_code
              AND denied.effect='deny'
         )
      UNION
      SELECT allowed.permission_code code
        FROM membership_permission_overrides allowed
       WHERE allowed.membership_id=? AND allowed.effect='allow'
      UNION
      SELECT '*' code
        FROM membership_roles protected_membership_role
        JOIN roles protected_role
          ON protected_role.id=protected_membership_role.role_id
         AND protected_role.status='active'
       WHERE protected_membership_role.membership_id=?
         AND protected_role.code IN ('owner','boss')
    ) effective`;
  let permissions: { code: string }[];
  try {
    permissions = (await env.DB.prepare(queryWithOverrides)
      .bind(member.membership_id, member.membership_id, member.membership_id)
      .all<{ code: string }>()).results;
  } catch (error) {
    if (!isMissingSqliteTableError(error, "membership_permission_overrides")) throw error;
    permissions = (await env.DB.prepare(
      `SELECT DISTINCT CASE WHEN r.code IN ('owner','boss') THEN '*' ELSE rp.permission_code END code
         FROM membership_roles mr
         JOIN roles r ON r.id=mr.role_id AND r.status='active'
         LEFT JOIN role_permissions rp ON rp.role_id=r.id
        WHERE mr.membership_id=?`,
    ).bind(member.membership_id).all<{ code: string }>()).results;
  }
  return satisfiesOrganizationAssigneePermissionRequirements(
    permissions.map((permission) => permission.code),
    permissionRequirements,
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
