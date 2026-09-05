export type PublicationStep = {
  id: string;
  step_key: string;
  name: string;
  is_active: number;
};

export type PublicationModule = {
  id: string;
  step_id: string;
  module_code: string;
  display_name: string;
  is_active: number;
  responsibility_position_code: string | null;
  completion_mode: "all_tasks" | "manual_confirm" | "automatic";
};

export type PublicationTask = {
  id: string;
  step_module_id: string;
  name: string;
  task_type: "form" | "review" | "decision" | "system";
  is_required: number;
  is_active: number;
  responsibility_position_code: string | null;
};

export type PublicationPositionReadiness = {
  code: string;
  name: string;
  status: string;
  active_member_count: number;
  permission_codes: string | null;
};

function acceptedHandlerPermissions(stepKey: string, moduleCode: string) {
  if (stepKey === "quotation") return ["quote.manage"];
  if (stepKey === "order_creation" && ["consignment", "cargo"].includes(moduleCode)) {
    return ["quote.manage", `order.module.${moduleCode}.manage`];
  }
  if (stepKey === "consignment_approval" && moduleCode === "consignment") {
    // The exact assignee uses the dedicated approval path, which deliberately
    // does not grant broad consignment editing to a supervisor.
    return ["order.view"];
  }
  if (["warehouse", "loading", "overseas_warehouse"].includes(moduleCode)) {
    return [`order.module.${moduleCode}.manage`, "warehouse.operate"];
  }
  return [`order.module.${moduleCode}.manage`];
}

function permissionSet(position: PublicationPositionReadiness) {
  return new Set(
    (position.permission_codes ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/**
 * Reject configurations that can be published but cannot be operated.
 *
 * Runtime authorization still uses the frozen workflow instance. This check
 * is the publication-time companion: every human task must resolve to a live
 * position with at least one active, permission-capable account. That keeps
 * the workflow editor, runtime gate and UI hand-off on the same configuration
 * instead of discovering an unreachable node after an order has been locked.
 */
export function validateWorkflowResponsibilityReadiness(input: {
  steps: readonly PublicationStep[];
  modules: readonly PublicationModule[];
  tasks: readonly PublicationTask[];
  positions: readonly PublicationPositionReadiness[];
}) {
  const issues: string[] = [];
  const activeSteps = input.steps.filter((step) => step.is_active);
  const activeStepIds = new Set(activeSteps.map((step) => step.id));
  const stepById = new Map(activeSteps.map((step) => [step.id, step]));
  const positionByCode = new Map(input.positions.map((position) => [position.code, position]));

  for (const module of input.modules.filter(
    (item) => item.is_active && activeStepIds.has(item.step_id),
  )) {
    const step = stepById.get(module.step_id)!;
    const tasks = input.tasks.filter(
      (task) => task.is_active && task.step_module_id === module.id,
    );

    if (module.completion_mode === "automatic") continue;

    for (const task of tasks.filter((item) => item.task_type !== "system")) {
      const positionCode = task.responsibility_position_code ?? module.responsibility_position_code;
      const taskLabel = `节点“${step.name}”模块“${module.display_name}”任务“${task.name}”`;
      if (!positionCode) {
        issues.push(`${taskLabel}未配置责任岗位`);
        continue;
      }
      const position = positionByCode.get(positionCode);
      if (!position || position.status !== "active") {
        issues.push(`${taskLabel}引用了不存在或已停用的岗位 ${positionCode}`);
        continue;
      }
      if (Number(position.active_member_count) < 1) {
        issues.push(`${taskLabel}的岗位“${position.name}”没有可用账号`);
        continue;
      }
      const accepted = acceptedHandlerPermissions(step.step_key, module.module_code);
      const granted = permissionSet(position);
      if (!accepted.some((permission) => granted.has(permission))) {
        issues.push(
          `${taskLabel}的岗位“${position.name}”缺少办理权限（需要 ${accepted.join(" 或 ")}）`,
        );
      }
    }
  }

  const reviewStep = activeSteps.find((step) => step.step_key === "completion_review");
  if (reviewStep) {
    const reviewModule = input.modules.find(
      (module) =>
        module.is_active &&
        module.step_id === reviewStep.id &&
        module.module_code === "review",
    );
    if (!reviewModule) {
      issues.push("完成复盘节点必须启用订单复盘模块");
    } else if (reviewModule.completion_mode === "automatic") {
      issues.push("订单复盘不能自动完成，必须由配置的复盘责任人明确确认归档");
    } else {
      const requiredHumanTask = input.tasks.some(
        (task) =>
          task.step_module_id === reviewModule.id &&
          task.is_active === 1 &&
          task.is_required === 1 &&
          task.task_type !== "system",
      );
      if (!requiredHumanTask) {
        issues.push("订单复盘模块必须至少配置一个必办的人工复盘任务");
      }
    }
  }

  return [...new Set(issues)];
}
