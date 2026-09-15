import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";
import type { SettlementWorkbenchActor } from "./settlement-workbench-access";

const harness = vi.hoisted(() => ({
  linkedRows: [] as Array<{ source_key: string; order_id: string }>,
  scopeRows: [] as Array<{ order_id: string; assigned_to_actor: number }>,
  sql: [] as string[],
  bindings: [] as unknown[][],
  contexts: new Map<string, LockedWorkflowStageContext>(),
  activeContextLoads: 0,
  maxConcurrentContextLoads: 0,
  loadContext: vi.fn(async (_db: unknown, _organizationId: string, orderId: string) => {
    harness.activeContextLoads += 1;
    harness.maxConcurrentContextLoads = Math.max(
      harness.maxConcurrentContextLoads,
      harness.activeContextLoads,
    );
    await Promise.resolve();
    harness.activeContextLoads -= 1;
    return harness.contexts.get(orderId);
  }),
}));

vi.mock("./workflow-instance-stage-gate.server", () => ({
  loadLockedWorkflowStageContext: harness.loadContext,
}));

import { loadSettlementWorkbenchActionAccess } from "./settlement-workbench-access.server";

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

function frozen(currentStepKey = "settlement"): LockedWorkflowStageContext {
  return {
    locked: true,
    currentStepKey,
    steps: [
      { stepKey: "delivery", stepName: "客户签收", sortOrder: 90 },
      { stepKey: "settlement", stepName: "三方结算", sortOrder: 100 },
      { stepKey: "review", stepName: "复盘归档", sortOrder: 110 },
    ],
    modulePlacements: [{ moduleCode: "costs", stepKey: "settlement" }],
    fields: [
      { moduleCode: "costs", fieldKey: "reconciliation_statement", stepKey: "settlement", isActive: true, isRequired: true },
      { moduleCode: "costs", fieldKey: "invoice_records", stepKey: "settlement", isActive: true, isRequired: true },
      { moduleCode: "costs", fieldKey: "cash_records", stepKey: "settlement", isActive: true, isRequired: true },
      { moduleCode: "costs", fieldKey: "writeoff_records", stepKey: "settlement", isActive: true, isRequired: true },
    ],
  };
}

