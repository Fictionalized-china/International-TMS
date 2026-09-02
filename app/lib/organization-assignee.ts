export type OrganizationAssigneeMember = {
  id: string;
  display_name: string;
  department_id: string | null;
  department_name: string | null;
  position_id: string | null;
  position_name: string | null;
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
