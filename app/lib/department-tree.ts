export type DepartmentTreeSource = {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  status: string;
  sort_order: number;
  member_count: number;
};

export type DepartmentTreeRow = DepartmentTreeSource & {
  level: number;
  path: string;
  childCount: number;
  orphaned: boolean;
};

/**
 * Keep configured sibling ordering, while presenting structural roots before
 * standalone root departments. This only affects the visual tree and never
 * mutates department ownership or access scope.
 */
export function buildDepartmentTree(departments: DepartmentTreeSource[]) {
  const children = new Map<string | null, DepartmentTreeSource[]>();
  for (const department of departments) {
    const group = children.get(department.parent_id) ?? [];
    group.push(department);
    children.set(department.parent_id, group);
  }
  const compare = (left: DepartmentTreeSource, right: DepartmentTreeSource) =>
    left.sort_order - right.sort_order || left.name.localeCompare(right.name, "zh-CN");
  for (const group of children.values()) group.sort(compare);
  const roots = [...(children.get(null) ?? [])].sort((left, right) => {
    const structureDelta = Number((children.get(right.id)?.length ?? 0) > 0) -
      Number((children.get(left.id)?.length ?? 0) > 0);
    return structureDelta || compare(left, right);
  });

  const result: DepartmentTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (
    department: DepartmentTreeSource,
    level: number,
    parentPath: string,
    orphaned = false,
  ) => {
    if (visited.has(department.id)) return;
    visited.add(department.id);
    const path = parentPath ? `${parentPath} / ${department.name}` : department.name;
    const directChildren = children.get(department.id) ?? [];
    result.push({
      ...department,
      level,
      path,
      childCount: directChildren.length,
      orphaned,
    });
    for (const child of directChildren) visit(child, level + 1, path, orphaned);
  };

  for (const root of roots) visit(root, 0, "");
  for (const department of [...departments].sort(compare)) {
    if (!visited.has(department.id)) visit(department, 0, "未关联", true);
  }
  return result;
}

export function departmentParentPath(row: DepartmentTreeRow) {
  if (row.orphaned) return "上级关系缺失";
  if (row.level === 0) return row.childCount ? `${row.childCount} 个直属下级` : "一级部门";
  return `上级：${row.path.split(" / ").slice(0, -1).join(" / ")}`;
}
