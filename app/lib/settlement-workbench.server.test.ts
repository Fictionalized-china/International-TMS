import { beforeEach, describe, expect, it, vi } from "vitest";

const dependency = vi.hoisted(() => ({
  refreshOrderCompletionStatus: vi.fn(async () => undefined),
  syncCostsModuleStatus: vi.fn(async () => undefined),
  syncOrderWorkflowSnapshot: vi.fn(async () => undefined),
}));

vi.mock("./order-review.server", () => ({
  refreshOrderCompletionStatus: dependency.refreshOrderCompletionStatus,
}));
vi.mock("./order-modules.server", () => ({
  syncCostsModuleStatus: dependency.syncCostsModuleStatus,
  syncOrderWorkflowSnapshot: dependency.syncOrderWorkflowSnapshot,
}));

import {
  allocateCashTransaction,
  confirmReconciliation,
  createReconciliation,
  loadSettlementWorkbench,
} from "./settlement-workbench.server";

type DbMode = "create" | "allocate" | "confirm-conflict" | "load";

function database(mode: DbMode) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  let batchCount = 0;
  let runCount = 0;
  const db = {
    prepare(sql: string) {
      const call = { sql, bindings: [] as unknown[] };
      calls.push(call);
      const statement = {
        bind(...bindings: unknown[]) {
          call.bindings = bindings;
          return statement;
        },
        async first() {
          if (mode === "confirm-conflict" && sql.includes("FROM settlement_reconciliations")) {
            return { status: "draft", direction: "receivable" };
          }
          if (mode === "create" && sql.includes("SELECT name FROM organizations")) {
            return { name: "Test Organization" };
          }
          if (mode === "allocate" && sql.includes("SELECT t.*")) {
            return {
              id: "cash-1",
              direction: "receipt",
              counterparty_name: "Customer A",
              currency: "CNY",
              amount: 100,
              remaining: 100,
            };
          }
          if (mode === "allocate" && sql.includes("FROM settlement_reconciliations")) {
            return {
              id: "reconciliation-1",
              direction: "receivable",
              counterparty_name: "Customer A",
              currency: "CNY",
              status: "confirmed",
            };
          }
          if (mode === "allocate" && sql.includes("SELECT COALESCE(SUM(amount),0)")) {
            return { total: 25 };
          }
          return null;
        },
        async all() {
          if (mode === "create" && sql.includes("FROM business_expenses e")) {
            return { results: [{
              id: "expense-1",
              order_id: "order-1",
              direction: "receivable",
              stage: "confirmed",
              currency: "CNY",
              amount: 100,
              counterparty_name: null,
              customer_id: "customer-1",
              customer_name: "Customer A",
              outbound_ready: 0,
              already_linked: 0,
            }] };
          }
          if (mode === "allocate" && sql.includes("SELECT l.expense_id")) {
            return { results: [{ expense_id: "expense-1", outstanding: 100 }] };
          }
          return { results: [] };
        },
        async run() {
          runCount += 1;
          return {};
        },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      batchCount += 1;
      return statements.map((_, index) => ({
        meta: { changes: mode === "confirm-conflict" && index === 0 ? 0 : 1 },
      }));
    },
  } as unknown as D1Database;
  return {
    db,
    calls,
    get batchCount() { return batchCount; },
    get runCount() { return runCount; },
  };
}

