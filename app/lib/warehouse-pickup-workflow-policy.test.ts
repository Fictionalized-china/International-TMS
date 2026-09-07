import { describe, expect, it } from "vitest";
import {
  resolvePickupWorkflowPolicy,
  validatePickupWorkflowSubmission,
} from "./warehouse-pickup-workflow-policy";

function field(
  fieldKey: "overseas_pickup_contact" | "pickup_proof",
  mode: "required" | "optional" | "hidden",
  stepKey = "overseas_pickup",
) {
  return {
    stepKey,
    fieldKey,
    label: fieldKey === "overseas_pickup_contact" ? "实际签收人" : "提货凭证引用",
    helpText: null,
    isActive: mode !== "hidden",
    isRequired: mode === "required",
  };
}

describe("warehouse pickup workflow field policy", () => {
  it("uses only the frozen current-step field modes", () => {
    const policy = resolvePickupWorkflowPolicy({
      fields: [
        field("overseas_pickup_contact", "optional", "previous_step"),
        field("overseas_pickup_contact", "required"),
        field("pickup_proof", "hidden"),
      ],
      targetStepKey: "overseas_pickup",
      legacyFallback: false,
    });

    expect(policy.contact).toMatchObject({ visible: true, required: true, label: "实际签收人" });
    expect(policy.proof).toMatchObject({ visible: false, required: false });
  });

  it("rejects a blank required field before pickup is confirmed", () => {
    const policy = resolvePickupWorkflowPolicy({
      fields: [field("overseas_pickup_contact", "required"), field("pickup_proof", "optional")],
      targetStepKey: "overseas_pickup",
      legacyFallback: false,
    });

    expect(validatePickupWorkflowSubmission(policy, {
      pickupContact: "   ",
      pickupProofReference: "",
    })).toEqual({
      error: "请填写“实际签收人”",
      pickupContact: null,
      pickupProofReference: null,
    });
  });

  it("ignores forged values for hidden fields", () => {
    const policy = resolvePickupWorkflowPolicy({
      fields: [field("overseas_pickup_contact", "hidden"), field("pickup_proof", "hidden")],
      targetStepKey: "overseas_pickup",
      legacyFallback: false,
    });

    expect(validatePickupWorkflowSubmission(policy, {
      pickupContact: "伪造签收人",
      pickupProofReference: "伪造凭证",
    })).toEqual({ error: null, pickupContact: null, pickupProofReference: null });
  });

  it("requires a proof reference only when the frozen field is required", () => {
    const policy = resolvePickupWorkflowPolicy({
      fields: [field("overseas_pickup_contact", "optional"), field("pickup_proof", "required")],
      targetStepKey: "overseas_pickup",
      legacyFallback: false,
    });

    expect(validatePickupWorkflowSubmission(policy, {
      pickupContact: "张三",
      pickupProofReference: "   ",
    })).toEqual({
      error: "请填写“提货凭证引用”",
      pickupContact: null,
      pickupProofReference: null,
    });
  });

  it("keeps the catalog defaults for legacy orders without a frozen workflow", () => {
    const policy = resolvePickupWorkflowPolicy({
      fields: [],
      targetStepKey: null,
      legacyFallback: true,
    });

    expect(policy.contact).toMatchObject({ visible: true, required: true });
    expect(policy.proof).toMatchObject({ visible: true, required: false, label: "提货凭证引用" });
  });
});
