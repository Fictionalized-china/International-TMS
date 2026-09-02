export type CustomsProcessPhase = "documents" | "declaration" | "release" | "tracking";

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
