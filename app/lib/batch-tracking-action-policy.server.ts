import {
  aggregateBatchTrackingActionPolicies,
  type BatchTrackingActionPolicy,
  type BatchTrackingOrderActionPolicy,
} from "./batch-tracking-action-policy";
import { frozenWorkflowFieldActionPolicy } from "./workflow-field-action-policy";
import { loadLockedWorkflowStageContext } from "./workflow-instance-stage-gate.server";

export type BatchTrackingActionOrder = {
  orderId: string;
  orderNumber?: string | null;
};

export type LoadedBatchTrackingActionPolicy = {
  orders: BatchTrackingOrderActionPolicy[];
  batch: BatchTrackingActionPolicy;
};

type FieldPlacementRow = {
  module_code: string;
  field_key: string;
  step_key: string;
  is_active: number;
  is_required: number;
};

/**
 * Load one PZ tracking action from each order's exact frozen workflow. The
 * field query deliberately follows transport_orders.workflow_instance_id and
 * never consults the mutable workflow template. Cross-module rows are loaded
 * too so a malformed field binding is detected by the pure policy.
 */
export async function loadBatchTrackingActionPolicy(input: {
  db: D1Database;
  organizationId: string;
  orders: readonly BatchTrackingActionOrder[];
  fieldKey: string;
}): Promise<LoadedBatchTrackingActionPolicy> {
  const uniqueOrders = [...new Map(
    input.orders
      .filter((order) => order.orderId.trim())
      .map((order) => [order.orderId, order]),
  ).values()];
  const orderPolicies: BatchTrackingOrderActionPolicy[] = [];

  // Keep D1 pressure bounded for large PZ batches. Each context loader uses a
  // small Promise.all internally, while orders themselves are resolved in
  // sequence rather than opening an unbounded number of connections.
  for (const order of uniqueOrders) {
    const context = await loadLockedWorkflowStageContext(
      input.db,
      input.organizationId,
      order.orderId,
      "tracking",
    );
    if (!context.locked) {
      orderPolicies.push({
        ...order,
        policy: frozenWorkflowFieldActionPolicy({
          context,
          moduleCode: "tracking",
          fieldKey: input.fieldKey,
        }),
      });
      continue;
    }

    const fieldRows = await input.db.prepare(
      `SELECT f.module_code,f.field_key,f.step_key,f.is_active,f.is_required
       FROM transport_orders o
       JOIN workflow_instances wi
         ON wi.id=o.workflow_instance_id
        AND wi.organization_id=o.organization_id
        AND wi.order_id=o.id
       JOIN workflow_instance_fields f ON f.instance_id=wi.id
       WHERE o.organization_id=? AND o.id=? AND f.field_key=?
       ORDER BY f.module_code,f.sort_order,f.id`,
    ).bind(
      input.organizationId,
      order.orderId,
      input.fieldKey,
    ).all<FieldPlacementRow>();

    const exactFieldContext = {
      ...context,
      fields: fieldRows.results.map((field) => ({
        moduleCode: field.module_code,
        fieldKey: field.field_key,
        stepKey: field.step_key,
        isActive: field.is_active === 1,
        isRequired: field.is_required === 1,
      })),
    };
    orderPolicies.push({
      ...order,
      policy: frozenWorkflowFieldActionPolicy({
        context: exactFieldContext,
        moduleCode: "tracking",
        fieldKey: input.fieldKey,
      }),
    });
  }

  return {
    orders: orderPolicies,
    batch: aggregateBatchTrackingActionPolicies(orderPolicies),
  };
}
