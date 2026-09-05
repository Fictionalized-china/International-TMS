import { describe, expect, it } from "vitest";
import {
  workflowFieldCatalog,
  legacyRequiredWorkflowFieldKeys,
  workflowFieldMode,
  workflowFieldModeFlags,
  workflowFieldPolicy,
} from "./workflow-field-catalog";

describe("workflow field building blocks", () => {
  it("keeps every built-in field key unique", () => {
    const keys = workflowFieldCatalog.map((field) => field.fieldKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses legacy mandatory fields as the required baseline", () => {
    for (const fieldKey of legacyRequiredWorkflowFieldKeys) {
      const field = workflowFieldCatalog.find((item) => item.fieldKey === fieldKey);
      expect(field, fieldKey).toBeDefined();
      expect(field?.defaultMode, fieldKey).toBe("required");
      expect(field?.requirementSource, fieldKey).toBe("legacy_required");
    }
  });

  it("keeps new-system supplemental fields optional by default", () => {
    for (const fieldKey of [
      "module_assignees",
      "vehicle_capacity_weight",
      "document_review",
      "customer_notified_at",
      "review_result",
    ]) {
      const field = workflowFieldCatalog.find((item) => item.fieldKey === fieldKey);
      expect(field?.defaultMode, fieldKey).toBe("optional");
      expect(field?.requirementSource, fieldKey).toBe("new_system");
    }
  });

  it("keeps settlement actions and evidence configurable", () => {
    expect(
      workflowFieldCatalog.find((item) => item.fieldKey === "customer_service_confirmation"),
    ).toMatchObject({ defaultMode: "required" });
    expect(
      workflowFieldCatalog.find((item) => item.fieldKey === "business_review"),
    ).toMatchObject({ defaultMode: "optional" });
    expect(
      workflowFieldCatalog.find((item) => item.fieldKey === "finance_review"),
    ).toMatchObject({ defaultMode: "optional" });
    expect(
      workflowFieldCatalog.find((item) => item.fieldKey === "document_billing_statement"),
    ).toMatchObject({ defaultMode: "optional" });
    expect(
      workflowFieldCatalog.find((item) => item.fieldKey === "document_payment_receipt"),
    ).toMatchObject({ defaultMode: "optional" });
  });

  it("shows the order-creation baseline but keeps only the consignment letter as its gate", () => {
    const orderCreationFields = workflowFieldCatalog.filter(
      (field) => field.stepKey === "order_creation",
    );
    expect(
      orderCreationFields
        .filter((field) => field.defaultMode === "required")
        .map((field) => field.fieldKey),
    ).toEqual(["document_consignment_letter"]);
    expect(
      orderCreationFields.find((field) => field.fieldKey === "customer_id"),
    ).toMatchObject({ defaultMode: "optional" });
    expect(
      orderCreationFields.find((field) => field.fieldKey === "cargo_name_cn"),
    ).toMatchObject({ defaultMode: "optional" });
    expect(
      orderCreationFields.find((field) => field.fieldKey === "document_consignment_letter"),
    ).toMatchObject({ defaultMode: "required" });
    expect(
      orderCreationFields.find((field) => field.fieldKey === "pre_receivable_expenses"),
    ).toMatchObject({ defaultMode: "hidden" });
  });

  it("maps required, optional and hidden without ambiguous states", () => {
    expect(workflowFieldMode({ is_active: 1, is_required: 1 })).toBe("required");
    expect(workflowFieldMode({ is_active: 1, is_required: 0 })).toBe("optional");
    expect(workflowFieldMode({ is_active: 0, is_required: 1 })).toBe("hidden");
    expect(workflowFieldModeFlags("required")).toEqual({ isActive: 1, isRequired: 1 });
    expect(workflowFieldModeFlags("optional")).toEqual({ isActive: 1, isRequired: 0 });
    expect(workflowFieldModeFlags("hidden")).toEqual({ isActive: 0, isRequired: 0 });
  });

  it("uses the configured rule and a deliberate fallback", () => {
    const fields = [{ fieldKey: "weight", isActive: false, isRequired: true }];
    expect(workflowFieldPolicy(fields, "weight", "required")).toEqual({
      isActive: false,
      isRequired: false,
    });
    expect(workflowFieldPolicy(fields, "missing", "required")).toEqual({
      isActive: true,
      isRequired: true,
    });
  });

  it("lets an optional workflow rule override a required document fallback", () => {
    const fields = [
      {
        fieldKey: "document_consignment_letter",
        isActive: true,
        isRequired: false,
      },
    ];
    expect(
      workflowFieldPolicy(fields, "document_consignment_letter", "required"),
    ).toEqual({ isActive: true, isRequired: false });
  });

  it("keeps order-level contracts available as a hidden workflow block", () => {
    expect(
      workflowFieldCatalog.find((item) => item.fieldKey === "document_contract"),
    ).toMatchObject({
      stepKey: "order_creation",
      moduleCode: "consignment",
      fieldType: "attachment",
      defaultMode: "hidden",
    });
  });
});
