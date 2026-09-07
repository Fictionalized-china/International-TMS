import { workflowFieldCatalogByKey, workflowFieldModeFlags } from "./workflow-field-catalog";

export type PickupWorkflowFieldKey = "overseas_pickup_contact" | "pickup_proof";

type PickupWorkflowFieldSource = {
  stepKey: string;
  fieldKey: string;
  label: string;
  helpText: string | null;
  isActive: boolean;
  isRequired: boolean;
};

export type PickupWorkflowFieldPolicy = {
  fieldKey: PickupWorkflowFieldKey;
  label: string;
  helpText: string | null;
  visible: boolean;
  required: boolean;
};

export type PickupWorkflowPolicy = {
  contact: PickupWorkflowFieldPolicy;
  proof: PickupWorkflowFieldPolicy;
};

function hiddenPolicy(fieldKey: PickupWorkflowFieldKey): PickupWorkflowFieldPolicy {
  const catalog = workflowFieldCatalogByKey.get(fieldKey);
  return {
    fieldKey,
    label: catalog?.label || fieldKey,
    helpText: catalog?.helpText || null,
    visible: false,
    required: false,
  };
}

function catalogPolicy(fieldKey: PickupWorkflowFieldKey): PickupWorkflowFieldPolicy {
  const catalog = workflowFieldCatalogByKey.get(fieldKey);
  const flags = workflowFieldModeFlags(catalog?.defaultMode || "hidden");
  return {
    fieldKey,
    label: catalog?.label || fieldKey,
    helpText: catalog?.helpText || null,
    visible: flags.isActive === 1,
    required: flags.isActive === 1 && flags.isRequired === 1,
  };
}

function fieldPolicy(
  fields: PickupWorkflowFieldSource[],
  fieldKey: PickupWorkflowFieldKey,
  targetStepKey: string | null,
  legacyFallback: boolean,
) {
  const candidates = fields.filter((field) => field.fieldKey === fieldKey);
  const configured = targetStepKey
    ? candidates.find((field) => field.stepKey === targetStepKey)
    : candidates[0];
  if (!configured) return legacyFallback ? catalogPolicy(fieldKey) : hiddenPolicy(fieldKey);
  return {
    fieldKey,
    label: configured.label,
    helpText: configured.helpText,
    visible: configured.isActive,
    required: configured.isActive && configured.isRequired,
  } satisfies PickupWorkflowFieldPolicy;
}

export function resolvePickupWorkflowPolicy(input: {
  fields: PickupWorkflowFieldSource[];
  targetStepKey: string | null;
  legacyFallback: boolean;
}): PickupWorkflowPolicy {
  return {
    contact: fieldPolicy(
      input.fields,
      "overseas_pickup_contact",
      input.targetStepKey,
      input.legacyFallback,
    ),
    proof: fieldPolicy(
      input.fields,
      "pickup_proof",
      input.targetStepKey,
      input.legacyFallback,
    ),
  };
}

export function validatePickupWorkflowSubmission(
  policy: PickupWorkflowPolicy,
  values: { pickupContact: string; pickupProofReference: string },
) {
  const pickupContact = policy.contact.visible ? values.pickupContact.trim() : "";
  const pickupProofReference = policy.proof.visible ? values.pickupProofReference.trim() : "";
  if (policy.contact.required && !pickupContact)
    return { error: `请填写“${policy.contact.label}”`, pickupContact: null, pickupProofReference: null };
  if (policy.proof.required && !pickupProofReference)
    return { error: `请填写“${policy.proof.label}”`, pickupContact: null, pickupProofReference: null };
  return {
    error: null,
    pickupContact: pickupContact || null,
    pickupProofReference: pickupProofReference || null,
  };
}
