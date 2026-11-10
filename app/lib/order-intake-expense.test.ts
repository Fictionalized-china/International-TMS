import { describe, expect, it } from "vitest";
import { intakeExpenseProblems } from "./order-intake-expense";
import { completeIntakeFacts } from "./order-intake-completeness.test-fixture";
const row = () => completeIntakeFacts().expenses[0];
describe("intake fee row completeness", () => {
  it("accepts explicit zero self-delivery and sub-cent source arithmetic without a false precision alarm", () => {
    expect(intakeExpenseProblems(completeIntakeFacts().expenses[1])).toEqual([]);
    expect(intakeExpenseProblems({ ...row(), quantity: 3, unit_price: 0.1, amount: 0.30000000000000004, base_amount: 0.30000000000000004 })).toEqual([]);
    expect(intakeExpenseProblems({ ...row(), quantity: 1, unit_price: 0.333, amount: 0.333, base_amount: 0.333 })).toEqual([]);
  });
  it.each([
    ["direction", "other"], ["charge_code", " "], ["charge_name", ""], ["counterparty_name", null],
    ["currency", ""], ["currency", "CNY\n"], ["quantity", ""], ["quantity", 0], ["unit_price", null],
    ["unit_price", -1], ["amount", NaN], ["amount", Infinity], ["exchange_rate", ""], ["exchange_rate", 0],
    ["base_amount", null], ["base_amount", Infinity],
  ])("rejects missing/invalid %s=%s instead of treating it as zero", (field, value) => {
    expect(intakeExpenseProblems({ ...row(), [field as string]: value }).some(problem => problem.field === field)).toBe(true);
  });
  it("detects inconsistent money and overflows without rewriting historical ledger rows", () => {
    expect(intakeExpenseProblems({ ...row(), amount: 10 }).map(problem => problem.field)).toContain("amount_calculation");
    expect(intakeExpenseProblems({ ...row(), base_amount: 10 }).map(problem => problem.field)).toContain("base_amount_calculation");
    expect(intakeExpenseProblems({ ...row(), quantity: 1e308, unit_price: 100 }).map(problem => problem.field)).toContain("amount_calculation");
    expect(intakeExpenseProblems({ ...row(), exchange_rate: 1e308 }).map(problem => problem.field)).toContain("base_amount_calculation");
  });
});
