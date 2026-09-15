export type CustomsProcessPhase = "documents" | "declaration" | "release" | "tracking";

export type CustomsReleaseDocumentRequirement = {
  documentCode: string;
  isPreDeparture: boolean;
  visible: boolean;
  required: boolean;
};

export type CustomsReleaseDocumentReview = {
  documentCode: string;
  reviewStatus: string | null;
};

export function customsReleaseDocumentGate(input: {
  requirements: readonly CustomsReleaseDocumentRequirement[];
  documents: readonly CustomsReleaseDocumentReview[];
}) {
  const requiredDocumentCodes = [...new Set(
    input.requirements
      .filter((item) => item.isPreDeparture && item.visible && item.required)
      .map((item) => item.documentCode),
  )];
  const reviewedDocumentCodes = new Set(
    input.documents
      .filter((item) => ["approved", "archived"].includes(item.reviewStatus || ""))
      .map((item) => item.documentCode),
  );
  const readyDocumentCodes = requiredDocumentCodes.filter((code) =>
    reviewedDocumentCodes.has(code)
  );
  const missingDocumentCodes = requiredDocumentCodes.filter((code) =>
    !reviewedDocumentCodes.has(code)
  );
  return {
    ready: missingDocumentCodes.length === 0,
    requiredDocumentCodes,
    readyDocumentCodes,
    missingDocumentCodes,
  };
}

export type CustomsDeclarationReleaseActionMode = "hidden" | "blocked" | "available";

export function customsDeclarationReleaseActionMode(input: {
  manage: boolean;
  releaseFieldVisible: boolean;
  declarationStatus: string;
  declarationDeleted: boolean;
  documentsReady: boolean;
}): CustomsDeclarationReleaseActionMode {
  if (
    !input.manage ||
    !input.releaseFieldVisible ||
    input.declarationDeleted ||
    ["released", "cancelled"].includes(input.declarationStatus)
  ) {
    return "hidden";
  }
  return input.documentsReady ? "available" : "blocked";
}

export type CustomsProcessGuideState = {
  currentPhase: CustomsProcessPhase;
  documentsReady: boolean;
  declarationReady: boolean;
  releaseReady: boolean;
  activeDeclarationCount: number;
  releasedDeclarationCount: number;
};

export function customsProcessGuideState(input: {
  requiredDocumentCodes: string[];
  readyDocumentCodes: string[];
  declarations: Array<{
    clearanceStage: string;
    status: string;
    isDeleted: boolean;
  }>;
}): CustomsProcessGuideState {
  const readyDocuments = new Set(input.readyDocumentCodes);
  const documentsReady = input.requiredDocumentCodes.every((code) => readyDocuments.has(code));
  const activeDeclarations = input.declarations.filter(
    (item) => item.clearanceStage === "origin" && !item.isDeleted && item.status !== "cancelled",
  );
  const releasedDeclarationCount = activeDeclarations.filter((item) => item.status === "released").length;
  const declarationReady = activeDeclarations.length > 0;
  const releaseReady = releasedDeclarationCount > 0;
  const currentPhase: CustomsProcessPhase = releaseReady
    ? "tracking"
    : !documentsReady
      ? "documents"
      : !declarationReady
        ? "declaration"
        : "release";

  return {
    currentPhase,
    documentsReady,
    declarationReady,
    releaseReady,
    activeDeclarationCount: activeDeclarations.length,
    releasedDeclarationCount,
  };
}
