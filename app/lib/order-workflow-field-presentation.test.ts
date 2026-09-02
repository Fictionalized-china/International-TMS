import { describe, expect, it } from "vitest";
import { workflowFieldCatalog } from "./workflow-field-catalog";
import {
  cargoDetailFieldGroups,
  orderWorkflowPresentationKeys,
  quotationCargoPresentationKeys,
  workflowFieldsForStep,
} from "./order-workflow-field-presentation";
import { hasVisibleRuntimeWorkflowField } from "./workflow-field-runtime";

describe("order workflow field presentation contract", () => {
  it("has an actual-order presentation for every quotation and order-creation fact", () => {
    const missing = workflowFieldCatalog
      .filter(
        (field) =>
          ["quotation", "order_creation"].includes(field.stepKey) &&
          ["consignment", "cargo", "costs"].includes(field.moduleCode) &&
          field.fieldType !== "attachment",
      )
      .filter((field) => !orderWorkflowPresentationKeys.has(field.fieldKey))
      .map((field) => `${field.moduleCode}:${field.fieldKey}`);

    expect(missing).toEqual([]);
  });

  it("does not render a configurable business field that is absent from the catalog", () => {
    const catalogKeys = new Set(workflowFieldCatalog.map((field) => field.fieldKey));
    expect(
      [...orderWorkflowPresentationKeys].filter((fieldKey) => !catalogKeys.has(fieldKey)),
    ).toEqual([]);
  });

  it("shows quotation facts but hides every detailed cargo group for the reported rule shape", () => {
    const fields = [
      ...quotationCargoPresentationKeys.map((fieldKey) => ({
        fieldKey,
        isActive: true,
        isRequired: fieldKey !== "quotation_notes",
      })),
      ...cargoDetailFieldGroups.flatMap((group) =>
        group.fieldKeys.map((fieldKey) => ({
          fieldKey,
          isActive: false,
          isRequired: false,
        })),
      ),
    ];

    expect(hasVisibleRuntimeWorkflowField(fields, quotationCargoPresentationKeys)).toBe(true);
    expect(
      cargoDetailFieldGroups.filter((group) =>
        hasVisibleRuntimeWorkflowField(fields, group.fieldKeys),
      ),
    ).toEqual([]);
  });

  it("does not show a later workflow node field inside the second step", () => {
    const fields = [
      { fieldKey:"document_consignment_letter", stepKey:"order_creation" },
      { fieldKey:"e2e_secondary_review_result", stepKey:"custom_secondary_review" },
    ];

    expect(workflowFieldsForStep(fields,"order_creation").map((field) => field.fieldKey))
      .toEqual(["document_consignment_letter"]);
    expect(workflowFieldsForStep(fields,"custom_secondary_review").map((field) => field.fieldKey))
      .toEqual(["e2e_secondary_review_result"]);
  });
});
