import {
  orderDocumentPlacements,
  orderDocumentTypeLabel,
  preDepartureDocumentTypeCodes,
  type OrderDocumentPlacement,
} from "./order-documents";
import { workflowFieldCatalogByKey } from "./workflow-field-catalog";

export type LoadingOrderDocumentModule = "consignment" | "customs";

function isLoadingDocumentPlacement(
  placement: OrderDocumentPlacement,
): placement is OrderDocumentPlacement & {
  moduleCode: LoadingOrderDocumentModule;
} {
  return (
    preDepartureDocumentTypeCodes.has(placement.documentCode) &&
    ["consignment", "customs"].includes(placement.moduleCode)
  );
}

// Keep the loading workbench on the same document taxonomy and field keys as
// the order modules and the departure gate. A newly configurable pre-departure
// document therefore appears here without adding another hard-coded list.
export const loadingOrderDocumentDefinitions = orderDocumentPlacements
  .filter(isLoadingDocumentPlacement)
  .map((placement) => ({
    code: placement.documentCode,
    name: orderDocumentTypeLabel(placement.documentCode),
    moduleCode: placement.moduleCode,
    fieldKey: placement.fieldKey,
    requiredByDefault: placement.requiredByDefault,
  }));

export type LoadingOrderDocumentCode =
  (typeof loadingOrderDocumentDefinitions)[number]["code"];

export type LoadingDocumentWorkflowField = {
  fieldKey: string;
  isActive: boolean;
  isRequired: boolean;
  stageAvailable?: boolean;
};

export type EffectiveLoadingDocumentRequirement =
  (typeof loadingOrderDocumentDefinitions)[number] & {
    isActive: boolean;
    isRequired: boolean;
    stageAvailable: boolean;
  };

export type OrderLoadingDocumentRequirements = {
  orderId: string;
  customsEnabled: boolean;
  documents: EffectiveLoadingDocumentRequirement[];
};

export type LoadingDocumentReview = {
  document_category: string;
  review_status: string;
};

export type LoadingDocumentRequirementSummary = {
  activeCount: number;
  requiredCount: number;
  uploadedRequiredCount: number;
  approvedRequiredCount: number;
  rejectedRequiredCount: number;
  missingUploadCodes: LoadingOrderDocumentCode[];
  incompleteCodes: LoadingOrderDocumentCode[];
  complete: boolean;
};

export const warehouseLoadingDocumentMutationPolicy = {
  allowed: false,
  reason: "订单文件由冻结工作流当前节点指定的业务或单证负责人办理；仓库端仅查看齐套状态",
} as const;

export function resolveLoadingDocumentRequirements(input: {
  orderId: string;
  customsEnabled: boolean;
  fieldsByModule: Partial<
    Record<LoadingOrderDocumentModule, readonly LoadingDocumentWorkflowField[]>
  >;
}): OrderLoadingDocumentRequirements {
  const documents = loadingOrderDocumentDefinitions.map((definition) => {
    if (definition.moduleCode === "customs" && !input.customsEnabled) {
      return {
        ...definition,
        isActive: false,
        isRequired: false,
        stageAvailable: false,
      };
    }
    const configured = (input.fieldsByModule[definition.moduleCode] ?? []).find(
      (field) => field.fieldKey === definition.fieldKey,
    );
    const defaultMode = workflowFieldCatalogByKey.get(
      definition.fieldKey,
    )?.defaultMode;
    const policy = configured
      ? {
          isActive: configured.isActive,
          isRequired: configured.isActive && configured.isRequired,
          stageAvailable: configured.stageAvailable ?? true,
        }
      : {
          // Visibility comes from the catalog (for example, contract is hidden
          // by default), while requiredness keeps the same legacy fallback as
          // checkOrderPreDepartureDocuments.
          isActive: defaultMode !== "hidden",
          isRequired:
            defaultMode !== "hidden" && definition.requiredByDefault,
          stageAvailable: true,
        };
    return {
      ...definition,
      isActive: policy.isActive,
      isRequired: policy.isRequired,
      stageAvailable: policy.stageAvailable,
    };
  });
  return {
    orderId: input.orderId,
    customsEnabled: input.customsEnabled,
    documents,
  };
}

export function currentStageLoadingDocumentRequirements(
  requirements: readonly EffectiveLoadingDocumentRequirement[],
) {
  return requirements.filter(
    (requirement) => requirement.isActive && requirement.stageAvailable,
  );
}

export function summarizeLoadingDocumentRequirements(
  requirements: readonly EffectiveLoadingDocumentRequirement[],
  reviews: readonly LoadingDocumentReview[],
): LoadingDocumentRequirementSummary {
  const latestByCode = new Map(
    reviews.map((review) => [review.document_category, review]),
  );
  const active = requirements.filter((requirement) => requirement.isActive);
  const required = active.filter((requirement) => requirement.isRequired);
  const missingUploadCodes = required
    .filter((requirement) => !latestByCode.has(requirement.code))
    .map((requirement) => requirement.code);
  const incompleteCodes = required
    .filter((requirement) => {
      const review = latestByCode.get(requirement.code);
      return !review || !["approved", "archived"].includes(review.review_status);
    })
    .map((requirement) => requirement.code);
  const approvedRequiredCount = required.length - incompleteCodes.length;
  return {
    activeCount: active.length,
    requiredCount: required.length,
    uploadedRequiredCount: required.length - missingUploadCodes.length,
    approvedRequiredCount,
    rejectedRequiredCount: required.filter(
      (requirement) =>
        latestByCode.get(requirement.code)?.review_status === "rejected",
    ).length,
    missingUploadCodes,
    incompleteCodes,
    complete: incompleteCodes.length === 0,
  };
}

export function loadingDocumentRequirement(
  requirements: readonly EffectiveLoadingDocumentRequirement[],
  code: string,
) {
  return requirements.find((requirement) => requirement.code === code);
}

export function uploadedRequiredDocumentCompletedGate(input: {
  requirements: readonly EffectiveLoadingDocumentRequirement[];
  reviews: readonly LoadingDocumentReview[];
  uploadedCode: string | null | undefined;
}) {
  if (!input.uploadedCode) return false;
  const uploaded = loadingDocumentRequirement(
    input.requirements,
    input.uploadedCode,
  );
  if (!uploaded?.isActive || !uploaded.isRequired) return false;
  return summarizeLoadingDocumentRequirements(
    input.requirements,
    input.reviews,
  ).complete;
}

export function loadingDocumentFieldPolicy(
  requirements: readonly EffectiveLoadingDocumentRequirement[] | null | undefined,
  code: string,
) {
  const requirement = requirements
    ? loadingDocumentRequirement(requirements, code)
    : undefined;
  return {
    visible: requirement?.isActive ?? false,
    required: requirement?.isRequired ?? false,
    label: undefined,
    configured: Boolean(requirement),
  };
}
