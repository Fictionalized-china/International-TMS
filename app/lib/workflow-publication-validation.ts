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

const customsDeclarationMutationFieldKeys = new Set([
  "customs_declarations",
  "declaration_stage",
  "declaration_status",
  "declaration_number",
  "declaration_type",
  "declaration_title",
  "declaring_company",
  "declared_at",
  "declared_amount",
  "declaration_currency",
  "declaration_gross_weight",
  "declaration_change_flags",
  "declaration_change_reason",
]);

export type PublicationPositionReadiness = {
  code: string;
  name: string;
  status: string;
  active_member_count: number;
  permission_codes: string | null;
  active_member_permissions?: readonly {
    membershipId: string;
    positionCode?: string;
    permissionCodes: readonly string[];
    permissionOverrides?: readonly { code: string; effect: "allow" | "deny" }[];
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
export function validateWorkflowOperationalGateStructure(input: {
  steps: readonly (PublicationStep & { sort_order?: number })[];
  modules: readonly PublicationModule[];
  fields: readonly PublicationField[];
}) {
  const activeStepIds = new Set(
    input.steps.filter((step) => step.is_active === 1).map((step) => step.id),
  );
  const activeStepById = new Map(
    input.steps
      .filter((step) => step.is_active === 1)
      .map((step) => [step.id, step]),
  );
  const activeFields = input.fields.filter(
    (field) => field.is_active === 1 && activeStepIds.has(field.step_id),
  );
  const activeModulePlacements = new Set(
    input.modules
      .filter((module) => module.is_active === 1 && activeStepIds.has(module.step_id))
      .map((module) => `${module.step_id}:${module.module_code}`),
  );
  const release = activeFields.find((field) => field.field_key === "customs_release");
  const declarations = activeFields.find(
    (field) => field.field_key === "customs_declarations",
  );
  const issues: string[] = [];
  for (const field of activeFields.filter((item) => item.module_code === "customs")) {
    if (!activeModulePlacements.has(`${field.step_id}:customs`)) {
      const stepName = activeStepById.get(field.step_id)?.name ?? field.step_id;
      issues.push(
        `节点“${stepName}”的 ${field.field_key} 已启用，但同节点未启用 customs 模块`,
      );
    }
  }
  if (release && !declarations) {
    issues.push("已启用 customs_release，但未启用其申报来源 customs_declarations");
  }
  if (release && declarations) {
    const releaseOrder = Number(activeStepById.get(release.step_id)?.sort_order ?? 0);
    const declarationOrder = Number(activeStepById.get(declarations.step_id)?.sort_order ?? 0);
    if (releaseOrder < declarationOrder) {
      issues.push("customs_release 不能早于 customs_declarations");
    }
  }
  const activeMutationFields = activeFields.filter((field) =>
    customsDeclarationMutationFieldKeys.has(field.field_key)
  );
  if (!declarations && activeMutationFields.length) {
    issues.push(
      `报关申报写入字段 ${activeMutationFields.map((field) => field.field_key).join("、")} 已启用，但未启用 customs_declarations`,
    );
  } else if (declarations) {
    const misplacedMutationFields = activeMutationFields.filter(
      (field) =>
        field.step_id !== declarations.step_id,
    );
    if (misplacedMutationFields.length) {
      issues.push(
        `报关申报写入字段必须与 customs_declarations 所在节点一致：${misplacedMutationFields
          .map((field) => field.field_key)
          .join("、")}`,
      );
    }
  }
  const loadingConfirmation = activeFields.find(
    (field) => field.field_key === "loading_scan_confirmation",
  );
  if (
    loadingConfirmation &&
    !activeModulePlacements.has(`${loadingConfirmation.step_id}:loading`)
  ) {
    const stepName = activeStepById.get(loadingConfirmation.step_id)?.name ?? loadingConfirmation.step_id;
    issues.push(
      `节点“${stepName}”的 loading_scan_confirmation 已启用，但同节点未启用 loading 模块`,
    );
  }
  const actualExit = activeFields.find((field) => field.field_key === "actual_exit_at");
  if (
    actualExit &&
    !activeModulePlacements.has(`${actualExit.step_id}:tracking`)
  ) {
    const stepName = activeStepById.get(actualExit.step_id)?.name ?? actualExit.step_id;
    issues.push(
      `节点“${stepName}”的 actual_exit_at 已启用，但同节点未启用 tracking 模块`,
    );
  }
  const requiredLoadingModules = input.modules.filter(
    (module) =>
      module.is_active === 1 &&
      module.is_required === 1 &&
      module.module_code === "loading" &&
      activeStepIds.has(module.step_id),
  );
  if (actualExit) {
    if (!requiredLoadingModules.length) {
      issues.push("actual_exit_at 已启用，但没有启用且必办的 loading 模块");
    } else {
      const exitOrder = Number(activeStepById.get(actualExit.step_id)?.sort_order ?? 0);
      const latestLoadingOrder = Math.max(
        ...requiredLoadingModules.map((module) =>
          Number(activeStepById.get(module.step_id)?.sort_order ?? 0)
        ),
      );
      if (exitOrder <= latestLoadingOrder) {
        issues.push("actual_exit_at 必须位于必办 loading 模块之后");
      }
    }
  }
  if (release?.is_required === 1 && actualExit) {
    const releaseOrder = Number(activeStepById.get(release.step_id)?.sort_order ?? 0);
    const exitOrder = Number(activeStepById.get(actualExit.step_id)?.sort_order ?? 0);
    if (releaseOrder > exitOrder) {
      issues.push("必填 customs_release 不能位于 actual_exit_at 之后");
    }
  }
  return issues;
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

function permissionSet(position: PublicationPositionReadiness) {
  return new Set(
    (position.permission_codes ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function handlerSafetyPermissionRequirements(
  stepKey: string,
  positionCode: string,
  moduleCode: string,
) {
  if (stepKey === "quotation") return [["quote.manage"]];
  return orderAssignmentPermissionRequirements({
    assignmentMode: "person",
    positionCode,
    moduleCodes: [moduleCode],
  });
}

type PublicationMember = NonNullable<PublicationPositionReadiness["active_member_permissions"]>[number];

function publicationMembers(positions: readonly PublicationPositionReadiness[]) {
  const members = new Map<string, PublicationMember>();
  for (const position of positions) {
    for (const member of position.active_member_permissions ?? []) {
      members.set(member.membershipId, {
        ...member,
        positionCode: member.positionCode ?? position.code,
      });
    }
  }
  return [...members.values()];
}

function publicationMemberCanHandleNodes(
  member: PublicationMember,
  responsibilityPositionCode: string,
  nodes: readonly { stepKey: string; moduleCode: string }[],
) {
  return nodes.every((node) => {
    if (member.permissionOverrides?.some(
      (override) =>
        override.code === `order.module.${node.moduleCode}.manage` &&
        override.effect === "deny",
    )) return false;
    return member.positionCode === responsibilityPositionCode;
  });
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
  const members = publicationMembers(input.positions);
  const hasMemberDetails = input.positions.some((position) =>
    position.active_member_permissions !== undefined
  );
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
      const safetyRequirements = handlerSafetyPermissionRequirements(
        step.step_key,
        positionCode,
        module.module_code,
      );
      const hasEligibleMember = hasMemberDetails
        ? members.some((member) =>
            publicationMemberCanHandleNodes(
              member,
              positionCode,
              [{ stepKey: step.step_key, moduleCode: module.module_code }],
            ) && satisfiesOrganizationAssigneePermissionRequirements(
              member.permissionCodes,
              safetyRequirements,
            )
          )
        : Number(position.active_member_count) > 0 &&
          satisfiesOrganizationAssigneePermissionRequirements(
            permissionSet(position),
            safetyRequirements,
          );
      if (!hasEligibleMember) {
        issues.push(
          `${taskLabel}的责任岗位没有具备基础安全权限的有效账号；请调整责任岗位或岗位角色权限`,
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
  const requiredPersonalGroups = new Map<string, {
    moduleCodes: Set<string>;
    nodes: Array<{ stepKey: string; moduleCode: string }>;
  }>();
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
    const group = requiredPersonalGroups.get(positionCode) ?? {
      moduleCodes: new Set<string>(),
      nodes: [],
    };
    group.moduleCodes.add(module.module_code);
    const stepKey = stepById.get(module.step_id)?.step_key;
    if (stepKey && !group.nodes.some(
      (node) => node.stepKey === stepKey && node.moduleCode === module.module_code,
    )) group.nodes.push({ stepKey, moduleCode: module.module_code });
    requiredPersonalGroups.set(positionCode, group);
  }
  for (const [positionCode, group] of requiredPersonalGroups) {
    const position = positionByCode.get(positionCode);
    if (!hasMemberDetails) continue;
    const safetyRequirements = orderAssignmentPermissionRequirements({
      assignmentMode: "person",
      positionCode,
      moduleCodes: [...group.moduleCodes],
    });
    const hasCapableMember = members.some((member) =>
      publicationMemberCanHandleNodes(member, positionCode, group.nodes) &&
      satisfiesOrganizationAssigneePermissionRequirements(
        member.permissionCodes,
        safetyRequirements,
      )
    );
    if (!hasCapableMember) {
      issues.push(
        `岗位“${position?.name ?? positionCode}”没有同一有效个人账号可同时办理派单后的全部必办节点（${[...group.moduleCodes].join("、")}）；请调整责任岗位或岗位角色权限后再发布`,
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
