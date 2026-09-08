export type OverseasInboundScannablePackage = {
  barcode: string;
  package_number?: string | null;
};

function normalizeScanCode(value: string | null | undefined) {
  return value?.trim().toUpperCase() || "";
}

/**
 * When the receiving scope was opened by scanning an OUL, that first scan is
 * already a physical package scan and must be included in the temporary batch.
 * An OUT task code only opens the scope and therefore never seeds an OUL scan.
 */
export function initialOverseasInboundScans(
  reference: string,
  packages: readonly OverseasInboundScannablePackage[],
) {
  const normalizedReference = normalizeScanCode(reference);
  if (!normalizedReference) return [];

  const matchedPackage = packages.find((item) =>
    [item.barcode, item.package_number]
      .map(normalizeScanCode)
      .includes(normalizedReference),
  );

  const barcode = normalizeScanCode(matchedPackage?.barcode);
  return barcode ? [barcode] : [];
}
