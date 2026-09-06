import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.billing";
import { QueryPagination } from "../components/QueryPagination";
import { OrderNumberLink, OrderNumberLinkList } from "../components/EntityNumberLink";
import { writeAudit } from "../lib/audit.server";
import { requireSessionUser, type SessionUser } from "../lib/auth.server";
import { canAccessSettlementWorkbench } from "../lib/billing-access";
import {
  BILLING_PAGE_SIZE,
  billingTabs,
  readBillingView,
  settlementExpenseGroupKey,
  type BillingHistoryType,
  type BillingTab,
  type BillingView,
} from "../lib/billing-view";
import {
  hasFullSettlementScope,
  type SettlementMultiOrderActionAccess,
  type SettlementWorkbenchAction,
  type SettlementWorkbenchActor,
} from "../lib/settlement-workbench-access";
import {
  loadFreshSettlementWorkbenchActor,
  loadSettlementWorkbenchActionAccess,
} from "../lib/settlement-workbench-access.server";
import {
  emptySettlementPage,
  loadAvailableCashTransactions,
  loadCashHistoryPage,
  loadEligibleExpensePage,
  loadInvoiceHistoryPage,
  loadLegacyInvoicePage,
  loadReconciliationPage,
  loadSettlementSummary,
  type LegacyInvoiceRow,
  type SettlementPage,
} from "../lib/settlement-workbench-pages.server";
import {
  allocateCashTransaction,
  confirmReconciliation,
  createReconciliation,
  recordCashTransaction,
  recordSettlementInvoice,
  type CashTransactionRow,
  type InvoiceRecordRow,
  type ReconciliationRow,
  type SettlementExpense,
} from "../lib/settlement-workbench.server";
import { valueOf } from "../lib/validation";

type UserOption = { id: string; display_name: string };
type SettlementUiAccess = Pick<SettlementMultiOrderActionAccess, "visible" | "canWrite" | "reason">;
type SettlementActionAccessIndex = {
  createReconciliationByExpenseId: Record<string, SettlementMultiOrderActionAccess>;
  confirmReconciliationById: Record<string, SettlementMultiOrderActionAccess>;
  allocateCashById: Record<string, SettlementMultiOrderActionAccess>;
  recordInvoiceById: Record<string, SettlementMultiOrderActionAccess>;
  recordCash: SettlementUiAccess;
};

const emptyActionAccessIndex = (): SettlementActionAccessIndex => ({
  createReconciliationByExpenseId: {}, confirmReconciliationById: {},
  allocateCashById: {}, recordInvoiceById: {},
  recordCash: { visible: true, canWrite: false, reason: "当前页没有可办理的收付款流水" },
});

