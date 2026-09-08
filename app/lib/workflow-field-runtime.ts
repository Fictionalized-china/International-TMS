export type RuntimeWorkflowFieldLike = {
  fieldKey: string;
  label?: string;
  isActive: boolean;
  isRequired: boolean;
};

export const frozenWorkflowFieldScopeMarkerKey =
  "__frozen_workflow_field_scope__";

const historicalWorkflowFieldAliases: Readonly<Record<string, readonly string[]>> = {
  domestic_carrier_id: ["carrier_name"],
  domestic_vehicle_type: ["vehicle_type"],
  domestic_plate_number: ["vehicle_plate"],
  domestic_driver_name: ["driver_name"],
  domestic_driver_phone: ["driver_phone"],
  domestic_actual_pickup_at: ["actual_pickup_at"],
  primary_operator: ["operator"],
  origin_address: ["pickup_address"],
  requested_pickup_date: ["pickup_time"],
  overseas_warehouse_id: ["overseas_warehouse"],
  shipper_contact: ["pickup_contact"],
  shipper_phone: ["pickup_phone"],
};

export function workflowFieldKeyCandidates(fieldKey: string) {
  return [fieldKey, ...(historicalWorkflowFieldAliases[fieldKey] || [])];
}

export function isFrozenWorkflowFieldScopeMarker(
  field: Pick<RuntimeWorkflowFieldLike, "fieldKey">,
) {
  return field.fieldKey === frozenWorkflowFieldScopeMarkerKey;
}

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
  const candidates = workflowFieldKeyCandidates(fieldKey);
  const configured = candidates
    .map((candidate) => fields.find(
      (field) =>
        !isFrozenWorkflowFieldScopeMarker(field) && field.fieldKey === candidate,
    ))
    .find(Boolean);
  if (configured) {
    return {
      visible: configured.isActive,
      required: configured.isActive && configured.isRequired,
      label: configured.label,
      configured: true,
    };
  }
  const frozenScope = fields.some(isFrozenWorkflowFieldScopeMarker);
  const configuredFieldCount = fields.filter(
    (field) => !isFrozenWorkflowFieldScopeMarker(field),
  ).length;
  const legacyFallback = !frozenScope && configuredFieldCount === 0;
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
