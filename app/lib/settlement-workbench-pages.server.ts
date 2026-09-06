import { hasFullSettlementScope, type SettlementWorkbenchActor } from "./settlement-workbench-access";
import {
  settlementOrderScopeSql,
} from "./settlement-workbench-access.server";
import type {
  CashTransactionRow,
  InvoiceRecordRow,
  ReconciliationRow,
  SettlementExpense,
} from "./settlement-workbench.server";

export type SettlementPageQuery = {
  page: number;
  pageSize: number;
  query: string;
  direction: string;
  currency: string;
  status: string;
};

export type SettlementPage<T> = {
  items: T[];
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
};

export type LegacyInvoiceRow = {
  id: string;
  invoice_number: string;
  customer_name: string;
  currency: string;
  total_amount: number;
  paid_amount: number;
  status: string;
  created_at: string;
};

export type SettlementBalance = {
  direction: "receivable" | "payable";
  currency: string;
  amount: number;
};

const outboundReadySql = `EXISTS(
  SELECT 1
  FROM transport_batch_orders bo
  JOIN transport_batches b ON b.id=bo.batch_id
  WHERE bo.order_id=o.id
    AND bo.organization_id=o.organization_id
    AND b.organization_id=bo.organization_id
    AND bo.status!='removed'
    AND b.road_status IN ('outbound_in_transit','overseas_arrived','waiting_pickup','pickup_completed')
)`;

function eligibleBaseSql(scopeSql: string) {
  return `
  FROM business_expenses e
  JOIN transport_orders o ON o.id=e.order_id AND o.organization_id=e.organization_id
  JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
  WHERE e.organization_id=?
    AND ${scopeSql}
    AND e.stage='confirmed'
    AND e.amount>0
    AND NOT EXISTS(
      SELECT 1
      FROM settlement_reconciliation_lines l
      JOIN settlement_reconciliations r
        ON r.id=l.reconciliation_id AND r.organization_id=l.organization_id
      WHERE l.expense_id=e.id AND l.organization_id=e.organization_id AND r.status!='withdrawn'
    )
    AND (e.direction='payable' OR ${outboundReadySql})`;
}

function reconciliationCte(actor: SettlementWorkbenchActor) {
  const scope = settlementOrderScopeSql(actor, "scope_order");
  return { sql: `WITH reconciliation_data AS (
    SELECT r.id,r.document_number,r.direction,r.counterparty_name,r.settlement_entity,r.currency,
      r.total_amount,r.status,r.notes,r.confirmed_at,r.created_at,
      COUNT(DISTINCT l.expense_id) expense_count,
      GROUP_CONCAT(DISTINCT o.order_number) orders,
      GROUP_CONCAT(DISTINCT o.id||'|'||o.order_number) order_refs,
      COALESCE((
        SELECT SUM(i.amount)
        FROM settlement_invoice_records i
        WHERE i.reconciliation_id=r.id AND i.organization_id=r.organization_id AND i.status!='void'
      ),0) invoiced_amount,
      COALESCE((
        SELECT SUM(a.amount)
        FROM settlement_cash_allocations a
        JOIN settlement_cash_transactions t
          ON t.id=a.cash_transaction_id AND t.organization_id=a.organization_id AND t.status!='void'
        WHERE a.reconciliation_id=r.id AND a.organization_id=r.organization_id
      ),0) settled_amount
    FROM settlement_reconciliations r
    JOIN settlement_reconciliation_lines l
      ON l.reconciliation_id=r.id AND l.organization_id=r.organization_id
    JOIN business_expenses e
      ON e.id=l.expense_id AND e.organization_id=r.organization_id
    JOIN transport_orders o
      ON o.id=e.order_id AND o.organization_id=e.organization_id
    WHERE r.organization_id=? AND r.status!='withdrawn'
      AND NOT EXISTS(
        SELECT 1
        FROM settlement_reconciliation_lines scope_line
        LEFT JOIN business_expenses scope_expense
          ON scope_expense.id=scope_line.expense_id
         AND scope_expense.organization_id=r.organization_id
        LEFT JOIN transport_orders scope_order
          ON scope_order.id=scope_expense.order_id
         AND scope_order.organization_id=r.organization_id
        WHERE scope_line.reconciliation_id=r.id
          AND (
            scope_line.organization_id<>r.organization_id OR
            scope_expense.id IS NULL OR
            scope_order.id IS NULL OR
            NOT (${scope.sql})
          )
      )
    GROUP BY r.id
  )`, bindings: [actor.organizationId, ...scope.values] };
}