const tabCopy: Record<BillingTab, { label: string; description: string }> = {
  pending: { label: "待对账", description: "从已确认费用生成对账单" },
  reconciliations: { label: "对账单", description: "复核草稿并查看对账进度" },
  cash: { label: "收付款核销", description: "登记真实流水并完成核销" },
  invoices: { label: "发票", description: "按对账单登记开票或收票" },
  history: { label: "历史记录", description: "查询流水、发票和旧账单" },
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request);
  if (!canAccessSettlementWorkbench(current.permissions)) {
    return { accessDenied: true as const, current };
  }

  const view = readBillingView(new URL(request.url).searchParams);
  const [summary, organization, users] = await Promise.all([
    loadSettlementSummary(env.DB, current),
    env.DB.prepare("SELECT name FROM organizations WHERE id=?")
      .bind(current.organizationId)
      .first<{ name: string }>(),
    env.DB.prepare(
      "SELECT u.id,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.status='active' AND u.status='active' ORDER BY u.display_name",
    ).bind(current.organizationId).all<UserOption>(),
  ]);
  const pageQuery = {
    page: view.page,
    pageSize: BILLING_PAGE_SIZE,
    query: view.query,
    direction: view.direction,
    currency: view.currency,
    status: view.status,
  };
  let eligiblePage = emptySettlementPage<SettlementExpense>(view.page, BILLING_PAGE_SIZE);
  let reconciliationPage = emptySettlementPage<ReconciliationRow>(view.page, BILLING_PAGE_SIZE);
  let cashWorkPage = emptySettlementPage<ReconciliationRow>(view.page, BILLING_PAGE_SIZE);
  let invoiceWorkPage = emptySettlementPage<ReconciliationRow>(view.page, BILLING_PAGE_SIZE);
  let cashHistoryPage = emptySettlementPage<CashTransactionRow>(view.page, BILLING_PAGE_SIZE);
  let invoiceHistoryPage = emptySettlementPage<InvoiceRecordRow>(view.page, BILLING_PAGE_SIZE);
  let legacyHistoryPage = emptySettlementPage<LegacyInvoiceRow>(view.page, BILLING_PAGE_SIZE);
  let availableCashTransactions: CashTransactionRow[] = [];
  const actionAccess = emptyActionAccessIndex();

  if (view.tab === "pending") {
    eligiblePage = await loadEligibleExpensePage(env.DB, current, pageQuery);
    for (const expense of eligiblePage.items) {
      actionAccess.createReconciliationByExpenseId[expense.id] = await loadSettlementWorkbenchActionAccess(env.DB, {
        actor: current,
        action: "create_reconciliation",
        source: { kind: "expense_ids", ids: [expense.id] },
        legacyFallback: "deny",
      });
    }
  } else if (view.tab === "reconciliations") {
    reconciliationPage = await loadReconciliationPage(env.DB, current, pageQuery);
    for (const row of reconciliationPage.items) {
      actionAccess.confirmReconciliationById[row.id] = await loadSettlementWorkbenchActionAccess(env.DB, {
        actor: current, action: "confirm_reconciliation",
        source: { kind: "reconciliation_id", id: row.id }, legacyFallback: "deny",
      });
    }
  } else if (view.tab === "cash") {
    cashWorkPage = await loadReconciliationPage(env.DB, current, pageQuery, "cash");
    availableCashTransactions = await loadAvailableCashTransactions(
      env.DB,
      current,
      cashWorkPage.items,
    );
    actionAccess.recordCash = recordCashUiAccess(current);
    for (const row of cashWorkPage.items) {
      actionAccess.allocateCashById[row.id] = await loadSettlementWorkbenchActionAccess(env.DB, {
        actor: current, action: "allocate_cash",
        source: { kind: "reconciliation_id", id: row.id }, legacyFallback: "deny",
      });
    }
  } else if (view.tab === "invoices") {
    invoiceWorkPage = await loadReconciliationPage(env.DB, current, pageQuery, "invoice");
    for (const row of invoiceWorkPage.items) {
      actionAccess.recordInvoiceById[row.id] = await loadSettlementWorkbenchActionAccess(env.DB, {
        actor: current, action: "record_invoice",
        source: { kind: "reconciliation_id", id: row.id }, legacyFallback: "deny",
      });
    }
  } else if (view.historyType === "cash") {
    cashHistoryPage = await loadCashHistoryPage(env.DB, current, pageQuery);
  } else if (view.historyType === "invoices") {
    invoiceHistoryPage = await loadInvoiceHistoryPage(env.DB, current, pageQuery);
  } else {
    legacyHistoryPage = await loadLegacyInvoicePage(env.DB, current, pageQuery);
  }

  return {
    accessDenied: false as const,
    current,
    view,
    organizationName: organization?.name || "当前组织",
    users: users.results,
    eligiblePage,
    reconciliationPage,
    cashWorkPage,
    invoiceWorkPage,
    cashHistoryPage,
    invoiceHistoryPage,
    legacyHistoryPage,
    availableCashTransactions,
    actionAccess,
    counts: summary.counts,
    balances: summary.balances,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "billing.view");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();
  if (!current.permissions.includes("billing.sensitive.view")) {
    throw new Response("没有权限查看或处理敏感费用", { status: 403 });
  }

  try {
    if (intent === "create_reconciliation") {
      const direction = valueOf(form, "direction");
      if (direction !== "receivable" && direction !== "payable") {
        return { formError: "对账方向无效" };
      }
      const expenseIds = form.getAll("expenseId").map(String);
      const source = {
        kind: "expense_ids", ids: expenseIds,
      } as const;
      const blocked = await settlementActionBlocked(current, "create_reconciliation", source);
      if (blocked) return { formError: blocked };
      const result = await createReconciliation(env.DB, {
        organizationId: current.organizationId,
        expenseIds,
        direction,
        notes: valueOf(form, "notes"),
        userId: current.userId,
        assertCanMutate: () => assertSettlementActionAllowed(current, "create_reconciliation", source),
        now,
      });
      await audit(request, current, "settlement.reconciliation.create", "settlement_reconciliation", result.id, {
        number: result.number,
        direction,
      });
      return { success: `对账单 ${result.number} 已生成草稿，请到“对账单”页签复核确认` };
    }
    if (intent === "confirm_reconciliation") {
      const id = valueOf(form, "id");
      const source = { kind: "reconciliation_id", id } as const;
      const blocked = await settlementActionBlocked(current, "confirm_reconciliation", source);
      if (blocked) return { formError: blocked };
      await confirmReconciliation(env.DB, {
        organizationId: current.organizationId,
        id,
        userId: current.userId,
        assertCanMutate: () => assertSettlementActionAllowed(current, "confirm_reconciliation", source),
        now,
      });
      await audit(request, current, "settlement.reconciliation.confirm", "settlement_reconciliation", id, {});
      return { success: "对账单已确认；发票与收付款核销现在可以并行办理" };
    }
    if (intent === "record_invoice") {
      const reconciliationId = valueOf(form, "reconciliationId");
      const source = { kind: "reconciliation_id", id: reconciliationId } as const;
      const blocked = await settlementActionBlocked(current, "record_invoice", source);
      if (blocked) return { formError: blocked };
      const result = await recordSettlementInvoice(env.DB, {
        organizationId: current.organizationId,
        reconciliationId,
        amount: positive(form, "amount"),
        invoiceCompany: valueOf(form, "invoiceCompany"),
        invoiceType: valueOf(form, "invoiceType"),
        invoiceNumber: valueOf(form, "invoiceNumber"),
        invoiceCode: valueOf(form, "invoiceCode"),
        invoiceDate: valueOf(form, "invoiceDate"),
        taxRate: nonNegative(form, "taxRate"),
        titleName: valueOf(form, "titleName"),
        taxNumber: valueOf(form, "taxNumber"),
        addressPhone: valueOf(form, "addressPhone"),
        bankAccount: valueOf(form, "bankAccount"),
        exchangeRate: positive(form, "exchangeRate", 1),
        attachmentReference: valueOf(form, "attachmentReference"),
        notes: valueOf(form, "invoiceNotes"),
        userId: current.userId,
        assertCanMutate: () => assertSettlementActionAllowed(current, "record_invoice", source),
        now,
      });
      await audit(request, current, "settlement.invoice.record", "settlement_invoice_record", result.id, {
        recordNumber: result.recordNumber,
        reconciliationId,
      });
      return { success: `发票记录 ${result.recordNumber} 已保存` };
    }
    if (intent === "record_cash") {
      const cashAccess = recordCashUiAccess(current);
      if (!cashAccess.canWrite) return { formError: cashAccess.reason ?? "当前不可登记收付款流水" };
      const direction = valueOf(form, "direction");
      if (direction !== "receipt" && direction !== "payment") {
        return { formError: "收付款方向无效" };
      }
      const result = await recordCashTransaction(env.DB, {
        organizationId: current.organizationId,
        direction,
        counterpartyName: valueOf(form, "counterpartyName"),
        currency: valueOf(form, "currency"),
        amount: positive(form, "amount"),
        occurredOn: valueOf(form, "occurredOn"),
        settlementEntity: valueOf(form, "settlementEntity"),
        accountName: valueOf(form, "accountName"),
        handledByUserId: valueOf(form, "handledByUserId"),
        evidenceReference: valueOf(form, "evidenceReference"),
        notes: valueOf(form, "cashNotes"),
        userId: current.userId,
        assertCanMutate: () => assertRecordCashAllowed(current),
        now,
      });
      await audit(request, current, "settlement.cash.record", "settlement_cash_transaction", result.id, {
        number: result.number,
        direction,
      });
      return { success: `流水 ${result.number} 已登记；可在当前页匹配对账单并核销` };
    }
    if (intent === "allocate_cash") {
      const transactionId = valueOf(form, "transactionId");
      const reconciliationId = valueOf(form, "reconciliationId");
      const source = { kind: "reconciliation_id", id: reconciliationId } as const;
      const blocked = await settlementActionBlocked(current, "allocate_cash", source);
      if (blocked) return { formError: blocked };
      await allocateCashTransaction(env.DB, {
        organizationId: current.organizationId,
        transactionId,
        reconciliationId,
        amount: positive(form, "amount"),
        userId: current.userId,
        assertCanMutate: () => assertSettlementActionAllowed(current, "allocate_cash", source),
        now,
      });
      await audit(request, current, "settlement.cash.allocate", "settlement_cash_transaction", transactionId, {
        reconciliationId,
      });
      return { success: "核销完成；流水未分配余额和订单费用余额已同步更新" };
    }
    return { formError: "操作无效" };
  } catch (error) {
    return { formError: error instanceof Error ? error.message : "操作失败，请稍后重试" };
  }
}

