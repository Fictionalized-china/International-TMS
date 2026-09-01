import { env } from "cloudflare:workers";
import {
  resolveLoadingDocumentRequirements,
  type LoadingDocumentWorkflowField,
  type LoadingOrderDocumentModule,
  type OrderLoadingDocumentRequirements,
} from "./loading-document-requirements";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";

type CustomsRow = {
  order_id: string;
  customs_enabled: number;
};

type DocumentFieldRow = {
  order_id: string;
  module_code: LoadingOrderDocumentModule;
  field_key: string;
  is_active: number;
  is_required: number;
};

export async function loadOrderLoadingDocumentRequirements(
  organizationId: string,
  orderIds: readonly string[],
): Promise<OrderLoadingDocumentRequirements[]> {
  const uniqueOrderIds = [...new Set(orderIds.filter(Boolean))];
  if (!uniqueOrderIds.length) return [];

  const customsRows: CustomsRow[] = [];
  const documentFieldRows: DocumentFieldRow[] = [];
  for (const chunk of chunkD1Values(uniqueOrderIds, 1)) {
    const placeholders = d1Placeholders(chunk.length);
    const [customs, documentFields] = await Promise.all([
      env.DB.prepare(
        `SELECT o.id order_id,
           CASE WHEN EXISTS(
             SELECT 1 FROM order_module_instances mi
             WHERE mi.organization_id=o.organization_id AND mi.order_id=o.id
               AND mi.module_code='customs' AND mi.enabled=1
           ) THEN 1 ELSE 0 END customs_enabled
         FROM transport_orders o
         WHERE o.organization_id=? AND o.id IN (${placeholders})`,
      ).bind(organizationId, ...chunk).all<CustomsRow>(),
      env.DB.prepare(
        `WITH bindings AS (
           SELECT o.id order_id,wi.id instance_id,wi.workflow_id
           FROM transport_orders o
           LEFT JOIN workflow_instances wi
             ON wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id
           WHERE o.organization_id=? AND o.id IN (${placeholders})
         )
         SELECT b.order_id,f.module_code,f.field_key,f.is_active,f.is_required
         FROM bindings b
         JOIN workflow_instance_fields f ON f.instance_id=b.instance_id
         WHERE f.module_code IN ('consignment','customs')
         UNION ALL
         SELECT b.order_id,COALESCE(f.module_code,'consignment') module_code,
                f.field_key,f.is_active,f.is_required
         FROM bindings b
         JOIN workflow_step_fields f ON f.workflow_id=b.workflow_id
         WHERE COALESCE(f.module_code,'consignment') IN ('consignment','customs')
           AND NOT EXISTS(
             SELECT 1 FROM workflow_instance_fields snapshot
             WHERE snapshot.instance_id=b.instance_id
               AND snapshot.module_code=COALESCE(f.module_code,'consignment')
           )`,
      ).bind(organizationId, ...chunk).all<DocumentFieldRow>(),
    ]);
    customsRows.push(...customs.results);
    documentFieldRows.push(...documentFields.results);
  }
  const customsEnabledByOrder = new Map(
    customsRows.map((row) => [row.order_id, row.customs_enabled === 1]),
  );

  const fieldsByOrder = new Map<
    string,
    Partial<Record<LoadingOrderDocumentModule, LoadingDocumentWorkflowField[]>>
  >();
  for (const row of documentFieldRows) {
    const orderFields = fieldsByOrder.get(row.order_id) ?? {};
    const moduleFields = orderFields[row.module_code] ?? [];
    moduleFields.push({
      fieldKey: row.field_key,
      isActive: Boolean(row.is_active),
      isRequired: Boolean(row.is_required),
    });
    orderFields[row.module_code] = moduleFields;
    fieldsByOrder.set(row.order_id, orderFields);
  }

  return uniqueOrderIds.map((orderId) => resolveLoadingDocumentRequirements({
    orderId,
    customsEnabled: customsEnabledByOrder.get(orderId) ?? false,
    fieldsByModule: fieldsByOrder.get(orderId) ?? {},
  }));
}
