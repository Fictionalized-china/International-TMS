import { feeLineAmount } from "./intake-fee-lines";
import { nonNegativeNumberPresent } from "./validation";

const text = (value: unknown) => typeof value === "string" && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);
const positive = (value: unknown) => nonNegativeNumberPresent(value) && Number(value) > 0;
const money = (value: unknown) => nonNegativeNumberPresent(value) && Number(value) <= Number.MAX_SAFE_INTEGER / 100;
const cents = (value: number) => Math.round(feeLineAmount(1, value) * 100);

/** Current ledger rows only; zero is explicit data, null/blank is not zero. */
export function intakeExpenseProblems(row: Record<string, unknown>) {
  const problems: Array<{ field: string; label: string }> = [];
  const check = (field: string, label: string, valid: unknown) => { if (!valid) problems.push({ field, label }); };
  check("direction", "应收/应付方向", ["receivable", "payable"].includes(String(row.direction)));
  check("charge_code", "费用类别", text(row.charge_code));
  check("charge_name", "费用名称", text(row.charge_name));
  check("counterparty_name", "往来单位", text(row.counterparty_name));
  check("currency", "币种（三位字母）", typeof row.currency === "string" && /^[A-Za-z]{3}$/.test(row.currency));
  check("quantity", "数量", positive(row.quantity));
  check("unit_price", "单价", money(row.unit_price));
  check("amount", "金额", money(row.amount));
  check("exchange_rate", "汇率", positive(row.exchange_rate));
  check("base_amount", "折算金额", money(row.base_amount));
  if (positive(row.quantity) && money(row.unit_price) && money(row.amount)) {
    const calculated = feeLineAmount(Number(row.quantity), Number(row.unit_price));
    check("amount_calculation", "金额与数量×单价不符或超出安全范围", money(calculated) && cents(calculated) === cents(Number(row.amount)));
  }
  if (money(row.amount) && positive(row.exchange_rate) && money(row.base_amount)) {
    const converted = Number(row.amount) * Number(row.exchange_rate);
    check("base_amount_calculation", "折算金额与金额×汇率不符或超出安全范围", money(converted) && cents(converted) === cents(Number(row.base_amount)));
  }
  return problems;
}
