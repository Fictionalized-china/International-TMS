import { calculateDomesticWarehouseDifference } from "./warehouse-actual";

/** Compare only arrived packages: an outstanding delivery is not lost stock. */
export function domesticReceiptComparison(input: {
  plannedPackages: number;
  cumulativePackages: number;
  cumulativeWeightKg: number;
  cumulativePieces: number;
  cumulativeVolumeCbm: number;
  arrivedDeclaredWeightKg: number;
  compareWeight: boolean;
  thresholdPercent: number;
}) {
  const difference = calculateDomesticWarehouseDifference(
    {
      pieces: input.cumulativePieces,
      weightKg: input.compareWeight ? input.arrivedDeclaredWeightKg : input.cumulativeWeightKg,
      volumeCbm: input.cumulativeVolumeCbm,
    },
    { pieces: input.cumulativePieces, weightKg: input.cumulativeWeightKg, volumeCbm: input.cumulativeVolumeCbm },
    input.thresholdPercent,
  );
  return {
    difference,
    // Shortage is a difference only when the operator declares an exception;
    // normal partial arrival leaves unreceived marks pending.
    packageMismatch: input.cumulativePackages > input.plannedPackages,
    acceptanceComparison: {
      actualPackages: input.cumulativePackages,
      expectedPackages: input.plannedPackages,
      piecesMismatch: false,
      requiresFeeConfirmation: difference.requiresFeeConfirmation,
    },
  };
}
