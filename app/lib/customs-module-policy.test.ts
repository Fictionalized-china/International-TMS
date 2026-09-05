import { describe, expect, it } from "vitest";

import { deriveCustomsModuleAutomationState } from "./customs-module-policy";

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
});
