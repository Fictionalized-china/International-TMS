import { customsDeclarationNumericErrors } from "./customs-declarations";
import { runtimeWorkflowFieldPolicy, type RuntimeWorkflowFieldLike } from "./workflow-field-runtime";

export type CustomsDeclarationWorkflowField = RuntimeWorkflowFieldLike;

export type ExistingCustomsDeclarationInput = {
  clearance_stage: string;
  status: string;
  declaration_number: string;
  declaration_type: string;
  declaration_title: string;
  declaring_company: string;
  declared_at: string;
  declared_amount: number;
  currency: string;
  gross_weight_kg: number;
  released_at: string | null;
  is_deleted: number;
  is_redeclared: number;
  is_amended: number;
  is_inspected: number;
  change_reason: string | null;
};

export type ResolvedCustomsDeclarationInput = {
  clearanceStage: string;
  declarationStatus: string;
  declarationNumber: string;
  declarationType: string;
  declarationTitle: string;
  declaringCompany: string;
  declaredAt: string;
  declaredAmount: number;
  currency: string;
  grossWeightKg: number;
  releasedAt: string | null;
  isDeleted: boolean;
  isRedeclared: boolean;
  isAmended: boolean;
  isInspected: boolean;
  changeReason: string;
};

type FieldBinding = {
  fieldKey: string;
  formNames: string[];
  label: string;
  fallbackRequired?: boolean;
};

const fieldBindings: FieldBinding[] = [
  { fieldKey: "declaration_stage", formNames: ["clearanceStage"], label: "报关作业阶段", fallbackRequired: true },
  { fieldKey: "declaration_status", formNames: ["status"], label: "申报单状态", fallbackRequired: true },
  { fieldKey: "declaration_number", formNames: ["declarationNumber"], label: "报关单号", fallbackRequired: true },
  { fieldKey: "declaration_type", formNames: ["declarationType"], label: "报关单类型", fallbackRequired: true },
  { fieldKey: "declaration_title", formNames: ["declarationTitle"], label: "申报抬头", fallbackRequired: true },
  { fieldKey: "declaring_company", formNames: ["declaringCompany"], label: "申报公司", fallbackRequired: true },
  { fieldKey: "declared_at", formNames: ["declaredAt"], label: "申报时间", fallbackRequired: true },
  { fieldKey: "declared_amount", formNames: ["declaredAmount"], label: "申报金额", fallbackRequired: true },
  { fieldKey: "declaration_currency", formNames: ["currency"], label: "申报币种", fallbackRequired: true },
  { fieldKey: "declaration_gross_weight", formNames: ["grossWeightKg"], label: "申报毛重", fallbackRequired: true },
  { fieldKey: "declaration_change_flags", formNames: ["isDeleted", "isRedeclared", "isAmended", "isInspected"], label: "业务变更标记" },
  { fieldKey: "declaration_change_reason", formNames: ["changeReason"], label: "申报变更原因" },
  { fieldKey: "customs_release", formNames: ["releaseDeclaration", "releasedAt"], label: "海关放行", fallbackRequired: true },
];

