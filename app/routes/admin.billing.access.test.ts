import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const current = {
    sessionId: "session-1",
    organizationId: "org-1",
    organizationName: "测试组织",
    userId: "finance-1",
    email: "finance@example.test",
    displayName: "财务会计岗账号",
    site: "admin",
    positionCode: "FINANCE_ACCOUNTING",
    roleCodes: ["pos_finance"],
    permissions: [
      "billing.view",
      "billing.sensitive.view",
      "billing.manage",
      "order.scope.assigned",
    ],
  };
  const expense = {
    id: "expense-1",
    order_id: "order-1",
    order_number: "SO-001",
    customer_name: "客户甲",
    direction: "receivable" as const,
    charge_name: "运费",
    counterparty_name: "客户甲",
    currency: "CNY",
    amount: 100,
    stage: "confirmed",
    invoiced_amount: 0,
    settled_amount: 0,
    outbound_ready: 1,
  };
  const access = {
    action: "create_reconciliation",
    visible: true,
    canWrite: true,
    reason: null,
    orders: [],
  };
  const DB = {
    prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        async first() {
          return sql.includes("FROM organizations") ? { name: "测试组织" } : null;
        },
        async all() { return { results: [] }; },
      };
      return statement;
    },
  };
  return {
    current,
    expense,
    access,
    DB,
    requireSessionUser: vi.fn(async () => current),
    loadSettlementSummary: vi.fn(async () => ({
      counts: { pending: 1, reconciliations: 0, cash: 0, invoices: 0, history: 0 },
      balances: [],
    })),
    loadEligibleExpensePage: vi.fn(async () => ({
      items: [expense], page: 1, pageCount: 1, pageSize: 10, total: 1,
    })),
    loadReconciliationPage: vi.fn(async () => ({
      items: [], page: 1, pageCount: 1, pageSize: 10, total: 0,
    })),
    loadAccess: vi.fn(async () => ({ ...access })),
    loadFreshActor: vi.fn(async (): Promise<typeof current | null> => ({
      ...current,
      roleCodes: [...current.roleCodes],
      permissions: [...current.permissions],
    })),
    createReconciliation: vi.fn(async (_db, input) => {
      await input.assertCanMutate();
      return { id: "rec-1", number: "REC-001" };
    }),
    confirmReconciliation: vi.fn(async (_db, input) => { await input.assertCanMutate(); }),
    recordSettlementInvoice: vi.fn(async (_db, input) => {
      await input.assertCanMutate();
      return { id: "invoice-1", recordNumber: "TAX-001" };
    }),
    recordCashTransaction: vi.fn(async (_db, input) => {
      await input.assertCanMutate();
      return { id: "cash-1", number: "CASH-001" };
    }),
    allocateCashTransaction: vi.fn(async (_db, input) => { await input.assertCanMutate(); }),
    writeAudit: vi.fn(async () => undefined),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/audit.server", () => ({ writeAudit: harness.writeAudit }));
vi.mock("../lib/settlement-workbench-access.server", () => ({
  loadSettlementWorkbenchActionAccess: harness.loadAccess,
  loadFreshSettlementWorkbenchActor: harness.loadFreshActor,
}));
vi.mock("../lib/settlement-workbench-pages.server", () => ({
  emptySettlementPage: (page = 1, pageSize = 10) => ({ items: [], page, pageCount: 1, pageSize, total: 0 }),
  loadSettlementSummary: harness.loadSettlementSummary,
  loadEligibleExpensePage: harness.loadEligibleExpensePage,
  loadReconciliationPage: harness.loadReconciliationPage,
  loadAvailableCashTransactions: vi.fn(async () => []),
  loadCashHistoryPage: vi.fn(async () => ({ items: [], page: 1, pageCount: 1, pageSize: 10, total: 0 })),
  loadInvoiceHistoryPage: vi.fn(async () => ({ items: [], page: 1, pageCount: 1, pageSize: 10, total: 0 })),
  loadLegacyInvoicePage: vi.fn(async () => ({ items: [], page: 1, pageCount: 1, pageSize: 10, total: 0 })),
}));
vi.mock("../lib/settlement-workbench.server", () => ({
  createReconciliation: harness.createReconciliation,
  confirmReconciliation: harness.confirmReconciliation,
  recordSettlementInvoice: harness.recordSettlementInvoice,
  recordCashTransaction: harness.recordCashTransaction,
  allocateCashTransaction: harness.allocateCashTransaction,
}));
vi.mock("../lib/settlement-task-pack.server", () => ({
  loadSettlementTaskPackCount: vi.fn(async () => 0),
  loadSettlementTaskPackPage: vi.fn(async () => ({ items: [], page: 1, pageCount: 1, pageSize: 10, total: 0 })),
}));

import { action, loader } from "./admin.billing";

function post(values: Record<string, string | string[]>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  return new Request("http://local.test/admin/billing", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function invokeAction(request: Request) {
  return action({ request, params: {}, context: undefined } as never);
}

describe("central settlement workbench access integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.current.positionCode = "FINANCE_ACCOUNTING";
    harness.current.roleCodes = ["pos_finance"];
    harness.current.permissions = [
      "billing.view",
      "billing.sensitive.view",
      "billing.manage",
      "order.scope.assigned",
    ];
    Object.assign(harness.access, {
      action: "create_reconciliation",
      visible: true,
      canWrite: true,
      reason: null,
      orders: [],
    });
    harness.loadFreshActor.mockImplementation(async () => ({
      ...harness.current,
      roleCodes: [...harness.current.roleCodes],
      permissions: [...harness.current.permissions],
    }));
  });

  it("uses actor-scoped pages and returns the current frozen gate for each expense group", async () => {
    const result = await loader({
      request: new Request("http://local.test/admin/billing?tab=pending"),
      params: {},
      context: undefined,
    } as never);

    expect(harness.loadSettlementSummary).toHaveBeenCalledWith(harness.DB, harness.current);
    expect(harness.loadEligibleExpensePage).toHaveBeenCalledWith(
      harness.DB,
      harness.current,
      expect.objectContaining({ page: 1, pageSize: 10 }),
    );
    expect(harness.loadAccess).toHaveBeenCalledWith(harness.DB, {
      actor: harness.current,
      action: "create_reconciliation",
      source: { kind: "expense_ids", ids: ["expense-1"] },
      legacyFallback: "deny",
    });
    expect(result.accessDenied).toBe(false);
    if (result.accessDenied) throw new Error("expected settlement workbench access");
    expect(result.actionAccess.createReconciliationByExpenseId["expense-1"])
      .toMatchObject({ visible: true, canWrite: true });
  });

  it("rechecks the frozen multi-order gate on POST before creating a reconciliation", async () => {
    Object.assign(harness.access, {
      visible: true,
      canWrite: false,
      reason: "SO-001：当前处于“客户签收”，进入“三方结算”后开放",
    });

    const result = await invokeAction(post({
      intent: "create_reconciliation",
      direction: "receivable",
      expenseId: ["expense-1"],
    }));

    expect(result).toEqual({ formError: harness.access.reason });
    expect(harness.loadAccess).toHaveBeenCalledWith(harness.DB, {
      actor: harness.current,
      action: "create_reconciliation",
      source: { kind: "expense_ids", ids: ["expense-1"] },
      legacyFallback: "deny",
    });
    expect(harness.createReconciliation).not.toHaveBeenCalled();
  });

  it.each([
    ["confirm_reconciliation", "confirm_reconciliation", "confirmReconciliation"],
    ["record_invoice", "record_invoice", "recordSettlementInvoice"],
    ["allocate_cash", "allocate_cash", "allocateCashTransaction"],
  ] as const)("rechecks %s against every order linked to the reconciliation", async (intent, policyAction, mutation) => {
    const values: Record<string, string> = intent === "confirm_reconciliation"
      ? { intent, id: "rec-1" }
      : intent === "record_invoice"
        ? { intent, reconciliationId: "rec-1", amount: "10", invoiceCompany: "公司", invoiceType: "增值税发票", invoiceNumber: "I-1", invoiceDate: "2026-09-06", titleName: "公司", exchangeRate: "1" }
        : { intent, reconciliationId: "rec-1", transactionId: "cash-1", amount: "10" };

    await invokeAction(post(values));

    expect(harness.loadAccess).toHaveBeenCalledWith(harness.DB, {
      actor: harness.current,
      action: policyAction,
      source: { kind: "reconciliation_id", id: "rec-1" },
      legacyFallback: "deny",
    });
    expect(harness.loadAccess).toHaveBeenCalledTimes(2);
    expect(harness[mutation]).toHaveBeenCalledTimes(1);
    expect(harness.loadFreshActor).toHaveBeenCalledWith(harness.DB, {
      sessionId: "session-1",
      organizationId: "org-1",
      userId: "finance-1",
    });
  });

  it("does not let order.scope.all authorize organization-level cash entry", async () => {
    harness.current.positionCode = "CASHIER";
    harness.current.roleCodes = ["pos_cashier"];
    harness.current.permissions = [
      "billing.view",
      "billing.sensitive.view",
      "billing.cash.manage",
      "order.scope.all",
    ];
    const request = post({ intent: "record_cash", direction: "receipt", counterpartyName: "客户甲", currency: "CNY", amount: "100", occurredOn: "2026-09-06", settlementEntity: "测试组织", accountName: "银行", handledByUserId: "cashier-1" });

    await expect(invokeAction(request)).resolves.toEqual({
      formError: "当前账号没有组织级结算范围，不能登记组织收付款流水",
    });
    expect(harness.recordCashTransaction).not.toHaveBeenCalled();

    harness.current.permissions.push("billing.scope.all");
    await invokeAction(post({ intent: "record_cash", direction: "receipt", counterpartyName: "客户甲", currency: "CNY", amount: "100", occurredOn: "2026-09-06", settlementEntity: "测试组织", accountName: "银行", handledByUserId: "cashier-1" }));
    expect(harness.recordCashTransaction).toHaveBeenCalledTimes(1);
  });

  it("fails closed at the critical write guard when the live identity was revoked", async () => {
    harness.loadFreshActor.mockResolvedValueOnce(null);

    const result = await invokeAction(post({
      intent: "create_reconciliation",
      direction: "receivable",
      expenseId: ["expense-1"],
    }));

    expect(result).toEqual({
      formError: "当前会话、岗位或角色已失效，请重新登录后再试",
    });
    expect(harness.loadFreshActor).toHaveBeenCalledWith(harness.DB, {
      sessionId: "session-1",
      organizationId: "org-1",
      userId: "finance-1",
    });
    expect(harness.loadAccess).toHaveBeenCalledTimes(1);
    expect(harness.writeAudit).not.toHaveBeenCalled();
  });

  it("does not write a success audit when reconciliation confirmation loses a race", async () => {
    harness.confirmReconciliation.mockRejectedValueOnce(
      new Error("对账单状态已变化，请刷新后重试"),
    );

    const result = await invokeAction(post({
      intent: "confirm_reconciliation",
      id: "rec-1",
    }));

    expect(result).toEqual({
      formError: "对账单状态已变化，请刷新后重试",
    });
    expect(harness.writeAudit).not.toHaveBeenCalled();
  });

});
