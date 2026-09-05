import { describe, expect, it } from "vitest";
import {
  canCreateExpenseFromModule,
  emptyExpenseDirectionControl,
  expenseDirectionActionAccess,
  expenseDirectionActionStageAccess,
  expenseDirectionActionCompleted,
  expenseDirectionActionFieldKeys,
  expenseDirectionActionPolicies,
  expenseDirectionComplete,
  expenseDirectionProgress,
} from "./expense-control";

describe("expense direction controls", () => {
  it("maps every sign-off action to its workflow field", () => {
    expect(expenseDirectionActionFieldKeys).toEqual({
      confirm: "customer_service_confirmation",
      business_review: "business_review",
      finance_review: "finance_review",
    });
  });

  it("derives required, optional and hidden actions from workflow fields", () => {
    expect(
      expenseDirectionActionPolicies([
        {
          fieldKey: "customer_service_confirmation",
          isActive: true,
          isRequired: true,
        },
        { fieldKey: "business_review", isActive: true, isRequired: false },
        { fieldKey: "finance_review", isActive: false, isRequired: true },
      ]),
    ).toEqual([
      {
        action: "confirm",
        fieldKey: "customer_service_confirmation",
        mode: "required",
        active: true,
        required: true,
      },
      {
        action: "business_review",
        fieldKey: "business_review",
        mode: "optional",
        active: true,
        required: false,
      },
      {
        action: "finance_review",
        fieldKey: "finance_review",
        mode: "hidden",
        active: false,
        required: false,
      },
    ]);
  });

  it("treats an absent field as hidden once a workflow snapshot is configured", () => {
    const policies = expenseDirectionActionPolicies([
      {
        fieldKey: "customer_service_confirmation",
        isActive: true,
        isRequired: true,
      },
    ]);
    expect(policies.find((item) => item.action === "business_review")).toMatchObject({
      mode: "hidden",
      active: false,
    });
  });

  it("keeps all three actions required for legacy orders without workflow fields", () => {
    expect(expenseDirectionActionPolicies([]).map((item) => item.mode)).toEqual([
      "required",
      "required",
      "required",
    ]);
  });

  it("calculates progress from visible actions and completes when required actions are done", () => {
    const fields = [
      {
        fieldKey: "customer_service_confirmation",
        isActive: true,
        isRequired: true,
      },
      { fieldKey: "business_review", isActive: true, isRequired: false },
      { fieldKey: "finance_review", isActive: false, isRequired: false },
    ];
    const control = {
      ...emptyExpenseDirectionControl("receivable"),
      confirmed: 1,
    };
    expect(expenseDirectionProgress(control, fields)).toBe(50);
    expect(expenseDirectionComplete(control, fields)).toBe(true);
    expect(
      expenseDirectionProgress(
        { ...control, business_reviewed: 1 },
        fields,
      ),
    ).toBe(100);
  });

  it("does not let an incomplete required action pass the completion gate", () => {
    const fields = [
      {
        fieldKey: "customer_service_confirmation",
        isActive: true,
        isRequired: true,
      },
      { fieldKey: "business_review", isActive: true, isRequired: true },
      { fieldKey: "finance_review", isActive: false, isRequired: false },
    ];
    const control = {
      ...emptyExpenseDirectionControl("payable"),
      confirmed: 1,
    };
    expect(expenseDirectionComplete(control, fields)).toBe(false);
  });

  it("reports full progress when no sign-off action is visible", () => {
    const hiddenFields = Object.values(expenseDirectionActionFieldKeys).map(
      (fieldKey) => ({ fieldKey, isActive: false, isRequired: false }),
    );
    const control = emptyExpenseDirectionControl("receivable");
    expect(expenseDirectionProgress(control, hiddenFields)).toBe(100);
    expect(expenseDirectionComplete(control, hiddenFields)).toBe(true);
  });

  it("keeps the historical stage fallback only for orders without a locked snapshot", () => {
    expect(expenseDirectionActionStageAccess("overseas_pickup").allowed).toBe(false);
    expect(expenseDirectionActionStageAccess("reconciliation").allowed).toBe(true);
    expect(expenseDirectionActionStageAccess("completion_review").allowed).toBe(true);
  });

  it("opens each sign-off from its locked workflow field placement", () => {
    const workflow = {
      locked: true,
      currentStepKey: "custom_finance_gate",
      steps: [
        { stepKey: "pickup", stepName: "客户提货", sortOrder: 10 },
        {
          stepKey: "custom_finance_gate",
          stepName: "自定义财务审核",
          sortOrder: 20,
        },
      ],
      modulePlacements: [
        { moduleCode: "costs", stepKey: "custom_finance_gate" },
      ],
      fields: [
        {
          moduleCode: "costs",
          fieldKey: "finance_review",
          stepKey: "custom_finance_gate",
          isActive: true,
          isRequired: false,
        },
      ],
    } as const;

    expect(
      expenseDirectionActionStageAccess({
        action: "finance_review",
        workflow,
      }),
    ).toMatchObject({ allowed: true, reason: null });
    expect(
      expenseDirectionActionStageAccess({
        action: "business_review",
        workflow,
      }).allowed,
    ).toBe(false);
  });
  it("keeps receivable and payable independent and allows parallel sign-off", () => {
    const receivable = emptyExpenseDirectionControl("receivable");
    const payable = { ...emptyExpenseDirectionControl("payable"), finance_reviewed: 1 };
    expect(expenseDirectionActionCompleted(receivable, "finance_review")).toBe(false);
    expect(expenseDirectionActionCompleted(payable, "finance_review")).toBe(true);
    expect(expenseDirectionComplete(payable)).toBe(false);
  });

  it("completes after the three independent sign-offs", () => {
    const control = {
      ...emptyExpenseDirectionControl("receivable"),
      confirmed: 1,
      business_reviewed: 1,
      finance_reviewed: 1,
      business_locked: 1,
      finance_locked: 1,
    };
    expect(expenseDirectionProgress(control)).toBe(100);
    expect(expenseDirectionComplete(control)).toBe(true);
  });

  it("routes confirmation only to the assigned customer-service owner", () => {
    const base = {
      currentUserId: "cost-owner",
      assignedUserId: "cost-owner",
      assignedUserName: "客服甲",
      positionCode: "CS",
      roleCodes: ["pos_customer_service"],
      permissions: ["order.module.costs.manage"],
    };
    expect(expenseDirectionActionAccess({ ...base, action: "confirm" }).allowed).toBe(true);
    expect(expenseDirectionActionAccess({ ...base, action: "business_review" }).allowed).toBe(false);
    expect(expenseDirectionActionAccess({ ...base, action: "finance_review" })).toMatchObject({
      allowed: false,
    });
  });

  it("routes business and finance reviews to their exact assigned accounts", () => {
    const finance = {
      currentUserId: "finance-1",
      assignedUserId: "finance-1",
      assignedUserName: "财务甲",
      positionCode: "FINANCE_ACCOUNTING",
      roleCodes: ["pos_finance"],
      permissions: ["order.module.costs.manage", "billing.expense.approve"],
    };
    expect(expenseDirectionActionAccess({ ...finance, action: "finance_review" }).allowed).toBe(true);
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
    expect(expenseDirectionActionAccess({
      action: "business_review",
      currentUserId: "sales-1",
      assignedUserId: "sales-1",
      assignedUserName: "业务甲",
      positionCode: "SALES",
      roleCodes: ["pos_sales"],
      permissions: [],
    }).allowed).toBe(true);
  });

  it("lets boss and developer accounts handle every expense action", () => {
    for (const positionCode of ["BOSS", "DEVELOPER"]) {
      expect(expenseDirectionActionAccess({
        action: "finance_review",
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