function recordCashUiAccess(actor: SettlementWorkbenchActor): SettlementUiAccess {
  if (!actor.permissions.includes("billing.cash.manage")) {
    return { visible: true, canWrite: false, reason: "当前账号没有收付款流水登记权限" };
  }
  if (!hasFullSettlementScope(actor)) {
    return {
      visible: true,
      canWrite: false,
      reason: "当前账号没有组织级结算范围，不能登记组织收付款流水",
    };
  }
  return { visible: true, canWrite: true, reason: null };
}

async function assertRecordCashAllowed(actor: SettlementWorkbenchActor & Pick<SessionUser, "sessionId">) {
  const freshActor = await freshSettlementActor(actor);
  const access = recordCashUiAccess(freshActor);
  if (!access.canWrite) {
    throw new Error(access.reason ?? "当前不可登记收付款流水");
  }
}

async function settlementActionBlocked(
  actor: Parameters<typeof loadSettlementWorkbenchActionAccess>[1]["actor"],
  action: SettlementWorkbenchAction,
  source: Parameters<typeof loadSettlementWorkbenchActionAccess>[1]["source"],
) {
  const access = await loadSettlementWorkbenchActionAccess(env.DB, {
    actor, action, source, legacyFallback: "deny",
  });
  return access.canWrite ? null : access.reason ?? "当前冻结工作流不允许办理该结算操作";
}

async function assertSettlementActionAllowed(
  actor: Parameters<typeof loadSettlementWorkbenchActionAccess>[1]["actor"] & Pick<SessionUser, "sessionId">,
  action: SettlementWorkbenchAction,
  source: Parameters<typeof loadSettlementWorkbenchActionAccess>[1]["source"],
) {
  const freshActor = await freshSettlementActor(actor);
  const blocked = await settlementActionBlocked(freshActor, action, source);
  if (blocked) throw new Error(blocked);
}

async function freshSettlementActor(
  actor: SettlementWorkbenchActor & Pick<SessionUser, "sessionId">,
) {
  const freshActor = await loadFreshSettlementWorkbenchActor(env.DB, {
    sessionId: actor.sessionId,
    organizationId: actor.organizationId,
    userId: actor.userId,
  });
  if (!freshActor) {
    throw new Error("当前会话、岗位或角色已失效，请重新登录后再试");
  }
  return freshActor;
}

