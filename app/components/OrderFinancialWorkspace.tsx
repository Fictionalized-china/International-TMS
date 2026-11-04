import { Form, Link } from "react-router";
import { CashEntryForm, ExpenseSelection, ReconciliationSheet } from "../routes/admin.billing";
import type { loadOrderFinancialWorkspace } from "../lib/order-settlement-workbench.server";
import { settlementExpenseGroupKey } from "../lib/billing-view";
import { SettlementHandoff } from "./SettlementHandoff";
import { orderFinancialHref } from "../lib/order-financial-navigation";

type Data = NonNullable<Awaited<ReturnType<typeof loadOrderFinancialWorkspace>>>;
export function OrderFinancialWorkspace({ data, orderId, orderNumber, actionUrl, busy, ledger }: {
  data: Data; orderId: string; orderNumber: string; actionUrl: string; busy: boolean; ledger: React.ReactNode;
}) {
  const tabs = [["ledger", "费用与签核"], ["statements", "对账办理"], ["cash", "收付款核销"], ["offline", "付款审批记录"], ["invoices", "发票登记"]];
  const currentAction = new URL(actionUrl, "http://local");
  if (data.sessionSlot) currentAction.searchParams.set("itmsTab", data.sessionSlot);
  actionUrl = orderFinancialHref(orderId, data.tab, currentAction.pathname + currentAction.search);
  const groups = new Map<string, typeof data.expenses.items>();
  for (const expense of data.expenses.items) { const key = settlementExpenseGroupKey(expense); groups.set(key, [...(groups.get(key) ?? []), expense]); }
  const rows = data.statements.items;
  const invoiceRows = rows.filter(row => row.status === "confirmed" && data.statementAccess[row.id].record_invoice.visible);
  const canCash = data.handoff.canCash;
  const page = data.tab === "statements" && data.expenses.pageCount >= data.statements.pageCount ? data.expenses : data.statements;
  return <div className="order-financial-workspace" aria-label="本单财务办理">
    <SettlementHandoff data={data.handoff} orderId={orderId} orderNumber={orderNumber} actionUrl={actionUrl} busy={busy}/>
    <nav className="order-financial-tabs" aria-label="本单财务办理页签">{tabs.filter(([key]) => key !== "ledger" || data.canLedger).map(([key, label]) => <Link key={key} className={data.tab === key ? "active" : ""} aria-current={data.tab === key ? "page" : undefined} to={orderFinancialHref(orderId, key, actionUrl)}>{label}</Link>)}</nav>
    {data.tab === "ledger" ? ledger : <section className="billing-workspace-page order-financial-body">
      {data.tab === "statements" && <>
        <h3>本单对账办理</h3><p>审批已完成不等于已收付款。客户应收按配置由客服生成，供应商应付由有权岗位生成；草稿生成后直接在下方确认。</p>
        {[...groups.entries()].map(([key, expenses]) => {
          const first = expenses[0], writable = expenses.filter(item => data.createAccess[item.id]?.canWrite), readonly = expenses.filter(item => !data.createAccess[item.id]?.canWrite);
          return <div key={key}>{writable.length > 0 && <ExpenseSelection direction={first.direction} currency={first.currency} counterparty={first.counterparty_name} expenses={writable} access={data.createAccess[writable[0].id]} busy={busy} formAction={actionUrl}/>}{readonly.length > 0 && <ExpenseSelection direction={first.direction} currency={first.currency} counterparty={first.counterparty_name} expenses={readonly} access={data.createAccess[readonly[0].id]} busy={busy} formAction={actionUrl}/>}</div>;
        })}
        {!data.expenses.total && <p className="empty-state">暂无待生成对账单的已确认费用。已生成的账单见下方；未签核的费用请先完成费用签核。</p>}
        <h3>已生成对账单</h3>{rows.map(row => <ReconciliationSheet key={row.id} row={row} mode="review" access={data.statementAccess[row.id].confirm_reconciliation} busy={busy} formAction={actionUrl}/>)}
        {!rows.length && <p className="empty-state">本单尚未生成对账单。</p>}
      </>}
      {data.tab === "cash" && <>
        <h3>本单收付款与核销</h3><p>先登记实际发生的收付款，再匹配同方向、同往来单位、同币种流水。登记流水后仍需点击“确认核销”，不会自动假定收款完成。</p>
        {!canCash && <p className="alert info">当前账号负责核对或审批，真实收付款登记与核销由出纳岗位办理。</p>}
        {rows.filter(row => row.status === "confirmed").map(row => <div key={row.id}>
          <ReconciliationSheet row={row} mode="cash" access={data.statementAccess[row.id].allocate_cash} cash={data.cash} busy={busy} formAction={actionUrl}/>
          {data.canRecordCash && data.statementAccess[row.id].allocate_cash.canWrite && row.total_amount - row.settled_amount > 0.009 && <CashEntryForm users={[{ id: data.currentUserId, display_name: data.currentUserName }]} organizationName={data.organizationName} busy={busy} formAction={actionUrl} statement={row}/>}
        </div>)}
        {!rows.some(row => row.status === "confirmed") && <p className="empty-state">请先在“对账办理”生成并确认本单对账单，随后出纳可在此登记真实流水并核销。</p>}
      </>}
      {data.tab === "offline" && <>
        <h3>本单线下付款审批记录</h3>
        {data.offline ? <p>已登记：{data.offline.approver_name} · {data.offline.approved_at} · {data.offline.evidence_reference}</p> : data.handoff.canRecordOffline ? <Form method="post" action={actionUrl} className="form-grid"><input type="hidden" name="intent" value="offline"/><input type="hidden" name="orderId" value={orderId}/><label>实际审批人<input name="approver" required/></label><label>实际审批日期<input name="approvedAt" type="date" required/></label><label>凭证 / 记录编号<input name="evidence" required/></label><button className="primary" disabled={busy}>保存本单付款审批记录</button></Form> : <p className="alert info">{data.handoff.offlineRequired ? "按当前策略，由本单财务负责人在应付签核完成后登记真实审批凭证。" : "当前策略不要求线下付款审批记录。"}</p>}
      </>}
      {data.tab === "invoices" && <><h3>本单发票登记</h3>{invoiceRows.map(row => <ReconciliationSheet key={row.id} row={row} mode="invoice" access={data.statementAccess[row.id].record_invoice} busy={busy} formAction={actionUrl}/>)}{!invoiceRows.length && <p className="empty-state">暂无可登记发票的已确认对账单；是否启用及是否必办仍由本单工作流控制。</p>}</>}
      {data.tab !== "offline" && page.pageCount > 1 && <nav className="row-actions" aria-label="本单财务翻页">{page.page > 1 && <Link to={orderFinancialHref(orderId, data.tab, actionUrl, page.page - 1)}>上一页</Link>}<span>第 {page.page} / {page.pageCount} 页</span>{page.page < page.pageCount && <Link to={orderFinancialHref(orderId, data.tab, actionUrl, page.page + 1)}>下一页</Link>}</nav>}
    </section>}
  </div>;
}
