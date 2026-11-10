import { describe, expect, it } from "vitest";
import { defaultBusinessProcessPolicy } from "./business-process-policy";
import { intakeOperationFields, intakeOperationFieldKey } from "./intake-operations";
import { intakeRouteFields } from "./intake-route-fields";
import { evaluateOrderIntakeCompleteness, knownIntakeRequirements } from "./order-intake-completeness";
import { completeIntakeFacts } from "./order-intake-completeness.test-fixture";
const evaluate = (facts = completeIntakeFacts()) => evaluateOrderIntakeCompleteness(facts, defaultBusinessProcessPolicy);
const nativeColumns: Record<string, string> = { quotation_salesperson_user_id: "salesperson_user_id", quotation_quote_commercial_user_id: "quote_commercial_user_id", quotation_origin_region: "origin_city", quotation_destination_region: "destination_city" };
const cargoColumns: Record<string, string> = { quotation_cargo_description: "cargo_name_cn", quotation_pieces: "declared_quantity", quotation_gross_weight_kg: "gross_weight_per_package_kg", quotation_volume_cbm: "volume_per_package_cbm" };
describe("shared known-red intake evaluation", () => {
  it("accepts all known facts but explicitly does not claim the two unresolved business dictionaries are complete", () => {
    const result = evaluate(); expect(result.issues).toEqual([]); expect(result.knownFieldsSatisfied).toBe(true);
    expect(result.coverage).toBe("known-fields-only"); expect(result.unresolvedDefinitions).toEqual(["业务大类", "业务类型"]);
  });
  it.each(knownIntakeRequirements.map(field => [field.fieldKey, field.label]))("reports each required %s (%s) from its authoritative source", (key) => {
    const facts = completeIntakeFacts(), operation = intakeOperationFields.find(field => intakeOperationFieldKey(field.key) === key), route = intakeRouteFields.find(field => field.fieldKey === key);
    if (operation?.key === "entrustedServices") facts.services = [];
    else if (operation) { const plan = JSON.parse(String(facts.order.intake_operations_json)); delete plan[operation.key]; facts.order.intake_operations_json = JSON.stringify(plan); }
    else if (route) facts.order[route.column] = null;
    else if (cargoColumns[key]) facts.cargo[0][cargoColumns[key]] = key === "quotation_pieces" ? 0 : null;
    else facts.order[nativeColumns[key]] = null;
    expect(evaluate(facts).issues.some(issue => issue.fieldKey === key)).toBe(true);
  });
  it.each([0, 0.0000001])("accepts explicit volume %s; dimensions and actual resources are not extra red gates", volume => {
    const facts = completeIntakeFacts(); facts.cargo[0].volume_per_package_cbm = volume; expect(evaluate(facts).knownFieldsSatisfied).toBe(true);
  });
  it("locates the second cargo line instead of relying on order totals or the first line", () => {
    const facts = completeIntakeFacts(); facts.cargo.push({ ...facts.cargo[0], id: "cargo-2", cargo_name_cn: "" });
    expect(evaluate(facts).issues).toContainEqual(expect.objectContaining({ fieldKey: "quotation_cargo_description", rowId: "cargo-2", rowNumber: 2, source: "cargo" }));
  });
  it("does not count cancelled services, cancelled expenses or wrong-direction fee names", () => {
    const facts = completeIntakeFacts(); facts.services[0].status = "cancelled"; facts.expenses[1].stage = "cancelled";
    facts.expenses.push({ ...facts.expenses[1], id: "wrong-direction", direction: "receivable", stage: "estimated" });
    expect(evaluate(facts).issues.map(issue => issue.fieldKey)).toEqual(expect.arrayContaining(["quotation_intake_entrustedServices", "intake_fee_pickup"]));
  });
  it("reports incomplete fee rows and cannot use their totals to meet a required category", () => {
    const facts = completeIntakeFacts(); facts.expenses[1].counterparty_name = "";
    expect(evaluate(facts).issues).toContainEqual(expect.objectContaining({ fieldKey: "expense_counterparty_name", rowId: "ap", source: "expense" }));
    expect(evaluate(facts).issues.some(issue => issue.fieldKey === "intake_fee_pickup")).toBe(true);
  });
  it("honors configured category/AR switches without disabling known red facts", () => {
    const facts = completeIntakeFacts(); facts.expenses = [];
    const policy = { ...defaultBusinessProcessPolicy, "order.ltl_required_fees": "", "order.require_receivable": "0" };
    expect(evaluateOrderIntakeCompleteness(facts, policy).issues).toEqual([]);
    facts.order.exit_port = null; expect(evaluateOrderIntakeCompleteness(facts, policy).knownFieldsSatisfied).toBe(false);
  });
  it("requires all configured FTL categories and AP, including those only present as AR", () => {
    const facts = completeIntakeFacts(); facts.order.business_type = "ftl";
    expect(evaluate(facts).issues.map(issue => issue.fieldKey)).toEqual(expect.arrayContaining(["intake_fee_handling", "intake_fee_storage", "intake_fee_customs_port", "intake_fee_overseas_driver", "intake_fee_transit_customs"]));
  });
  it("flags unsupported later-node/quote-only rules rather than silently declaring them complete", () => {
    const result = evaluateOrderIntakeCompleteness(completeIntakeFacts(), defaultBusinessProcessPolicy, ["actual_weight_kg", "quotation_valid_until"]);
    expect(result.issues.filter(issue => issue.source === "configuration")).toHaveLength(2);
  });
  it("retains a real historical quote-commercial name and leaves all input facts unchanged", () => {
    const facts = completeIntakeFacts(); facts.order.quote_commercial_user_id = null; facts.order.quote_commercial_name_snapshot = "历史实际报价人";
    const before = structuredClone(facts); expect(evaluate(facts).knownFieldsSatisfied).toBe(true); expect(facts).toEqual(before);
  });
});