export default function Billing({ loaderData, actionData }: Route.ComponentProps) {
  if (loaderData.accessDenied) return <BillingAccessHandoff />;

  const busy = useNavigation().state !== "idle";
  const manage = loaderData.current.permissions.includes("billing.manage");
  const cashManage = loaderData.current.permissions.includes("billing.cash.manage");
  return <>
    <header className="page-header billing-page-header">
      <div>
        <p className="eyebrow">FINANCE SETTLEMENT</p>
        <h1>费用结算</h1>
        <p>按业务阶段逐页办理；应收与应付分开筛选，发票和收付款在对账确认后并行推进。</p>
      </div>
      <span className="status-pill">
        {manage && cashManage ? "全流程办理" : manage ? "财务办理" : cashManage ? "出纳办理" : "只读"}
      </span>
    </header>

    {loaderData.balances.length > 0 && <div className="billing-balance-strip" aria-label="未核销余额">
      {loaderData.balances.map((item) => <span key={`${item.direction}-${item.currency}`}>
        <small>{item.direction === "receivable" ? "应收未核销" : "应付未核销"}</small>
        <strong>{item.currency} {item.amount.toFixed(2)}</strong>
      </span>)}
    </div>}

    <BillingTabs active={loaderData.view.tab} counts={loaderData.counts} />

    {(actionData?.success || actionData?.formError) && <div className={`alert ${actionData.formError ? "error" : "success"}`} role="status">
      {actionData.formError ?? actionData.success}
    </div>}

    {loaderData.view.tab === "pending" && <PendingReconciliationPage
      view={loaderData.view}
      page={loaderData.eligiblePage}
      accessByExpenseId={loaderData.actionAccess.createReconciliationByExpenseId}
      busy={busy}
    />}
    {loaderData.view.tab === "reconciliations" && <ReconciliationPage
      view={loaderData.view}
      page={loaderData.reconciliationPage}
      accessById={loaderData.actionAccess.confirmReconciliationById}
      busy={busy}
    />}
    {loaderData.view.tab === "cash" && <CashSettlementPage
      view={loaderData.view}
      page={loaderData.cashWorkPage}
      cash={loaderData.availableCashTransactions}
      users={loaderData.users}
      organizationName={loaderData.organizationName}
      recordCashAccess={loaderData.actionAccess.recordCash}
      accessById={loaderData.actionAccess.allocateCashById}
      busy={busy}
    />}
    {loaderData.view.tab === "invoices" && <InvoicePage
      view={loaderData.view}
      page={loaderData.invoiceWorkPage}
      accessById={loaderData.actionAccess.recordInvoiceById}
      busy={busy}
    />}
    {loaderData.view.tab === "history" && <HistoryPage
      view={loaderData.view}
      cashPage={loaderData.cashHistoryPage}
      invoicePage={loaderData.invoiceHistoryPage}
      legacyPage={loaderData.legacyHistoryPage}
    />}
  </>;
}

function BillingTabs({ active, counts }: {
  active: BillingTab;
  counts: Record<BillingTab, number>;
}) {
  return <nav className="billing-workspace-tabs" aria-label="费用结算工作区">
    {billingTabs.map((tab) => <Link
      key={tab}
      to={`/admin/billing?tab=${tab}`}
      className={active === tab ? "active" : undefined}
      aria-current={active === tab ? "page" : undefined}
    >
      <span>{tabCopy[tab].label}<b>{counts[tab]}</b></span>
      <small>{tabCopy[tab].description}</small>
    </Link>)}
  </nav>;
}

export function PendingReconciliationPage({ view, page, accessByExpenseId, busy }: {
  view: BillingView;
  page: SettlementPage<SettlementExpense>;
  accessByExpenseId: Record<string, SettlementUiAccess>;
  busy: boolean;
}) {
  const groups = groupExpenses(page.items);
  const visibleCount = page.items.filter((expense) => accessByExpenseId[expense.id]?.visible).length;
  return <section className="panel billing-workspace-page">
    <WorkspaceHeading
      title="待对账费用"
      description="只展示已完成订单费用确认、尚未进入有效对账单的费用。每组只能包含同一往来单位和同一币种。"
      count={visibleCount === page.items.length ? `${page.total} 条` : `当前页 ${visibleCount} 条`}
    />
    <BillingFilters view={view} mode="pending" />
    {groups.map((group) => <PendingExpenseGroup
      key={group.key}
      group={group}
      accessByExpenseId={accessByExpenseId}
      busy={busy}
    />)}
    {!visibleCount && <EmptyState>没有符合当前筛选条件的待对账费用。</EmptyState>}
    <QueryPagination {...page} unit="条" />
  </section>;
}

function PendingExpenseGroup({ group, accessByExpenseId, busy }: {
  group: ReturnType<typeof groupExpenses>[number];
  accessByExpenseId: Record<string, SettlementUiAccess>;
  busy: boolean;
}) {
  const writableExpenses = group.expenses.filter((expense) => accessByExpenseId[expense.id]?.canWrite);
  const readonlyExpenses = group.expenses.filter((expense) => {
    const access = accessByExpenseId[expense.id];
    return access?.visible && !access.canWrite;
  });
  return <>
    {writableExpenses.length > 0 && <ExpenseSelection
      access={{ visible: true, canWrite: true, reason: null }}
      direction={group.direction}
      counterparty={group.counterparty}
      currency={group.currency}
      expenses={writableExpenses}
      busy={busy}
    />}
    {readonlyExpenses.map((expense) => <ExpenseSelection
      key={expense.id}
      access={accessByExpenseId[expense.id]}
      direction={group.direction}
      counterparty={group.counterparty}
      currency={group.currency}
      expenses={[expense]}
      busy={busy}
    />)}
  </>;
}

function ReconciliationPage({ view, page, accessById, busy }: {
  view: BillingView;
  page: SettlementPage<ReconciliationRow>;
  accessById: Record<string, SettlementUiAccess>;
  busy: boolean;
}) {
  return <section className="panel billing-workspace-page">
    <WorkspaceHeading
      title="对账单"
      description="在这里复核并确认草稿。确认后，发票与收付款进入各自页签继续办理。"
      count={`${page.total} 张`}
    />
    <BillingFilters view={view} mode="reconciliations" />
    <div className="reconciliation-list">
      {page.items.map((row) => <ReconciliationSheet
        key={row.id}
        row={row}
        mode="review"
        access={accessById[row.id] ?? { visible: false, canWrite: false, reason: "当前对账确认项不可用" }}
        busy={busy}
      />)}
    </div>
    {!page.items.length && <EmptyState>没有符合当前筛选条件的对账单。</EmptyState>}
    <QueryPagination {...page} unit="张" />
  </section>;
}

