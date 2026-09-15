import { describe, expect, it } from "vitest";
import { workflowPositionCoverageBlocker } from "./workflow-position-coverage";

const assignment = {
  workflow_name: "整车标准流程",
  step_name: "报关放行",
  module_name: "报关作业",
};

describe("published workflow position coverage", () => {
  it("blocks removing the final live handler of a published workflow", () => {
    expect(
      workflowPositionCoverageBlocker({
        positionName: "单证岗",
        otherActiveMembers: 0,
        assignments: [assignment],
      }),
    ).toContain("不能移除岗位“单证岗”的最后一个有效账号");
  });

  it("allows removal when another active handler remains", () => {
    expect(
      workflowPositionCoverageBlocker({
        positionName: "单证岗",
        otherActiveMembers: 1,
        assignments: [assignment],
      }),
    ).toBeNull();
  });

  it("allows removal when no published human task uses the position", () => {
    expect(
      workflowPositionCoverageBlocker({
        positionName: "前端配载岗",
        otherActiveMembers: 0,
        assignments: [],
      }),
    ).toBeNull();
  });
});
