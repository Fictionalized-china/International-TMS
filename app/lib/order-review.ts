export type OrderCompletionStatus =
  | "in_progress"
  | "business_complete_unsettled"
  | "completed_settled";

export type CurrencyFinance = {
  currency: string;
  receivable: number;
  payable: number;
  received: number;
  paid: number;
  margin: number;
  marginRate: number | null;
  receivableBalance: number;
  payableBalance: number;
};

export type CompletionInput = {
  pickupComplete: boolean;
  pickupRequired?: boolean;
  blockers: string[];
  reviewGenerated: boolean;
  finance: CurrencyFinance[];
};

export type ReviewSettlementWorkflowField = {
  fieldKey: string;
  label?: string | null;
  isActive: boolean;
  isRequired: boolean;
};

export type ReviewSettlementDirectionControl = {
  direction: "receivable" | "payable";
  confirmed: boolean;
  businessReviewed: boolean;
  financeReviewed: boolean;
};

export type OrderReviewSettlementBlocker = {
  code: string;
  message: string;
  area: "costs" | "billing";
};

export type CostsModuleReviewState = {
  enabled: boolean;
  isRequired: boolean;
  status: string;
  blockingReason: string | null;
};

export type PickupReviewState = {
  module: Pick<CostsModuleReviewState, "enabled" | "isRequired"> | null;
  fields: readonly ReviewSettlementWorkflowField[];
  pickupComplete: boolean;
};

export function configuredModuleRequiresCompletion(
  state: Pick<CostsModuleReviewState, "enabled" | "isRequired"> | null,
) {
  return state ? state.enabled && state.isRequired : true;
}

export function orderReviewModuleState(
  completionStatus: OrderCompletionStatus,
  blockerMessages: readonly string[],
) {
  const blocked = completionStatus === "in_progress";
  return {
    status: blocked ? "blocked" as const : "completed" as const,
    stepCode: blocked ? "reviewing" : "confirmed",
    stepName: blocked ? "复盘中" : "复盘确认",
    progressPercent: blocked ? 67 : 100,
    blockingReason: blocked ? blockerMessages.join("；") || null : null,
    completed: !blocked,
  };
}

export function costsModuleReviewBlocker(
  state: CostsModuleReviewState | null,
): OrderReviewSettlementBlocker | null {
  if (!state || !configuredModuleRequiresCompletion(state) || state.status === "completed")
    return null;
  return {
    code: "costs_workflow_gate",
    message:
      state.blockingReason?.trim() ||
      "费用结算仍有当前工作流配置的必填项未完成",
    area: "costs",
  };
}

export function pickupCompletionReviewBlocker(
  state: PickupReviewState,
): OrderReviewSettlementBlocker | null {
  if (!pickupCompletionRequired(state) || state.pickupComplete) return null;
  return {
    code: "pickup",
    message: "客户自提/签收尚未完成",
    area: "costs",
  };
}

export function pickupCompletionRequired(state: PickupReviewState) {
  const moduleRequired = configuredModuleRequiresCompletion(state.module);
  const configuredField = state.fields.find(
    (field) => field.fieldKey === "pickup_completed_at",
  );
  const fieldRequired = configuredField
    ? configuredField.isActive && configuredField.isRequired
    : state.fields.length === 0;
  return moduleRequired && fieldRequired;
}

type ReviewSettlementFieldKey =
  | "receivable_expenses"
  | "payable_expenses"
  | "customer_service_confirmation"
  | "business_review"
  | "finance_review"
  | "cash_records"
  | "writeoff_records";

const reviewSettlementFieldLabels: Record<ReviewSettlementFieldKey, string> = {
  receivable_expenses: "应收费用",
  payable_expenses: "应付费用",
  customer_service_confirmation: "客服费用确认",
  business_review: "业务审核",
  finance_review: "财务审核",
  cash_records: "收付款流水",
  writeoff_records: "核销记录",
};

function requiredReviewSettlementField(
  fields: readonly ReviewSettlementWorkflowField[],
  fieldKey: ReviewSettlementFieldKey,
) {
  const configured = fields.find((field) => field.fieldKey === fieldKey);
  const legacyFallback = fields.length === 0;
  return {
    required: configured
      ? configured.isActive && configured.isRequired
      : legacyFallback,
    label:
      configured?.label?.trim() || reviewSettlementFieldLabels[fieldKey],
  };
}