function CashSettlementPage({ view, page, cash, users, organizationName, recordCashAccess, accessById, busy }: {
  view: BillingView;
  page: SettlementPage<ReconciliationRow>;
  cash: CashTransactionRow[];
  users: UserOption[];
  organizationName: string;
  recordCashAccess: SettlementUiAccess;
  accessById: Record<string, SettlementUiAccess>;
  busy: boolean;
}) {
  return <section className="panel billing-workspace-page">
    <WorkspaceHeading
      title="收付款与核销"
      description="先登记真实收付款流水，再匹配同方向、同往来单位、同币种的已确认对账单。"
      count={`${page.total} 张待核销`}
    />
    {recordCashAccess.visible && (recordCashAccess.canWrite
      ? <CashEntryForm users={users} organizationName={organizationName} busy={busy} />
      : <ReadOnlyNotice>{recordCashAccess.reason ?? "当前账号不能登记收付款流水。"}</ReadOnlyNotice>)}
    <BillingFilters view={view} mode="cash" />
    <div className="reconciliation-list">
      {page.items.map((row) => <ReconciliationSheet
        key={row.id}
        row={row}
        mode="cash"
        access={accessById[row.id] ?? { visible: false, canWrite: false, reason: "当前核销项不可用" }}
        busy={busy}
        cash={cash}
      />)}
    </div>
    {!page.items.length && <EmptyState>当前筛选条件下没有待核销对账单。</EmptyState>}
    <QueryPagination {...page} unit="张" />
  </section>;
}

function InvoicePage({ view, page, accessById, busy }: {
  view: BillingView;
  page: SettlementPage<ReconciliationRow>;
  accessById: Record<string, SettlementUiAccess>;
  busy: boolean;
}) {
  return <section className="panel billing-workspace-page">
    <WorkspaceHeading
      title="发票办理"
      description="从已确认对账单登记销项开票或进项收票，支持按实际进度分次登记。"
      count={`${page.total} 张待登记`}
    />
    <BillingFilters view={view} mode="invoices" />
    <div className="reconciliation-list">
      {page.items.map((row) => <ReconciliationSheet
        key={row.id}
        row={row}
        mode="invoice"
        access={accessById[row.id] ?? { visible: false, canWrite: false, reason: "当前发票办理项不可用" }}
        busy={busy}
      />)}
    </div>
    {!page.items.length && <EmptyState>当前筛选条件下没有待登记发票的对账单。</EmptyState>}
    <QueryPagination {...page} unit="张" />
  </section>;
}

function HistoryPage({ view, cashPage, invoicePage, legacyPage }: {
  view: BillingView;
  cashPage: SettlementPage<CashTransactionRow>;
  invoicePage: SettlementPage<InvoiceRecordRow>;
  legacyPage: SettlementPage<LegacyInvoiceRow>;
}) {
  return <section className="panel billing-workspace-page">
    <WorkspaceHeading
      title="历史记录"
      description="历史页只负责查询和追溯，不与当前办理表单混排。"
      count="只读"
    />
    <HistoryTypeSwitch active={view.historyType} />
    <BillingFilters view={view} mode="history" />
    {view.historyType === "cash" && <CashHistoryTable page={cashPage} />}
    {view.historyType === "invoices" && <InvoiceHistoryTable page={invoicePage} />}
    {view.historyType === "legacy" && <LegacyHistoryTable page={legacyPage} />}
  </section>;
}

function BillingFilters({ view, mode }: {
  view: BillingView;
  mode: "pending" | "reconciliations" | "cash" | "invoices" | "history";
}) {
  const cashHistory = mode === "history" && view.historyType === "cash";
  const showDirection = mode !== "history" || view.historyType !== "legacy";
  const statusOptions = mode === "reconciliations"
    ? [["", "全部状态"], ["draft", "草稿待确认"], ["unsettled", "已确认未结清"], ["settled", "已结清"]]
    : cashHistory
      ? [["", "全部状态"], ["unallocated", "未分配"], ["partially_allocated", "部分分配"], ["allocated", "已分配"]]
      : [];
  const directionOptions = mode === "pending"
    ? [["receivable", "客户应收"], ["payable", "供应商应付"]]
    : cashHistory
      ? [["", "全部方向"], ["receipt", "客户收款"], ["payment", "供应商付款"]]
      : [["", "全部方向"], ["receivable", "客户应收"], ["payable", "供应商应付"]];

  return <Form method="get" className="billing-workspace-filters" aria-label="结算记录筛选">
    <input type="hidden" name="tab" value={view.tab} />
    {mode === "history" && <input type="hidden" name="historyType" value={view.historyType} />}
    <label className="field billing-filter-search">
      <span>搜索</span>
      <input name="q" defaultValue={view.query} placeholder="订单号、单据号或往来单位" />
    </label>
    {showDirection && <label className="field">
      <span>方向</span>
      <select name="direction" defaultValue={view.direction}>
        {directionOptions.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}
      </select>
    </label>}
    <label className="field billing-filter-currency">
      <span>币种</span>
      <input name="currency" defaultValue={view.currency} placeholder="全部" maxLength={3} />
    </label>
    {statusOptions.length > 0 && <label className="field">
      <span>状态</span>
      <select name="status" defaultValue={view.status}>
        {statusOptions.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}
      </select>
    </label>}
    <div className="billing-filter-actions">
      <button className="primary" type="submit">筛选</button>
      <Link className="secondary" to={historyResetHref(view, mode)}>重置</Link>
    </div>
  </Form>;
}

