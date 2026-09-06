import { beforeEach, describe, expect, it } from "vitest";
import type { SettlementWorkbenchActor } from "./settlement-workbench-access";
import {
  loadEligibleExpensePage,
  loadCashHistoryPage,
  loadInvoiceHistoryPage,
  loadLegacyInvoicePage,
  loadSettlementSummary,
  loadReconciliationPage,
} from "./settlement-workbench-pages.server";

const actor: SettlementWorkbenchActor = {
  organizationId: "org-1",
  userId: "finance-1",
  positionCode: "FINANCE_ACCOUNTING",
  roleCodes: ["pos_finance"],
  permissions: [
    "billing.view",
    "billing.sensitive.view",
    "billing.manage",
    "order.scope.assigned",
  ],
};

function database() {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
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
          return { total: 0 };
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe("settlement workbench page scope", () => {
  let query: {
    page: number;
    pageSize: number;
    query: string;
    direction: string;
    currency: string;
    status: string;
  };

  beforeEach(() => {
    query = {
      page: 1,
      pageSize: 10,
      query: "",
      direction: "",
      currency: "",
      status: "",
    };
  });

  it("limits pending expenses to the actor's assigned orders with organization-safe joins", async () => {
    const { db, calls } = database();

    await loadEligibleExpensePage(db, actor, query);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain("o.organization_id=e.organization_id");
      expect(call.sql).toContain("c.organization_id=o.organization_id");
      expect(call.sql).toContain("l.organization_id=e.organization_id");
      expect(call.sql).toContain("workflow_instance_task_states");
      expect(call.sql).not.toContain("AND 1=1");
      expect(call.bindings).toContain("org-1");
      expect(call.bindings).toContain("finance-1");
    }
    expect(calls[1].sql).toContain("i.organization_id=a.organization_id");
    expect(calls[1].sql).toContain("t.organization_id=a.organization_id");
    expect(calls[1].sql.match(/a\.organization_id=e\.organization_id/g)).toHaveLength(2);
  });

  it("shows a reconciliation only when every linked order is in assigned scope", async () => {
    const { db, calls } = database();

    await loadReconciliationPage(db, actor, query);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain("scope_line.organization_id<>r.organization_id");
      expect(call.sql).toContain("scope_expense.organization_id=r.organization_id");
      expect(call.sql).toContain("scope_order.organization_id=r.organization_id");
      expect(call.sql).toContain("NOT EXISTS");
      expect(call.sql).toContain("workflow_instance_task_states");
      expect(call.bindings).toContain("org-1");
      expect(call.bindings).toContain("finance-1");
    }
  });

  it("scopes every summary count and balance to the same assigned order range", async () => {
    const { db, calls } = database();

    await loadSettlementSummary(db, actor);

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.sql).toContain("workflow_instance_task_states");
      expect(call.bindings).toContain("org-1");
      expect(call.bindings).toContain("finance-1");
      expect(call.bindings).not.toContain(actor);
    }
    expect(calls[2].sql).toContain("reconciliation_data");
    expect(calls[2].sql).toContain("NOT EXISTS");
    expect(calls[2].sql).toContain("cash_outside.organization_id<>cash.organization_id");
  });

  it("keeps cash and invoice history inside all-pass reconciliation scope", async () => {
    const cashDb = database();
    await loadCashHistoryPage(cashDb.db, actor, query);
    expect(cashDb.calls).toHaveLength(2);
    for (const call of cashDb.calls) {
      expect(call.sql).toContain("reconciliation_data");
      expect(call.sql).toContain("cash_outside");
      expect(call.sql).toContain("cash_outside.organization_id<>t.organization_id");
      expect(call.sql).toContain("workflow_instance_task_states");
      expect(call.bindings).toContain("finance-1");
    }

    const invoiceDb = database();
    await loadInvoiceHistoryPage(invoiceDb.db, actor, query);
    expect(invoiceDb.calls).toHaveLength(2);
    for (const call of invoiceDb.calls) {
      expect(call.sql).toContain("reconciliation_data");
      expect(call.sql).toContain("scoped_invoice_reconciliation");
      expect(call.sql).toContain("workflow_instance_task_states");
      expect(call.bindings).toContain("finance-1");
    }
  });

  it("hides order-unlinked legacy invoices from assigned-only settlement scope", async () => {
    const assignedDb = database();
    const assignedPage = await loadLegacyInvoicePage(assignedDb.db, actor, query);

    expect(assignedPage.items).toEqual([]);
    expect(assignedDb.calls).toHaveLength(0);

    const fullDb = database();
    await loadLegacyInvoicePage(fullDb.db, {
      ...actor,
      permissions: [...actor.permissions, "billing.scope.all"],
    }, query);
    expect(fullDb.calls).toHaveLength(2);
    for (const call of fullDb.calls) {
      expect(call.bindings).toContain("org-1");
      expect(call.bindings).not.toContain("finance-1");
    }
  });
});
