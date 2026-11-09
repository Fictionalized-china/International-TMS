import type { SessionUser } from "./auth.server";
import { canAccessSettlementWorkbench } from "./billing-access";
import { loadMeetingSettlement, loadMeetingSettlementDirections, assertMeetingSignoffsComplete } from "./meeting-settlement.server";
import { loadSettlementHandoff } from "./financial-closure.server";
import { loadEligibleExpensePage, loadReconciliationPage, loadAvailableCashTransactions } from "./settlement-workbench-pages.server";
import { createSettlementAccessReadPhase, loadSettlementWorkbenchActionAccess, type SettlementAccessSource } from "./settlement-workbench-access.server";
import type { SettlementWorkbenchAction, SettlementMultiOrderActionAccess } from "./settlement-workbench-access";
import { hasFullSettlementScope } from "./settlement-workbench-access";
import { orderVisibilitySql } from "./order-access";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";

export const orderFinancialIntents = ["create_reconciliation", "confirm_reconciliation", "record_invoice", "record_cash", "allocate_cash", "offline"];
export type OrderFinancialTab = "ledger" | "statements" | "cash" | "invoices" | "offline";

async function assertOrderScope(db: D1Database, actor: SessionUser, orderId: string) {
  const scope = orderVisibilitySql(actor, "o");
  if (!canAccessSettlementWorkbench(actor.permissions) || !actor.permissions.includes("order.view") || !await db.prepare(`SELECT 1 FROM transport_orders o WHERE o.organization_id=? AND o.id=? AND ${scope.sql}`).bind(actor.organizationId, orderId, ...scope.values).first()) throw new Error("本单不在当前账号的财务办理范围内");
}
async function statementIsExclusive(db: D1Database, org: string, orderId: string, id: string) {
  const lines = (await db.prepare(`SELECT e.order_id,e.organization_id FROM settlement_reconciliation_lines l
    LEFT JOIN business_expenses e ON e.id=l.expense_id AND e.organization_id=l.organization_id
    WHERE l.organization_id=? AND l.reconciliation_id=?`).bind(org, id).all<{ order_id: string | null; organization_id: string | null }>()).results;
  return lines.length > 0 && lines.every(line => line.order_id === orderId && line.organization_id === org);
}

/** Order context is server-owned, never accepted from a hidden orderId field. */
export async function assertOrderFinancialSubmission(db: D1Database, actor: SessionUser, orderId: string, form: FormData) {
  await assertOrderScope(db, actor, orderId);
  const intent = String(form.get("intent") ?? "");
  if (!orderFinancialIntents.includes(intent)) throw new Error("不支持的订单财务操作");
  if (intent === "offline") {
    if (form.get("orderId") !== orderId) throw new Error("付款审批记录不属于当前订单");
    return;
  }
  if (intent === "create_reconciliation") {
    const ids = [...new Set(form.getAll("expenseId").map(String))];
    if (!ids.length || ids.length > 100) throw new Error("请勾选本单的 1 至 100 条费用");
    for (const chunk of chunkD1Values(ids, 2)) {
      const found = await db.prepare(`SELECT id FROM business_expenses WHERE organization_id=? AND order_id=? AND id IN (${d1Placeholders(chunk.length)})`).bind(actor.organizationId, orderId, ...chunk).all();
      if (found.results.length !== chunk.length) throw new Error("只能办理当前订单的费用，不能混入其他订单");
    }
    return;
  }
  const id = String(form.get(intent === "confirm_reconciliation" ? "id" : "reconciliationId") ?? "");
  if (!await statementIsExclusive(db, actor.organizationId, orderId, id)) throw new Error("对账单不存在、包含其他订单或不属于当前订单；不能在本单代办其他订单");
  if (intent === "record_cash") {
    const statement = await db.prepare("SELECT direction,counterparty_name,currency,document_number FROM settlement_reconciliations WHERE organization_id=? AND id=? AND status='confirmed'").bind(actor.organizationId, id).first<{ direction: string; counterparty_name: string; currency: string; document_number: string }>();
    if (!statement || form.get("direction") !== (statement.direction === "receivable" ? "receipt" : "payment") || form.get("counterpartyName") !== statement.counterparty_name || String(form.get("currency")).toUpperCase() !== statement.currency || (statement.direction === "payable" && form.get("paymentStatementNumber") !== statement.document_number)) throw new Error("收付款必须关联本单已确认对账单，方向、往来单位和币种须一致");
    const access = await loadSettlementWorkbenchActionAccess(db, { actor, action: "allocate_cash", source: { kind: "reconciliation_id", id }, legacyFallback: "deny" });
    if (!access.canWrite) throw new Error(access.reason ?? "本单收付款办理尚未开放");
    await assertMeetingSignoffsComplete(db, actor.organizationId, [orderId], statement.direction === "receivable" ? "receivable" : "payable", statement.direction === "payable");
  }
}

