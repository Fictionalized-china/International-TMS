import { describe, expect, it } from "vitest";
import {
  canCreateExpenseFromModule,
  emptyExpenseDirectionControl,
  expenseDirectionActionAccess,
  expenseDirectionNextAction,
  expenseDirectionNextActionCode,
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
    expect(expenseDirectionNextActionCode(control)).toBeNull();
  });

  it("routes business-side actions to the assigned costs owner", () => {
    const base = {
      currentUserId: "cost-owner",
      assignedUserId: "cost-owner",
      assignedUserName: "客服甲",
      positionCode: "CS",
      roleCodes: ["pos_customer_service"],
      permissions: ["order.module.costs.manage"],
    };
    expect(expenseDirectionActionAccess({ ...base, action: "confirm" }).allowed).toBe(true);
    expect(expenseDirectionActionAccess({ ...base, action: "business_review" }).allowed).toBe(true);
    expect(expenseDirectionActionAccess({ ...base, action: "business_lock" }).allowed).toBe(true);
    expect(expenseDirectionActionAccess({ ...base, action: "finance_review" })).toMatchObject({
      allowed: false,
      ownerLabel: "财务会计岗",
    });
  });

  it("routes finance actions to finance and rejects unrelated module managers", () => {
    const finance = {
      currentUserId: "finance-1",
      assignedUserId: "cost-owner",
      assignedUserName: "客服甲",
      positionCode: "FINANCE_ACCOUNTING",
      roleCodes: ["pos_finance"],
      permissions: ["order.module.costs.manage", "billing.expense.approve"],
    };
    expect(expenseDirectionActionAccess({ ...finance, action: "finance_review" }).allowed).toBe(true);
    expect(expenseDirectionActionAccess({ ...finance, action: "finance_lock" }).allowed).toBe(true);
    expect(expenseDirectionActionAccess({ ...finance, action: "business_review" }).allowed).toBe(false);
    expect(expenseDirectionActionAccess({
      ...finance,
      permissions: ["order.module.costs.manage"],
      action: "finance_review",
    }).allowed).toBe(false);
    expect(expenseDirectionActionAccess({
      ...finance,
      currentUserId: "other-cs",
      positionCode: "CS",
      roleCodes: ["pos_customer_service"],
      permissions: ["order.module.costs.manage"],
      action: "confirm",
    }).allowed).toBe(false);
  });

  it("lets boss and developer accounts handle every expense action", () => {
    for (const positionCode of ["BOSS", "DEVELOPER"]) {
      expect(expenseDirectionActionAccess({
        action: "finance_lock",
        currentUserId: "admin",
        assignedUserId: null,
        positionCode,
        roleCodes: [],
        permissions: [],
      }).allowed).toBe(true);
    }
  });

  it("allows early expense entry only from the consignment costs section", () => {
    expect(canCreateExpenseFromModule("costs", "")).toBe(true);
    expect(canCreateExpenseFromModule("consignment", "consignment_costs")).toBe(true);
    expect(canCreateExpenseFromModule("consignment", "info")).toBe(false);
    expect(canCreateExpenseFromModule("warehouse", "consignment_costs")).toBe(false);
  });
});