function HistoryTypeSwitch({ active }: { active: BillingHistoryType }) {
  const items: Array<[BillingHistoryType, string]> = [
    ["cash", "收付款流水"],
    ["invoices", "发票记录"],
    ["legacy", "升级前账单"],
  ];
  return <nav className="billing-history-switch" aria-label="历史记录类型">
    {items.map(([value, label]) => <Link
      key={value}
      to={`/admin/billing?tab=history&historyType=${value}`}
      className={active === value ? "active" : undefined}
      aria-current={active === value ? "page" : undefined}
    >{label}</Link>)}
  </nav>;
}

export function ExpenseSelection({ direction, counterparty, currency, expenses, busy, access }: {
  direction: "receivable" | "payable";
  counterparty: string;
  currency: string;
  expenses: SettlementExpense[];
  busy: boolean;
  access: SettlementUiAccess;
}) {
  if (!access.visible) return null;
  const total = expenses.reduce((sum, item) => sum + item.amount, 0);
  if (!access.canWrite) return <section className="settlement-selector">
    <header><div>
      <span className={`billing-flow-chip ${direction}`}>{direction === "receivable" ? "客户应收" : "供应商应付"}</span>
      <strong>{counterparty}</strong>
      <small>{currency} · 本页 {expenses.length} 条 · 合计 {total.toFixed(2)}</small>
    </div></header>
    <div className="settlement-expense-list" aria-label="只读费用明细">
      {expenses.map((item) => <div key={item.id} className="settlement-expense-readonly"><span>
        <strong><OrderNumberLink id={item.order_id} number={item.order_number} /> · {item.charge_name}</strong>
        <small>{item.currency} {item.amount.toFixed(2)}</small>
      </span></div>)}
    </div>
    <ReadOnlyNotice>{access.reason ?? "当前冻结工作流不允许生成对账单。"}</ReadOnlyNotice>
  </section>;
  return <section className="settlement-selector">
    <header>
      <div>
        <span className={`billing-flow-chip ${direction}`}>{direction === "receivable" ? "客户应收" : "供应商应付"}</span>
        <strong>{counterparty}</strong>
        <small>{currency} · 本页 {expenses.length} 条 · 合计 {total.toFixed(2)}</small>
      </div>
    </header>
    <Form method="post">
      <input type="hidden" name="intent" value="create_reconciliation" />
      <input type="hidden" name="direction" value={direction} />
      <div className="settlement-expense-list">
        {expenses.map((item) => <label key={item.id}>
          <input type="checkbox" name="expenseId" value={item.id} />
          <span>
            <strong><OrderNumberLink id={item.order_id} number={item.order_number} /> · {item.charge_name}</strong>
            <small>{item.currency} {item.amount.toFixed(2)}</small>
          </span>
        </label>)}
      </div>
      <div className="settlement-selector-footer">
        <label className="field">
          <span>对账备注</span>
          <input name="notes" placeholder="选填" />
        </label>
        <button className="primary" disabled={busy}>生成对账草稿</button>
      </div>
    </Form>
  </section>;
}

