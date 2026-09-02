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
  | "finance_review"
  | "business_lock"
  | "finance_lock";

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

export function expenseDirectionNextAction(control: ExpenseDirectionControl) {
  if (!control.confirmed) return "确认费用";
  if (!control.business_reviewed) return "业务审核";
  if (!control.finance_reviewed) return "财务审核";
  if (!control.business_locked) return "业务锁定";
  if (!control.finance_locked) return "财务锁定";
  return "已完成并锁定";
}

export function expenseDirectionNextActionCode(
  control: ExpenseDirectionControl,
): ExpenseDirectionAction | null {
  if (!control.confirmed) return "confirm";
  if (!control.business_reviewed) return "business_review";
  if (!control.finance_reviewed) return "finance_review";
  if (!control.business_locked) return "business_lock";
  if (!control.finance_locked) return "finance_lock";
  return null;
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

  if (!input.permissions.includes("order.module.costs.manage")) {
    return {
      allowed: false,
      ownerLabel: "已授权的费用办理人员",
      reason: "当前账号没有费用模块办理权限",
    };
  }

  if (["finance_review", "finance_lock"].includes(input.action)) {
    const financeOperator = input.permissions.includes("billing.expense.approve");
    return financeOperator
      ? { allowed: true, ownerLabel: "财务会计岗", reason: null }
      : {
          allowed: false,
          ownerLabel: "财务会计岗",
          reason: "当前步骤由具有费用审批权限的财务会计岗办理",
        };
  }

  const ownerLabel = input.assignedUserName
    ? `费用负责人 ${input.assignedUserName}`
    : "已分配的费用负责人";
  if (!input.assignedUserId) {
    return {
      allowed: false,
      ownerLabel,
      reason: "尚未分配费用负责人，请先在任务分配中指定具体个人账户",
    };
  }
  return input.assignedUserId === input.currentUserId
    ? { allowed: true, ownerLabel, reason: null }
    : {
        allowed: false,
        ownerLabel,
        reason: `当前步骤由${ownerLabel}办理`,
      };
}

export function expenseDirectionProgress(control: ExpenseDirectionControl) {
  return [
    control.confirmed,
    control.business_reviewed,
    control.finance_reviewed,
    control.business_locked,
    control.finance_locked,
  ].filter(Boolean).length * 20;
}

export function canCreateExpenseFromModule(
  moduleCode: string | null | undefined,
  entryContext: string,
) {
  return moduleCode === "costs" || (
    moduleCode === "consignment" && entryContext === "consignment_costs"
  );
}