function database() {
  return {
    prepare(sql: string) {
      harness.sql.push(sql);
      return {
        bind(...values: unknown[]) {
          if (values.length > 100) {
            throw new Error(`D1 hard binding limit exceeded: ${values.length}`);
          }
          harness.bindings.push(values);
          return {
            async all() {
              return {
                results: sql.includes("assigned_to_actor")
                  ? harness.scopeRows
                  : harness.linkedRows,
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("settlement workbench access loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.linkedRows = [];
    harness.scopeRows = [];
    harness.sql.length = 0;
    harness.bindings.length = 0;
    harness.contexts.clear();
    harness.activeContextLoads = 0;
    harness.maxConcurrentContextLoads = 0;
  });

  it("loads expense-linked orders in one batch and evaluates every frozen costs context", async () => {
    harness.linkedRows = [
      { source_key: "expense-1", order_id: "order-1" },
      { source_key: "expense-2", order_id: "order-2" },
    ];
    harness.scopeRows = [
      { order_id: "order-1", assigned_to_actor: 1 },
      { order_id: "order-2", assigned_to_actor: 1 },
    ];
    harness.contexts.set("order-1", frozen());
    harness.contexts.set("order-2", frozen());

    const result = await loadSettlementWorkbenchActionAccess(database(), {
      actor: actor(),
      action: "create_reconciliation",
      source: { kind: "expense_ids", ids: ["expense-1", "expense-2"] },
      legacyFallback: "deny",
    });

    expect(result).toMatchObject({ visible: true, canWrite: true, reason: null });
    expect(result.orders.map((item) => item.orderId)).toEqual(["order-1", "order-2"]);
    expect(harness.sql[0]).toContain("o.organization_id=e.organization_id");
    expect(harness.sql[1]).toContain("assigned_to_actor");
    expect(harness.sql[1]).toContain("workflow_instance_task_states");
    expect(harness.loadContext).toHaveBeenCalledTimes(2);
    expect(harness.loadContext).toHaveBeenCalledWith(expect.anything(), "org-1", "order-1", "costs");
  });

  it("fails closed when any requested expense is missing or belongs to another organization", async () => {
    harness.linkedRows = [{ source_key: "expense-1", order_id: "order-1" }];

    const result = await loadSettlementWorkbenchActionAccess(database(), {
      actor: actor(),
      action: "create_reconciliation",
      source: { kind: "expense_ids", ids: ["expense-1", "expense-missing"] },
      legacyFallback: "deny",
    });

    expect(result).toMatchObject({ visible: false, canWrite: false, orders: [] });
    expect(result.reason).toContain("不存在或不属于当前组织");
    expect(harness.loadContext).not.toHaveBeenCalled();
  });

  it("loads all reconciliation-linked orders and applies all-pass assigned scope", async () => {
    harness.linkedRows = [
      { source_key: "reconciliation-1", order_id: "order-1" },
      { source_key: "reconciliation-1", order_id: "order-2" },
    ];
    harness.scopeRows = [
      { order_id: "order-1", assigned_to_actor: 1 },
      { order_id: "order-2", assigned_to_actor: 0 },
    ];
    harness.contexts.set("order-1", frozen());
    harness.contexts.set("order-2", frozen());

    const result = await loadSettlementWorkbenchActionAccess(database(), {
      actor: actor(),
      action: "record_invoice",
      source: { kind: "reconciliation_id", id: "reconciliation-1" },
      legacyFallback: "deny",
    });

    expect(result).toMatchObject({ visible: false, canWrite: false });
    expect(result.reason).toContain("至少一票订单不在当前账号");
    expect(harness.sql[0]).toContain("r.organization_id=?");
    expect(harness.sql[0]).toContain("e.organization_id=r.organization_id");
    expect(harness.sql[0]).toContain("o.organization_id=e.organization_id");
  });

  it("does not treat order.scope.all or sensitive visibility as settlement full scope", async () => {
    harness.linkedRows = [{ source_key: "order-1", order_id: "order-1" }];
    harness.scopeRows = [{ order_id: "order-1", assigned_to_actor: 0 }];
    harness.contexts.set("order-1", frozen());

    const result = await loadSettlementWorkbenchActionAccess(database(), {
      actor: actor({
        positionCode: "CASHIER",
        roleCodes: ["pos_cashier"],
        permissions: [
          "billing.view",
          "billing.sensitive.view",
          "billing.cash.manage",
          "order.scope.all",
        ],
      }),
      action: "allocate_cash",
      source: { kind: "order_ids", ids: ["order-1"] },
      legacyFallback: "deny",
    });

    expect(result).toMatchObject({ visible: false, canWrite: false });
    expect(harness.sql[1]).toContain("assigned_to_actor");
    expect(harness.sql[1]).not.toContain("1=1 THEN 1");
  });

  it("lets explicit billing scope bypass assignment while still loading frozen gates", async () => {
    harness.linkedRows = [{ source_key: "order-1", order_id: "order-1" }];
    harness.scopeRows = [{ order_id: "order-1", assigned_to_actor: 0 }];
    harness.contexts.set("order-1", frozen());

    const result = await loadSettlementWorkbenchActionAccess(database(), {
      actor: actor({ permissions: [...actor().permissions, "billing.scope.all"] }),
      action: "record_invoice",
      source: { kind: "order_ids", ids: ["order-1"] },
      legacyFallback: "deny",
    });

    expect(result).toMatchObject({ visible: true, canWrite: true });
    expect(harness.loadContext).toHaveBeenCalledOnce();
  });

  it("applies legacy fallback only after an organization-scoped order is resolved", async () => {
    harness.linkedRows = [{ source_key: "order-legacy", order_id: "order-legacy" }];
    harness.scopeRows = [{ order_id: "order-legacy", assigned_to_actor: 1 }];
    harness.contexts.set("order-legacy", {
      locked: false,
      currentStepKey: null,
      steps: [],
      modulePlacements: [],
      fields: [],
    });

    const result = await loadSettlementWorkbenchActionAccess(database(), {
      actor: actor(),
      action: "create_reconciliation",
      source: { kind: "order_ids", ids: ["order-legacy"] },
      legacyFallback: "allow",
    });

    expect(result).toMatchObject({ visible: true, canWrite: true });
    expect(result.orders[0]).toMatchObject({ legacy: true });
  });

  it("keeps a boundary-sized batch within D1 binding and workflow-load limits", async () => {
    const orderIds = Array.from({ length: 100 }, (_, index) =>
      `order-${String(index + 1).padStart(3, "0")}`,
    );
    harness.linkedRows = orderIds.map((orderId) => ({
      source_key: orderId,
      order_id: orderId,
    }));
    harness.scopeRows = orderIds.map((orderId) => ({
      order_id: orderId,
      assigned_to_actor: 1,
    }));
    for (const orderId of orderIds) harness.contexts.set(orderId, frozen());

    const result = await loadSettlementWorkbenchActionAccess(database(), {
      actor: actor(),
      action: "confirm_reconciliation",
      source: { kind: "order_ids", ids: orderIds },
      legacyFallback: "deny",
    });

    expect(result).toMatchObject({ visible: true, canWrite: true });
    expect(result.orders).toHaveLength(100);
    expect(harness.bindings.every((values) => values.length <= 100)).toBe(true);
    expect(harness.maxConcurrentContextLoads).toBe(1);
  });
});
