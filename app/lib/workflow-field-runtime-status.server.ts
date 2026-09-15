import { env } from "cloudflare:workers";
import { syncOrderWorkflowSnapshot } from "./order-modules.server";
import { synchronizeOrderDocumentsModuleStatus } from "./documents-module-status.server";
import { loadingOrderDocumentDefinitions } from "./loading-document-requirements";
import { reconcileWorkflowFieldBlocker } from "./module-policy-status";
import type { OrderModuleCode } from "./order-modules";
import { missingRequiredModuleFields } from "./workflow-fields.server";

type AffectedOrder = {
  instance_id: string;
  order_id: string;
  policy_applies: number;
};
type ModuleRow = {
  id: string;
  status: string;
  blocking_reason: string | null;
  started_at: string | null;
};

/**
 * Applies a template-field policy change to current/future instance gates and
 * mirrors open historical supplement tasks as blockers. Historical workflow
 * snapshots and completed module facts are never reopened.
 */
export async function reconcileWorkflowFieldRuntimeStatus(input: {
  organizationId: string;
  workflowId: string;
  targetStepKey: string;
  moduleCode: OrderModuleCode;
  fieldKey: string;
  actorUserId: string;
  now?: string;
}) {
  const now = input.now ?? new Date().toISOString();
  const affected = await env.DB.prepare(
    `SELECT wi.id instance_id,wi.order_id,
       CASE WHEN current_step.sort_order<=target_step.sort_order THEN 1 ELSE 0 END policy_applies
     FROM workflow_instances wi
     JOIN workflow_steps current_step
       ON current_step.workflow_id=wi.workflow_id AND current_step.step_key=wi.current_step_key
     JOIN workflow_steps target_step
       ON target_step.workflow_id=wi.workflow_id AND target_step.step_key=?
     WHERE wi.organization_id=? AND wi.workflow_id=? AND wi.order_id IS NOT NULL
    `,
  ).bind(input.targetStepKey, input.organizationId, input.workflowId).all<AffectedOrder>();

  let updated = 0;
  let documentsUpdated = 0;
  const isLoadingDocument = loadingOrderDocumentDefinitions.some(
    (document) => document.fieldKey === input.fieldKey,
  );
  for (const item of affected.results) {
    const module = await env.DB.prepare(
      `SELECT id,status,blocking_reason,started_at
       FROM order_module_instances
       WHERE organization_id=? AND order_id=? AND module_code=? AND enabled=1`,
    ).bind(input.organizationId, item.order_id, input.moduleCode).first<ModuleRow>();
    if (module) {
      const missingLabels = item.policy_applies === 1
        ? (await missingRequiredModuleFields(
            input.organizationId,
            item.order_id,
            input.moduleCode,
          )).map((field) => field.label)
        : (await env.DB.prepare(
            `SELECT DISTINCT field_label
             FROM workflow_supplement_tasks
             WHERE organization_id=? AND workflow_id=? AND instance_id=?
               AND module_code=? AND task_kind='supplement' AND status='open'
             ORDER BY field_label`,
          ).bind(
            input.organizationId,
            input.workflowId,
            item.instance_id,
            input.moduleCode,
          ).all<{ field_label: string }>()).results.map((task) => task.field_label);
      const next = reconcileWorkflowFieldBlocker({
        status: module.status,
        blockingReason: module.blocking_reason,
        startedAt: module.started_at,
        missingLabels,
        blockerPrefix: item.policy_applies === 1 ? undefined : "待补录必填字段：",
      });
      if (next.changed) {
        const result = await env.DB.prepare(
          `UPDATE order_module_instances
           SET status=?,blocking_reason=?,completed_at=CASE WHEN ?='completed' THEN completed_at ELSE NULL END,updated_at=?
           WHERE id=? AND status NOT IN ('completed','not_applicable')`,
        ).bind(next.status, next.blockingReason, next.status, now, module.id).run();
        if (Number(result.meta?.changes || 0)) {
          updated += 1;
          await syncOrderWorkflowSnapshot(input.organizationId, item.order_id);
        }
      }
    }
    if (isLoadingDocument && item.policy_applies === 1) {
      const documentResult = await synchronizeOrderDocumentsModuleStatus({
        organizationId: input.organizationId,
        orderId: item.order_id,
        actorUserId: input.actorUserId,
        now,
        source: "workflow_policy",
      });
      if (documentResult.changed) documentsUpdated += 1;
    }
  }
  return { affected: affected.results.length, updated, documentsUpdated };
}
