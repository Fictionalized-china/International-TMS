import { env } from "cloudflare:workers";
import {
  loadingOrderDocumentDefinitions,
  resolveLoadingDocumentRequirements,
  type LoadingDocumentWorkflowField,
  type LoadingOrderDocumentModule,
  type OrderLoadingDocumentRequirements,
} from "./loading-document-requirements";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";

type CustomsRow = {
  order_id: string;
  customs_enabled: number;
  workflow_instance_bound: number;
};

type DocumentFieldRow = {
  order_id: string;
  module_code: LoadingOrderDocumentModule;
  field_key: string;
  is_active: number;
  is_required: number;
  stage_available: number;
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
           ) THEN 1 ELSE 0 END customs_enabled,
           CASE WHEN o.workflow_instance_id IS NOT NULL THEN 1 ELSE 0 END workflow_instance_bound
         FROM transport_orders o
         WHERE o.organization_id=? AND o.id IN (${placeholders})`,
      ).bind(organizationId, ...chunk).all<CustomsRow>(),
      env.DB.prepare(
        `WITH bindings AS (
           SELECT o.id order_id,o.workflow_instance_id bound_instance_id,
                  wi.id instance_id,wi.workflow_id,wi.current_step_key
           FROM transport_orders o
           LEFT JOIN workflow_instances wi
             ON wi.id=o.workflow_instance_id
            AND wi.organization_id=o.organization_id
            AND wi.order_id=o.id
           WHERE o.organization_id=? AND o.id IN (${placeholders})
         )
         SELECT b.order_id,f.module_code,f.field_key,f.is_active,f.is_required,
                CASE
                  WHEN current_step.sort_order IS NULL OR field_step.sort_order IS NULL THEN 0
                  WHEN field_step.sort_order<=current_step.sort_order THEN 1
                  ELSE 0
                END stage_available
         FROM bindings b
         JOIN workflow_instance_fields f ON f.instance_id=b.instance_id
         LEFT JOIN workflow_instance_step_states current_step
           ON current_step.instance_id=b.instance_id
          AND current_step.step_key=b.current_step_key
         LEFT JOIN workflow_instance_step_states field_step
           ON field_step.instance_id=b.instance_id
          AND field_step.step_key=f.step_key
         WHERE f.module_code IN ('consignment','customs')
         UNION ALL
         SELECT b.order_id,COALESCE(f.module_code,'consignment') module_code,
                f.field_key,f.is_active,f.is_required,1 stage_available
         FROM bindings b
         JOIN workflow_step_fields f ON f.workflow_id=b.workflow_id
         WHERE COALESCE(f.module_code,'consignment') IN ('consignment','customs')
           AND b.bound_instance_id IS NULL
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
  const workflowInstanceBoundByOrder = new Map(
    customsRows.map((row) => [row.order_id, row.workflow_instance_bound === 1]),
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
      stageAvailable: Boolean(row.stage_available),
    });
    orderFields[row.module_code] = moduleFields;
    fieldsByOrder.set(row.order_id, orderFields);
  }
  for (const orderId of uniqueOrderIds) {
    if (!workflowInstanceBoundByOrder.get(orderId)) continue;
    const orderFields = fieldsByOrder.get(orderId) ?? {};
    for (const definition of loadingOrderDocumentDefinitions) {
      const moduleFields = orderFields[definition.moduleCode] ?? [];
      if (!moduleFields.some((field) => field.fieldKey === definition.fieldKey)) {
        moduleFields.push({
          fieldKey: definition.fieldKey,
          isActive: false,
          isRequired: false,
          stageAvailable: false,
        });
      }
      orderFields[definition.moduleCode] = moduleFields;
    }
    fieldsByOrder.set(orderId, orderFields);
  }

  return uniqueOrderIds.map((orderId) => resolveLoadingDocumentRequirements({
    orderId,
    customsEnabled: customsEnabledByOrder.get(orderId) ?? false,
    fieldsByModule: fieldsByOrder.get(orderId) ?? {},
  }));
}
