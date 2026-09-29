const allowedRepeatedRequiredModuleSteps: Readonly<Record<string, ReadonlySet<string>>> = {
  consignment: new Set([
    "quotation",
    "order_creation",
    "consignment_approval",
  ]),
};

/**
 * A module normally has one required placement because order module progress is
 * aggregated by module code. Consignment is the sole deliberate exception: its
 * three pre-execution states are advanced by the quotation/order status machine.
 */
export function isAllowedRepeatedRequiredModulePlacement(
  moduleCode: string,
  stepKeys: readonly string[],
) {
  const allowedSteps = allowedRepeatedRequiredModuleSteps[moduleCode];
  const distinctSteps = new Set(stepKeys);
  if (!allowedSteps || distinctSteps.size !== stepKeys.length) return false;
  if (stepKeys.length === allowedSteps.size) {
    return stepKeys.every((stepKey) => allowedSteps.has(stepKey));
  }
  // The direct-entry standard makes quotation optional while the two
  // order-status-driven consignment gates remain required.
  return distinctSteps.size === 2 &&
    distinctSteps.has("order_creation") &&
    distinctSteps.has("consignment_approval");
}
