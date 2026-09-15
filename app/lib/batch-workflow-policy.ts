import {
  runtimeWorkflowFieldPolicy,
  type RuntimeWorkflowFieldLike,
} from "./workflow-field-runtime";

export type BatchWorkflowModuleCode = "loading" | "tracking" | "customs";

export type BatchOrderWorkflowPolicy = {
  orderId: string;
  businessType: string;
  moduleCode: BatchWorkflowModuleCode;
  enabled: boolean;
  required: boolean;
  fields: Array<RuntimeWorkflowFieldLike & { label?: string }>;
};

export function orderBatchWorkflowPolicy(
  policies: readonly BatchOrderWorkflowPolicy[],
  orderId: string,
  moduleCode: BatchWorkflowModuleCode,
) {
  return policies.find(
    (policy) => policy.orderId === orderId && policy.moduleCode === moduleCode,
  ) ?? {
    orderId,
    businessType: "",
    moduleCode,
    enabled: false,
    required: false,
    fields: [],
  };
}

export function batchWorkflowModulePolicy(
  policies: readonly BatchOrderWorkflowPolicy[],
  moduleCode: BatchWorkflowModuleCode,
) {
  const modules = policies.filter((policy) => policy.moduleCode === moduleCode);
  const enabled = modules.filter((policy) => policy.enabled);
  return {
    enabled: enabled.length > 0,
    required: enabled.some((policy) => policy.required),
    enabledOrderCount: enabled.length,
    totalOrderCount: new Set(modules.map((policy) => policy.orderId)).size,
  };
}

/**
 * Shared batch forms are the union of enabled order fields: a field remains
 * usable when at least one mounted order enables it, and becomes required in
 * the form when any enabled order requires it. Module requiredness is kept
 * separate so optional modules never become a batch progress gate.
 */
export function batchWorkflowFieldPolicy(
  policies: readonly BatchOrderWorkflowPolicy[],
  moduleCode: BatchWorkflowModuleCode,
  fieldKey: string,
  fallbackRequired = false,
) {
  const enabled = policies.filter(
    (policy) => policy.moduleCode === moduleCode && policy.enabled,
  );
  const fieldPolicies = enabled.map((module) =>
    runtimeWorkflowFieldPolicy(module.fields, fieldKey, fallbackRequired),
  );
  const visible = fieldPolicies.some((field) => field.visible);
  return {
    visible,
    required: visible && fieldPolicies.some((field) => field.visible && field.required),
    label: fieldPolicies.find((field) => field.visible && field.label)?.label,
    configured: fieldPolicies.some((field) => field.configured),
  };
}

export function orderWorkflowFieldBlocksBatch(
  policies: readonly BatchOrderWorkflowPolicy[],
  orderId: string,
  moduleCode: BatchWorkflowModuleCode,
  fieldKey: string,
  fallbackRequired = false,
) {
  const module = orderBatchWorkflowPolicy(policies, orderId, moduleCode);
  if (!module.enabled || !module.required) return false;
  return runtimeWorkflowFieldPolicy(
    module.fields,
    fieldKey,
    fallbackRequired,
  ).required;
}

export type BatchWorkflowFormBinding = {
  moduleCode: BatchWorkflowModuleCode;
  fieldKey: string;
  formNames: string[];
  label: string;
  fallbackRequired?: boolean;
};

/** Enforce the same workflow-field visibility contract on batch form POSTs. */
export function validateBatchWorkflowFormSubmission(
  policies: readonly BatchOrderWorkflowPolicy[],
  form: FormData,
  bindings: readonly BatchWorkflowFormBinding[],
) {
  const missing: string[] = [];
  for (const binding of bindings) {
    const field = batchWorkflowFieldPolicy(
      policies,
      binding.moduleCode,
      binding.fieldKey,
      binding.fallbackRequired ?? false,
    );
    const posted = binding.formNames.some((name) => form.has(name));
    if (!field.visible && posted) {
      return `当前工作流已隐藏“${field.label || binding.label}”，不能提交该字段`;
    }
    if (!field.visible || !field.required) continue;
    const hasValue = binding.formNames.some((name) => {
      const value = form.get(name);
      return typeof value === "string" ? value.trim().length > 0 : value !== null;
    });
    if (!hasValue) missing.push(field.label || binding.label);
  }
  return missing.length
    ? `请填写当前工作流要求的字段：${Array.from(new Set(missing)).join("、")}`
    : null;
}
