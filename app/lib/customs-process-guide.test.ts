import { describe, expect, it } from "vitest";
import { customsDeclarationReleaseActionMode, customsProcessGuideState, customsReleaseDocumentGate } from "./customs-process-guide";

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

describe("customsReleaseDocumentGate", () => {
  it("blocks release on pending required pre-departure files only", () => {
    expect(customsReleaseDocumentGate({
      requirements: [
        { documentCode: "commercial_invoice", isPreDeparture: true, visible: true, required: true },
        { documentCode: "border_document", isPreDeparture: false, visible: true, required: true },
        { documentCode: "packing_list", isPreDeparture: true, visible: false, required: true },
        { documentCode: "customs_declaration_file", isPreDeparture: true, visible: true, required: false },
      ],
      documents: [
        { documentCode: "commercial_invoice", reviewStatus: "pending" },
        { documentCode: "border_document", reviewStatus: "approved" },
      ],
    })).toEqual({
      ready: false,
      requiredDocumentCodes: ["commercial_invoice"],
      readyDocumentCodes: [],
      missingDocumentCodes: ["commercial_invoice"],
    });
  });

  it("opens release when every required file has an approved or archived copy", () => {
    expect(customsReleaseDocumentGate({
      requirements: [
        { documentCode: "commercial_invoice", isPreDeparture: true, visible: true, required: true },
        { documentCode: "packing_list", isPreDeparture: true, visible: true, required: true },
      ],
      documents: [
        { documentCode: "commercial_invoice", reviewStatus: "pending" },
        { documentCode: "commercial_invoice", reviewStatus: "approved" },
        { documentCode: "packing_list", reviewStatus: "archived" },
      ],
    })).toEqual({
      ready: true,
      requiredDocumentCodes: ["commercial_invoice", "packing_list"],
      readyDocumentCodes: ["commercial_invoice", "packing_list"],
      missingDocumentCodes: [],
    });
  });
});

describe("customsDeclarationReleaseActionMode", () => {
  it("replaces the release action with a blocked state until required files are ready", () => {
    const declaration = {
      manage: true,
      releaseFieldVisible: true,
      declarationStatus: "declared",
      declarationDeleted: false,
    };

    expect(customsDeclarationReleaseActionMode({
      ...declaration,
      documentsReady: false,
    })).toBe("blocked");
    expect(customsDeclarationReleaseActionMode({
      ...declaration,
      documentsReady: true,
    })).toBe("available");
  });
});
