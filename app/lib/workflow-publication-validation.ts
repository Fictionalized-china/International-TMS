import { workflowSystemTaskHasAutoHandler } from "./workflow-execution";
import { isAllowedRepeatedRequiredModulePlacement } from "./workflow-required-module-placements";
import {
  orderAssignmentMode,
  orderAssignmentPermissionRequirements,
} from "./order-assignment-manifest";
import { satisfiesOrganizationAssigneePermissionRequirements } from "./organization-assignee";

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
  is_required: number;
  responsibility_position_code: string | null;
  completion_mode: "all_tasks" | "manual_confirm" | "automatic";
};

export type PublicationTask = {
  id: string;
  task_key?: string;
  step_module_id: string;
  name: string;
  task_type: "form" | "review" | "decision" | "system";
  is_required: number;
  is_active: number;
  responsibility_position_code: string | null;
};

export type PublicationField = {
  step_id: string;
  module_code: string | null;
  field_key: string;
  is_required: number;
  is_active: number;
};

export type PublicationPositionReadiness = {
  code: string;
  name: string;
  status: string;
  active_member_count: number;
  permission_codes: string | null;
  active_member_permissions?: readonly {
    membershipId: string;
    permissionCodes: readonly string[];
  }[];
};

export const workflowCoreStepSequence = [
  "quotation",
  "order_creation",
  "consignment_approval",
  "task_assignment",
  "domestic_execution",
  "warehouse_receiving",
  "port_loading",
  "outbound_transport",
  "overseas_pickup",
  "reconciliation",
  "completion_review",
] as const;

export function validateWorkflowCoreStepOrder(
  steps: readonly (PublicationStep & { sort_order?: number })[],
) {
  const activeOrder = new Map(
    steps
      .filter((step) => step.is_active === 1)
      .map((step) => [step.step_key, Number(step.sort_order ?? 0)]),
  );
  const presentSequence = workflowCoreStepSequence.filter((key) => activeOrder.has(key));
  const misplaced = presentSequence.find((key, index) =>
    index > 0 && activeOrder.get(key)! <= activeOrder.get(presentSequence[index - 1])!,
  );
  return misplaced
    ? ["基础业务节点必须保持询价、委托、审批、分配、运输、仓库、出境、签收、结算、复盘的先后顺序；可在其间插入自定义节点，但不能倒置基础节点"]
    : [];
}
export function validateWorkflowCoreModuleBindings(
  steps: readonly PublicationStep[],
  modules: readonly PublicationModule[],
  tasks: readonly PublicationTask[] = [],
) {
  const activeSteps = steps.filter((step) => step.is_active === 1);
  const requirements = [
    {
      stepKey: "quotation",
      moduleCode: "consignment",
      mustBeRequired: true,
      label: "询价报价",
    },
    {
      stepKey: "order_creation",
      moduleCode: "consignment",
      mustBeRequired: true,
      label: "委托信息",
    },
    {
      stepKey: "consignment_approval",
      moduleCode: "consignment",
      mustBeRequired: true,
      label: "委托审核",
    },
    {
      stepKey: "task_assignment",
      moduleCode: "assignment",
      mustBeRequired: true,
      label: "任务分配",
    },
  ] as const;
  const issues = requirements.flatMap((requirement) => {
    const step = activeSteps.find((item) => item.step_key === requirement.stepKey);
    if (!step) return [];
    const hasSemanticModule = modules.some((module) =>
      module.is_active === 1 &&
      module.step_id === step.id &&
      (!requirement.mustBeRequired || module.is_required === 1) &&
      module.module_code === requirement.moduleCode
    );
    return hasSemanticModule ? [] : [`状态驱动节点“${requirement.label}”必须启用必办的 ${requirement.moduleCode} 语义模块`];
  });
  const approvalStep = activeSteps.find((item) => item.step_key === "consignment_approval");
  const approvalModule = approvalStep
    ? modules.find((module) =>
        module.is_active === 1 &&
        module.step_id === approvalStep.id &&
        module.module_code === "consignment"
        && module.is_required === 1
      )
    : null;
  if (approvalModule && (
    approvalModule.completion_mode !== "manual_confirm" ||
    !tasks.some((task) =>
      task.step_module_id === approvalModule.id && task.is_active === 1 &&
      task.is_required === 1 && task.task_type === "review"
    )
  )) issues.push("状态驱动节点“委托审核”必须使用人工确认模式并配置必办审核任务");
  return issues;
}

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

