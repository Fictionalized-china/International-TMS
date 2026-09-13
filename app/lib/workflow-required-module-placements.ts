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
  return Boolean(
    allowedSteps &&
    stepKeys.length === allowedSteps.size &&
    new Set(stepKeys).size === stepKeys.length &&
    stepKeys.every((stepKey) => allowedSteps.has(stepKey)),
  );
}
