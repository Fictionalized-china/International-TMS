import { describe, expect, it } from "vitest";

import { buildDepartmentTree, departmentParentPath } from "./department-tree";

const row = (id: string, name: string, parentId: string | null, sortOrder = 10) => ({
  id,
  parent_id: parentId,
  code: id.toUpperCase(),
  name,
  status: "active",
  sort_order: sortOrder,
  member_count: 0,
});

describe("department tree presentation", () => {
  it("shows structural roots and their children before standalone roots", () => {
    const rows = buildDepartmentTree([
      row("sales", "业务部", null, 10),
      row("hq", "总部", null, 10),
      row("branch", "上海分公司", "hq", 10),
    ]);
    expect(rows.map((item) => item.id)).toEqual(["hq", "branch", "sales"]);
    expect(rows[0]).toMatchObject({ level: 0, childCount: 1, orphaned: false });
    expect(rows[1]).toMatchObject({ level: 1, path: "总部 / 上海分公司" });
    expect(departmentParentPath(rows[1])).toBe("上级：总部");
  });

  it("moves invalid parent relationships into a clearly marked orphan group", () => {
    const rows = buildDepartmentTree([row("lost", "未关联部门", "missing")]);
    expect(rows[0]).toMatchObject({ orphaned: true, path: "未关联 / 未关联部门" });
    expect(departmentParentPath(rows[0])).toBe("上级关系缺失");
  });
});
