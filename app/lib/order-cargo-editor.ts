import { runtimeWorkflowFieldPolicy } from "./workflow-field-runtime";

export type CargoEditorWorkflowField = {
  fieldKey: string;
  label?: string;
  isActive: boolean;
  isRequired: boolean;
  optionsText?: string | null;
};

export type CargoEditorRecord = {
  cargoName: string;
  cargoNameEn: string;
  hsCode: string;
  overseasHsCode: string;
  packageType: string;
  packageCount: number;
  piecesPerPackage: number;
  weight: number;
  netWeight: number;
  length: number;
  width: number;
  height: number;
  volume: number;
  declaredValue: number;
  currency: string;
  originCountry: string;
  brandModel: string;
  marks: string;
  specialAttributes: string;
  notes: string;
};

export type CargoEditorSubmission = Record<string, string | string[]>;

const requiredByDefault = new Set([
  "cargo_name_cn",
  "package_type",
  "package_count",
  "pieces_per_package",
  "gross_weight_per_package_kg",
  "volume_per_package_cbm",
]);

const fieldNames = {
  cargo_name_cn: "cargoName",
  cargo_name_en: "cargoNameEn",
  hs_code: "hsCode",
  overseas_hs_code: "overseasHsCode",
  package_type: "packageType",
  package_count: "packageCount",
  pieces_per_package: "piecesPerPackage",
  gross_weight_per_package_kg: "weight",
  net_weight_per_package_kg: "netWeight",
  length_cm: "length",
  width_cm: "width",
  height_cm: "height",
  volume_per_package_cbm: "volume",
  declared_value: "declaredValue",
  currency: "currency",
  origin_country_cargo: "originCountry",
  brand_model: "brandModel",
  marks: "marks",
  special_attributes: "specialAttributes",
  cargo_notes: "notes",
} as const;

type CargoFieldKey = keyof typeof fieldNames;

const defaults: CargoEditorRecord = {
  cargoName: "",
  cargoNameEn: "",
  hsCode: "",
  overseasHsCode: "",
  packageType: "carton",
  packageCount: 1,
  piecesPerPackage: 1,
  weight: 0,
  netWeight: 0,
  length: 0,
  width: 0,
  height: 0,
  volume: 0,
  declaredValue: 0,
  currency: "USD",
  originCountry: "",
  brandModel: "",
  marks: "",
  specialAttributes: "",
  notes: "",
};

export function cargoEditorFieldPolicy(
  fields: readonly CargoEditorWorkflowField[],
  fieldKey: string,
) {
  return runtimeWorkflowFieldPolicy(
    fields,
    fieldKey,
    requiredByDefault.has(fieldKey),
  );
}

export function nextOrderPackageCodeSequence(orderNumber: string, packageCodes: readonly string[]) {
  const prefix = `${orderNumber}-P`;
  return packageCodes.reduce((max, packageCode) => {
    if (!packageCode.startsWith(prefix)) return max;
    const sequence = Number(packageCode.slice(prefix.length));
    return Number.isInteger(sequence) && sequence > 0 ? Math.max(max, sequence) : max;
  }, 0) + 1;
}

export function resolveCargoEditorSubmission(input: {
  fields: readonly CargoEditorWorkflowField[];
  submitted: CargoEditorSubmission;
  existing?: CargoEditorRecord | null;
  existingImageCount?: number;
  uploadedImageCount?: number;
}): { ok: true; value: CargoEditorRecord } | { ok: false; error: string } {
  const base = input.existing ?? defaults;
  const value = { ...base };
  const read = (fieldKey: CargoFieldKey) => {
    const policy = cargoEditorFieldPolicy(input.fields, fieldKey);
    if (!policy.visible) return undefined;
    const raw = input.submitted[fieldNames[fieldKey]];
    return Array.isArray(raw) ? raw.join(",") : (raw ?? "").trim();
  };
  const assignText = (fieldKey: CargoFieldKey, target: keyof CargoEditorRecord) => {
    const raw = read(fieldKey);
    if (raw !== undefined) (value[target] as string | number) = raw;
  };
  const assignNumber = (fieldKey: CargoFieldKey, target: keyof CargoEditorRecord) => {
    const raw = read(fieldKey);
    if (raw === undefined) return;
    const number = Number(raw || 0);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${cargoEditorFieldPolicy(input.fields, fieldKey).label || fieldKey}格式无效`);
    (value[target] as string | number) = number;
  };

  try {
    assignText("cargo_name_cn", "cargoName");
    assignText("cargo_name_en", "cargoNameEn");
    assignText("hs_code", "hsCode");
    assignText("overseas_hs_code", "overseasHsCode");
    assignText("package_type", "packageType");
    assignNumber("package_count", "packageCount");
    assignNumber("pieces_per_package", "piecesPerPackage");
    assignNumber("gross_weight_per_package_kg", "weight");
    assignNumber("net_weight_per_package_kg", "netWeight");
    assignNumber("length_cm", "length");
    assignNumber("width_cm", "width");
    assignNumber("height_cm", "height");
    assignNumber("volume_per_package_cbm", "volume");
    assignNumber("declared_value", "declaredValue");
    assignText("currency", "currency");
    assignText("origin_country_cargo", "originCountry");
    assignText("brand_model", "brandModel");
    assignText("marks", "marks");
    assignText("special_attributes", "specialAttributes");
    assignText("cargo_notes", "notes");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "货物数据格式无效" };
  }

  if (read("volume_per_package_cbm") !== undefined && value.volume <= 0) {
    value.volume = (value.length * value.width * value.height) / 1_000_000;
  }
  if (!Number.isInteger(value.packageCount) || value.packageCount < 1 || value.packageCount > 500)
    return { ok: false, error: "包装数量必须是 1—500 的整数" };
  if (!Number.isInteger(value.piecesPerPackage) || value.piecesPerPackage < 1)
    return { ok: false, error: "每包装件数必须是大于 0 的整数" };

  const present = (fieldKey: CargoFieldKey) => {
    const target = fieldNames[fieldKey];
    const current = value[target];
    return typeof current === "number" ? current > 0 : Boolean(current.trim());
  };
  for (const fieldKey of Object.keys(fieldNames) as CargoFieldKey[]) {
    const policy = cargoEditorFieldPolicy(input.fields, fieldKey);
    if (policy.visible && policy.required && !present(fieldKey))
      return { ok: false, error: `请填写${policy.label || fieldKey}` };
  }
  const imagePolicy = cargoEditorFieldPolicy(input.fields, "cargo_images");
  if (imagePolicy.visible && imagePolicy.required &&
    (input.existingImageCount ?? 0) + (input.uploadedImageCount ?? 0) === 0)
    return { ok: false, error: `请填写${imagePolicy.label || "货物图片"}` };

  for (const fieldKey of ["package_type", "currency", "special_attributes"] as const) {
    const field = input.fields.find((item) => item.fieldKey === fieldKey);
    if (!field?.isActive || !field.optionsText) continue;
    const allowed = new Set(field.optionsText.split(/\r?\n|,/).map((entry) => entry.trim().split("|")[0]).filter(Boolean));
    const submittedValues = fieldKey === "special_attributes"
      ? value.specialAttributes.split(",").filter(Boolean)
      : [fieldKey === "package_type" ? value.packageType : value.currency].filter(Boolean);
    if (submittedValues.some((entry) => !allowed.has(entry)))
      return { ok: false, error: `${field.label || fieldKey}选项无效，请从当前工作流配置中选择` };
  }

  return { ok: true, value };
}