export function ReconciliationSheet({ row, mode, access, busy, cash = [] }: {
  row: ReconciliationRow;
  mode: "review" | "cash" | "invoice";
  access: SettlementUiAccess;
  busy: boolean;
  cash?: CashTransactionRow[];
}) {
  const invoiceRemaining = Math.max(0, row.total_amount - row.invoiced_amount);
  if (!access.visible) return null;
  const settlementRemaining = Math.max(0, row.total_amount - row.settled_amount);
  const matchingCash = cash.filter((item) =>
    item.direction === (row.direction === "receivable" ? "receipt" : "payment") &&
    item.counterparty_name === row.counterparty_name &&
    item.currency === row.currency &&
    item.amount - item.allocated_amount > 0.009);
  const visualStatus = reconciliationStatus(row, settlementRemaining);
  const canManage = access.canWrite;

  return <article className="reconciliation-card">
    <header>
      <div>
        <span className={`billing-flow-chip ${row.direction}`}>{row.direction === "receivable" ? "客户应收" : "供应商应付"}</span>
        <strong>{row.document_number}</strong>
        <small>{row.counterparty_name} · {row.currency} · {row.created_at.slice(0, 10)}</small>
      </div>
      <span className={`status-pill ${visualStatus.className}`}>{visualStatus.label}</span>
    </header>
    <div className="reconciliation-reference-row">
      <span>订单 <OrderNumberLinkList orders={orderReferences(row.order_refs)} /></span>
      <span>{row.expense_count} 条费用</span>
    </div>
    <div className="reconciliation-money">
      <span>对账金额<strong>{row.currency} {row.total_amount.toFixed(2)}</strong></span>
      <span>已开 / 收票<strong>{row.invoiced_amount.toFixed(2)}</strong><small>剩余 {invoiceRemaining.toFixed(2)}</small></span>
      <span>已核销<strong>{row.settled_amount.toFixed(2)}</strong><small>剩余 {settlementRemaining.toFixed(2)}</small></span>
    </div>

    {mode === "review" && row.status === "draft" && canManage && <Form method="post" className="card-action">
      <input type="hidden" name="intent" value="confirm_reconciliation" />
      <input type="hidden" name="id" value={row.id} />
      <p>确认后费用进入正式对账，不能再按草稿修改。</p>
      <button className="primary" disabled={busy}>确认对账单</button>
    </Form>}
    {mode === "review" && row.status === "draft" && !canManage &&
      <ReadOnlyNotice>{access.reason ?? "当前不可确认该对账单。"}</ReadOnlyNotice>}

    {mode === "invoice" && canManage && invoiceRemaining > 0.009 && <details className="billing-card-operation">
      <summary>登记{row.direction === "receivable" ? "销项开票" : "进项收票"}</summary>
      <Form method="post" className="form-grid compact billing-invoice-form">
        <input type="hidden" name="intent" value="record_invoice" />
        <input type="hidden" name="reconciliationId" value={row.id} />
        <Num name="amount" label={`本次金额（剩余 ${invoiceRemaining.toFixed(2)}）`} required max={invoiceRemaining} />
        <Text name="invoiceCompany" label="开票 / 收票公司" required defaultValue={row.settlement_entity} />
        <Text name="invoiceType" label="发票类别" required defaultValue="增值税发票" />
        <Text name="invoiceNumber" label="发票号码" required />
        <Text name="invoiceCode" label="发票代码" />
        <label className="field"><span>开票日期</span><input name="invoiceDate" type="date" required /></label>
        <Num name="taxRate" label="税率 %" />
        <Text name="titleName" label="抬头 / 销方" required defaultValue={row.direction === "receivable" ? row.settlement_entity : row.counterparty_name} />
        <Text name="taxNumber" label="税号" />
        <Text name="addressPhone" label="地址电话" />
        <Text name="bankAccount" label="开户行账号" />
        <Num name="exchangeRate" label="汇率" required defaultValue="1" />
        <Text name="attachmentReference" label="附件 / 凭证编号" />
        <label className="field span-2"><span>备注</span><input name="invoiceNotes" /></label>
        <button className="primary" disabled={busy}>保存发票记录</button>
      </Form>
    </details>}
    {mode === "invoice" && invoiceRemaining > 0.009 && !canManage &&
      <ReadOnlyNotice>{access.reason ?? "当前不可登记发票。"}</ReadOnlyNotice>}

    {mode === "cash" && canManage && settlementRemaining > 0.009 && <details className="billing-card-operation">
      <summary>匹配收付款流水并核销</summary>
      <Form method="post" className="form-grid compact billing-allocation-form">
        <input type="hidden" name="intent" value="allocate_cash" />
        <input type="hidden" name="reconciliationId" value={row.id} />
        <Sel name="transactionId" label="可用流水" items={matchingCash.map((item) => [
          item.id,
          `${item.transaction_number} · 剩余 ${(item.amount - item.allocated_amount).toFixed(2)}`,
        ])} />
        <Num name="amount" label={`本次核销（剩余 ${settlementRemaining.toFixed(2)}）`} required max={settlementRemaining} />
        <button className="primary" disabled={busy || !matchingCash.length}>确认核销</button>
        {!matchingCash.length && <small className="field-error">尚无同方向、同往来单位、同币种的可用流水，请先登记。</small>}
      </Form>
    </details>}
    {mode === "cash" && settlementRemaining > 0.009 && !canManage &&
      <ReadOnlyNotice>{access.reason ?? "当前不可核销该对账单。"}</ReadOnlyNotice>}
  </article>;
}

function CashEntryForm({ users, organizationName, busy }: {
  users: UserOption[];
  organizationName: string;
  busy: boolean;
}) {
  return <details className="billing-entry-disclosure">
    <summary><span>登记一笔新流水</span><small>客户收款或供应商付款</small></summary>
    <Form method="post" className="form-grid compact settlement-cash-form">
      <input type="hidden" name="intent" value="record_cash" />
      <Sel name="direction" label="方向" items={[["receipt", "客户收款"], ["payment", "供应商付款"]]} />
      <Text name="counterpartyName" label="往来单位" required />
      <Text name="currency" label="币种" required defaultValue="CNY" />
      <Num name="amount" label="金额" required />
      <label className="field"><span>收 / 付款日期</span><input name="occurredOn" type="date" required /></label>
      <Text name="settlementEntity" label="所属公司" required defaultValue={organizationName} />
      <Text name="accountName" label="银行 / 现金账户" required />
      <Sel name="handledByUserId" label="经办人" items={users.map((item) => [item.id, item.display_name])} />
      <Text name="evidenceReference" label="凭证附件 / 编号" />
      <label className="field settlement-cash-notes"><span>备注</span><textarea name="cashNotes" rows={2} /></label>
      <button className="primary" disabled={busy}>登记收付款流水</button>
    </Form>
  </details>;
}

function CashHistoryTable({ page }: { page: SettlementPage<CashTransactionRow> }) {
  return <>
    <div className="table-wrap billing-history-table"><table>
      <thead><tr><th>流水号 / 日期</th><th>方向</th><th>往来单位</th><th>金额</th><th>已分配 / 未分配</th><th>账户 / 公司</th><th>状态</th></tr></thead>
      <tbody>{page.items.map((row) => <tr key={row.id}>
        <td><strong>{row.transaction_number}</strong><small>{row.occurred_on}</small></td>
        <td>{row.direction === "receipt" ? "收款" : "付款"}</td>
        <td>{row.counterparty_name}</td>
        <td>{row.currency} {row.amount.toFixed(2)}</td>
        <td>{row.allocated_amount.toFixed(2)} / {(row.amount - row.allocated_amount).toFixed(2)}</td>
        <td>{row.account_name}<small>{row.settlement_entity}</small></td>
        <td><span className="status-pill">{cashStatus(row.status)}</span></td>
      </tr>)}</tbody>
    </table></div>
    {!page.items.length && <EmptyState>没有符合筛选条件的收付款流水。</EmptyState>}
    <QueryPagination {...page} unit="笔" />
  </>;
}

