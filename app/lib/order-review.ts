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
  blockers: string[];
  reviewGenerated: boolean;
  finance: CurrencyFinance[];
};

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
  if (!input.pickupComplete || input.blockers.length || !input.reviewGenerated)
    return "in_progress";
  const unsettled = input.finance.some(
    (line) => line.receivableBalance > 0.009 || line.payableBalance > 0.009,
  );
  return unsettled ? "in_progress" : "completed_settled";
}

function money(value: number) {
  return round(value, 2);
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
