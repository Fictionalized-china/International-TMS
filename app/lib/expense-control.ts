export type ExpenseDirectionControl = {
  direction: "receivable" | "payable";
  confirmed: number;
  business_reviewed: number;
  finance_reviewed: number;
  business_locked: number;
  finance_locked: number;
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

export function expenseDirectionProgress(control: ExpenseDirectionControl) {
  return [
    control.confirmed,
    control.business_reviewed,
    control.finance_reviewed,
    control.business_locked,
    control.finance_locked,
  ].filter(Boolean).length * 20;
}
