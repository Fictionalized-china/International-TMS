import {
  workflowFieldPolicy,
  type WorkflowFieldMode,
  type WorkflowFieldPolicyLike,
} from "./workflow-field-catalog";

export type WarehouseAcceptanceFieldPolicy = {
  isActive: boolean;
  isRequired: boolean;
  isSystemLocked: boolean;
};

const systemRequiredPolicy: WarehouseAcceptanceFieldPolicy = {
  isActive: true,
  isRequired: true,
  isSystemLocked: true,
};

function configurablePolicy(
  fields: readonly WorkflowFieldPolicyLike[],
  fieldKey: string,
  fallbackMode: WorkflowFieldMode,
): WarehouseAcceptanceFieldPolicy {
  return {
    ...workflowFieldPolicy(fields, fieldKey, fallbackMode),
    isSystemLocked: false,
  };
}

/**
 * Dimensions are structural because every physical inventory label needs a
 * usable package size. Operator-facing receipt inputs otherwise follow the
 * order instance snapshot so a published required/optional/hidden change is
 * effective immediately.
 */
export function resolveWarehouseAcceptancePolicies(
  fields: readonly WorkflowFieldPolicyLike[],
) {
  return {
    actualPackages: configurablePolicy(fields, "actual_package_count", "required"),
    actualPieces: configurablePolicy(fields, "actual_pieces", "required"),
    actualWeight: configurablePolicy(fields, "actual_weight_kg", "required"),
    actualVolume: configurablePolicy(fields, "actual_volume_cbm", "required"),
    actualDimensions: systemRequiredPolicy,
    location: configurablePolicy(fields, "warehouse_location", "required"),
    cargoComplete: configurablePolicy(fields, "cargo_complete_set", "required"),
    evidence: configurablePolicy(fields, "receipt_evidence", "optional"),
    notes: configurablePolicy(fields, "warehouse_receipt_notes", "optional"),
  } as const;
}

export function acceptanceRequiredMarker(policy: WarehouseAcceptanceFieldPolicy) {
  if (!policy.isRequired) return "";
  return policy.isSystemLocked ? " * · 系统锁定" : " *";
}

export function warehouseAcceptancePackageCount(input: {
  plannedPackages: number;
  receivedPackages: number;
  submittedPackages: number | null;
}) {
  if (input.submittedPackages !== null) return input.submittedPackages;
  return Math.max(0, input.plannedPackages - input.receivedPackages);
}

export type WarehouseAcceptanceComparison = {
  actualPackages: number;
  expectedPackages: number;
  piecesMismatch: boolean;
  requiresFeeConfirmation: boolean;
};

export function automaticWarehouseAcceptanceResult(
  comparison: WarehouseAcceptanceComparison,
): "partial" | "ready" | "exception" {
  if (
    comparison.actualPackages > comparison.expectedPackages ||
    comparison.piecesMismatch ||
    comparison.requiresFeeConfirmation
  ) return "exception";
  return comparison.actualPackages === comparison.expectedPackages
    ? "ready"
    : "partial";
}

export function warehouseAcceptanceReadyIsBlocked(
  comparison: WarehouseAcceptanceComparison,
) {
  return comparison.actualPackages !== comparison.expectedPackages ||
    comparison.piecesMismatch ||
    comparison.requiresFeeConfirmation;
}
