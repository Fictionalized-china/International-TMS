export type OrganizationAssigneeMember = {
  id: string;
  display_name: string;
  department_id: string | null;
  department_code?: string | null;
  department_name: string | null;
  position_id: string | null;
  position_code?: string | null;
  position_name: string | null;
  permission_codes?: string | null;
};

export type OrganizationPositionNode = {
  id: string;
  name: string;
  members: OrganizationAssigneeMember[];
};

export type OrganizationDepartmentNode = {
  id: string;
  name: string;
  positions: OrganizationPositionNode[];
};

export function isStructurallyAssignableMember(
  member: OrganizationAssigneeMember,
) {
  return Boolean(
    member.id &&
      member.display_name &&
      member.department_id &&
      member.department_name &&
      member.position_id &&
      member.position_name,
  );
}

export function organizationAssigneePermissionCodes(
  member: Pick<OrganizationAssigneeMember, "permission_codes">,
) {
  return new Set(
    (member.permission_codes ?? "")
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean),
  );
}

/** Every inner list is OR; all outer requirements must be satisfied. */
export function satisfiesOrganizationAssigneePermissionRequirements(
  permissionCodes: Iterable<string>,
  requirements: readonly (readonly string[])[],
) {
  const granted = new Set(permissionCodes);
  if (granted.has("*")) return true;
  return requirements.every((alternatives) =>
    alternatives.length === 0 || alternatives.some((code) => granted.has(code)),
  );
}

export function organizationAssigneeCanHandle(
  member: Pick<OrganizationAssigneeMember, "permission_codes">,
  requirements: readonly (readonly string[])[],
) {
  return satisfiesOrganizationAssigneePermissionRequirements(
    organizationAssigneePermissionCodes(member),
    requirements,
  );
}

export function buildOrganizationAssigneeTree(
  members: OrganizationAssigneeMember[],
) {
  const departments = new Map<string, OrganizationDepartmentNode>();
  const seenMembers = new Set<string>();

  for (const member of members) {
    if (!isStructurallyAssignableMember(member) || seenMembers.has(member.id)) continue;
    seenMembers.add(member.id);

    const departmentId = member.department_id!;
    const positionId = member.position_id!;
    let department = departments.get(departmentId);
    if (!department) {
      department = {
        id: departmentId,
        name: member.department_name!,
        positions: [],
      };
      departments.set(departmentId, department);
    }

    let position = department.positions.find((item) => item.id === positionId);
    if (!position) {
      position = { id: positionId, name: member.position_name!, members: [] };
      department.positions.push(position);
    }
    position.members.push(member);
  }

  return Array.from(departments.values());
}

export function findOrganizationAssigneePath(
  members: OrganizationAssigneeMember[],
  userId: string,
) {
  const member = members.find(
    (item) => item.id === userId && isStructurallyAssignableMember(item),
  );
  if (!member) return null;
  return {
    departmentId: member.department_id!,
    departmentName: member.department_name!,
    positionId: member.position_id!,
    positionName: member.position_name!,
    userId: member.id,
    userName: member.display_name,
  };
}
