/** Order-local business amounts are not permission to read bank/settlement data. */
export function canReadConsignmentExpenses(input: {
  permissions: readonly string[];
  userId: string;
  salespersonUserId: string | null;
  responsibleUserIds: readonly (string | null | undefined)[];
}) {
  if (!input.permissions.includes("order.view")) return false;
  if (input.permissions.includes("billing.sensitive.view")) return true;
  if (input.permissions.includes("billing.assigned_expense.review") && input.salespersonUserId === input.userId) return true;
  return input.permissions.includes("order.module.costs.manage") && input.responsibleUserIds.includes(input.userId);
}

export type ConsignmentExpense = {
  id: string;
  direction: string;
  charge_name: string;
  charge_code?: string;
  counterparty_name: string | null;
  currency: string;
  quantity: number;
  unit_price: number;
  amount: number;
  exchange_rate: number;
  stage: string;
  notes: string | null;
};

/** Display-only amounts. Never used to write, settle or approve an expense. */
export function consignmentExpenseTotals(expenses: readonly ConsignmentExpense[], direction: string) {
  const rows = expenses.filter(row => row.direction === direction && row.stage !== "cancelled");
  const currencies = new Map<string, number>();
  let baseCents = 0, invalid = false;
  for (const row of rows) {
    const amount = Number(row.amount), rate = Number(row.exchange_rate);
    if (!row.currency?.trim() || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(rate) || rate <= 0) {
      invalid = true;
      continue;
    }
    currencies.set(row.currency, (currencies.get(row.currency) ?? 0) + Math.round(amount * 100));
    baseCents += Math.round(amount * rate * 100);
  }
  return {
    count: rows.length,
    currencyLabel: [...currencies].map(([currency, cents]) => `${currency} ${(cents / 100).toFixed(2)}`).join(" · ") || (rows.length ? "金额待补齐" : "尚未登记"),
    base: invalid ? null : baseCents / 100,
  };
}
