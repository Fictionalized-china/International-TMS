import { d1Placeholders } from "./d1-bindings";
import {
  orderTrackingActionFieldKeys,
  resolveOrderTrackingActionAccess,
  type OrderTrackingActionAccessMap,
  type OrderTrackingLegacyCompatibility,
} from "./order-tracking-action-policy";
import { frozenWorkflowFieldActionPolicy } from "./workflow-field-action-policy";
import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";
import { loadLockedWorkflowStageContext } from "./workflow-instance-stage-gate.server";

type FrozenFieldRow = {
  module_code: string;
  field_key: string;
  step_key: string;
  is_active: number;
  is_required: number;
};

/**
 * Load both ordinary-order tracking write surfaces from the order's frozen
 * instance. Looking up the field keys across modules makes malformed
 * cross-module bindings visible to the shared fail-closed policy.
 */
export async function loadOrderTrackingActionAccess(input: {
  db: D1Database;
  organizationId: string;
  orderId: string;
  canOperate: boolean;
  legacyCompatibility: OrderTrackingLegacyCompatibility;
}): Promise<OrderTrackingActionAccessMap> {
  const context = await loadLockedWorkflowStageContext(
    input.db,
    input.organizationId,
    input.orderId,
    "tracking",
  );

  let exactContext: LockedWorkflowStageContext = context;
  if (context.locked) {
    const rows = await input.db.prepare(
      `SELECT f.module_code,f.field_key,f.step_key,f.is_active,f.is_required
       FROM transport_orders o
       JOIN workflow_instances wi
         ON wi.id=o.workflow_instance_id
        AND wi.organization_id=o.organization_id
        AND wi.order_id=o.id
       JOIN workflow_instance_fields f ON f.instance_id=wi.id
       WHERE o.organization_id=? AND o.id=?
         AND f.field_key IN (${d1Placeholders(orderTrackingActionFieldKeys.length)})
       ORDER BY f.field_key,f.module_code,f.sort_order,f.id`,
    ).bind(
      input.organizationId,
      input.orderId,
      ...orderTrackingActionFieldKeys,
    ).all<FrozenFieldRow>();
    exactContext = {
      ...context,
      fields: rows.results.map((field) => ({
        moduleCode: field.module_code,
        fieldKey: field.field_key,
        stepKey: field.step_key,
        isActive: field.is_active === 1,
        isRequired: field.is_required === 1,
      })),
    };
  }

  return Object.fromEntries(orderTrackingActionFieldKeys.map((fieldKey) => [
    fieldKey,
    resolveOrderTrackingActionAccess({
      fieldKey,
      policy: frozenWorkflowFieldActionPolicy({
        context: exactContext,
        moduleCode: "tracking",
        fieldKey,
      }),
      canOperate: input.canOperate,
      legacyCompatibility: input.legacyCompatibility,
    }),
  ])) as OrderTrackingActionAccessMap;
}
