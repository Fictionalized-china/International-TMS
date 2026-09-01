import { env } from "cloudflare:workers";
import {
  quotationNativeFieldKeySet,
  quotationNativeFieldPresent,
} from "./quotation-native-field-catalog";
import {
  maxInlineQuotationWorkflowFileBytes,
  quotationWorkflowFieldHasValue,
  quotationWorkflowFieldInputName,
  type QuotationWorkflowField,
  type QuotationWorkflowFieldValue,
} from "./quotation-workflow-fields";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";

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
      f.field_key,f.label,f.field_type,f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text
     FROM workflow_step_fields f
     JOIN workflow_steps s ON s.id=f.step_id AND s.workflow_id=f.workflow_id
     JOIN workflow_definitions wd ON wd.id=f.workflow_id
     WHERE wd.organization_id=? AND s.step_key='quotation' AND s.is_active=1
     ORDER BY f.workflow_id,f.sort_order,f.label`,
  ).bind(organizationId).all<QuotationWorkflowField>()).results;
}

export async function listQuotationWorkflowInstanceFields(
  organizationId: string,
  quotationIds: string[],
) {
  if (!quotationIds.length) return [];
  const uniqueQuotationIds = [...new Set(quotationIds)];
  const rows: Array<QuotationWorkflowField & { quotation_id: string }> = [];
  for (const chunk of chunkD1Values(uniqueQuotationIds, 1)) {
    const result = await env.DB.prepare(
      `SELECT wi.quotation_id,definition_field.id,f.workflow_id,
        COALESCE(f.module_code,'consignment') module_code,
        f.field_key,f.label,f.field_type,f.is_required,f.is_active,f.sort_order,
        f.options_text,f.help_text
       FROM workflow_instances wi
       JOIN workflow_instance_fields f ON f.instance_id=wi.id
       JOIN workflow_step_fields definition_field
         ON definition_field.workflow_id=f.workflow_id
        AND definition_field.field_key=f.field_key
        AND COALESCE(definition_field.module_code,'consignment')=COALESCE(f.module_code,'consignment')
       JOIN workflow_steps definition_step
         ON definition_step.id=definition_field.step_id
        AND definition_step.step_key='quotation'
       WHERE wi.organization_id=? AND wi.quotation_id IN (${d1Placeholders(chunk.length)})
         AND f.step_key='quotation'
       ORDER BY wi.quotation_id,f.sort_order,f.label`,
    ).bind(organizationId, ...chunk).all<QuotationWorkflowField & {
      quotation_id: string;
    }>();
    rows.push(...result.results);
  }
  return rows;
}

export async function listQuotationWorkflowFieldValues(
  organizationId: string,
  quotationIds: string[],
) {
  if (!quotationIds.length) return [];
  const uniqueQuotationIds = [...new Set(quotationIds)];
  const rows: QuotationWorkflowFieldValue[] = [];
  for (const chunk of chunkD1Values(uniqueQuotationIds, 1)) {
    const result = await env.DB.prepare(
      `SELECT id,quotation_id,field_id,field_key,value_text,file_name,content_type,size_bytes
       FROM quotation_workflow_field_values
       WHERE organization_id=? AND quotation_id IN (${d1Placeholders(chunk.length)})
       ORDER BY created_at,id`,
    ).bind(organizationId, ...chunk).all<QuotationWorkflowFieldValue>();
    rows.push(...result.results);
  }
  return rows;
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
    if (!field.is_active || quotationNativeFieldKeySet.has(field.field_key)) continue;
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
  guard?: {
    quotationUpdatedAt: string;
  };
}) {
  const now = new Date().toISOString();
  const statements = input.values
    .filter((value) => !value.keepExistingFile)
    .map((value) => {
      const values = [
        crypto.randomUUID(),input.organizationId,input.quotationId,input.workflowId,
        value.field.id,value.field.field_key,value.field.module_code,value.valueText,
        value.file?.name ?? null,value.file?.type ?? null,value.file?.size ?? null,
        value.file?.dataUrl ?? null,input.actorUserId,input.actorUserId,now,now,
      ];
      if (!input.guard) {
        return env.DB.prepare(
          `INSERT INTO quotation_workflow_field_values(
            id,organization_id,quotation_id,workflow_id,field_id,field_key,module_code,
            value_text,file_name,content_type,size_bytes,data_url,
            created_by_user_id,updated_by_user_id,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(quotation_id,field_id) DO UPDATE SET
             value_text=excluded.value_text,file_name=excluded.file_name,
             content_type=excluded.content_type,size_bytes=excluded.size_bytes,data_url=excluded.data_url,
             updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
        ).bind(...values);
      }
      return env.DB.prepare(
        `INSERT INTO quotation_workflow_field_values(
          id,organization_id,quotation_id,workflow_id,field_id,field_key,module_code,
          value_text,file_name,content_type,size_bytes,data_url,
          created_by_user_id,updated_by_user_id,created_at,updated_at
         )
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
         WHERE EXISTS(
           SELECT 1 FROM quotations q
           WHERE q.id=? AND q.organization_id=?
             AND q.lifecycle_status IN ('pending','withdrawn')
             AND q.updated_at=?
         )
         ON CONFLICT(quotation_id,field_id) DO UPDATE SET
           value_text=excluded.value_text,file_name=excluded.file_name,
           content_type=excluded.content_type,size_bytes=excluded.size_bytes,data_url=excluded.data_url,
           updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
      ).bind(
        ...values,input.quotationId,input.organizationId,
        input.guard.quotationUpdatedAt,
      );
    });
  if (statements.length) {
    const results = await env.DB.batch(statements);
    if (input.guard && results.every((result) => Number(result.meta.changes || 0) === 0))
      throw new Error("报价状态已被其他窗口更新，当前补充内容未覆盖，请刷新后确认");
  }
}

export async function assertQuotationWorkflowFieldsComplete(
  organizationId: string,
  quotationId: string,
) {
  const quote = await env.DB.prepare(
    `SELECT q.*,
       (SELECT COUNT(*) FROM quotation_charges c
        WHERE c.quotation_id=q.id AND c.quantity>0 AND c.unit_price>0) quotation_charge_items
     FROM quotations q WHERE q.organization_id=? AND q.id=?`,
  ).bind(organizationId,quotationId).first<Record<string, unknown>>();
  if (!quote) throw new Error("报价不存在");
  const workflowId = String(quote.workflow_definition_id || "");
  if (!workflowId) throw new Error("报价未锁定工作流版本");
  const [liveFields,instanceFields,values] = await Promise.all([
    listQuotationWorkflowFields(organizationId),
    listQuotationWorkflowInstanceFields(organizationId,[quotationId]),
    listQuotationWorkflowFieldValues(organizationId,[quotationId]),
  ]);
  const fields = instanceFields.length
    ? instanceFields
    : liveFields.filter((field) => field.workflow_id === workflowId);
  const valueByField = new Map(values.map((value) => [value.field_id,value]));
  const valueByFieldKey = new Map(values.map((value) => [value.field_key,value]));
  const missing = fields
    .filter((field) => field.workflow_id === workflowId && field.is_active && field.is_required)
    .filter((field) => quotationNativeFieldKeySet.has(field.field_key)
      ? !quotationNativeFieldPresent(field.field_key, quote)
      : !quotationWorkflowFieldHasValue(
          field,
          valueByField.get(field.id) || valueByFieldKey.get(field.field_key) || null,
        ))
    .slice(0,8);
  if (missing.length)
    throw new Error(`询价报价第一步尚缺必填项：${missing.map((item) => item.label).join("、")}`);
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
