import { describe, expect, it } from "vitest";
import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";
import {
  resolveSettlementMultiOrderActionAccess,
  resolveSettlementOrderActionAccess,
  settlementActionFieldKeys,
  type SettlementWorkbenchActor,
} from "./settlement-workbench-access";

function actor(overrides: Partial<SettlementWorkbenchActor> = {}): SettlementWorkbenchActor {
  return {
    organizationId: "org-1",
    userId: "finance-1",
    positionCode: "FINANCE_ACCOUNTING",
    roleCodes: ["pos_finance"],
    permissions: [
      "billing.view",
      "billing.sensitive.view",
      "billing.manage",
      "billing.cash.manage",
      "order.scope.assigned",
    ],
    ...overrides,
  };
}

function frozen(input: {
  current?: string | null;
  target?: string;
  fields?: LockedWorkflowStageContext["fields"];
  placements?: LockedWorkflowStageContext["modulePlacements"];
  steps?: LockedWorkflowStageContext["steps"];
  locked?: boolean;
} = {}): LockedWorkflowStageContext {
  const target = input.target ?? "settlement";
  return {
    locked: input.locked ?? true,
    currentStepKey: input.current === undefined ? target : input.current,
    steps: input.steps ?? [
      { stepKey: "delivery", stepName: "客户签收", sortOrder: 90 },
      { stepKey: target, stepName: "三方结算", sortOrder: 100 },
      { stepKey: "review", stepName: "复盘归档", sortOrder: 110 },
    ],
    modulePlacements: input.placements ?? [{ moduleCode: "costs", stepKey: target }],
    fields: input.fields ?? [
      { moduleCode: "costs", fieldKey: "reconciliation_statement", stepKey: target, isActive: true, isRequired: true },
      { moduleCode: "costs", fieldKey: "invoice_records", stepKey: target, isActive: true, isRequired: true },
      { moduleCode: "costs", fieldKey: "cash_records", stepKey: target, isActive: true, isRequired: true },
      { moduleCode: "costs", fieldKey: "writeoff_records", stepKey: target, isActive: true, isRequired: true },
    ],
  };
}