describe("settlement mutation critical guards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets frozen workflow policy decide receivable timing and rechecks immediately before write", async () => {
    const harness = database("create");
    const assertCanMutate = vi.fn(async () => undefined);

    await createReconciliation(harness.db, {
      organizationId: "org-1",
      expenseIds: ["expense-1"],
      direction: "receivable",
      userId: "finance-1",
      now: "2026-09-06T00:00:00.000Z",
      assertCanMutate,
    });

    expect(assertCanMutate).toHaveBeenCalledTimes(1);
    expect(harness.batchCount).toBe(1);
    const candidateSql = harness.calls.find((call) => call.sql.includes("FROM business_expenses e"))?.sql ?? "";
    expect(candidateSql).not.toContain("road_status");
    expect(candidateSql).not.toContain("transport_batches");
    expect(candidateSql).toContain("o.organization_id=e.organization_id");
    expect(candidateSql).toContain("c.organization_id=o.organization_id");
    expect(candidateSql).toContain("l.organization_id=e.organization_id");
  });

  it("aborts before the first write when the final frozen gate changed", async () => {
    const harness = database("create");
    const assertCanMutate = vi.fn(async () => {
      throw new Error("frozen gate changed");
    });

    await expect(createReconciliation(harness.db, {
      organizationId: "org-1",
      expenseIds: ["expense-1"],
      direction: "receivable",
      userId: "finance-1",
      now: "2026-09-06T00:00:00.000Z",
      assertCanMutate,
    })).rejects.toThrow("frozen gate changed");

    expect(assertCanMutate).toHaveBeenCalledTimes(1);
    expect(harness.batchCount).toBe(0);
    expect(harness.runCount).toBe(0);
  });

  it("keeps allocation reads and derived writes inside the same organization", async () => {
    const harness = database("allocate");
    const assertCanMutate = vi.fn(async () => undefined);

    await allocateCashTransaction(harness.db, {
      organizationId: "org-1",
      transactionId: "cash-1",
      reconciliationId: "reconciliation-1",
      amount: 25,
      userId: "cashier-1",
      now: "2026-09-06T00:00:00.000Z",
      assertCanMutate,
    });

    expect(assertCanMutate).toHaveBeenCalledTimes(1);
    expect(harness.batchCount).toBe(1);
    expect(harness.calls.some((call) =>
      call.sql.includes("a.organization_id=t.organization_id"))).toBe(true);
    expect(harness.calls.some((call) =>
      call.sql.includes("a.organization_id=l.organization_id"))).toBe(true);
    expect(harness.calls.some((call) =>
      call.sql.includes("WHERE organization_id=? AND cash_transaction_id=?"))).toBe(true);
  });
});

  it("treats a lost draft-confirm race as a conflict without syncing derived state", async () => {
    const harness = database("confirm-conflict");
    const assertCanMutate = vi.fn(async () => undefined);

    await expect(confirmReconciliation(harness.db, {
      organizationId: "org-1",
      id: "reconciliation-1",
      userId: "finance-1",
      now: "2026-09-06T00:00:00.000Z",
      assertCanMutate,
    })).rejects.toThrow("对账单状态已变化，请刷新后重试");

    expect(assertCanMutate).toHaveBeenCalledTimes(1);
    expect(harness.batchCount).toBe(1);
    expect(dependency.syncCostsModuleStatus).not.toHaveBeenCalled();
    expect(dependency.syncOrderWorkflowSnapshot).not.toHaveBeenCalled();
    expect(dependency.refreshOrderCompletionStatus).not.toHaveBeenCalled();
    const expenseUpdate = harness.calls.find((call) =>
      call.sql.startsWith("UPDATE business_expenses SET stage='reconciled'"))?.sql ?? "";
    expect(expenseUpdate).toContain("confirmed_header.organization_id=business_expenses.organization_id");
    expect(expenseUpdate).toContain("confirmed_header.confirmed_by_user_id=?");
    expect(expenseUpdate).toContain("confirmed_header.confirmed_at=?");
    const taskUpdate = harness.calls.find((call) =>
      call.sql.startsWith("UPDATE order_tasks SET status='completed'"))?.sql ?? "";
    expect(taskUpdate).toContain("confirmed_header.organization_id=order_tasks.organization_id");
    expect(taskUpdate).toContain("confirmed_header.confirmed_by_user_id=?");
    expect(taskUpdate).toContain("confirmed_header.confirmed_at=?");
  });

  it("keeps every legacy workbench relation inside the requested organization", async () => {
    const harness = database("load");

    await loadSettlementWorkbench(harness.db, "org-1");

    expect(harness.calls).toHaveLength(4);
    const eligible = harness.calls[0].sql;
    expect(eligible).toContain("a.organization_id=e.organization_id");
    expect(eligible).toContain("i.organization_id=a.organization_id");
    expect(eligible).toContain("t.organization_id=a.organization_id");
    expect(eligible).toContain("l.organization_id=e.organization_id");
    expect(eligible).toContain("r.organization_id=l.organization_id");

    const reconciliations = harness.calls[1].sql;
    expect(reconciliations).toContain("i.organization_id=r.organization_id");
    expect(reconciliations).toContain("a.organization_id=r.organization_id");
    expect(reconciliations).toContain("t.organization_id=a.organization_id");
    expect(reconciliations).toContain("l.organization_id=r.organization_id");
    expect(reconciliations).toContain("e.organization_id=l.organization_id");
    expect(reconciliations).toContain("o.organization_id=e.organization_id");

    const cash = harness.calls[3].sql;
    expect(cash).toContain("a.organization_id=t.organization_id");
  });
