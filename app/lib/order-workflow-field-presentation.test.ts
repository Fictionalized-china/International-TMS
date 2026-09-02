import { describe, expect, it } from "vitest";
import { workflowFieldCatalog } from "./workflow-field-catalog";
import {
  cargoDetailFieldGroups,
  orderWorkflowPresentationKeys,
  quotationCargoPresentationKeys,
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
});
