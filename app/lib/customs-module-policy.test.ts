import { describe, expect, it } from "vitest";

import {
  customsModuleGateRequirements,
  deriveCustomsModuleAutomationState,
} from "./customs-module-policy";

const field = (
  fieldKey: string,
  mode: "required" | "optional" | "hidden",
) => ({
  fieldKey,
  isActive: mode !== "hidden",
  isRequired: mode === "required",
});

describe("deriveCustomsModuleAutomationState", () => {
  it("blocks on declarations and release only when both gates are required", () => {
    const fields = [
      field("customs_declarations", "required"),
      field("customs_release", "required"),
    ];

    expect(deriveCustomsModuleAutomationState({ total: 0, released: 0, fields }))
      .toMatchObject({ status: "in_progress", step: "documents" });
    expect(deriveCustomsModuleAutomationState({ total: 2, released: 1, fields }))
      .toMatchObject({ status: "in_progress", step: "review" });
    expect(deriveCustomsModuleAutomationState({ total: 2, released: 2, fields }))
      .toMatchObject({ status: "completed", step: "released" });
  });

  it("does not turn optional or hidden customs fields into automatic blockers", () => {
    expect(deriveCustomsModuleAutomationState({
      total: 0,
      released: 0,
      fields: [
        field("customs_declarations", "optional"),
        field("customs_release", "hidden"),
      ],
    })).toMatchObject({ status: "completed", blocker: null });

    expect(deriveCustomsModuleAutomationState({
      total: 1,
      released: 0,
      fields: [
        field("customs_declarations", "required"),
        field("customs_release", "optional"),
      ],
    })).toMatchObject({ status: "completed", step: "declared", blocker: null });
  });

  it("keeps the legacy declaration and release gate when no field snapshot exists", () => {
    expect(deriveCustomsModuleAutomationState({ total: 0, released: 0, fields: [] }))
      .toMatchObject({ status: "in_progress", step: "documents" });
  });

  it("does not upgrade optional core actions when the customs module itself is required", () => {
    const fields = [
      field("customs_declarations", "optional"),
      field("customs_release", "optional"),
    ];

    expect(customsModuleGateRequirements(fields, { moduleRequired: true }))
      .toEqual({ declarationsRequired: false, releaseRequired: false });
    expect(deriveCustomsModuleAutomationState({
      total: 0,
      released: 0,
      fields,
      moduleRequired: true,
    })).toMatchObject({ status: "completed", blocker: null });
  });

  it("uses detail fields only as a compatibility fallback when the declaration group is absent", () => {
    expect(customsModuleGateRequirements([
      field("declaration_number", "required"),
      field("customs_release", "optional"),
    ], { moduleRequired: true })).toEqual({
      declarationsRequired: true,
      releaseRequired: false,
    });
  });

  it("never blocks an optional customs module even if its fields are required", () => {
    const fields = [
      field("customs_declarations", "required"),
      field("customs_release", "required"),
    ];

    expect(customsModuleGateRequirements(fields, { moduleRequired: false }))
      .toEqual({ declarationsRequired: false, releaseRequired: false });
    expect(deriveCustomsModuleAutomationState({
      total: 0,
      released: 0,
      fields,
      moduleRequired: false,
    })).toMatchObject({ status: "completed", blocker: null });
  });
});