function cashCte(actor: SettlementWorkbenchActor) {
  const reconciliation = reconciliationCte(actor);
  const limitedScope = hasFullSettlementScope(actor) ? "" : `
      AND EXISTS(
        SELECT 1 FROM settlement_cash_allocations cash_scope
        JOIN reconciliation_data scoped_reconciliation
          ON scoped_reconciliation.id=cash_scope.reconciliation_id
        WHERE cash_scope.cash_transaction_id=t.id
          AND cash_scope.organization_id=t.organization_id
      )
      AND NOT EXISTS(
        SELECT 1 FROM settlement_cash_allocations cash_outside
        WHERE cash_outside.cash_transaction_id=t.id
          AND (
            cash_outside.organization_id<>t.organization_id OR
            NOT EXISTS(
            SELECT 1 FROM reconciliation_data allowed_reconciliation
            WHERE allowed_reconciliation.id=cash_outside.reconciliation_id
            )
          )
      )`;
  return { sql: `${reconciliation.sql}, cash_data AS (
    SELECT t.id,t.transaction_number,t.direction,t.counterparty_name,t.currency,t.amount,t.occurred_on,
      t.settlement_entity,t.account_name,t.created_at,COALESCE(SUM(a.amount),0) allocated_amount,
      CASE
        WHEN COALESCE(SUM(a.amount),0)>=t.amount-0.009 THEN 'allocated'
        WHEN COALESCE(SUM(a.amount),0)>0.009 THEN 'partially_allocated'
        ELSE 'unallocated'
      END status
    FROM settlement_cash_transactions t
    LEFT JOIN settlement_cash_allocations a
      ON a.cash_transaction_id=t.id AND a.organization_id=t.organization_id
    WHERE t.organization_id=? AND t.status!='void'${limitedScope}
    GROUP BY t.id
  )`, bindings: [...reconciliation.bindings, actor.organizationId] };
}

export function emptySettlementPage<T>(requestedPage = 1, pageSize = 10): SettlementPage<T> {
  return { items: [], page: Math.max(1, requestedPage), pageCount: 1, pageSize, total: 0 };
}

export async function loadSettlementSummary(db: D1Database, actor: SettlementWorkbenchActor) {
  const eligibleScope = settlementOrderScopeSql(actor, "o");
  const eligibleSql = eligibleBaseSql(eligibleScope.sql);
  const reconciliation = reconciliationCte(actor);
  const fullScope = hasFullSettlementScope(actor);
  const limitedCashScope = fullScope ? "" : `
        AND EXISTS(
          SELECT 1 FROM settlement_cash_allocations cash_scope
          JOIN reconciliation_data scoped_reconciliation
            ON scoped_reconciliation.id=cash_scope.reconciliation_id
          WHERE cash_scope.cash_transaction_id=cash.id
            AND cash_scope.organization_id=cash.organization_id
        )
        AND NOT EXISTS(
          SELECT 1 FROM settlement_cash_allocations cash_outside
          WHERE cash_outside.cash_transaction_id=cash.id
            AND (
              cash_outside.organization_id<>cash.organization_id OR
              NOT EXISTS(
              SELECT 1 FROM reconciliation_data allowed_reconciliation
              WHERE allowed_reconciliation.id=cash_outside.reconciliation_id
              )
            )
        )`;
  const legacyCountSql = fullScope
    ? "(SELECT COUNT(*) FROM invoices WHERE organization_id=?)"
    : "0";
  const [pending, reconciliationStats, historyStats, balances] = await Promise.all([
    db.prepare(`SELECT COUNT(*) total ${eligibleSql}`)
      .bind(actor.organizationId, ...eligibleScope.values).first<{ total: number }>(),
    db.prepare(`${reconciliation.sql}
      SELECT COUNT(*) total,
        SUM(CASE WHEN status='confirmed' AND total_amount-settled_amount>0.009 THEN 1 ELSE 0 END) cash_open,
        SUM(CASE WHEN status='confirmed' AND total_amount-invoiced_amount>0.009 THEN 1 ELSE 0 END) invoice_open
      FROM reconciliation_data`).bind(...reconciliation.bindings)
      .first<{ total: number; cash_open: number; invoice_open: number }>(),
    db.prepare(`${reconciliation.sql}
      SELECT
        (SELECT COUNT(*) FROM settlement_cash_transactions cash
          WHERE cash.organization_id=? AND cash.status!='void'${limitedCashScope}) cash_total,
        (SELECT COUNT(*) FROM settlement_invoice_records invoice
          WHERE invoice.organization_id=? AND invoice.status!='void'
            AND EXISTS(
              SELECT 1 FROM reconciliation_data scoped_invoice_reconciliation
              WHERE scoped_invoice_reconciliation.id=invoice.reconciliation_id
            )) invoice_total,
        ${legacyCountSql} legacy_total`)
      .bind(...reconciliation.bindings, actor.organizationId, actor.organizationId,
        ...(fullScope ? [actor.organizationId] : []))
      .first<{ cash_total: number; invoice_total: number; legacy_total: number }>(),
    db.prepare(`${reconciliation.sql}
      SELECT direction,currency,SUM(total_amount-settled_amount) amount
      FROM reconciliation_data
      WHERE status='confirmed' AND total_amount-settled_amount>0.009
      GROUP BY direction,currency
      ORDER BY direction,currency`).bind(...reconciliation.bindings).all<SettlementBalance>(),
  ]);

  return {
    counts: {
      pending: Number(pending?.total || 0),
      reconciliations: Number(reconciliationStats?.total || 0),
      cash: Number(reconciliationStats?.cash_open || 0),
      invoices: Number(reconciliationStats?.invoice_open || 0),
      history: Number(historyStats?.cash_total || 0) + Number(historyStats?.invoice_total || 0) + Number(historyStats?.legacy_total || 0),
    },
    balances: balances.results.map((item) => ({ ...item, amount: Number(item.amount) })),
  };
}

