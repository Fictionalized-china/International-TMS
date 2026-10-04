export type SettlementTaskPackRow = {
  id: string;
  order_number: string;
  customer_name: string;
  business_type: "ftl" | "ltl";
  status: string;
  current_step_name: string | null;
  completion_status: string;
  expense_count: number;
  receivable_count: number;
  payable_count: number;
  expense_amount: number;
  receivable_confirmed: number | null;
  payable_confirmed: number | null;
  receivable_business_reviewed: number | null;
  payable_business_reviewed: number | null;
  receivable_finance_reviewed: number | null;
  payable_finance_reviewed: number | null;
  reconciliation_count: number;
  reconciliation_draft_count: number;
  reconciliation_confirmed_count: number;
  invoiced_amount: number;
  settled_amount: number;
  billing_document_count: number;
  payment_receipt_count: number;
  review_snapshot_count: number;
  review_conclusion: string | null;
  updated_at: string;
  required_signoff_fields?:readonly string[];
};

export type SettlementTaskAction = {
  label: string;
  href: string;
  waiting: boolean;
};

export function settlementDirectionSignoffComplete(
  row: SettlementTaskPackRow,
  kind: "confirmed" | "business_reviewed" | "finance_reviewed",
) {
  const key={confirmed:"customer_service_confirmation",business_reviewed:"business_review",finance_reviewed:"finance_review"}[kind];
  if(row.required_signoff_fields && !row.required_signoff_fields.includes(key)) return true;
  const receivable = row.receivable_count === 0 || row[`receivable_${kind}`] === 1;
  const payable = row.payable_count === 0 || row[`payable_${kind}`] === 1;
  return receivable && payable;
}

function orderModuleHref(row: SettlementTaskPackRow, section: "expenses" | "files" | null, stage = "reconciliation", module = "costs") {
  const params = new URLSearchParams({ stage, module });
  if (section) params.set("section", section);
  return `/admin/orders/${encodeURIComponent(row.id)}?${params.toString()}`;
}

function billingHref(tab: "pending" | "reconciliations" | "cash" | "invoices", row: SettlementTaskPackRow) {
  return `/admin/billing?tab=${tab}&q=${encodeURIComponent(row.order_number)}`;
}

export function settlementTaskNextAction(
  row: SettlementTaskPackRow,
  positionCode: string | null | undefined,
): SettlementTaskAction {
  const required=(key:string)=>!row.required_signoff_fields||row.required_signoff_fields.includes(key);
  const receivableCustomerServiceDone = !required("customer_service_confirmation")||row.receivable_count === 0 || row.receivable_confirmed === 1;
  const receivableOperationDone = !required("business_review")||row.receivable_count === 0 || row.receivable_business_reviewed === 1;
  const receivableSupervisorDone = !required("finance_review")||row.receivable_count === 0 || row.receivable_finance_reviewed === 1;
  const payableApplicationDone = !required("customer_service_confirmation")||row.payable_count === 0 || row.payable_confirmed === 1;
  const payableSupervisorDone = !required("business_review")||row.payable_count === 0 || row.payable_business_reviewed === 1;
  const payableFinanceDone = !required("finance_review")||row.payable_count === 0 || row.payable_finance_reviewed === 1;
  const signoffsDone = receivableCustomerServiceDone && receivableOperationDone &&
    receivableSupervisorDone && payableApplicationDone && payableSupervisorDone && payableFinanceDone;

  if (positionCode === "CASHIER") {
    if (row.reconciliation_confirmed_count > 0 && row.settled_amount + 0.009 < row.expense_amount) {
      return { label: "登记流水并核销", href: billingHref("cash", row), waiting: false };
    }
    return { label: "等待已确认对账单", href: orderModuleHref(row, "expenses"), waiting: true };
  }

  if (positionCode === "CS" && !receivableCustomerServiceDone) {
    return { label: "客服确认应收", href: orderModuleHref(row, "expenses"), waiting: false };
  }
  if (positionCode === "OPERATION" && (!receivableOperationDone || !payableApplicationDone)) {
    return { label: "复核应收 / 发起应付", href: orderModuleHref(row, "expenses"), waiting: false };
  }
  if (positionCode === "OPERATION_SUPERVISOR" && (!receivableSupervisorDone || !payableSupervisorDone)) {
    return { label: "主管审批费用", href: orderModuleHref(row, "expenses"), waiting: false };
  }
  if (positionCode === "FINANCE_ACCOUNTING" && !payableFinanceDone) {
    return { label: "财务审批应付", href: orderModuleHref(row, "expenses"), waiting: false };
  }
  if (!signoffsDone) {
    return { label: "查看应收应付审批进度", href: orderModuleHref(row, "expenses"), waiting: true };
  }
  if (row.reconciliation_count === 0) {
    return positionCode === "CS"
      ? { label: "生成对账单", href: billingHref("pending", row), waiting: false }
      : { label: "等待客服生成对账单", href: orderModuleHref(row, "expenses"), waiting: true };
  }
  if (row.reconciliation_draft_count > 0 || row.reconciliation_confirmed_count === 0) {
    return { label: "确认对账单", href: billingHref("reconciliations", row), waiting: false };
  }
  if (row.invoiced_amount + 0.009 < row.expense_amount) {
    return { label: "登记发票", href: billingHref("invoices", row), waiting: false };
  }
  if (row.settled_amount + 0.009 < row.expense_amount) {
    return {
      label: positionCode === "FINANCE_ACCOUNTING" ? "等待出纳核销" : "办理收付款核销",
      href: billingHref("cash", row),
      waiting: positionCode === "FINANCE_ACCOUNTING",
    };
  }
  if (!row.billing_document_count || !row.payment_receipt_count) {
    return { label: "归集账单与凭证", href: orderModuleHref(row, "files"), waiting: false };
  }
  if (!row.review_conclusion) {
    return { label: "完成复盘", href: orderModuleHref(row, null, "completion_review", "review"), waiting: false };
  }
  return { label: "查看已完成结算", href: orderModuleHref(row, null, "completion_review", "review"), waiting: true };
}
