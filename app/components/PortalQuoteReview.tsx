import { ConfirmAction } from "./ConfirmAction";
import { Modal } from "./Modal";
import { PortalForm as Form } from "./PortalNavigation";
import {
  activeQuotationCustomWorkflowFields,
  quotationWorkflowDisplayValue,
  quotationWorkflowFieldPolicy,
  type QuotationWorkflowField,
  type QuotationWorkflowFieldValue,
} from "../lib/quotation-workflow-fields";
import type { QuotationNativeFieldKey } from "../lib/quotation-native-field-catalog";

export type PortalQuote = {
  id: string;
  quote_number: string;
  customer_name: string;
  customer_contact_name: string | null;
  customer_contact_phone: string | null;
  salesperson_name: string | null;
  workflow_definition_id: string | null;
  workflow_name: string | null;
  workflow_version_number: number | null;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  pickup_address: string | null;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  destination_warehouse_name: string | null;
  destination_warehouse_note: string | null;
  customs_clearance_mode: "company" | "customer";
  road_load_type: "ftl" | "ltl";
  cargo_description: string;
  pieces: number;
  declared_quantity_unit: string;
  planned_package_count: number;
  planned_package_type: string;
  gross_weight_kg: number;
  volume_cbm: number;
  estimated_length_cm: number;
  estimated_width_cm: number;
  estimated_height_cm: number;
  total_amount: number;
  valid_until: string | null;
  notes: string | null;
  lifecycle_status: "pending" | "accepted" | "withdrawn" | "void";
  order_id: string | null;
  order_number: string | null;
  order_status: string | null;
  current_step_code: string | null;
  created_at: string;
};

export type PortalQuoteCharge = {
  quotation_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  sort_order: number;
};