describe("settlement workbench action policy", () => {
  it("maps each mutation to its frozen costs fields", () => {
    expect(settlementActionFieldKeys).toEqual({
      create_reconciliation: ["reconciliation_statement"],
      confirm_reconciliation: ["reconciliation_statement"],
      record_invoice: ["invoice_records"],
      allocate_cash: ["cash_records", "writeoff_records"],
    });
  });

  it("does not let sensitive visibility expand an unassigned actor's order scope", () => {
    const denied = resolveSettlementOrderActionAccess({
      action: "create_reconciliation",
      actor: actor(),
      orderId: "order-1",
      assignedToActor: false,
      workflow: frozen(),
      legacyFallback: "deny",
    });
    expect(denied).toMatchObject({ inScope: false, visible: false, canWrite: false });
    expect(denied.reason).toContain("不在当前账号的结算范围");

    const explicit = resolveSettlementOrderActionAccess({
      action: "create_reconciliation",
      actor: actor({ permissions: [...actor().permissions, "billing.scope.all"] }),
      orderId: "order-1",
      assignedToActor: false,
      workflow: frozen(),
      legacyFallback: "deny",
    });
    expect(explicit).toMatchObject({ inScope: true, visible: true, canWrite: true });
  });

  it("gives owner and boss roles full scope without treating ordinary admin roles as owners", () => {
    for (const roleCode of ["owner", "boss"]) {
      expect(resolveSettlementOrderActionAccess({
        action: "record_invoice",
        actor: actor({ roleCodes: [roleCode] }),
        orderId: `order-${roleCode}`,
        assignedToActor: false,
        workflow: frozen(),
        legacyFallback: "deny",
      }).canWrite).toBe(true);
    }
    expect(resolveSettlementOrderActionAccess({
      action: "record_invoice",
      actor: actor({ roleCodes: ["developer"] }),
      orderId: "order-developer",
      assignedToActor: false,
      workflow: frozen(),
      legacyFallback: "deny",
    }).inScope).toBe(false);
  });

  it("allows writes only at the exact frozen field step and keeps past or future stages read-only", () => {
    const atTarget = resolveSettlementOrderActionAccess({
      action: "create_reconciliation",
      actor: actor(),
      orderId: "order-at",
      assignedToActor: true,
      workflow: frozen(),
      legacyFallback: "deny",
    });
    expect(atTarget).toMatchObject({ visible: true, canWrite: true, targetStepKey: "settlement", reason: null });

    const before = resolveSettlementOrderActionAccess({
      action: "create_reconciliation",
      actor: actor(),
      orderId: "order-before",
      assignedToActor: true,
      workflow: frozen({ current: "delivery" }),
      legacyFallback: "deny",
    });
    expect(before).toMatchObject({ visible: true, canWrite: false, targetStepName: "三方结算" });
    expect(before.reason).toContain("进入“三方结算”后开放");

    const after = resolveSettlementOrderActionAccess({
      action: "create_reconciliation",
      actor: actor(),
      orderId: "order-after",
      assignedToActor: true,
      workflow: frozen({ current: "review" }),
      legacyFallback: "deny",
    });
    expect(after).toMatchObject({ visible: true, canWrite: false });
    expect(after.reason).toContain("已离开“三方结算”");
  });

  it("does not show an action when every mapped frozen field is hidden", () => {
    const hidden = frozen();
    const result = resolveSettlementOrderActionAccess({
      action: "allocate_cash",
      actor: actor(),
      orderId: "order-hidden",
      assignedToActor: true,
      workflow: {
        ...hidden,
        fields: hidden.fields.map((field) =>
          ["cash_records", "writeoff_records"].includes(field.fieldKey)
            ? { ...field, isActive: false }
            : field,
        ),
      },
      legacyFallback: "deny",
    });
    expect(result).toMatchObject({ visible: false, canWrite: false });
    expect(result.reason).toContain("未启用");
  });

  it("uses the active allocation field when its paired field is hidden", () => {
    const context = frozen();
    const result = resolveSettlementOrderActionAccess({
      action: "allocate_cash",
      actor: actor(),
      orderId: "order-one-active",
      assignedToActor: true,
      workflow: {
        ...context,
        fields: context.fields.map((field) =>
          field.fieldKey === "writeoff_records" ? { ...field, isActive: false } : field,
        ),
      },
      legacyFallback: "deny",
    });
    expect(result).toMatchObject({ visible: true, canWrite: true, targetStepKey: "settlement" });
  });

  it("fails closed for duplicated, misplaced, or split frozen configuration", () => {
    const context = frozen();
    const duplicate = resolveSettlementOrderActionAccess({
      action: "record_invoice",
      actor: actor(),
      orderId: "order-duplicate",
      assignedToActor: true,
      workflow: {
        ...context,
        fields: [...context.fields, context.fields.find((field) => field.fieldKey === "invoice_records")!],
      },
      legacyFallback: "deny",
    });
    expect(duplicate).toMatchObject({ visible: true, canWrite: false });
    expect(duplicate.reason).toContain("配置重复");

    const misplaced = resolveSettlementOrderActionAccess({
      action: "record_invoice",
      actor: actor(),
      orderId: "order-misplaced",
      assignedToActor: true,
      workflow: frozen({ placements: [] }),
      legacyFallback: "deny",
    });
    expect(misplaced).toMatchObject({ visible: true, canWrite: false });
    expect(misplaced.reason).toContain("缺少费用模块");

    const split = frozen();
    const splitFields = split.fields.map((field) =>
      field.fieldKey === "writeoff_records" ? { ...field, stepKey: "review" } : field,
    );
    const splitResult = resolveSettlementOrderActionAccess({
      action: "allocate_cash",
      actor: actor(),
      orderId: "order-split",
      assignedToActor: true,
      workflow: {
        ...split,
        fields: splitFields,
        modulePlacements: [...split.modulePlacements, { moduleCode: "costs", stepKey: "review" }],
      },
      legacyFallback: "deny",
    });
    expect(splitResult).toMatchObject({ visible: true, canWrite: false });
    expect(splitResult.reason).toContain("同一办理节点");
  });

  it("requires an explicit fallback for a truly unbound legacy order", () => {
    const unbound = frozen({ locked: false, current: null, fields: [], placements: [], steps: [] });
    const denied = resolveSettlementOrderActionAccess({
      action: "create_reconciliation",
      actor: actor(),
      orderId: "legacy-denied",
      assignedToActor: true,
      workflow: unbound,
      legacyFallback: "deny",
    });
    expect(denied).toMatchObject({ legacy: true, visible: false, canWrite: false });

    const allowed = resolveSettlementOrderActionAccess({
      action: "create_reconciliation",
      actor: actor(),
      orderId: "legacy-allowed",
      assignedToActor: true,
      workflow: unbound,
      legacyFallback: "allow",
    });
    expect(allowed).toMatchObject({ legacy: true, visible: true, canWrite: true });
  });

  it("keeps a visible in-scope action read-only without its dedicated mutation permission", () => {
    const result = resolveSettlementOrderActionAccess({
      action: "record_invoice",
      actor: actor({ permissions: ["billing.view", "billing.sensitive.view", "order.scope.assigned"] }),
      orderId: "order-reader",
      assignedToActor: true,
      workflow: frozen(),
      legacyFallback: "deny",
    });
    expect(result).toMatchObject({ inScope: true, visible: true, canWrite: false });
    expect(result.reason).toContain("billing.manage");
  });

  it("requires every linked order to pass scope and its own exact frozen step", () => {
    const passed = resolveSettlementMultiOrderActionAccess({
      action: "record_invoice",
      actor: actor(),
      legacyFallback: "deny",
      orders: [
        { orderId: "ftl-1", assignedToActor: true, workflow: frozen() },
        { orderId: "ltl-1", assignedToActor: true, workflow: frozen({ target: "ltl_settlement" }) },
      ],
    });
    expect(passed).toMatchObject({ visible: true, canWrite: true, reason: null });

    const outOfScope = resolveSettlementMultiOrderActionAccess({
      action: "record_invoice",
      actor: actor(),
      legacyFallback: "deny",
      orders: [
        { orderId: "ftl-1", assignedToActor: true, workflow: frozen() },
        { orderId: "ltl-2", assignedToActor: false, workflow: frozen() },
      ],
    });
    expect(outOfScope).toMatchObject({ visible: false, canWrite: false });
    expect(outOfScope.reason).toContain("至少一票订单不在当前账号");

    const wrongStage = resolveSettlementMultiOrderActionAccess({
      action: "record_invoice",
      actor: actor(),
      legacyFallback: "deny",
      orders: [
        { orderId: "ftl-1", assignedToActor: true, workflow: frozen() },
        { orderId: "ltl-3", assignedToActor: true, workflow: frozen({ current: "delivery" }) },
      ],
    });
    expect(wrongStage).toMatchObject({ visible: true, canWrite: false });
    expect(wrongStage.reason).toContain("ltl-3");
  });
});
