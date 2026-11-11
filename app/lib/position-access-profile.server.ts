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
  dataScope: PositionBusinessDataScope;
};

export type PositionBusinessDataScope =
  | "self"
  | "department"
  | "warehouse"
  | "region"
  | "company";

/** Recheck a previously authorized profile inside the caller's write batch. */
export function activePositionProfilePredicate(input: {
  organizationId: string; userId: string; profile: PositionAccessProfile;
  requiredPermissions: readonly string[];
}) {
  const {profile}=input;
  const permissions=[...new Set(input.requiredPermissions)];
  return {
    sql:`EXISTS(SELECT 1 FROM memberships m
      JOIN users u ON u.id=m.user_id AND u.status='active'
      JOIN departments d ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.status='active'
      JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.department_code=d.code AND p.status='active'
      JOIN roles r ON r.organization_id=m.organization_id AND r.code=${positionRoleCodeSql("p.code")} AND r.status='active'
      WHERE m.id=? AND m.organization_id=? AND m.user_id=? AND m.status='active'
        AND m.department_id=? AND m.position_id=? AND p.code=? AND r.code=?
        AND (?=1 OR (${permissions.length?permissions.map(()=>"EXISTS(SELECT 1 FROM role_permissions rp WHERE rp.role_id=r.id AND rp.permission_code=?)").join(" AND "):"1=1"})))`,
    values:[profile.membershipId,input.organizationId,input.userId,profile.departmentId,profile.positionId,profile.positionCode,profile.roleCode,isProtectedAccessPosition(profile.positionCode)?1:0,...permissions] as (string|number|null)[],
  };
}

type PositionAccessRow = {
  membership_id: string;
  department_id: string;
  department_code: string;
  position_id: string;
  position_code: string;
  position_name: string;
  role_code: string;
  permission_codes: string | null;
  data_scope: PositionBusinessDataScope;
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
       COALESCE(portal_setting.business_data_scope,CASE
         WHEN position.code IN ('BOSS','DEVELOPER','TRACKING','BUSINESS_ROUTE','HR_ADMIN') THEN 'company'
         WHEN position.code IN ('BUSINESS_SUPERVISOR','OPERATION_SUPERVISOR') THEN 'department'
         WHEN position.code IN ('WAREHOUSE','OVERSEAS_WAREHOUSE') THEN 'warehouse'
         WHEN position.code='OVERSEAS' THEN 'region'
         ELSE 'self' END) data_scope,
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
     LEFT JOIN position_portal_settings portal_setting
       ON portal_setting.organization_id=membership.organization_id
      AND portal_setting.position_id=position.id
     WHERE membership.organization_id=? AND membership.user_id=?
       AND membership.status='active'
     GROUP BY membership.id,department.id,department.code,
       position.id,position.code,position.name,role.code,portal_setting.business_data_scope
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
    dataScope: row.position_code === "BOSS" ? "company" : row.data_scope,
  };
}

function splitPermissionCodes(value: string | null) {
  return [...new Set(
    (value ?? "").split(",").map((code) => code.trim()).filter(Boolean),
  )].sort();
}