export async function loadEligibleExpensePage(
  db: D1Database,
  actor: SettlementWorkbenchActor,
  query: SettlementPageQuery,
) {
  const scope = settlementOrderScopeSql(actor, "o");
  const baseSql = eligibleBaseSql(scope.sql);
  const where: string[] = [];
  const bindings: unknown[] = [actor.organizationId, ...scope.values];
  if (query.direction) {
    where.push("e.direction=?");
    bindings.push(query.direction);
  }
  if (query.currency) {
    where.push("UPPER(e.currency)=?");
    bindings.push(query.currency);
  }
  if (query.query) {
    const pattern = `%${query.query}%`;
    where.push("(o.order_number LIKE ? OR c.name LIKE ? OR e.counterparty_name LIKE ? OR e.charge_name LIKE ?)");
    bindings.push(pattern, pattern, pattern, pattern);
  }
  const filterSql = where.length ? ` AND ${where.join(" AND ")}` : "";
  const count = await db.prepare(`SELECT COUNT(*) total ${baseSql}${filterSql}`)
    .bind(...bindings).first<{ total: number }>();
  const page = pageBounds(Number(count?.total || 0), query);
  const rows = await db.prepare(`SELECT e.id,e.order_id,o.order_number,c.name customer_name,e.direction,e.charge_name,
      CASE WHEN e.direction='receivable' THEN c.name ELSE COALESCE(NULLIF(TRIM(e.counterparty_name),''),'未指定供应商') END counterparty_name,
      e.currency,e.amount,e.stage,
      COALESCE((SELECT SUM(a.amount)
        FROM settlement_invoice_allocations a
        JOIN settlement_invoice_records i
          ON i.id=a.invoice_record_id AND i.organization_id=a.organization_id AND i.status!='void'
        WHERE a.expense_id=e.id AND a.organization_id=e.organization_id),0) invoiced_amount,
      COALESCE((SELECT SUM(a.amount)
        FROM settlement_cash_allocations a
        JOIN settlement_cash_transactions t
          ON t.id=a.cash_transaction_id AND t.organization_id=a.organization_id AND t.status!='void'
        WHERE a.expense_id=e.id AND a.organization_id=e.organization_id),0) settled_amount,
      CASE WHEN ${outboundReadySql} THEN 1 ELSE 0 END outbound_ready
      ${baseSql}${filterSql}
      ORDER BY e.direction,c.name,e.currency,o.order_number,e.created_at
      LIMIT ? OFFSET ?`)
    .bind(...bindings, page.pageSize, page.offset)
    .all<SettlementExpense>();
  return toPage(rows.results, page);
}

