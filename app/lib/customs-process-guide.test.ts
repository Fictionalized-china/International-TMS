import { describe, expect, it } from "vitest";
import { customsProcessGuideState } from "./customs-process-guide";

describe("customsProcessGuideState", () => {
  it("guides the user to missing required documents first", () => {
    expect(customsProcessGuideState({
      requiredDocumentCodes: ["invoice", "packing_list"],
      readyDocumentCodes: ["invoice"],
      declarations: [],
    }).currentPhase).toBe("documents");
  });

  it("guides the user from declaration creation to release", () => {
    const documents = {
      requiredDocumentCodes: ["invoice"],
      readyDocumentCodes: ["invoice"],
    };
    expect(customsProcessGuideState({ ...documents, declarations: [] }).currentPhase).toBe("declaration");
    expect(customsProcessGuideState({
      ...documents,
      declarations: [{ clearanceStage: "origin", status: "declared", isDeleted: false }],
    }).currentPhase).toBe("release");
  });

  it("opens the tracking phase only after a valid origin declaration is released", () => {
    const result = customsProcessGuideState({
      requiredDocumentCodes: [],
      readyDocumentCodes: [],
      declarations: [
        { clearanceStage: "origin", status: "cancelled", isDeleted: true },
        { clearanceStage: "origin", status: "released", isDeleted: false },
      ],
    });
    expect(result.currentPhase).toBe("tracking");
    expect(result.releaseReady).toBe(true);
    expect(result.activeDeclarationCount).toBe(1);
  });
});