export function PortalQuoteReviewModal({
  quote,
  charges,
  fields,
  values,
  busy,
  closeSignal,
}: {
  quote: PortalQuote;
  charges: PortalQuoteCharge[];
  fields: QuotationWorkflowField[];
  values: QuotationWorkflowFieldValue[];
  busy: boolean;
  closeSignal?: unknown;
}) {
  const canAccept = quote.lifecycle_status === "pending" || quote.lifecycle_status === "withdrawn";
  const visible = (key: QuotationNativeFieldKey, fallback: "required" | "optional") =>
    quotationWorkflowFieldPolicy(fields, key, fallback).isActive;
  const route = [quote.origin_country, quote.origin_state, quote.origin_city].filter(Boolean).join(" ") +
    " → " + [quote.destination_country, quote.destination_state, quote.destination_city].filter(Boolean).join(" ");
  const dimensions = [quote.estimated_length_cm, quote.estimated_width_cm, quote.estimated_height_cm].join(" × ");
  const customFacts = activeQuotationCustomWorkflowFields(fields).map((field) => ({
    id: field.id,
    label: field.label,
    value: quotationWorkflowDisplayValue(
      field,
      values.find((value) => value.field_id === field.id || value.field_key === field.field_key) || null,
    ),
  }));

  return <Modal
    title={quote.order_number ? `报价详情 · ${quote.order_number}` : "报价详情"}
    triggerLabel={canAccept ? "查看信息" : "查看详情"}
    triggerClassName={canAccept ? "btn primary" : "btn"}
    size="wide"
    dialogClassName="quote-review-modal"
    closeSignal={closeSignal}
  >
    <div className="quote-review-sheet">
      <header className="quote-review-hero">
        <div><span>{quote.road_load_type === "ltl" ? "拼车运输报价" : "整车运输报价"}</span><strong>{route}</strong><small>{quote.workflow_name ? `${quote.workflow_name} · v${quote.workflow_version_number}` : "历史报价"}</small></div>
        <div><span>报价总额</span><strong>CNY {quote.total_amount.toLocaleString()}</strong><small>{quote.valid_until ? `有效期至 ${quote.valid_until}` : "未设置有效期"}</small></div>
      </header>
      <div className="quote-review-sections">
        <section><h3>客户与服务</h3><div className="quote-review-facts">
          <QuoteReviewCell label="客户" value={quote.customer_name}/>
          {visible("quotation_salesperson_user_id", "required") && <QuoteReviewCell label="业务员" value={quote.salesperson_name || "—"}/>} 
          {visible("quotation_customer_contact_name", "required") && <QuoteReviewCell label="联系人" value={quote.customer_contact_name || "—"}/>} 
          {visible("quotation_customer_contact_phone", "required") && <QuoteReviewCell label="联系电话" value={quote.customer_contact_phone || "—"}/>} 
          {visible("quotation_customs_clearance_mode", "required") && <QuoteReviewCell label="清关责任" value={quote.customs_clearance_mode === "company" ? "公司代办清关" : "客户自理清关"}/>} 
        </div></section>
        <section><h3>运输路线</h3><div className="quote-review-facts">
          <QuoteReviewCell label="起运地区" value={[quote.origin_country, quote.origin_state, quote.origin_city].filter(Boolean).join(" ")}/>
          {visible("quotation_pickup_address", "required") && <QuoteReviewCell label="提货地址" value={quote.pickup_address || "—"}/>} 
          <QuoteReviewCell label="目的地区" value={[quote.destination_country, quote.destination_state, quote.destination_city].filter(Boolean).join(" ")}/>
          {visible("quotation_destination_warehouse_id", "required") && <QuoteReviewCell label="目的仓" value={quote.destination_warehouse_name || "—"}/>} 
          {visible("quotation_destination_warehouse_note", "optional") && <QuoteReviewCell label="目的仓备注" value={quote.destination_warehouse_note || "—"}/>} 
        </div></section>
        <section><h3>货物概况</h3><div className="quote-review-facts">
          {visible("quotation_cargo_description", "required") && <QuoteReviewCell label="货物" value={quote.cargo_description || "—"}/>} 
          {visible("quotation_pieces", "required") && <QuoteReviewCell label="商品数量" value={`${quote.pieces} ${quote.declared_quantity_unit || "件"}`}/>} 
          {visible("quotation_planned_package_count", "required") && <QuoteReviewCell label="预计入仓包装" value={`${quote.planned_package_count || 1} 包`}/>} 
          {visible("quotation_planned_package_type", "required") && <QuoteReviewCell label="预计包装类型" value={quote.planned_package_type || "other"}/>} 
          {visible("quotation_gross_weight_kg", "required") && <QuoteReviewCell label="预计重量" value={`${quote.gross_weight_kg} KG`}/>} 
          {visible("quotation_volume_cbm", "required") && <QuoteReviewCell label="预计体积" value={`${quote.volume_cbm} CBM`}/>} 
          {(visible("quotation_length_cm", "required") || visible("quotation_width_cm", "required") || visible("quotation_height_cm", "required")) && <QuoteReviewCell label="预计尺寸" value={`${dimensions} CM`}/>} 
          {visible("quotation_notes", "optional") && <QuoteReviewCell label="报价备注" value={quote.notes || "—"}/>} 
        </div></section>
        <section><h3>费用明细</h3>{charges.length ? <div className="table-wrap"><table className="quote-review-charges"><thead><tr><th>费用名称</th><th>数量</th><th>单价</th><th>金额</th></tr></thead><tbody>{charges.map((charge) => <tr key={`${charge.sort_order}-${charge.description}`}><td>{charge.description}</td><td>{charge.quantity}</td><td>{charge.unit_price.toLocaleString()}</td><td><strong>{charge.amount.toLocaleString()}</strong></td></tr>)}</tbody><tfoot><tr><td colSpan={3}>合计</td><td><strong>CNY {quote.total_amount.toLocaleString()}</strong></td></tr></tfoot></table></div> : <p className="empty-state">当前报价没有费用明细。</p>}</section>
        {customFacts.length > 0 && <section className="span-2"><h3>其他报价信息</h3><div className="quote-review-facts">{customFacts.map((fact) => <QuoteReviewCell key={fact.id} label={fact.label} value={fact.value}/>)}</div></section>}
      </div>
      <footer className="quote-review-actions">
        <div><strong>{canAccept ? "请核对运输条件与费用" : quotationStatusLabel(quote.lifecycle_status)}</strong><span>{canAccept ? "确认后系统将生成唯一运输订单，并进入委托资料补充。" : quote.order_number ? `已生成订单 ${quote.order_number}` : "报价信息仅供查看。"}</span></div>
        {canAccept && <Form method="post"><input type="hidden" name="intent" value="accept_quote"/><input type="hidden" name="id" value={quote.id}/><button className="btn primary" disabled={busy}>{quote.lifecycle_status === "withdrawn" ? "确认重新接受报价" : "确认报价"}</button></Form>}
        {quote.lifecycle_status === "accepted" && quote.order_status === "draft" && <Form method="post"><input type="hidden" name="intent" value="withdraw_quote"/><input type="hidden" name="id" value={quote.id}/><ConfirmAction className="btn" title="撤回报价接受" description="撤回后该报价将恢复为可重新接受状态；已经生成的订单保留为草稿并留下审计记录。" triggerLabel="撤回接受" confirmLabel="确认撤回" pending={busy}/></Form>}
      </footer>
    </div>
  </Modal>;
}

function QuoteReviewCell({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value || "—"}</strong></div>;
}

export function quotationStatusLabel(status: PortalQuote["lifecycle_status"]) {
  return { pending: "待确认", accepted: "已接受", withdrawn: "接受已撤回", void: "已作废" }[status];
}

export function quotationStatusTone(status: PortalQuote["lifecycle_status"]) {
  if (status === "accepted") return "green";
  if (status === "pending") return "orange";
  if (status === "void") return "red";
  return "blue";
}