export async function loadReconciliationPage(
  db: D1Database,
  actor: SettlementWorkbenchActor,
  query: SettlementPageQuery,
  purpose: "all" | "cash" | "invoice" = "all",
) {
  const cte = reconciliationCte(actor);
  const where: string[] = [];
  const bindings: unknown[] = [...cte.bindings];
  if (query.direction) {
    where.push("direction=?");
    bindings.push(query.direction);
  }
  if (query.currency) {
    where.push("UPPER(currency)=?");
    bindings.push(query.currency);
  }
  if (query.query) {
    const pattern = `%${query.query}%`;
    where.push("(document_number LIKE ? OR counterparty_name LIKE ? OR orders LIKE ?)");
    bindings.push(pattern, pattern, pattern);
  }
  if (purpose === "cash") {
    where.push("status='confirmed' AND total_amount-settled_amount>0.009");
  } else if (purpose === "invoice") {
    where.push("status='confirmed' AND total_amount-invoiced_amount>0.009");
  } else if (query.status === "settled") {
    where.push("status='confirmed' AND total_amount-settled_amount<=0.009");
  } else if (query.status === "unsettled") {
    where.push("status='confirmed' AND total_amount-settled_amount>0.009");
  } else if (query.status) {
    where.push("status=?");
    bindings.push(query.status);
  }
  const filterSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const count = await db.prepare(`${cte.sql} SELECT COUNT(*) total FROM reconciliation_data${filterSql}`)
    .bind(...bindings).first<{ total: number }>();
  const page = pageBounds(Number(count?.total || 0), query);
  const rows = await db.prepare(`${cte.sql}
      SELECT * FROM reconciliation_data${filterSql}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, page.pageSize, page.offset)
    .all<ReconciliationRow>();
  return toPage(rows.results, page);
}

export async function loadCashHistoryPage(
  db: D1Database,
  actor: SettlementWorkbenchActor,
  query: SettlementPageQuery,
) {
  const cte = cashCte(actor);
  const where: string[] = [];
  const bindings: unknown[] = [...cte.bindings];
  if (query.direction) {
    where.push("direction=?");
    bindings.push(query.direction);
  }
  if (query.currency) {
    where.push("UPPER(currency)=?");
    bindings.push(query.currency);
  }
  if (query.status) {
    where.push("status=?");
    bindings.push(query.status);
  }
  if (query.query) {
    const pattern = `%${query.query}%`;
    where.push("(transaction_number LIKE ? OR counterparty_name LIKE ? OR account_name LIKE ? OR settlement_entity LIKE ?)");
    bindings.push(pattern, pattern, pattern, pattern);
  }
  const filterSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const count = await db.prepare(`${cte.sql} SELECT COUNT(*) total FROM cash_data${filterSql}`)
    .bind(...bindings).first<{ total: number }>();
  const page = pageBounds(Number(count?.total || 0), query);
  const rows = await db.prepare(`${cte.sql} SELECT * FROM cash_data${filterSql} ORDER BY occurred_on DESC,created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, page.pageSize, page.offset)
    .all<CashTransactionRow>();
  return toPage(rows.results, page);
}

