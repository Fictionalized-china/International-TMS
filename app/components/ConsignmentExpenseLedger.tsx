import { consignmentExpenseTotals, type ConsignmentExpense } from "../lib/consignment-expenses";

const stages: Record<string, string> = { estimated: "预估", confirmed: "已确认", reconciled: "已对账", invoiced: "已开票/收票", settled: "已结算", cancelled: "已取消（不计合计）" };
export function ConsignmentExpenseLedger({ expenses, canRead, canReadMargin }: {
  expenses: readonly ConsignmentExpense[];
  canRead: boolean;
  canReadMargin: boolean;
}) {
  if (!canRead) return <section className="approval-section" aria-label="当前订单费用"><header><strong>当前订单费用</strong></header><p className="alert">当前账号没有本单费用查看权限；请由有权限的本单责任人核对，不以隐藏金额代替审核。</p></section>;
  const receivable = consignmentExpenseTotals(expenses, "receivable"), payable = consignmentExpenseTotals(expenses, "payable");
  return <section className="approval-section consignment-current-expenses" aria-label="当前订单费用">
    <header><strong>当前订单费用</strong><span>直接引用本单应收应付；来源报价不重复计入，取消项不计合计。</span></header>
    <div className="approval-facts approval-expense-summary">
      <div className="info-cell"><span>应收 · {receivable.count} 笔</span><strong>{receivable.currencyLabel}</strong><small>折算 CNY {receivable.base?.toFixed(2) ?? "待补齐金额/汇率"}</small></div>
      <div className="info-cell"><span>应付 · {payable.count} 笔</span><strong>{payable.currencyLabel}</strong><small>折算 CNY {payable.base?.toFixed(2) ?? "待补齐金额/汇率"}</small></div>
      {canReadMargin && <div className="info-cell"><span>预计收支差额 · CNY</span><strong>{receivable.base !== null && payable.base !== null ? (receivable.base - payable.base).toFixed(2) : "待补齐金额/汇率"}</strong><small>含预估，非实际收款或正式毛利。</small></div>}
    </div>
    {(["receivable", "payable"] as const).map(direction => {
      const rows = expenses.filter(row => row.direction === direction), title = direction === "receivable" ? "应收" : "应付";
      return <div key={direction} className="consignment-form-group">
        <h4>{title}费用明细</h4>
        <div className="table-wrap consignment-current-expense-table" role="region" aria-label={`${title}费用明细，可左右滚动`} tabIndex={0}>
          <table><thead><tr><th>费用名称</th><th>往来单位</th><th>币种</th><th>数量</th><th>单价</th><th>金额</th><th>汇率</th><th>状态</th><th>备注</th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.id}><td><strong>{row.charge_name}</strong>{row.charge_code && <small>{row.charge_code}</small>}</td><td>{row.counterparty_name || "待补齐"}</td><td>{row.currency}</td><td>{row.quantity}</td><td>{Number(row.unit_price).toLocaleString("zh-CN", { maximumFractionDigits: 8 })}</td><td><strong>{Number(row.amount).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td><td>{row.exchange_rate}</td><td>{stages[row.stage] || row.stage}</td><td>{row.notes || "—"}</td></tr>)}
              {!rows.length && <tr><td colSpan={9} className="empty-state">尚未登记{title}费用，请由本单业务或操作责任人补录。</td></tr>}
            </tbody></table>
        </div>
      </div>;
    })}
  </section>;
}
