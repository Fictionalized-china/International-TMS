import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrganizationAssigneePicker } from "../components/OrganizationAssigneePicker";
import {
  buildOrganizationAssigneeTree,
  findOrganizationAssigneePath,
  type OrganizationAssigneeMember,
} from "./organization-assignee";

const members: OrganizationAssigneeMember[] = [
  {
    id: "user-a1",
    display_name: "a1",
    department_id: "department-a",
    department_name: "A 部门",
    position_id: "position-1",
    position_name: "1 岗位",
  },
  {
    id: "user-a2",
    display_name: "a2",
    department_id: "department-a",
    department_name: "A 部门",
    position_id: "position-1",
    position_name: "1 岗位",
  },
  {
    id: "user-a3",
    display_name: "a3",
    department_id: "department-a",
    department_name: "A 部门",
    position_id: "position-2",
    position_name: "2 岗位",
  },
  {
    id: "user-b1",
    display_name: "b1",
    department_id: "department-b",
    department_name: "B 部门",
    position_id: "position-1b",
    position_name: "1 岗位",
  },
];

describe("organization assignee hierarchy", () => {
  it("groups concrete accounts by department and position without merging same-name positions", () => {
    const tree = buildOrganizationAssigneeTree(members);

    expect(tree).toHaveLength(2);
    expect(tree[0]).toMatchObject({ id: "department-a", name: "A 部门" });
    expect(tree[0].positions).toHaveLength(2);
    expect(tree[0].positions[0].members.map((member) => member.id)).toEqual([
      "user-a1",
      "user-a2",
    ]);
    expect(tree[1].positions[0].id).toBe("position-1b");
  });

  it("never exposes an account that is missing a department or position", () => {
    const tree = buildOrganizationAssigneeTree([
      ...members,
      { ...members[0], id: "no-department", department_id: null },
      { ...members[0], id: "no-position", position_id: null },
      members[0],
    ]);

    expect(
      tree.flatMap((department) =>
        department.positions.flatMap((position) => position.members.map((member) => member.id)),
      ),
    ).toEqual(["user-a1", "user-a2", "user-a3", "user-b1"]);
  });

  it("resolves the full department-position-person path from the saved user id", () => {
    expect(findOrganizationAssigneePath(members, "user-a3")).toEqual({
      departmentId: "department-a",
      departmentName: "A 部门",
      positionId: "position-2",
      positionName: "2 岗位",
      userId: "user-a3",
      userName: "a3",
    });
    expect(findOrganizationAssigneePath(members, "missing-user")).toBeNull();
  });

  it("uses one cascade trigger while submitting the selected concrete account", () => {
    const html = renderToStaticMarkup(createElement(OrganizationAssigneePicker, {
      members,
      name: "assigneeUserId",
      defaultValue: "user-a3",
      personLabel: "审批负责人",
    }));

    expect(html).toContain("organization-assignee-trigger");
    expect(html).toContain("A 部门 / 2 岗位 / a3");
    expect(html).toContain('name="assigneeUserId"');
    expect(html).not.toContain('aria-label="选择部门"');
  });
});
