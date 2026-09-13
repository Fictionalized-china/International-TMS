import { isProtectedAccessPosition, positionRoleCodeSql } from "./position-role";

export type PositionAccessProfile = {
  membershipId: string;
  departmentId: string;
  departmentCode: string;
  positionId: string;
  positionCode: string;
  positionName: string;
  roleCode: string;
  permissions: string[];
};

type PositionAccessRow = {
  membership_id: string;
  department_id: string;
  department_code: string;
  position_id: string;
  position_code: string;
  position_name: string;
  role_code: string;
  permission_codes: string | null;
};

export async function loadActivePositionAccessProfile(
  db: D1Database,
  organizationId: string,
  userId: string,
): Promise<PositionAccessProfile | null> {
  const roleCodeSql = positionRoleCodeSql("position.code");
  const row = await db.prepare(
    `SELECT membership.id membership_id,
       department.id department_id,department.code department_code,
       position.id position_id,position.code position_code,position.name position_name,
       role.code role_code,
       GROUP_CONCAT(DISTINCT role_permission.permission_code) permission_codes
     FROM memberships membership
     JOIN users user ON user.id=membership.user_id AND user.status='active'
     JOIN departments department
       ON department.id=membership.department_id
      AND department.organization_id=membership.organization_id
      AND department.status='active'
     JOIN positions position
       ON position.id=membership.position_id
      AND position.organization_id=membership.organization_id
      AND position.department_code=department.code
      AND position.status='active'
     JOIN roles role
       ON role.organization_id=membership.organization_id
      AND role.code=${roleCodeSql}
      AND role.status='active'
     LEFT JOIN role_permissions role_permission ON role_permission.role_id=role.id
     WHERE membership.organization_id=? AND membership.user_id=?
       AND membership.status='active'
     GROUP BY membership.id,department.id,department.code,
       position.id,position.code,position.name,role.code
     LIMIT 1`,
  ).bind(organizationId, userId).first<PositionAccessRow>();
  if (!row) return null;

  const permissions = isProtectedAccessPosition(row.position_code)
    ? (await db.prepare("SELECT code FROM permissions ORDER BY code")
      .all<{ code: string }>()).results.map((permission) => permission.code)
    : splitPermissionCodes(row.permission_codes);

  return {
    membershipId: row.membership_id,
    departmentId: row.department_id,
    departmentCode: row.department_code,
    positionId: row.position_id,
    positionCode: row.position_code,
    positionName: row.position_name,
    roleCode: row.role_code,
    permissions,
  };
}

function splitPermissionCodes(value: string | null) {
  return [...new Set(
    (value ?? "").split(",").map((code) => code.trim()).filter(Boolean),
  )].sort();
}
