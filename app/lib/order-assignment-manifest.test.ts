import { describe, expect, it } from "vitest";
import {
  buildOrderAssignmentManifest,
  missingRequiredOrderAssignmentGroupKeys,
  nextRequiredOrderAssignmentGroup,
  orderAssignmentCandidateConfigurationErrors,
  orderAssignmentGroupPermissionRequirements,
  orderAssignmentAssigneeFieldName,
  type WorkflowAssignmentSnapshotRow,
} from "./order-assignment-manifest";

function row(
  overrides: Partial<WorkflowAssignmentSnapshotRow> = {},
): WorkflowAssignmentSnapshotRow {
  return {
    moduleStateId: "module-transport",
    moduleCode: "transport",
    moduleName: "国内运输",
    stepSortOrder: 40,
    moduleSortOrder: 10,
    moduleRequired: true,
    moduleStatus: "pending",
    modulePositionCode: "OPERATION",
    moduleAssigneeUserId: null,
    taskStateId: "task-transport",
    taskKey: "arrange_transport",
    taskName: "安排国内运输",
    taskSortOrder: 10,
    taskRequired: true,
    taskStatus: "pending",
    taskPositionCode: "OPERATION",
    taskAssigneeUserId: null,
    ...overrides,
  };
}

describe("order assignment manifest", () => {
  it("blocks only unresolved required groups in the assignment workbench", () => {
    const manifest = buildOrderAssignmentManifest([
      row(),
      row({
        moduleStateId: "module-exceptions",
        moduleCode: "exceptions",
        moduleName: "异常处理",
        moduleRequired: false,
        taskStateId: "task-exceptions",
        taskKey: "handle_exception",
        taskName: "处理异常",
      }),
    ]);

    expect(missingRequiredOrderAssignmentGroupKeys(manifest.groups, {})).toEqual([
      "position:OPERATION",
    ]);
    expect(missingRequiredOrderAssignmentGroupKeys(manifest.groups, {
      "position:OPERATION": "operator-1",
    })).toEqual([]);
  });

  it("selects the first unfinished required human responsibility as the dispatch owner", () => {
    const manifest = buildOrderAssignmentManifest([
      row({
        moduleStateId: "module-optional",
        moduleCode: "exceptions",
        moduleName: "可选异常处理",
        moduleRequired: false,
        taskStateId: "task-optional",
        taskPositionCode: "OPERATION",
      }),
      row({
        moduleStateId: "module-documents",
        moduleCode: "documents",
        moduleName: "报关文件",
        modulePositionCode: "DOC",
        taskStateId: "task-documents",
        taskPositionCode: "DOC",
        stepSortOrder: 50,
      }),
    ]);

    expect(nextRequiredOrderAssignmentGroup(manifest.groups)?.positionCode).toBe("DOC");
  });

  it("uses the selected warehouse site and frozen position as a queue instead of requiring a person", () => {
    const manifest = buildOrderAssignmentManifest([
      row({
        moduleStateId: "module-warehouse",
        moduleCode: "warehouse",
        moduleName: "国内仓入库",
        modulePositionCode: "WAREHOUSE",
        taskStateId: "task-warehouse",
        taskPositionCode: "WAREHOUSE",
      }),
      row({
        moduleStateId: "module-transport",
        moduleCode: "transport",
        moduleName: "国内运输",
        stepSortOrder: 50,
      }),
    ]);

    expect(manifest.groups[0]).toMatchObject({
      positionCode: "WAREHOUSE",
      assignmentMode: "site_queue",
      assignmentState: "assigned",
      assigneeUserId: null,
    });
    expect(missingRequiredOrderAssignmentGroupKeys(manifest.groups, {})).toEqual([
      "position:OPERATION",
    ]);
    expect(nextRequiredOrderAssignmentGroup(manifest.groups)?.positionCode).toBe("OPERATION");
  });

  it("derives every runtime permission required by a frozen responsibility group", () => {
    const finance = buildOrderAssignmentManifest([row({
      moduleStateId: "module-review",
      moduleCode: "review",
      modulePositionCode: "FINANCE_ACCOUNTING",
      taskStateId: "task-review",
      taskPositionCode: "FINANCE_ACCOUNTING",
    })]).groups[0];
    expect(orderAssignmentGroupPermissionRequirements(finance)).toEqual([
      ["order.module.review.manage"],
      ["billing.expense.approve"],
    ]);

    const warehouse = buildOrderAssignmentManifest([row({
      moduleStateId: "module-warehouse",
      moduleCode: "warehouse",
      modulePositionCode: "WAREHOUSE",
      taskStateId: "task-warehouse",
      taskPositionCode: "WAREHOUSE",
    })]).groups[0];
    expect(orderAssignmentGroupPermissionRequirements(warehouse)).toEqual([]);
  });

  it("uses a stable form field name for each frozen assignment group", () => {
    expect(orderAssignmentAssigneeFieldName("position:OPERATION")).toBe(
      "assignmentAssignee:position%3AOPERATION",
    );
  });

  it("对无岗位成员和全员被 deny 的必填责任给出不同配置错误", () => {
    const group = buildOrderAssignmentManifest([row()]).groups;
    expect(orderAssignmentCandidateConfigurationErrors(group, [])).toEqual([
      "OPERATION 岗位暂无有效个人账户",
    ]);
    expect(orderAssignmentCandidateConfigurationErrors(group, [{
      position_code: "OPERATION",
      permission_codes: "order.view",
    }])).toEqual([
      "OPERATION 岗位现有账户均不具备该责任所需的有效权限（含个人拒绝覆盖）",
    ]);
    expect(orderAssignmentCandidateConfigurationErrors(group, [{
      position_code: "OPERATION",
      permission_codes: "order.module.transport.manage",
    }])).toEqual([]);
  });

  it("builds a required assignment group from the frozen workflow snapshot", () => {
    expect(buildOrderAssignmentManifest([row()])).toEqual({
      groups: [
        expect.objectContaining({
          key: "position:OPERATION",
          positionCode: "OPERATION",
          required: true,
          assignmentState: "unassigned",
          assigneeUserId: null,
          modules: [
            expect.objectContaining({
              moduleCode: "transport",
              required: true,
              taskStateIds: ["task-transport"],
            }),
          ],
        }),
      ],
      configurationErrors: [],
    });
  });

  it("splits one module by task-level position overrides", () => {
    const manifest = buildOrderAssignmentManifest([
      row({ taskStateId: "task-plan", taskKey: "plan", taskName: "安排运输" }),
      row({
        taskStateId: "task-documents",
        taskKey: "documents",
        taskName: "准备随车文件",
        taskSortOrder: 20,
        taskPositionCode: "DOC",
      }),
    ]);

    expect(manifest.groups.map((group) => ({
      positionCode: group.positionCode,
      taskStateIds: group.modules[0].taskStateIds,
      primaryOwner: group.modules[0].primaryOwner,
    }))).toEqual([
      { positionCode: "OPERATION", taskStateIds: ["task-plan"], primaryOwner: true },
      { positionCode: "DOC", taskStateIds: ["task-documents"], primaryOwner: false },
    ]);
  });

  it("does not leak a module owner into an unassigned task owned by another position", () => {
    const manifest = buildOrderAssignmentManifest([
      row({
        moduleAssigneeUserId: "operator-1",
        taskAssigneeUserId: "operator-1",
      }),
      row({
        moduleAssigneeUserId: "operator-1",
        taskStateId: "task-documents",
        taskKey: "documents",
        taskName: "准备随车文件",
        taskSortOrder: 20,
        taskPositionCode: "DOC",
        taskAssigneeUserId: null,
      }),
    ]);

    expect(manifest.groups.map((group) => ({
      positionCode: group.positionCode,
      assignmentState: group.assignmentState,
      assigneeUserId: group.assigneeUserId,
    }))).toEqual([
      { positionCode: "OPERATION", assignmentState: "assigned", assigneeUserId: "operator-1" },
      { positionCode: "DOC", assignmentState: "unassigned", assigneeUserId: null },
    ]);
  });

  it("keeps optional work visible without turning it into a confirmation blocker", () => {
    const manifest = buildOrderAssignmentManifest([
      row({
        moduleStateId: "module-exceptions",
        moduleCode: "exceptions",
        moduleName: "异常处理",
        moduleRequired: false,
        taskStateId: "task-exceptions",
        taskRequired: true,
      }),
    ]);

    expect(manifest.groups).toHaveLength(1);
    expect(manifest.groups[0]).toMatchObject({ required: false });
    expect(manifest.groups[0].modules[0]).toMatchObject({ required: false });
  });

  it("excludes completed work and reports a missing position only for required work", () => {
    const manifest = buildOrderAssignmentManifest([
      row({ moduleStatus: "completed" }),
      row({
        moduleStateId: "module-review",
        moduleCode: "review",
        moduleName: "完成复盘",
        modulePositionCode: null,
        taskStateId: null,
        taskKey: null,
        taskName: null,
        taskSortOrder: null,
        taskRequired: null,
        taskStatus: null,
        taskPositionCode: null,
      }),
      row({
        moduleStateId: "module-optional",
        moduleCode: "documents",
        moduleName: "文件归档",
        moduleRequired: false,
        modulePositionCode: null,
        taskStateId: null,
        taskKey: null,
        taskName: null,
        taskSortOrder: null,
        taskRequired: null,
        taskStatus: null,
        taskPositionCode: null,
      }),
    ]);

    expect(manifest.groups.map((group) => group.modules[0].moduleCode).sort()).toEqual([
      "documents",
      "review",
    ]);
    expect(manifest.configurationErrors).toEqual(["完成复盘未配置责任岗位"]);
  });
});