const settlementActionRequirements = {
  customer_service_confirmation: {
    label: "费用确认",
    positionCode: "CS",
    permissionCodes: ["order.module.costs.manage"],
  },
  business_review: {
    label: "业务审核",
    positionCode: "SALES",
    permissionCodes: [],
  },
  finance_review: {
    label: "财务审核",
    positionCode: "FINANCE_ACCOUNTING",
    permissionCodes: ["billing.expense.approve"],
  },
} as const;

function positionReadinessIssue(
  position: PublicationPositionReadiness | undefined,
  expectedCode: string,
  permissionCodes: readonly string[],
) {
  if (!position || position.status !== "active") return `岗位 ${expectedCode} 不存在或已停用`;
  if (Number(position.active_member_count) < 1) return `岗位“${position.name}”没有可用账号`;
  const granted = permissionSet(position);
  const missing = permissionCodes.filter((permission) => !granted.has(permission));
  return missing.length ? `岗位“${position.name}”缺少办理权限（需要 ${missing.join("、")}）` : null;
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
  fields?: readonly PublicationField[];
}) {
  const issues: string[] = [];
  const activeSteps = input.steps.filter((step) => step.is_active);
  const activeStepIds = new Set(activeSteps.map((step) => step.id));
  const stepById = new Map(activeSteps.map((step) => [step.id, step]));
  const positionByCode = new Map(input.positions.map((position) => [position.code, position]));
  const requiredPlacements = new Map<string, string[]>();
  for (const module of input.modules.filter(
    (item) => item.is_active === 1 && item.is_required === 1 && activeStepIds.has(item.step_id),
  )) {
    const stepKey = stepById.get(module.step_id)?.step_key;
    if (!stepKey) continue;
    const stepKeys = requiredPlacements.get(module.module_code) ?? [];
    stepKeys.push(stepKey);
    requiredPlacements.set(module.module_code, stepKeys);
  }
  for (const [moduleCode, stepKeys] of requiredPlacements) {
    if (
      stepKeys.length > 1 &&
      !isAllowedRepeatedRequiredModulePlacement(moduleCode, stepKeys)
    ) {
      issues.push(`同一模块编码“${moduleCode}”不能配置多个启用且必办的节点位置`);
    }
  }

  for (const module of input.modules.filter(
    (item) => item.is_active && activeStepIds.has(item.step_id),
  )) {
    const step = stepById.get(module.step_id)!;
    const tasks = input.tasks.filter(
      (task) => task.is_active && task.step_module_id === module.id,
    );

    if (module.completion_mode === "automatic") continue;

    const humanTasks = tasks.filter((item) => item.task_type !== "system");
    if (
      module.is_required === 1 &&
      humanTasks.length > 0 &&
      !humanTasks.some((task) => task.is_required === 1)
    ) {
      issues.push(
        `节点“${step.name}”模块“${module.display_name}”是必办人工模块，但人工任务全部设为选办；请至少将一个已配置责任岗位的人工任务设为必办，或将模块改为选办/系统自动完成`,
      );
    }
    for (const task of tasks.filter(
      (item) =>
        module.is_required === 1 &&
        item.task_type === "system" &&
        item.is_required === 1,
    )) {
      if (!workflowSystemTaskHasAutoHandler(step.step_key, task.task_key ?? "")) {
        const taskKey = task.task_key ?? "";
        issues.push(
          `节点“${step.name}”模块“${module.display_name}”的必办系统任务“${task.name}”没有受支持的自动处理器${taskKey ? `（${taskKey}）` : ""}；请改用系统支持的任务键，或改为人工任务/系统自动完成模块`,
        );
      }
    }

    for (const task of humanTasks) {
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
      const memberPermissions = position.active_member_permissions;
      const hasAcceptedPermission = memberPermissions
        ? memberPermissions.some((member) =>
            satisfiesOrganizationAssigneePermissionRequirements(
              member.permissionCodes,
              [accepted],
            )
          )
        : accepted.some((permission) => permissionSet(position).has(permission));
      if (!hasAcceptedPermission) {
        issues.push(
          `${taskLabel}的岗位“${position.name}”缺少办理权限（需要 ${accepted.join(" 或 ")}）`,
        );
      }
    }
  }
  const assignmentStepIndex = activeSteps.findIndex(
    (step) => step.step_key === "task_assignment",
  );
  const assignableStepIds = new Set(
    activeSteps
      .filter((_, index) => assignmentStepIndex < 0 || index > assignmentStepIndex)
      .map((step) => step.id),
  );
  const requiredPersonalGroups = new Map<string, Set<string>>();
  for (const task of input.tasks.filter(
    (item) => item.is_active === 1 && item.is_required === 1 && item.task_type !== "system",
  )) {
    const module = input.modules.find(
      (item) =>
        item.id === task.step_module_id &&
        item.is_active === 1 &&
        item.is_required === 1 &&
        item.completion_mode !== "automatic" &&
        item.module_code !== "assignment" &&
        assignableStepIds.has(item.step_id),
    );
    if (!module) continue;
    const positionCode =
      task.responsibility_position_code ?? module.responsibility_position_code;
    if (!positionCode || orderAssignmentMode(positionCode) !== "person") continue;
    const moduleCodes = requiredPersonalGroups.get(positionCode) ?? new Set<string>();
    moduleCodes.add(module.module_code);
    requiredPersonalGroups.set(positionCode, moduleCodes);
  }
  for (const [positionCode, moduleCodes] of requiredPersonalGroups) {
    const position = positionByCode.get(positionCode);
    const members = position?.active_member_permissions;
    if (!members) continue;
    const requirements = orderAssignmentPermissionRequirements({
      assignmentMode: "person",
      positionCode,
      moduleCodes: [...moduleCodes],
    });
    const hasCapableMember = members.some((member) =>
      satisfiesOrganizationAssigneePermissionRequirements(
        member.permissionCodes,
        requirements,
      ),
    );
    if (!hasCapableMember) {
      issues.push(
        `岗位“${position?.name ?? positionCode}”没有同一有效个人账号可同时办理派单后的全部必办模块（${[...moduleCodes].join("、")}）；请调整个人权限或责任岗位后再发布`,
      );
    }
  }


  const activeSettlementFields = (input.fields ?? []).filter(
    (field) =>
      field.is_active === 1 &&
      field.module_code === "costs" &&
      field.field_key in settlementActionRequirements &&
      activeStepIds.has(field.step_id),
  );
  for (const field of activeSettlementFields) {
    const requirement = settlementActionRequirements[
      field.field_key as keyof typeof settlementActionRequirements
    ];
    const step = stepById.get(field.step_id)!;
    const label = `节点“${step.name}”的结算动作“${requirement.label}”`;

    if (field.field_key === "customer_service_confirmation") {
      const costsModule = input.modules.find(
        (module) =>
          module.is_active === 1 &&
          module.step_id === field.step_id &&
          module.module_code === "costs",
      );
      if (!costsModule) {
        issues.push(`${label}已启用，但同节点未启用费用结算模块`);
        continue;
      }
      if (costsModule.responsibility_position_code !== requirement.positionCode) {
        issues.push(
          `${label}运行时由客服费用负责人办理；对应费用模块责任岗位必须为 ${requirement.positionCode}`,
        );
        continue;
      }
      const incompatibleTasks = input.tasks.filter((task) =>
        task.is_active === 1 &&
        task.is_required === 1 &&
        task.task_type !== "system" &&
        task.step_module_id === costsModule.id &&
        (task.responsibility_position_code ?? costsModule.responsibility_position_code) !==
          requirement.positionCode
      );
      if (incompatibleTasks.length) {
        issues.push(`${label}不支持由任务覆写其他岗位；必办人工任务责任岗位必须为 ${requirement.positionCode}`);
        continue;
      }
    }

    if (field.field_key === "finance_review") {
      const reviewModules = input.modules.filter(
        (module) =>
          module.is_active === 1 &&
          activeStepIds.has(module.step_id) &&
          module.module_code === "review",
      );
      if (!reviewModules.length) {
        issues.push(`${label}已启用，但未启用提供财务负责人的订单复盘模块`);
        continue;
      }
      if (reviewModules.some(
        (module) => module.responsibility_position_code !== requirement.positionCode,
      )) {
        issues.push(
          `${label}运行时由订单复盘负责人办理；所有已启用订单复盘模块的责任岗位必须为 ${requirement.positionCode}`,
        );
        continue;
      }
      const incompatibleTasks = reviewModules.flatMap((module) =>
        input.tasks.filter((task) =>
          task.is_active === 1 &&
          task.is_required === 1 &&
          task.task_type !== "system" &&
          task.step_module_id === module.id &&
          (task.responsibility_position_code ?? module.responsibility_position_code) !==
            requirement.positionCode
        )
      );
      if (incompatibleTasks.length) {
        issues.push(`${label}不支持由复盘任务覆写其他岗位；必办人工任务责任岗位必须为 ${requirement.positionCode}`);
        continue;
      }
    }

    const readiness = positionReadinessIssue(
      positionByCode.get(requirement.positionCode),
      requirement.positionCode,
      requirement.permissionCodes,
    );
    if (readiness) issues.push(`${label}${readiness}`);
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
