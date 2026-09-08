import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  calculateAssigneeCascadePlacement,
  OrganizationAssigneePicker,
} from "../components/OrganizationAssigneePicker";
import {
  buildOrganizationAssigneeTree,
  findOrganizationAssigneePath,
  organizationAssigneeCanHandleWorkflowNodes,
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
  it("opens below the trigger when the lower viewport has enough room", () => {
    expect(calculateAssigneeCascadePlacement(
      { top: 360, right: 1140, bottom: 402 },
      { width: 1600, height: 1000 },
    )).toMatchObject({ direction: "below", left: 480, top: 407, listHeight: 224 });
  });

  it("opens above the trigger when lower space is insufficient", () => {
    const placement = calculateAssigneeCascadePlacement(
      { top: 650, right: 900, bottom: 684 },
      { width: 1000, height: 720 },
    );
    expect(placement.direction).toBe("above");
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.listHeight).toBe(224);
  });

  it("limits panel height when neither side has the preferred room", () => {
    const placement = calculateAssigneeCascadePlacement(
      { top: 170, right: 500, bottom: 204 },
      { width: 600, height: 400 },
    );
    expect(placement.direction).toBe("below");
    expect(placement.listHeight).toBeLessThan(224);
    expect(placement.top + placement.listHeight + 33).toBeLessThanOrEqual(392);
  });

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

  it("inherits node eligibility from the responsibility position and honors explicit overrides", () => {
    const node = [{ stepKey: "order_creation", moduleCode: "consignment" }];
    expect(organizationAssigneeCanHandleWorkflowNodes({
      position_code: "SALES",
    }, "SALES", node)).toBe(true);
    expect(organizationAssigneeCanHandleWorkflowNodes({
      position_code: "DOC",
      workflow_access_entries: "order_creation:consignment:allow",
    }, "SALES", node)).toBe(true);
    expect(organizationAssigneeCanHandleWorkflowNodes({
      position_code: "SALES",
      workflow_access_entries: "order_creation:consignment:deny",
    }, "SALES", node)).toBe(false);
    expect(organizationAssigneeCanHandleWorkflowNodes({
      position_code: "SALES",
      permission_override_entries: "order.module.consignment.manage:deny",
    }, "SALES", node)).toBe(false);
  });

  it("does not submit a disabled candidate and explains why it is unavailable", () => {
    const html = renderToStaticMarkup(createElement(OrganizationAssigneePicker, {
      members,
      name: "assigneeUserId",
      defaultValue: "user-a1",
      personLabel: "整批操作负责人",
      disabledUserReasons: {
        "user-a1": "a1 是挂载订单的原操作负责人；PZ 首次分配必须换人。",
      },
    }));

    expect(html).toContain("已禁用 1 名不符合当前指派条件的人员");
    expect(html).toContain("（不可选）");
    expect(html).not.toContain("A 部门 / 1 岗位 / a1");
  });
});
