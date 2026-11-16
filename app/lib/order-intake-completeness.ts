import type { BusinessProcessPolicy } from "./business-process-policy";
import { intakeOperationFields, intakeOperationFieldKey, readIntakeOperations } from "./intake-operations";
import { intakeRouteFields } from "./intake-route-fields";
import { cargoNativeFieldKeys, cargoNativeFieldPresent, orderNativeQuotationFacts } from "./order-intake-facts";
import { missingOrderIntakeFees } from "./order-intake-fees";
import { intakeExpenseProblems } from "./order-intake-expense";
import { quotationNativeFieldCatalog, quotationNativeFieldPresent } from "./quotation-native-field-catalog";
import type { OrderModuleCode } from "./order-modules";

// This is a named, reviewable baseline, NOT an implicit activation for old orders.
// Business category/type await their real dictionary; do not substitute FTL/LTL.
export const knownIntakeRuleVersion = "known-red-2026-11-09-v1";
export const currentIntakeRuleVersion = "red-intake-2026-11-16-v2";
export const unresolvedIntakeDefinitions = ["业务大类", "业务类型"] as const;
const baselineKeys = new Set([
  "quotation_salesperson_user_id", "quotation_quote_commercial_user_id",
  "quotation_origin_region", "quotation_destination_region",
  "quotation_cargo_description", "quotation_pieces", "quotation_gross_weight_kg", "quotation_volume_cbm",
  ...intakeRouteFields.map(field => field.fieldKey),
  // Preserve the named v1 baseline. New independent business classifications
  // are required by the explicitly bound v2 contract, not silently by v1.
  ...intakeOperationFields.filter(field => !["businessMajor", "businessKind"].includes(field.key)).map(field => intakeOperationFieldKey(field.key)),
]);
export const knownIntakeRequirements = quotationNativeFieldCatalog.filter(field => baselineKeys.has(field.fieldKey));
export type IntakeCompletenessIssue = {
  key: string; fieldKey: string; label: string; reason: string;
  moduleCode: OrderModuleCode; source: "order" | "cargo" | "expense" | "configuration";
  rowId?: string; rowNumber?: number;
};
export type CurrentOrderIntakeFacts = {
  order: Record<string, unknown>; cargo: Record<string, unknown>[];
  expenses: Record<string, unknown>[]; services: Record<string, unknown>[];
};
const text = (value: unknown) => typeof value === "string" && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);

/** Shared read-only evaluation; callers must separately authorize and bind/guard writes. */
export function evaluateOrderIntakeCompleteness(
  facts: CurrentOrderIntakeFacts, policy: BusinessProcessPolicy,
  additionalRequiredNativeKeys: readonly string[] = [],
) {
  const issues: IntakeCompletenessIssue[] = [];
  const add = (issue: Omit<IntakeCompletenessIssue, "key">) => issues.push({ ...issue, key: `${issue.source}:${issue.fieldKey}:${issue.rowId ?? issue.rowNumber ?? "order"}` });
  const orderFacts = orderNativeQuotationFacts(facts.order, null);
  orderFacts.intake_operations_json = JSON.stringify({ ...readIntakeOperations(facts.order.intake_operations_json), entrustedServices: facts.services.filter(row => row.status !== "cancelled").map(row => row.service_code) });
  for (const [fieldKey, label, present] of [
    ["customer_id", "委托人", text(facts.order.customer_id)],
    ["business_type", "装车方式", ["ftl", "ltl"].includes(String(facts.order.business_type))],
    ["transport_mode", "运输方式", text(facts.order.transport_mode)],
  ] as const) if (!present) add({ fieldKey, label, reason: "缺失或无效", moduleCode: "consignment", source: "order" });
  const required = new Set([...baselineKeys, ...additionalRequiredNativeKeys]);
  // Quote-only notes/expiry are not current-order facts and must not become an
  // uneditable intake hard gate through this projection.
  const unsupported = new Set(["quotation_notes", "quotation_valid_until"]);
  for (const fieldKey of required) {
    const field = quotationNativeFieldCatalog.find(field => field.fieldKey === fieldKey);
    if (!field || unsupported.has(fieldKey)) {
      add({ fieldKey, label: field?.label ?? fieldKey, reason: "该字段不属于当前订单录单资料，请检查规则挂载", moduleCode: "consignment", source: "configuration" });
      continue;
    }
    if (cargoNativeFieldKeys.has(fieldKey)) {
      if (!facts.cargo.length) add({ fieldKey, label: field.label, reason: "尚未登记货物清单", moduleCode: "cargo", source: "cargo" });
      facts.cargo.forEach((row, index) => {
        if (!cargoNativeFieldPresent(fieldKey, [row], facts.order)) add({ fieldKey, label: field.label, reason: "缺失或无效", moduleCode: "cargo", source: "cargo", rowId: typeof row.id === "string" ? row.id : undefined, rowNumber: index + 1 });
      });
    } else if (fieldKey !== "quotation_charge_items" && !quotationNativeFieldPresent(fieldKey, orderFacts)) {
      add({ fieldKey, label: field.label, reason: "缺失或无效", moduleCode: field.moduleCode, source: "order" });
    }
  }
  const expenses = facts.expenses.filter(row => row.stage !== "cancelled");
  const validExpenses = expenses.filter((row, index) => {
    const problems = intakeExpenseProblems(row);
    for (const problem of problems) add({ fieldKey: `expense_${problem.field}`, label: problem.label, reason: `${row.direction === "receivable" ? "应收" : row.direction === "payable" ? "应付" : "费用"}明细缺失或无效`, moduleCode: "costs", source: "expense", rowId: typeof row.id === "string" ? row.id : undefined, rowNumber: index + 1 });
    return !problems.length;
  });
  const missingFees = missingOrderIntakeFees(String(facts.order.business_type), validExpenses.map(row => ({ chargeCode: String(row.charge_code), chargeName: String(row.charge_name), amount: Number(row.amount), direction: row.direction as "receivable" | "payable" })), policy);
  for (const fee of missingFees) add({ fieldKey: `intake_fee_${fee.code}`, label: fee.label, reason: "未登记完整的对应方向费用；明确零值可以，缺明细或非法金额不可以", moduleCode: "costs", source: "expense" });
  if (required.has("quotation_charge_items") && !validExpenses.some(row => row.direction === "receivable") && !missingFees.some(fee => fee.code === "receivable")) add({ fieldKey: "quotation_charge_items", label: "客户应收费用", reason: "未登记完整的应收明细", moduleCode: "costs", source: "expense" });
  const classified=required.has("quotation_intake_businessMajor")&&required.has("quotation_intake_businessKind");
  return { ruleVersion: classified?currentIntakeRuleVersion:knownIntakeRuleVersion, coverage: classified?"confirmed-red-fields" as const:"known-fields-only" as const, unresolvedDefinitions: classified?[]:[...unresolvedIntakeDefinitions], knownFieldsSatisfied: issues.length === 0, issues };
}