function valueOf(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(
  form: FormData,
  fieldVisible: boolean,
  key: string,
  existing: number | undefined,
) {
  return fieldVisible ? form.has(key) : existing === 1;
}

export function resolveCustomsDeclarationWorkflowInput(input: {
  form: FormData;
  fields: readonly CustomsDeclarationWorkflowField[];
  existing?: ExistingCustomsDeclarationInput | null;
  now: string;
  autoDeclarationNumber: string;
}): { value?: ResolvedCustomsDeclarationInput; error?: string } {
  const declarationsPolicy = runtimeWorkflowFieldPolicy(
    input.fields,
    "customs_declarations",
    true,
  );
  if (!declarationsPolicy.visible) {
    return { error: "当前工作流未启用报关申报明细，不能提交报关单" };
  }

  for (const binding of fieldBindings) {
    const policy = runtimeWorkflowFieldPolicy(
      input.fields,
      binding.fieldKey,
      binding.fallbackRequired ?? false,
    );
    if (!policy.visible && binding.formNames.some((name) => input.form.has(name))) {
      return {
        error: `当前工作流已隐藏“${policy.label || binding.label}”，不能提交该字段`,
      };
    }
  }

  const policy = (fieldKey: string, fallbackRequired = false) =>
    runtimeWorkflowFieldPolicy(input.fields, fieldKey, fallbackRequired);
  const releaseRequested = valueOf(input.form, "releaseDeclaration") === "1";
  const visibleText = (
    fieldKey: string,
    formName: string,
    existing: string | number | null | undefined,
    fallback: string,
    fallbackRequired = false,
  ) => policy(fieldKey, fallbackRequired).visible
    ? (releaseRequested && !input.form.has(formName)
      ? String(existing ?? fallback)
      : valueOf(input.form, formName))
    : String(existing ?? fallback);

  const changeFlagsVisible = policy("declaration_change_flags").visible;
  const isDeleted = booleanValue(input.form, changeFlagsVisible, "isDeleted", input.existing?.is_deleted);
  const isRedeclared = booleanValue(input.form, changeFlagsVisible, "isRedeclared", input.existing?.is_redeclared);
  const isAmended = booleanValue(input.form, changeFlagsVisible, "isAmended", input.existing?.is_amended);
  const isInspected = booleanValue(input.form, changeFlagsVisible, "isInspected", input.existing?.is_inspected);
  const statusPolicy = policy("declaration_status", true);
  const releasePolicy = policy("customs_release", true);
  const requestedStatus = releaseRequested
    ? "released"
    : statusPolicy.visible
      ? valueOf(input.form, "status") || input.existing?.status || "declared"
      : input.existing?.status || "declared";
  const declarationStatus = isDeleted ? "cancelled" : requestedStatus;
  if (!["declared", "released", "cancelled"].includes(declarationStatus)) {
    return { error: "申报单状态无效" };
  }
  const changesToReleased = releaseRequested || (
    statusPolicy.visible && input.form.has("status") &&
    valueOf(input.form, "status") === "released" &&
    input.existing?.status !== "released"
  );
  if (changesToReleased && !releasePolicy.visible) {
    return { error: "当前工作流已隐藏“海关放行”，不能确认放行" };
  }

  const clearanceStage = visibleText(
    "declaration_stage", "clearanceStage", input.existing?.clearance_stage, "origin", true,
  ) || "origin";
  if (!["origin", "transit", "destination"].includes(clearanceStage)) {
    return { error: "报关作业阶段无效" };
  }
  const declarationNumber = visibleText(
    "declaration_number", "declarationNumber", input.existing?.declaration_number,
    input.autoDeclarationNumber, true,
  );
  const declarationType = visibleText(
    "declaration_type", "declarationType", input.existing?.declaration_type, "未配置", true,
  );
  const declarationTitle = visibleText(
    "declaration_title", "declarationTitle", input.existing?.declaration_title, "未配置", true,
  );
  const declaringCompany = visibleText(
    "declaring_company", "declaringCompany", input.existing?.declaring_company, "未配置", true,
  );
  const declaredAt = visibleText(
    "declared_at", "declaredAt", input.existing?.declared_at, input.now, true,
  );
  const declaredAmountText = visibleText(
    "declared_amount", "declaredAmount", input.existing?.declared_amount, "0", true,
  );
  const currency = visibleText(
    "declaration_currency", "currency", input.existing?.currency, "USD", true,
  ).toUpperCase();
  const grossWeightText = visibleText(
    "declaration_gross_weight", "grossWeightKg", input.existing?.gross_weight_kg, "0", true,
  );
  const changeReason = visibleText(
    "declaration_change_reason", "changeReason", input.existing?.change_reason, "",
  );
  const releasedAt = declarationStatus === "released"
    ? (releasePolicy.visible
      ? valueOf(input.form, "releasedAt") || input.existing?.released_at || input.now
      : input.existing?.released_at || null)
    : null;

  const requiredValues = [
    ["declaration_stage", clearanceStage, true],
    ["declaration_status", declarationStatus, true],
    ["declaration_number", declarationNumber, true],
    ["declaration_type", declarationType, true],
    ["declaration_title", declarationTitle, true],
    ["declaring_company", declaringCompany, true],
    ["declared_at", declaredAt, true],
    ["declared_amount", declaredAmountText, true],
    ["declaration_currency", currency, true],
    ["declaration_gross_weight", grossWeightText, true],
    ["declaration_change_flags", isDeleted || isRedeclared || isAmended || isInspected ? "1" : "", false],
    ["declaration_change_reason", changeReason, false],
  ] as const;
  const missing = requiredValues.flatMap(([fieldKey, value, fallbackRequired]) => {
    const fieldPolicy = policy(fieldKey, fallbackRequired);
    return fieldPolicy.visible && fieldPolicy.required && !String(value).trim()
      ? [fieldPolicy.label || fieldBindings.find((item) => item.fieldKey === fieldKey)?.label || fieldKey]
      : [];
  });
  if (declarationStatus === "released" && releasePolicy.required && !releasedAt) {
    missing.push(releasePolicy.label || "海关放行");
  }
  if (missing.length) {
    return { error: `请填写当前模板要求的字段：${missing.join("、")}` };
  }

  const declaredAmount = declaredAmountText ? Number(declaredAmountText) : 0;
  const grossWeightKg = grossWeightText ? Number(grossWeightText) : 0;
  const numericErrors = customsDeclarationNumericErrors({
    declaredAmount,
    grossWeightKg,
    declaredAmountRequired: !isDeleted && policy("declared_amount", true).required,
    grossWeightRequired: !isDeleted && policy("declaration_gross_weight", true).required,
  });
  if (numericErrors.length) return { error: numericErrors.join("；") };

  return {
    value: {
      clearanceStage,
      declarationStatus,
      declarationNumber: declarationNumber || input.autoDeclarationNumber,
      declarationType: declarationType || "未配置",
      declarationTitle: declarationTitle || "未配置",
      declaringCompany: declaringCompany || "未配置",
      declaredAt: declaredAt || input.now,
      declaredAmount,
      currency: currency || "USD",
      grossWeightKg,
      releasedAt,
      isDeleted,
      isRedeclared,
      isAmended,
      isInspected,
      changeReason,
    },
  };
}
