import {
  quotationNativeFieldCatalog,
  quotationNativeFieldKeySet,
  type QuotationNativeFieldKey,
  type QuotationNativeFieldMode,
} from "./quotation-native-field-catalog";

export type QuotationWorkflowField = {
  id: string;
  workflow_id: string;
  module_code: string;
  field_key: string;
  label: string;
  field_type: string;
  is_required: number;
  is_active: number;
  sort_order: number;
  options_text: string | null;
  help_text: string | null;
};

// Compatibility exports for callers that pre-date the single native-field
// registry. Their values are derived from the registry so the UI, validation
// and workflow catalog cannot silently drift apart again.
export const quotationBuiltInWorkflowFieldKeys = quotationNativeFieldCatalog.map(
  (field) => field.fieldKey,
);
export const quotationBuiltInWorkflowFieldKeySet = quotationNativeFieldKeySet;
export type QuotationBuiltInWorkflowFieldKey = QuotationNativeFieldKey;
export type QuotationWorkflowFieldMode = QuotationNativeFieldMode;

export function quotationWorkflowFieldPolicy(
  fields: readonly QuotationWorkflowField[],
  fieldKey: QuotationBuiltInWorkflowFieldKey,
  fallbackMode: QuotationWorkflowFieldMode,
) {
  const configured = fields.find((field) => field.field_key === fieldKey);
  if (configured) {
    return {
      isActive: Boolean(configured.is_active),
      isRequired: Boolean(configured.is_active && configured.is_required),
    };
  }
  return {
    isActive: fallbackMode !== "hidden",
    isRequired: fallbackMode === "required",
  };
}

export function activeQuotationCustomWorkflowFields(
  fields: readonly QuotationWorkflowField[],
) {
  return fields.filter(
    (field) =>
      Boolean(field.is_active) &&
      !quotationBuiltInWorkflowFieldKeySet.has(field.field_key),
  );
}

export type QuotationWorkflowFieldValue = {
  id: string;
  quotation_id: string;
  field_id: string;
  field_key: string;
  value_text: string | null;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
};

export const maxInlineQuotationWorkflowFileBytes = 1_200_000;

export function quotationWorkflowFieldInputName(fieldId: string) {
  return `workflowField_${fieldId}`;
}

export function parseQuotationWorkflowFieldOptions(optionsText: string | null) {
  return (optionsText || "")
    .split(/\r?\n|,/)
    .map((option) => option.trim())
    .filter(Boolean)
    .map((option) => {
      const [value, label] = option.split("|");
      return { value, label: label || value };
    });
}

export function quotationWorkflowFieldHasValue(
  field: Pick<QuotationWorkflowField, "field_type">,
  value: Pick<QuotationWorkflowFieldValue, "value_text" | "file_name"> | null,
) {
  if (!value) return false;
  return field.field_type === "attachment"
    ? Boolean(value.file_name?.trim())
    : Boolean(value.value_text?.trim());
}

export function quotationWorkflowDisplayValue(
  field: Pick<QuotationWorkflowField, "field_type" | "options_text">,
  value: Pick<QuotationWorkflowFieldValue, "value_text" | "file_name"> | null,
) {
  if (!value) return "—";
  if (field.field_type === "attachment") return value.file_name || "—";
  const stored = value.value_text?.trim();
  if (!stored) return "—";
  const options = parseQuotationWorkflowFieldOptions(field.options_text);
  const labels = new Map(options.map((option) => [option.value, option.label]));
  if (field.field_type === "multiselect") {
    let selected: string[];
    try {
      const parsed = JSON.parse(stored);
      selected = Array.isArray(parsed) ? parsed.map(String) : [stored];
    } catch {
      selected = stored.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return selected.map((item) => labels.get(item) || item).join("、") || "—";
  }
  return labels.get(stored) || stored;
}
