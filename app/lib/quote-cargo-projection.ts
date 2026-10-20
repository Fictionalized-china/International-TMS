export const MAX_QUOTE_AUTO_PACKAGES = 500;

export type QuoteCargoProjection = {
  declaredQuantity: number;
  packageCount: number;
  piecesPerPackage: 1;
  grossWeightPerPackageKg: number;
  netWeightPerPackageKg: number;
  volumePerPackageCbm: number;
};

export function assertQuoteAutoPackageCount(pieces: number): number {
  if (!Number.isSafeInteger(pieces) || pieces < 1 || pieces > MAX_QUOTE_AUTO_PACKAGES) {
    throw new Error(
      `预计件数必须是 1–${MAX_QUOTE_AUTO_PACKAGES} 之间的整数；更多货物请拆分报价或分行登记货物`,
    );
  }
  return pieces;
}

function assertNonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label}必须是大于或等于 0 的有限数值`);
  }
  return value;
}

export function calculateQuoteTotalVolumeCbm(input: {
  pieces: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}): number | null {
  const values = [input.pieces, input.lengthCm, input.widthCm, input.heightCm]
    .map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const [pieces, lengthCm, widthCm, heightCm] = values;
  const volume = (pieces * lengthCm * widthCm * heightCm) / 1_000_000;
  // Significant digits remove binary floating noise without rounding tiny cargo to zero.
  return Number.isFinite(volume) ? Number(volume.toPrecision(15)) : null;
}

/** Display precision must never change the value submitted to the server. */
export function formatQuoteVolumeInput(volume: number | null): string {
  if (volume == null || !Number.isFinite(volume)) return "";
  return volume.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 15 });
}

export function resolveQuoteTotalVolumeCbm(input: {
  deriveFromDimensions: boolean;
  pieces: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  submittedVolumeCbm: number;
}): number {
  if (!input.deriveFromDimensions) {
    return assertNonNegativeFinite(input.submittedVolumeCbm, "预计体积");
  }
  return calculateQuoteTotalVolumeCbm(input)
    ?? assertNonNegativeFinite(input.submittedVolumeCbm, "预计体积");
}

/**
 * Product quantity is a commercial/customs fact. Package count is a physical
 * warehouse fact. They intentionally remain independent from this point on.
 */
export function quoteCargoProjection(input: {
  pieces: number;
  plannedPackageCount: number;
  totalGrossWeightKg: number;
  totalVolumeCbm: number;
}): QuoteCargoProjection {
  const packageCount = assertQuoteAutoPackageCount(input.plannedPackageCount);
  const declaredQuantity = assertNonNegativeFinite(input.pieces, "商品数量");
  if (declaredQuantity <= 0) throw new Error("商品数量必须大于 0");
  const totalGrossWeightKg = assertNonNegativeFinite(input.totalGrossWeightKg, "预计重量");
  const totalVolumeCbm = assertNonNegativeFinite(input.totalVolumeCbm, "预计体积");
  return {
    declaredQuantity,
    packageCount,
    piecesPerPackage: 1,
    grossWeightPerPackageKg: totalGrossWeightKg / packageCount,
    netWeightPerPackageKg: totalGrossWeightKg / packageCount,
    volumePerPackageCbm: totalVolumeCbm / packageCount,
  };
}
