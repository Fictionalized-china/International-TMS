import {
  workflowInstanceCapabilityStageAccess,
  type LockedWorkflowStageContext,
} from "./workflow-instance-stage-gate";

export type ExpenseDirectionControl = {
  direction: "receivable" | "payable";
  confirmed: number;
  business_reviewed: number;
  finance_reviewed: number;
  business_locked: number;
  finance_locked: number;
};

export type ExpenseDirectionAction =
  | "confirm"
  | "business_review"
  | "finance_review";

export type ExpenseDirectionWorkflowField = {
  fieldKey: string;
  isActive: boolean;
  isRequired: boolean;
};

export type ExpenseDirectionActionMode = "required" | "optional" | "hidden";

export type ExpenseDirectionActionPolicy = {
  action: ExpenseDirectionAction;
  fieldKey: string;
  mode: ExpenseDirectionActionMode;
  active: boolean;
  required: boolean;
};

export type ExpenseDirectionActionAccess = {
  allowed: boolean;
  ownerLabel: string;
  reason: string | null;
};

export function emptyExpenseDirectionControl(
  direction: "receivable" | "payable",
): ExpenseDirectionControl {
  return {
    direction,
    confirmed: 0,
    business_reviewed: 0,
    finance_reviewed: 0,
    business_locked: 0,
    finance_locked: 0,
  };
}

export const expenseDirectionActions: readonly ExpenseDirectionAction[] = [
  "confirm",
  "business_review",
  "finance_review",
] as const;

export const expenseDirectionActionFieldKeys = {
  confirm: "customer_service_confirmation",
  business_review: "business_review",
  finance_review: "finance_review",
} as const satisfies Record<ExpenseDirectionAction, string>;

export function expenseDirectionActionPolicies(
  fields: readonly ExpenseDirectionWorkflowField[] = [],
): ExpenseDirectionActionPolicy[] {
  const legacyFallback = fields.length === 0;
  return expenseDirectionActions.map((action) => {
    const fieldKey = expenseDirectionActionFieldKeys[action];
    const configured = fields.find((field) => field.fieldKey === fieldKey);
    const active = configured ? configured.isActive : legacyFallback;
    const required = active && (configured ? configured.isRequired : true);
    return {
      action,
      fieldKey,
      mode: !active ? "hidden" : required ? "required" : "optional",
      active,
      required,
    };
  });
}

export function expenseDirectionActionLabel(action: ExpenseDirectionAction) {
  if (action === "confirm") return "费用确认";
  if (action === "business_review") return "业务审核";
  return "财务审核";
}

export function expenseDirectionActionCompleted(
  control: ExpenseDirectionControl,
  action: ExpenseDirectionAction,
) {
  if (action === "confirm") return control.confirmed === 1;
  if (action === "business_review") return control.business_reviewed === 1;
  return control.finance_reviewed === 1;
}

export function expenseDirectionComplete(
  control: ExpenseDirectionControl,
  fields: readonly ExpenseDirectionWorkflowField[] = [],
) {
  return expenseDirectionActionPolicies(fields)
    .filter((policy) => policy.required)
    .every((policy) =>
      expenseDirectionActionCompleted(control, policy.action),
  );
}

export function expenseDirectionActionAccess(input: {
  action: ExpenseDirectionAction;
  currentUserId: string;
  assignedUserId: string | null;
  assignedUserName?: string | null;
  positionCode: string | null;
  roleCodes: readonly string[];
  permissions: readonly string[];
}): ExpenseDirectionActionAccess {
  const administrator =
    ["BOSS", "DEVELOPER"].includes(input.positionCode ?? "") ||
    input.roleCodes.some((code) => ["boss", "developer", "owner"].includes(code));
  if (administrator) {
    return { allowed: true, ownerLabel: "老板或开发者", reason: null };
  }

  const roleName = input.action === "confirm"
    ? "客服费用负责人"
    : input.action === "business_review"
      ? "订单业务员"
      : "财务审核负责人";
  const ownerLabel = input.assignedUserName
    ? `${roleName} ${input.assignedUserName}`
    : `已分配的${roleName}`;
  if (!input.assignedUserId) {
    return {
      allowed: false,
      ownerLabel,
      reason: `尚未分配${roleName}，请先在任务分配中指定具体个人账户`,
    };
  }
  if (input.assignedUserId !== input.currentUserId) {
    return {
      allowed: false,
      ownerLabel,
      reason: `当前签核由${ownerLabel}办理`,
    };
  }

  const qualified = input.action === "confirm"
    ? input.positionCode === "CS" && input.permissions.includes("order.module.costs.manage")
    : input.action === "business_review"
      ? input.positionCode === "SALES"
      : input.positionCode === "FINANCE_ACCOUNTING" &&
        input.permissions.includes("billing.expense.approve");
  return qualified
    ? { allowed: true, ownerLabel, reason: null }
    : {
        allowed: false,
        ownerLabel,
        reason: `当前账号不是有效的${roleName}账号`,
      };
}

export function expenseDirectionProgress(
  control: ExpenseDirectionControl,
  fields: readonly ExpenseDirectionWorkflowField[] = [],
) {
  const activePolicies = expenseDirectionActionPolicies(fields).filter(
    (policy) => policy.active,
  );
  if (!activePolicies.length) return 100;
  const completed = activePolicies.filter((policy) =>
    expenseDirectionActionCompleted(control, policy.action),
  ).length;
  return Math.round((completed / activePolicies.length) * 100);
}

export function canCreateExpenseFromModule(
  moduleCode: string | null | undefined,
  entryContext: string,
) {
  return moduleCode === "costs" || (
    moduleCode === "consignment" && entryContext === "consignment_costs"
  );
}

export type ExpenseDirectionActionStageInput = {
  action: ExpenseDirectionAction;
  orderStatus: string;
  workflow: LockedWorkflowStageContext;
};

export function expenseDirectionActionStageAccess(
  currentStepKeyOrInput: string | null | ExpenseDirectionActionStageInput,
) {
  if (typeof currentStepKeyOrInput === "object" && currentStepKeyOrInput) {
    if (["completed", "cancelled"].includes(currentStepKeyOrInput.orderStatus)) {
      return {
        allowed: false as const,
        visible: true,
        targetStepKey: null,
        targetStepName: null,
        reason: currentStepKeyOrInput.orderStatus === "completed"
          ? "订单已完成，费用签核仅供查看"
          : "订单已取消，费用签核仅供查看",
      };
    }
    const access = workflowInstanceCapabilityStageAccess({
      context: currentStepKeyOrInput.workflow,
      moduleCode: "costs",
      fieldKeys: [expenseDirectionActionFieldKeys[currentStepKeyOrInput.action]],
    });
    if (access.configured) {
      return {
        allowed: access.available,
        visible: access.visible,
        targetStepKey: access.targetStepKey,
        targetStepName: access.targetStepName,
        reason: access.reason,
      };
    }
  }

  const currentStepKey = typeof currentStepKeyOrInput === "string"
    ? currentStepKeyOrInput
    : currentStepKeyOrInput?.workflow.currentStepKey ?? null;
  return ["reconciliation", "completion_review"].includes(currentStepKey ?? "")
    ? {
        allowed: true as const,
        visible: true,
        targetStepKey: null,
        targetStepName: null,
        reason: null,
      }
    : {
        allowed: false as const,
        visible: true,
        targetStepKey: null,
        targetStepName: null,
        reason: "客户自提签收完成并进入对账结算节点后，才可执行费用确认与三方审核",
      };
}
