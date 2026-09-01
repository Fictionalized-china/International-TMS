import { env } from "cloudflare:workers";
import {
  maxInlineQuotationWorkflowFileBytes,
  quotationWorkflowFieldHasValue,
  quotationWorkflowFieldInputName,
  type QuotationWorkflowField,
  type QuotationWorkflowFieldValue,
} from "./quotation-workflow-fields";

export type PreparedQuotationWorkflowFieldValue = {
  field: QuotationWorkflowField;
  valueText: string | null;
  file: {
    name: string;
    type: string;
    size: number;
    dataUrl: string;
  } | null;
  keepExistingFile: boolean;
};

export async function listQuotationWorkflowFields(organizationId: string) {
  return (await env.DB.prepare(
    `SELECT f.id,f.workflow_id,COALESCE(f.module_code,'consignment') module_code,
      f.field_key,f.label,f.field_type,f.is_required,f.sort_order,f.options_text,f.help_text
     FROM workflow_step_fields f
     JOIN workflow_steps s ON s.id=f.step_id AND s.workflow_id=f.workflow_id
     JOIN workflow_definitions wd ON wd.id=f.workflow_id
     WHERE wd.organization_id=? AND s.step_key='quotation' AND s.is_active=1 AND f.is_active=1
     ORDER BY f.workflow_id,f.sort_order,f.label`,
  ).bind(organizationId).all<QuotationWorkflowField>()).results;
}

export async function listQuotationWorkflowFieldValues(
  organizationId: string,
  quotationIds: string[],
) {
  if (!quotationIds.length) return [];
  const placeholders = quotationIds.map(() => "?").join(",");
  return (await env.DB.prepare(
    `SELECT id,quotation_id,field_id,value_text,file_name,content_type,size_bytes
     FROM quotation_workflow_field_values
     WHERE organization_id=? AND quotation_id IN (${placeholders})
     ORDER BY created_at,id`,
  ).bind(organizationId, ...quotationIds).all<QuotationWorkflowFieldValue>()).results;
}

export async function prepareQuotationWorkflowFieldValues(input: {
  form: FormData;
  fields: QuotationWorkflowField[];
  existingValues?: QuotationWorkflowFieldValue[];
}) {
  const existingByField = new Map(
    (input.existingValues || []).map((value) => [value.field_id, value]),
  );
  const prepared: PreparedQuotationWorkflowFieldValue[] = [];
  for (const field of input.fields) {
    const name = quotationWorkflowFieldInputName(field.id);
    const existing = existingByField.get(field.id) || null;
    if (field.field_type === "attachment") {
      const raw = input.form.get(name);
      const file = raw instanceof File && raw.size > 0 ? raw : null;
      if (!file) {
        if (field.is_required && !quotationWorkflowFieldHasValue(field, existing))
          throw new Error(`请上传“${field.label}”`);
        prepared.push({ field, valueText: null, file: null, keepExistingFile: Boolean(existing?.file_name) });
        continue;
      }
      validateWorkflowFile(file, field.label);
      prepared.push({
        field,
        valueText: null,
        file: {
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          dataUrl: await toDataUrl(file),
        },
        keepExistingFile: false,
      });
      continue;
    }
    const values = input.form.getAll(name)
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    const valueText = field.field_type === "multiselect"
      ? values.length ? JSON.stringify(values) : null
      : values[0] || null;
    if (field.is_required && !valueText) throw new Error(`请填写“${field.label}”`);
    prepared.push({ field, valueText, file: null, keepExistingFile: false });
  }
  return prepared;
}

export async function savePreparedQuotationWorkflowFieldValues(input: {
  organizationId: string;
  quotationId: string;
  workflowId: string;
  actorUserId: string;
  values: PreparedQuotationWorkflowFieldValue[];
}) {
  const now = new Date().toISOString();
  const statements = input.values
    .filter((value) => !value.keepExistingFile)
    .map((value) => env.DB.prepare(
      `INSERT INTO quotation_workflow_field_values(
        id,organization_id,quotation_id,workflow_id,field_id,field_key,module_code,
        value_text,file_name,content_type,size_bytes,data_url,
        created_by_user_id,updated_by_user_id,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(quotation_id,field_id) DO UPDATE SET
         value_text=excluded.value_text,file_name=excluded.file_name,
         content_type=excluded.content_type,size_bytes=excluded.size_bytes,data_url=excluded.data_url,
         updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),input.organizationId,input.quotationId,input.workflowId,
      value.field.id,value.field.field_key,value.field.module_code,value.valueText,
      value.file?.name ?? null,value.file?.type ?? null,value.file?.size ?? null,
      value.file?.dataUrl ?? null,input.actorUserId,input.actorUserId,now,now,
    ));
  if (statements.length) await env.DB.batch(statements);
}

export async function assertQuotationWorkflowFieldsComplete(
  organizationId: string,
  quotationId: string,
) {
  const missing = await env.DB.prepare(
    `SELECT f.label
     FROM quotations q
     JOIN workflow_steps s
       ON s.workflow_id=q.workflow_definition_id AND s.step_key='quotation' AND s.is_active=1
     JOIN workflow_step_fields f
       ON f.workflow_id=s.workflow_id AND f.step_id=s.id AND f.is_active=1 AND f.is_required=1
     LEFT JOIN quotation_workflow_field_values v
       ON v.quotation_id=q.id AND v.workflow_id=q.workflow_definition_id AND v.field_id=f.id
     WHERE q.organization_id=? AND q.id=? AND (
       (f.field_type='attachment' AND COALESCE(TRIM(v.file_name),'')='') OR
       (f.field_type<>'attachment' AND COALESCE(TRIM(v.value_text),'')='')
     )
     ORDER BY f.sort_order,f.label LIMIT 8`,
  ).bind(organizationId,quotationId).all<{ label: string }>();
  if (missing.results.length)
    throw new Error(`询价报价第一步尚缺必填项：${missing.results.map((item) => item.label).join("、")}`);
}

function validateWorkflowFile(file: File, label: string) {
  if (file.size > maxInlineQuotationWorkflowFileBytes)
    throw new Error(`“${label}”附件不能超过 1.2MB`);
  const allowed = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  if (!allowed.has(file.type)) throw new Error(`“${label}”仅支持 PDF、Word、Excel、JPG、PNG 或 WebP`);
}

async function toDataUrl(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
}