function InvoiceHistoryTable({ page }: { page: SettlementPage<InvoiceRecordRow> }) {
  return <>
    <div className="table-wrap billing-history-table"><table>
      <thead><tr><th>内部记录号</th><th>发票号码</th><th>方向 / 类别</th><th>往来单位</th><th>开票 / 收票公司</th><th>金额</th><th>日期</th></tr></thead>
      <tbody>{page.items.map((row) => <tr key={row.id}>
        <td>{row.record_number}</td><td><strong>{row.invoice_number}</strong></td>
        <td>{row.direction === "receivable" ? "销项" : "进项"} · {row.invoice_type}</td>
        <td>{row.counterparty_name}</td><td>{row.invoice_company}</td>
        <td>{row.currency} {row.amount.toFixed(2)}</td><td>{row.invoice_date}</td>
      </tr>)}</tbody>
    </table></div>
    {!page.items.length && <EmptyState>没有符合筛选条件的发票记录。</EmptyState>}
    <QueryPagination {...page} unit="张" />
  </>;
}

function LegacyHistoryTable({ page }: { page: SettlementPage<LegacyInvoiceRow> }) {
  return <>
    <ReadOnlyNotice>这里保留系统升级前的历史应收账单，只供查询，不再参与当前核销流程。</ReadOnlyNotice>
    <div className="table-wrap billing-history-table"><table>
      <thead><tr><th>账单号</th><th>客户</th><th>金额</th><th>已收</th><th>状态</th><th>创建时间</th></tr></thead>
      <tbody>{page.items.map((row) => <tr key={row.id}>
        <td><strong>{row.invoice_number}</strong></td><td>{row.customer_name}</td>
        <td>{row.currency} {row.total_amount.toFixed(2)}</td><td>{row.paid_amount.toFixed(2)}</td>
        <td>{row.status}</td><td>{row.created_at.slice(0, 10)}</td>
      </tr>)}</tbody>
    </table></div>
    {!page.items.length && <EmptyState>没有符合筛选条件的升级前账单。</EmptyState>}
    <QueryPagination {...page} unit="张" />
  </>;
}

function WorkspaceHeading({ title, description, count }: { title: string; description: string; count: string }) {
  return <div className="panel-header billing-workspace-heading">
    <div><h2>{title}</h2><p>{description}</p></div>
    <span>{count}</span>
  </div>;
}

function ReadOnlyNotice({ children }: { children: React.ReactNode }) {
  return <div className="billing-readonly-notice">{children}</div>;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="empty-state billing-empty-state">{children}</p>;
}

function BillingAccessHandoff() {
  return <>
    <header className="page-header"><div><p className="eyebrow">FINANCE HANDOFF</p><h1>费用结算</h1><p>当前节点已转交财务相关岗位，本账号无需在这里继续办理。</p></div><span className="status-pill off">当前账号只读隔离</span></header>
    <section className="panel settlement-access-handoff"><div><strong>请切换到对应岗位继续</strong><p>财务会计岗负责费用复核、对账和发票；客服岗负责客户对账与收款协同；出纳岗负责登记收付款流水和核销。当前页面不会向无敏感财务权限的账号加载应收、应付或利润数据。</p></div><Link className="primary" to="/admin/portal">返回当前岗位工作台</Link></section>
  </>;
}

function Text({ name, label, required, defaultValue }: { name: string; label: string; required?: boolean; defaultValue?: string }) {
  return <label className="field"><span>{label}</span><input name={name} required={required} defaultValue={defaultValue} /></label>;
}

function Num({ name, label, required, defaultValue = "0", max }: { name: string; label: string; required?: boolean; defaultValue?: string; max?: number }) {
  return <label className="field"><span>{label}</span><input name={name} type="number" min="0" max={max} step="0.01" required={required} defaultValue={defaultValue} /></label>;
}

function Sel({ name, label, items }: { name: string; label: string; items: string[][] }) {
  return <label className="field"><span>{label}</span><select name={name} required><option value="">请选择</option>{items.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
}

function groupExpenses(expenses: SettlementExpense[]) {
  const groups = new Map<string, {
    key: string;
    direction: "receivable" | "payable";
    counterparty: string;
    currency: string;
    expenses: SettlementExpense[];
  }>();
  for (const expense of expenses) {
    const key = settlementExpenseGroupKey(expense);
    const group = groups.get(key) || {
      key,
      direction: expense.direction,
      counterparty: expense.counterparty_name,
      currency: expense.currency,
      expenses: [],
    };
    group.expenses.push(expense);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function reconciliationStatus(row: ReconciliationRow, remaining: number) {
  if (row.status === "draft") return { label: "草稿待确认", className: "off" };
  if (remaining <= 0.009) return { label: "已结清", className: "success" };
  return { label: "已确认未结清", className: "" };
}

function historyResetHref(view: BillingView, mode: string) {
  return mode === "history"
    ? `/admin/billing?tab=history&historyType=${view.historyType}`
    : `/admin/billing?tab=${view.tab}`;
}

function orderReferences(value: string | null) {
  return (value || "").split(",").flatMap((reference) => {
    const separator = reference.indexOf("|");
    return separator > 0 ? [{ id: reference.slice(0, separator), number: reference.slice(separator + 1) }] : [];
  });
}

function positive(form: FormData, name: string, fallback = 0) {
  const value = Number(valueOf(form, name) || fallback);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function nonNegative(form: FormData, name: string) {
  const value = Number(valueOf(form, name) || 0);
  return Number.isFinite(value) && value >= 0 ? value : -1;
}

function cashStatus(status: string) {
  return { unallocated: "未分配", partially_allocated: "部分分配", allocated: "已分配" }[status] || status;
}

async function audit(
  request: Request,
  current: { organizationId: string; userId: string },
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
) {
  await writeAudit({
    request,
    action,
    resourceType,
    resourceId,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata,
  });
}

export function meta() {
  return [{ title: "费用结算 | International TMS" }];
}