export function orderReviewSettlementBlockers(input: {
  fields: readonly ReviewSettlementWorkflowField[];
  hasReceivable: boolean;
  hasPayable: boolean;
  controls: readonly ReviewSettlementDirectionControl[];
  finance: readonly CurrencyFinance[];
}): OrderReviewSettlementBlocker[] {
  const blockers: OrderReviewSettlementBlocker[] = [];
  const receivablePolicy = requiredReviewSettlementField(
    input.fields,
    "receivable_expenses",
  );
  const payablePolicy = requiredReviewSettlementField(
    input.fields,
    "payable_expenses",
  );
  if (receivablePolicy.required && !input.hasReceivable) {
    blockers.push({
      code: "receivable_missing",
      message: `尚未录入${receivablePolicy.label}`,
      area: "costs",
    });
  }
  if (payablePolicy.required && !input.hasPayable) {
    blockers.push({
      code: "payable_missing",
      message: `尚未录入${payablePolicy.label}`,
      area: "costs",
    });
  }

  const signoffPolicies = [
    {
      fieldKey: "customer_service_confirmation" as const,
      completedKey: "confirmed" as const,
    },
    {
      fieldKey: "business_review" as const,
      completedKey: "businessReviewed" as const,
    },
    {
      fieldKey: "finance_review" as const,
      completedKey: "financeReviewed" as const,
    },
  ].map((item) => ({
    ...item,
    ...requiredReviewSettlementField(input.fields, item.fieldKey),
  }));
  for (const direction of ["receivable", "payable"] as const) {
    const hasExpenses =
      direction === "receivable" ? input.hasReceivable : input.hasPayable;
    if (!hasExpenses) continue;
    const directionControl = input.controls.find(
      (control) => control.direction === direction,
    );
    const missingSignoffs = signoffPolicies
      .filter(
        (policy) =>
          policy.required && !directionControl?.[policy.completedKey],
      )
      .map((policy) => policy.label);
    if (missingSignoffs.length) {
      blockers.push({
        code: `${direction}_signoffs_pending`,
        message: `${direction === "receivable" ? "应收" : "应付"}费用尚缺：${missingSignoffs.join("、")}`,
        area: "costs",
      });
    }
  }

  const requiredBalancePolicies = (
    ["cash_records", "writeoff_records"] as const
  )
    .map((fieldKey) => requiredReviewSettlementField(input.fields, fieldKey))
    .filter((policy) => policy.required);
  if (requiredBalancePolicies.length) {
    const requiredBalanceLabels = requiredBalancePolicies
      .map((policy) => policy.label)
      .join("、");
    for (const line of input.finance) {
      if (line.receivableBalance > 0.009) {
        blockers.push({
          code: `receivable_balance_${line.currency}`,
          message: `${line.currency} 应收尚有 ${line.receivableBalance.toFixed(2)} 未收款或未核销；必办：${requiredBalanceLabels}`,
          area: "billing",
        });
      }
      if (line.payableBalance > 0.009) {
        blockers.push({
          code: `payable_balance_${line.currency}`,
          message: `${line.currency} 应付尚有 ${line.payableBalance.toFixed(2)} 未付款或未核销；必办：${requiredBalanceLabels}`,
          area: "billing",
        });
      }
    }
  }
  return blockers;
}

export const completionStatusLabels: Record<OrderCompletionStatus, string> = {
  in_progress: "业务办理中",
  business_complete_unsettled: "业务完成，结算未闭环",
  completed_settled: "已完成并结清",
};

export function currencyFinance(input: {
  currency: string;
  receivable: number;
  payable: number;
  received: number;
  paid: number;
}): CurrencyFinance {
  const receivable = money(input.receivable);
  const payable = money(input.payable);
  const received = money(input.received);
  const paid = money(input.paid);
  const margin = money(receivable - payable);
  return {
    currency: input.currency.toUpperCase(),
    receivable,
    payable,
    received,
    paid,
    margin,
    marginRate: receivable > 0 ? round((margin / receivable) * 100, 2) : null,
    receivableBalance: money(Math.max(0, receivable - received)),
    payableBalance: money(Math.max(0, payable - paid)),
  };
}

export function orderCompletionStatus(input: CompletionInput): OrderCompletionStatus {
  if (
    ((input.pickupRequired ?? true) && !input.pickupComplete) ||
    input.blockers.length ||
    !input.reviewGenerated
  )
    return "in_progress";
  const unsettled = input.finance.some(
    (line) => line.receivableBalance > 0.009 || line.payableBalance > 0.009,
  );
  return unsettled ? "business_complete_unsettled" : "completed_settled";
}

function money(value: number) {
  return round(value, 2);
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
