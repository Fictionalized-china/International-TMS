import { Form, Link } from "react-router";
import type { loadSettlementHandoff } from "../lib/financial-closure.server";

export function SettlementHandoff({ data, orderId, orderNumber, actionUrl, busy }: {
  data: Awaited<ReturnType<typeof loadSettlementHandoff>> | null;
  orderId: string; orderNumber: string; actionUrl?: string; busy: boolean;
}) {
  if (!data) return null;
  const query = encodeURIComponent(orderNumber);
  return <section className="alert info settlement-handoff" aria-label="财务办理下一步">
    <strong>{data.archived ? "已完成并结清" : "财务闭环办理路径"}</strong>
    <p>① 本单各岗核对账单并签核 → ② 客服 / 财务生成并确认对账单 → ③ 出纳登记真实收付款并核销 → ④ 财务最终复盘归档</p>
    {!data.archived && <p>当前待办：{data.phase === "signatures" ? "请先由本单配置责任人完成费用签核" : data.phase === "statements" ? "客服 / 财务生成并确认对账单" : data.phase === "cash" ? "出纳登记真实收付款并核销；资金未发生时继续保留待办" : "财务生成最终复盘并明确确认归档"}。</p>}
    {data.configurationIssue && <p role="alert">{data.configurationIssue}</p>}
    {!data.archived && data.offlineRequired && !data.offlineRecorded && <p>本单付款策略要求财务先登记真实线下审批凭证；未登记前不能支付供应商款。</p>}
    <div className="row-actions">
      {!data.archived && data.canStatements && <><Link className="secondary" to={`/admin/billing?tab=pending&q=${query}${data.statementDirection ? `&direction=${data.statementDirection}` : ""}`}>生成对账单</Link><Link className="secondary" to={`/admin/billing?tab=reconciliations&q=${query}`}>确认对账单</Link></>}
      {!data.archived && data.canCash && <Link className="secondary" to={`/admin/billing?tab=cash&q=${query}`}>出纳 · 收付款核销</Link>}
      {!data.archived && data.canReview && <Link className="secondary" to={`/admin/orders/${orderId}?stage=completion_review&module=review`}>财务 · 最终复盘归档</Link>}
      {!data.archived && data.offlineRequired && !data.offlineRecorded && data.canRecordOffline && <Link className="secondary" to={`/admin/settlement-approvals?q=${query}`}>财务 · 登记付款审批凭证</Link>}
    </div>
    {data.canRecover && <details><summary>本单曾提前业务归档：恢复财务待结算</summary><p>保留运输结果、费用、已签核及原复盘记录，只重新开放结算与最终复盘。</p>
      <Form method="post" action={actionUrl}><input type="hidden" name="intent" value="settlement_reopen"/><input type="hidden" name="orderId" value={orderId}/><label><input type="checkbox" name="confirmed" value="1" required/>确认恢复本单财务办理，不代签或生成资金流水</label><button className="secondary" disabled={busy}>恢复财务待结算</button></Form></details>}
  </section>;
}
