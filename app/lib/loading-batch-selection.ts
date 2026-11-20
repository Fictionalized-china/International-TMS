export type LoadingBatchSelectionCandidate = {
  package_count: number;
  allocated_package_count: number;
};

/**
 * A normal consolidation batch still needs at least two orders. A one-order
 * batch is valid only when it is visibly part of a split transport: either an
 * earlier batch already owns OULs, or this batch deliberately leaves OULs for
 * a later batch.
 */
export function isSingleOrderPartialBatch(
  candidate: LoadingBatchSelectionCandidate,
  requestedPackageCount: number,
) {
  const available = Math.max(0, Number(candidate.package_count || 0));
  const allocated = Math.max(0, Number(candidate.allocated_package_count || 0));
  const requested = Math.trunc(Number(requestedPackageCount || 0));
  return requested >= 1 && requested <= available && (allocated > 0 || requested < available);
}

export function canCreateLoadingBatch(
  candidates: readonly LoadingBatchSelectionCandidate[],
  requestedPackageCounts: readonly number[],
) {
  if (candidates.length >= 2) return true;
  if (candidates.length !== 1) return false;
  return isSingleOrderPartialBatch(candidates[0], requestedPackageCounts[0] || 0);
}
