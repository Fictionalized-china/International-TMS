import { env } from "cloudflare:workers";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";
import type { LoadingBatchWorkflowOrder } from "./loading-batch-field-policy";

type StageRow = {
  order_id: string;
  applies_to_current_or_future: number;
};

type FieldRow = {
  order_id: string;
  field_key: string;
  is_active: number;
  is_required: number;
};

/**
 * Loads the effective loading-field snapshot for each order and marks whether
 * the port-loading node is current/future. Legacy instances without a snapshot
 * fall back to their workflow definition; orders without a workflow use the
 * catalog defaults in the pure aggregator.
 */
export async function loadLoadingBatchWorkflowOrders(
  organizationId: string,
  orderIds: readonly string[],
): Promise<LoadingBatchWorkflowOrder[]> {
  const uniqueOrderIds = [...new Set(orderIds.filter(Boolean))];
  if (!uniqueOrderIds.length) return [];
  const stageRows: StageRow[] = [];
  const fieldRows: FieldRow[] = [];
  for (const chunk of chunkD1Values(uniqueOrderIds, 1)) {
    const placeholders = d1Placeholders(chunk.length);
    // Keep each chunk at two simultaneous D1 connections: one stage query and
    // one effective-field query. Chunks themselves are processed in order.
    const [stages, fields] = await Promise.all([
      env.DB.prepare(
        `SELECT o.id order_id,
                CASE
                  WHEN wi.id IS NULL OR current_step.sort_order IS NULL OR target_step.sort_order IS NULL THEN 1
                  WHEN current_step.sort_order<=target_step.sort_order THEN 1
                  ELSE 0
                END applies_to_current_or_future
         FROM transport_orders o
         LEFT JOIN workflow_instances wi
           ON wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id
         LEFT JOIN workflow_steps current_step
           ON current_step.workflow_id=wi.workflow_id AND current_step.step_key=wi.current_step_key
         LEFT JOIN workflow_steps target_step
           ON target_step.workflow_id=wi.workflow_id AND target_step.step_key='port_loading'
         WHERE o.organization_id=? AND o.id IN (${placeholders})`,
      ).bind(organizationId, ...chunk).all<StageRow>(),
      env.DB.prepare(
        `WITH bindings AS (
           SELECT o.id order_id,wi.id instance_id,wi.workflow_id
           FROM transport_orders o
           LEFT JOIN workflow_instances wi
             ON wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id
           WHERE o.organization_id=? AND o.id IN (${placeholders})
         )
         SELECT b.order_id,f.field_key,f.is_active,f.is_required
         FROM bindings b
         JOIN workflow_instance_fields f
           ON f.instance_id=b.instance_id AND f.module_code='loading'
         UNION ALL
         SELECT b.order_id,f.field_key,f.is_active,f.is_required
         FROM bindings b
         JOIN workflow_step_fields f
           ON f.workflow_id=b.workflow_id AND COALESCE(f.module_code,'consignment')='loading'
         WHERE NOT EXISTS(
           SELECT 1 FROM workflow_instance_fields snapshot
           WHERE snapshot.instance_id=b.instance_id AND snapshot.module_code='loading'
         )`,
      ).bind(organizationId, ...chunk).all<FieldRow>(),
    ]);
    stageRows.push(...stages.results);
    fieldRows.push(...fields.results);
  }
  const stageByOrder = new Map(stageRows.map((row) => [row.order_id, Boolean(row.applies_to_current_or_future)]));
  const fieldsByOrder = new Map<string, FieldRow[]>();
  for (const field of fieldRows) {
    const fields = fieldsByOrder.get(field.order_id) ?? [];
    fields.push(field);
    fieldsByOrder.set(field.order_id, fields);
  }
  return uniqueOrderIds.map((orderId) => ({
    orderId,
    appliesToCurrentOrFuture: stageByOrder.get(orderId) ?? true,
    fields: (fieldsByOrder.get(orderId) ?? []).map((field) => ({
      fieldKey: field.field_key,
      isActive: Boolean(field.is_active),
      isRequired: Boolean(field.is_required),
    })),
  }));
}
