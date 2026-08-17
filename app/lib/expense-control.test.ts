import { describe, expect, it } from "vitest";
import {
  emptyExpenseDirectionControl,
  expenseDirectionNextAction,
  expenseDirectionProgress,
} from "./expense-control";

describe("expense direction controls", () => {
  it("keeps receivable and payable independent", () => {
    const receivable = emptyExpenseDirectionControl("receivable");
    const payable = { ...emptyExpenseDirectionControl("payable"), confirmed: 1 };
    expect(expenseDirectionNextAction(receivable)).toBe("确认费用");
    expect(expenseDirectionNextAction(payable)).toBe("业务审核");
  });

  it("shows the five explicit finance gates", () => {
    const control = {
      ...emptyExpenseDirectionControl("receivable"),
      confirmed: 1,
      business_reviewed: 1,
      finance_reviewed: 1,
      business_locked: 1,
      finance_locked: 1,
    };
    expect(expenseDirectionProgress(control)).toBe(100);
    expect(expenseDirectionNextAction(control)).toBe("已完成并锁定");
  });
});