export async function loadOrderFinancialWorkspace(db: D1Database, actor: SessionUser, orderId: string, params: URLSearchParams) {
  if (!canAccessSettlementWorkbench(actor.permissions)) return null;
  await assertOrderScope(db, actor, orderId);
  const state = await loadMeetingSettlement(db, actor.organizationId, orderId);
  const directions = await loadMeetingSettlementDirections(db, actor.organizationId, orderId, state, actor);
  const handoff = await loadSettlementHandoff(db, state, actor, directions);
  const canLedger = actor.permissions.includes("billing.manage");
  const fallback: OrderFinancialTab = handoff.canCash ? "cash" : handoff.phase === "signatures" ? "ledger" : "statements";
  const requested = params.get("financeTab") as OrderFinancialTab;
  let tab: OrderFinancialTab = ["ledger", "statements", "cash", "invoices", "offline"].includes(requested) ? requested : fallback;
  if (tab === "ledger" && !canLedger) tab = "cash";
  const query = { orderId, page: Number(params.get("financePage")) || 1, pageSize: 10, query: "", direction: "", currency: "", status: "" };
  const expenses = await loadEligibleExpensePage(db, actor, query);
  const statements = await loadReconciliationPage(db, actor, query);
  const cash = handoff.canCash ? await loadAvailableCashTransactions(db, actor, statements.items.filter(row => row.status === "confirmed")) : [];
  // Everything below only reads. Share facts for row controls, never with
  // assertOrderFinancialSubmission or the actual money mutations.
  const readAccess = createSettlementAccessReadPhase(db, actor);
  const createAccess: Record<string, SettlementMultiOrderActionAccess> = {};
  const signatureReasons = new Map<string, string | null>();
  const prerequisite = async (direction: "receivable" | "payable", payment = false) => {
    const key = `${direction}:${payment}`;
    if (!signatureReasons.has(key)) {
      try { await assertMeetingSignoffsComplete(db, actor.organizationId, [orderId], direction, payment); signatureReasons.set(key, null); }
      catch (error) { signatureReasons.set(key, error instanceof Error ? error.message : "本单前序费用签核尚未完成"); }
    }
    return signatureReasons.get(key);
  };
  for (const expense of expenses.items) {
    const access = await readAccess({ action: "create_reconciliation", source: { kind: "expense_ids", ids: [expense.id] }, legacyFallback: "deny" });
    const reason = access.canWrite ? await prerequisite(expense.direction) : null;
    createAccess[expense.id] = reason ? { ...access, canWrite: false, reason } : access;
  }
  const statementAccess: Record<string, Record<string, SettlementMultiOrderActionAccess>> = {};
  for (const row of statements.items) {
    const exclusive = await statementIsExclusive(db, actor.organizationId, orderId, row.id);
    statementAccess[row.id] = {};
    for (const action of ["confirm_reconciliation", "record_invoice", "allocate_cash"] as SettlementWorkbenchAction[]) {
      const access = await readAccess({ action, source: { kind: "reconciliation_id", id: row.id } as SettlementAccessSource, legacyFallback: "deny" });
      const reason = access.canWrite ? await prerequisite(row.direction === "receivable" ? "receivable" : "payable", action === "allocate_cash") : null;
      statementAccess[row.id][action] = !exclusive ? { ...access, canWrite: false, reason: "该账单合并了其他订单，本单只展示进度；请按合并账单统一办理" } : reason ? { ...access, canWrite: false, reason } : access;
    }
  }
  const offline = await db.prepare("SELECT approver_name,approved_at,evidence_reference FROM order_payable_offline_approvals WHERE organization_id=? AND order_id=?").bind(actor.organizationId, orderId).first<{ approver_name: string; approved_at: string; evidence_reference: string }>();
  return { tab, sessionSlot: params.get("itmsTab"), canLedger, canRecordCash: handoff.canCash && hasFullSettlementScope(actor), handoff, expenses, statements, cash, createAccess, statementAccess, offline, organizationName: actor.organizationName, currentUserId: actor.userId, currentUserName: actor.displayName };
}
