import { describe, expect, it } from "vitest";
import {
  loadingDispatchPlanPolicyIssues,
  loadingBatchRequiredValueError,
  loadingBatchResourcePolicy,
  resolveLoadingBatchFieldPolicies,
  type LoadingBatchWorkflowOrder,
} from "./loading-batch-field-policy";

const order = (
  orderId: string,
  fields: LoadingBatchWorkflowOrder["fields"],
  appliesToCurrentOrFuture = true,
): LoadingBatchWorkflowOrder => ({ orderId, fields, appliesToCurrentOrFuture });

describe("resolveLoadingBatchFieldPolicies", () => {
  it("uses the strictest current or future rule across all participating orders", () => {
    const policies = resolveLoadingBatchFieldPolicies([
      order("optional", [{ fieldKey: "exit_port", isActive: true, isRequired: false }]),
      order("hidden", [{ fieldKey: "exit_port", isActive: false, isRequired: false }]),
      order("required", [{ fieldKey: "exit_port", isActive: true, isRequired: true }]),
    ]);
    expect(policies.exit_port).toEqual({ isActive: true, isRequired: true, mode: "required" });
  });

  it("aggregates visible-only as optional and all hidden as hidden", () => {
    const optional = resolveLoadingBatchFieldPolicies([
      order("one", [{ fieldKey: "customs_location", isActive: false, isRequired: false }]),
      order("two", [{ fieldKey: "customs_location", isActive: true, isRequired: false }]),
    ]);
    expect(optional.customs_location.mode).toBe("optional");

    const hidden = resolveLoadingBatchFieldPolicies([
      order("one", [{ fieldKey: "customs_location", isActive: false, isRequired: false }]),
      order("two", [{ fieldKey: "customs_location", isActive: false, isRequired: false }]),
    ]);
    expect(hidden.customs_location).toEqual({ isActive: false, isRequired: false, mode: "hidden" });
  });

  it("excludes historical nodes and falls back for legacy current orders", () => {
    const policies = resolveLoadingBatchFieldPolicies([
      order("historical", [{ fieldKey: "planned_arrival_at", isActive: true, isRequired: true }], false),
      order("legacy", []),
    ]);
    expect(policies.planned_arrival_at.mode).toBe("optional");
    expect(policies.exit_port.mode).toBe("required");
  });

  it("does not expose or validate fields when every order is historical", () => {
    const policies = resolveLoadingBatchFieldPolicies([
      order("historical", [{ fieldKey: "exit_port", isActive: true, isRequired: true }], false),
    ]);
    expect(policies.exit_port.mode).toBe("hidden");
    expect(loadingBatchRequiredValueError(policies, {})).toBe("");
  });

  it("derives resource selector dependencies from the same field policies", () => {
    const policies = resolveLoadingBatchFieldPolicies([
      order("one", [
        { fieldKey: "main_carrier_id", isActive: false, isRequired: false },
        { fieldKey: "main_vehicle_type", isActive: false, isRequired: false },
        { fieldKey: "main_plate_number", isActive: true, isRequired: true },
        { fieldKey: "main_driver_name", isActive: true, isRequired: false },
        { fieldKey: "main_driver_phone", isActive: false, isRequired: false },
      ]),
    ]);
    expect(loadingBatchResourcePolicy(policies)).toEqual({
      carrier: { isActive: true, isRequired: true },
      vehicle: { isActive: true, isRequired: true },
      driver: { isActive: true, isRequired: false },
    });
  });

  it("validates only active required scalar values", () => {
    const policies = resolveLoadingBatchFieldPolicies([
      order("one", [
        { fieldKey: "exit_port", isActive: false, isRequired: false },
        { fieldKey: "planned_arrival_at", isActive: true, isRequired: true },
      ]),
    ]);
    const otherwiseComplete = {
      exit_port: "",
      customs_location: "TAS",
      planned_exit_at: "2026-09-03T06:00",
      planned_arrival_at: "",
    } as const;
    expect(loadingBatchRequiredValueError(policies, otherwiseComplete))
      .toBe("请填写计划境外到仓时间");
    expect(loadingBatchRequiredValueError(policies, { ...otherwiseComplete, planned_arrival_at: "2026-09-03T08:00" }))
      .toBe("");
  });

  it("treats hidden, optional and required transport resources as distinct modes", () => {
    const policies = resolveLoadingBatchFieldPolicies([
      order("one", [
        { fieldKey: "main_carrier_id", isActive: false, isRequired: false },
        { fieldKey: "main_vehicle_type", isActive: true, isRequired: false },
        { fieldKey: "main_plate_number", isActive: true, isRequired: true },
        { fieldKey: "main_driver_name", isActive: true, isRequired: false },
        { fieldKey: "main_driver_phone", isActive: false, isRequired: false },
        { fieldKey: "planned_exit_at", isActive: false, isRequired: false },
      ]),
    ]);

    expect(loadingDispatchPlanPolicyIssues(policies, {})).toEqual({
      requiredMissing: ["出境车牌号"],
      optionalMissing: [
        { fieldKey: "main_vehicle_type", label: "出境车型" },
        { fieldKey: "main_driver_name", label: "出境司机姓名" },
      ],
    });
  });
});
