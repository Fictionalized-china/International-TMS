import { describe, expect, it } from "vitest";
import { validateWorkflowResponsibilityReadiness } from "./workflow-publication-validation";

const steps = [
  { id: "review-step", step_key: "completion_review", name: "完成复盘", is_active: 1 },
];
const reviewModule = {
  id: "review-module",
  step_id: "review-step",
  module_code: "review",
  display_name: "订单复盘",
  is_active: 1,
  responsibility_position_code: "FINANCE_ACCOUNTING",
  completion_mode: "all_tasks" as const,
};
const reviewTask = {
  id: "review-task",
  step_module_id: "review-module",
  name: "复盘并归档",
  task_type: "review" as const,
  is_required: 1,
  is_active: 1,
  responsibility_position_code: null,
};
const finance = {
  code: "FINANCE_ACCOUNTING",
  name: "财务会计岗",
  status: "active",
  active_member_count: 1,
  permission_codes: "order.view,order.module.review.manage",
};

describe("workflow publication responsibility readiness", () => {
  it("accepts an explicit, staffed and authorized review finalizer", () => {
    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [reviewModule],
        tasks: [reviewTask],
        positions: [finance],
      }),
    ).toEqual([]);
  });

  it("rejects an unreachable or unauthorized human task", () => {
    const issues = validateWorkflowResponsibilityReadiness({
      steps,
      modules: [reviewModule],
      tasks: [reviewTask],
      positions: [{ ...finance, active_member_count: 0, permission_codes: "order.view" }],
    });
    expect(issues).toContain('节点“完成复盘”模块“订单复盘”任务“复盘并归档”的岗位“财务会计岗”没有可用账号');

    const permissionIssues = validateWorkflowResponsibilityReadiness({
      steps,
      modules: [reviewModule],
      tasks: [reviewTask],
      positions: [{ ...finance, permission_codes: "order.view" }],
    });
    expect(permissionIssues.join("\n")).toContain("order.module.review.manage");
  });

  it("rejects missing or disabled responsibility positions", () => {
    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [reviewModule],
        tasks: [{ ...reviewTask, responsibility_position_code: "DISABLED" }],
        positions: [{ ...finance, code: "DISABLED", status: "disabled" }],
      }).join("\n"),
    ).toContain("不存在或已停用");

    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [{ ...reviewModule, responsibility_position_code: null }],
        tasks: [reviewTask],
        positions: [finance],
      }).join("\n"),
    ).toContain("未配置责任岗位");
  });

  it("requires review to remain an explicit human finalization gate", () => {
    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [{ ...reviewModule, completion_mode: "automatic" }],
        tasks: [],
        positions: [finance],
      }).join("\n"),
    ).toContain("不能自动完成");

    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [reviewModule],
        tasks: [{ ...reviewTask, task_type: "system", is_required: 1 }],
        positions: [finance],
      }).join("\n"),
    ).toContain("必办的人工复盘任务");
  });

  it("does not demand a human assignee for automatic or system work", () => {
    const autoModule = {
      ...reviewModule,
      id: "auto-module",
      module_code: "documents",
      display_name: "系统文件同步",
      completion_mode: "automatic" as const,
      responsibility_position_code: null,
    };
    expect(
      validateWorkflowResponsibilityReadiness({
        steps: [{ ...steps[0], step_key: "outbound_transport", name: "出境运输" }],
        modules: [autoModule],
        tasks: [],
        positions: [],
      }),
    ).toEqual([]);
  });
});
