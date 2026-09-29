import { describe, expect, it } from "vitest";
import {
  defaultOperationalRuleValues,
  normalizeOperationalRuleValue,
  resolveOperationalRuleValues,
} from "./operational-rules";

describe("operational rules", () => {
  it("keeps safe defaults when an organization has no overrides", () => {
    expect(resolveOperationalRuleValues([])).toEqual(defaultOperationalRuleValues);
    expect(defaultOperationalRuleValues["loading.volume_weight_ratio_kg_per_cbm"]).toBe(300);
  });

  it("uses organization overrides and ignores unknown historical rows", () => {
    const values = resolveOperationalRuleValues([
      { rule_code: "warehouse.receipt_difference_threshold_percent", numeric_value: 2.5 },
      { rule_code: "removed.rule", numeric_value: 999 },
    ]);
    expect(values["warehouse.receipt_difference_threshold_percent"]).toBe(2.5);
    expect(values["tracking.stale_warning_hours"]).toBe(48);
  });

  it("falls back or clamps invalid values to the declared safe range", () => {
    expect(normalizeOperationalRuleValue("tracking.due_warning_hours", "bad")).toBe(24);
    expect(normalizeOperationalRuleValue("tracking.due_warning_hours", 0)).toBe(1);
    expect(normalizeOperationalRuleValue("warehouse.receipt_difference_threshold_percent", 120)).toBe(100);
  });
});
