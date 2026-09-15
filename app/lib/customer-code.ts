export function resolveCustomerCode(code: string, identityCode: string) {
  const normalized = code.trim().toLowerCase();
  return normalized || `cus-${identityCode.toLowerCase()}`;
}
