import { env } from "cloudflare:workers";
import { intakeRouteFields, type IntakeFieldPolicy, type IntakeRouteReference, type IntakeRouteValues } from "./intake-route-fields";

export async function listIntakeRouteReferences(organizationId: string) {
  const rows = await env.DB.prepare(`SELECT category,code,name FROM reference_data
    WHERE organization_id=? AND status='active' AND category IN ('border_port','transit_place','customs_place')
    ORDER BY category,sort_order,name,code`).bind(organizationId).all<IntakeRouteReference>();
  return rows.results;
}

export async function resolveIntakeRouteFields(input: {
  organizationId: string;
  form: FormData;
  direct: boolean;
  policy: (fieldKey: string) => IntakeFieldPolicy;
  existing?: Record<string, unknown>;
}): Promise<IntakeRouteValues> {
  const values = {} as IntakeRouteValues;
  const errors: string[] = [];
  const toValidate: typeof intakeRouteFields[number][] = [];
  for (const field of intakeRouteFields) {
    const policy = input.policy(field.fieldKey);
    const previous = String(input.existing?.[field.column] ?? "").trim();
    const editable = (input.direct || policy.isActive) && (!input.existing || input.form.has(field.formName));
    if (editable && input.form.get(field.formName) !== null && typeof input.form.get(field.formName) !== "string")
      errors.push(`“${field.label}”必须是文本，不能上传文件代替`);
    const value = editable ? String(input.form.get(field.formName) ?? "").trim() : previous;
    values[field.column] = value || null;
    if ((input.direct || policy.isRequired) && !value) errors.push(`请填写“${field.label}”`);
    if (value.length > field.maxLength || /[\u0000-\u001f\u007f]/.test(value)) errors.push(`“${field.label}”最多 ${field.maxLength} 字，不能包含控制字符`);
    // A reference disabled after intake must not block an unrelated correction.
    if (field.category && value && (!input.existing || value !== previous)) toValidate.push(field);
  }
  if (toValidate.length) {
    const references = await listIntakeRouteReferences(input.organizationId);
    for (const field of toValidate) if (!references.some(row => row.category === field.category && row.code === values[field.column]))
      errors.push(`请选择当前组织基础数据中启用的“${field.label}”`);
  }
  if (errors.length) throw new Error(errors.join("；"));
  return values;
}
