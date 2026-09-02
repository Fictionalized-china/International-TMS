export type RuntimeWorkflowFieldLike = {
  fieldKey: string;
  label?: string;
  isActive: boolean;
  isRequired: boolean;
};

/**
 * Resolve one field exactly as the bound workflow snapshot defines it.
 *
 * A populated snapshot is authoritative: a key missing from it must not leak
 * into the page through a hard-coded legacy fallback. Completely empty
 * snapshots are treated as historical data and keep the old page defaults.
 */
export function runtimeWorkflowFieldPolicy(
  fields: readonly RuntimeWorkflowFieldLike[],
  fieldKey: string,
  fallbackRequired = false,
) {
  const configured = fields.find((field) => field.fieldKey === fieldKey);
  if (configured) {
    return {
      visible: configured.isActive,
      required: configured.isActive && configured.isRequired,
      label: configured.label,
      configured: true,
    };
  }
  const legacyFallback = fields.length === 0;
  return {
    visible: legacyFallback,
    required: legacyFallback && fallbackRequired,
    label: undefined,
    configured: false,
  };
}

export function hasVisibleRuntimeWorkflowField(
  fields: readonly RuntimeWorkflowFieldLike[],
  fieldKeys: readonly string[],
) {
  return fieldKeys.some(
    (fieldKey) => runtimeWorkflowFieldPolicy(fields, fieldKey).visible,
  );
}