export async function loadInvoiceHistoryPage(
  db: D1Database,
  actor: SettlementWorkbenchActor,
  query: SettlementPageQuery,
) {
  const cte = reconciliationCte(actor);
  const where = ["invoice.organization_id=?", "invoice.status!='void'",
    "EXISTS(SELECT 1 FROM reconciliation_data scoped_invoice_reconciliation WHERE scoped_invoice_reconciliation.id=invoice.reconciliation_id)"];
  const bindings: unknown[] = [...cte.bindings, actor.organizationId];
  if (query.direction) {
    where.push("invoice.direction=?");
    bindings.push(query.direction);
  }
  if (query.currency) {
    where.push("UPPER(invoice.currency)=?");
    bindings.push(query.currency);
  }
  if (query.query) {
    const pattern = `%${query.query}%`;
    where.push("(invoice.record_number LIKE ? OR invoice.invoice_number LIKE ? OR invoice.counterparty_name LIKE ? OR invoice.invoice_company LIKE ? OR invoice.invoice_type LIKE ?)");
    bindings.push(pattern, pattern, pattern, pattern, pattern);
  }
  const filterSql = ` WHERE ${where.join(" AND ")}`;
  const count = await db.prepare(`${cte.sql} SELECT COUNT(*) total FROM settlement_invoice_records invoice${filterSql}`)
    .bind(...bindings).first<{ total: number }>();
  const page = pageBounds(Number(count?.total || 0), query);
  const rows = await db.prepare(`${cte.sql} SELECT invoice.id,invoice.record_number,invoice.reconciliation_id,invoice.direction,invoice.counterparty_name,invoice.invoice_company,invoice.invoice_type,invoice.invoice_number,invoice.invoice_date,invoice.currency,invoice.amount,invoice.status,invoice.created_at
      FROM settlement_invoice_records invoice${filterSql} ORDER BY invoice.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, page.pageSize, page.offset)
    .all<InvoiceRecordRow>();
  return toPage(rows.results, page);
}

export async function loadLegacyInvoicePage(
  db: D1Database,
  actor: SettlementWorkbenchActor,
  query: SettlementPageQuery,
) {
  if (!hasFullSettlementScope(actor)) return emptySettlementPage<LegacyInvoiceRow>(query.page, query.pageSize);
  const where = ["i.organization_id=?"];
  const bindings: unknown[] = [actor.organizationId];
  if (query.currency) {
    where.push("UPPER(i.currency)=?");
    bindings.push(query.currency);
  }
  if (query.status) {
    where.push("i.status=?");
    bindings.push(query.status);
  }
  if (query.query) {
    const pattern = `%${query.query}%`;
    where.push("(i.invoice_number LIKE ? OR c.name LIKE ?)");
    bindings.push(pattern, pattern);
  }
  const filterSql = ` WHERE ${where.join(" AND ")}`;
  const count = await db.prepare(`SELECT COUNT(*) total FROM invoices i JOIN customers c ON c.id=i.customer_id AND c.organization_id=i.organization_id${filterSql}`)
    .bind(...bindings).first<{ total: number }>();
  const page = pageBounds(Number(count?.total || 0), query);
  const rows = await db.prepare(`SELECT i.id,i.invoice_number,c.name customer_name,i.currency,i.total_amount,i.paid_amount,i.status,i.created_at
      FROM invoices i JOIN customers c ON c.id=i.customer_id AND c.organization_id=i.organization_id${filterSql}
      ORDER BY i.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, page.pageSize, page.offset)
    .all<LegacyInvoiceRow>();
  return toPage(rows.results, page);
}

export async function loadAvailableCashTransactions(
  db: D1Database,
  actor: SettlementWorkbenchActor,
  reconciliations: ReconciliationRow[],
) {
  const cte = cashCte(actor);
  const keys = [...new Map(reconciliations.map((row) => {
    const direction = row.direction === "receivable" ? "receipt" : "payment";
    const key = `${direction}\u0000${row.counterparty_name}\u0000${row.currency}`;
    return [key, { direction, counterparty: row.counterparty_name, currency: row.currency }];
  })).values()];
  if (!keys.length) return [];
  const matchingSql = keys.map(() => "(direction=? AND counterparty_name=? AND currency=?)").join(" OR ");
  const bindings = keys.flatMap((key) => [key.direction, key.counterparty, key.currency]);
  const rows = await db.prepare(`${cte.sql}
      SELECT * FROM cash_data
      WHERE amount-allocated_amount>0.009 AND (${matchingSql})
      ORDER BY occurred_on DESC,created_at DESC LIMIT 500`)
    .bind(...cte.bindings, ...bindings)
    .all<CashTransactionRow>();
  return rows.results;
}

function pageBounds(total: number, query: Pick<SettlementPageQuery, "page" | "pageSize">) {
  const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize) || 10));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(query.page) || 1), pageCount);
  return { total, page, pageCount, pageSize, offset: (page - 1) * pageSize };
}

function toPage<T>(items: T[], page: ReturnType<typeof pageBounds>): SettlementPage<T> {
  return {
    items,
    total: page.total,
    page: page.page,
    pageCount: page.pageCount,
    pageSize: page.pageSize,
  };
}
