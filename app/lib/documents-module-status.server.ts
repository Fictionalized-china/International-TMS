import { env } from "cloudflare:workers";
import { syncOrderWorkflowSnapshot } from "./order-modules.server";
import {
  loadOrderLoadingDocumentRequirements,
} from "./loading-document-requirements.server";
import { orderDocumentTypeLabel } from "./order-documents";
import {
  isDocumentRequirementManagedBlocker,
  isWorkflowFieldManagedBlocker,
  reconcileDocumentsModuleState,
} from "./module-policy-status";

type DocumentsModuleRow = {
  id: string;
  status: string;
  current_step_code: string | null;
  current_step_name: string | null;
  progress_percent: number;
  blocking_reason: string | null;
};

type LatestDocumentReview = {
  document_category: string;
  review_status: string;
};

export type DocumentsModuleSyncResult = {
  found: boolean;
  changed: boolean;
  complete: boolean;
  incompleteCodes: string[];
  optionalPendingCodes: string[];
};

/**
 * Recomputes the read-only documents aggregate from the current order-instance
 * policy. Only blockers owned by this calculator are replaced or cleared;
 * manual, warehouse and exception blockers remain untouched.
 */
export async function synchronizeOrderDocumentsModuleStatus(input: {
  organizationId: string;
  orderId: string;
  actorUserId: string;
  now?: string;
  source?: "admin_upload" | "admin_review" | "warehouse_upload" | "workflow_policy";
}): Promise<DocumentsModuleSyncResult> {
  const now = input.now ?? new Date().toISOString();
  const module = await env.DB.prepare(
    `SELECT id,status,current_step_code,current_step_name,progress_percent,blocking_reason
     FROM order_module_instances
     WHERE organization_id=? AND order_id=? AND module_code='documents' AND enabled=1`,
  ).bind(input.organizationId, input.orderId).first<DocumentsModuleRow>();

  const [requirementGroup] = await loadOrderLoadingDocumentRequirements(
    input.organizationId,
    [input.orderId],
  );
  const requirements = requirementGroup?.documents ?? [];
  const reviews = await env.DB.prepare(
    `WITH ranked AS (
       SELECT m.document_category,m.review_status,
         ROW_NUMBER() OVER(PARTITION BY m.document_category ORDER BY a.created_at DESC,a.id DESC) row_no
       FROM order_document_metadata m
       JOIN order_attachments a
         ON a.id=m.attachment_id AND a.organization_id=m.organization_id
       WHERE m.organization_id=? AND m.order_id=?
     )
     SELECT document_category,review_status FROM ranked WHERE row_no=1`,
  ).bind(input.organizationId, input.orderId).all<LatestDocumentReview>();
  const latestByCode = new Map(
    reviews.results.map((review) => [review.document_category, review.review_status]),
  );
  const required = requirements.filter((item) => item.isActive && item.isRequired);
  const incomplete = required.filter(
    (item) => !["approved", "archived"].includes(latestByCode.get(item.code) ?? ""),
  );
  const optionalPending = requirements.filter((item) => {
    if (!item.isActive || item.isRequired) return false;
    const status = latestByCode.get(item.code);
    return Boolean(status && !["approved", "archived"].includes(status));
  });
  if (!module) {
    return {
      found: false,
      changed: false,
      complete: incomplete.length === 0,
      incompleteCodes: incomplete.map((item) => item.code),
      optionalPendingCodes: optionalPending.map((item) => item.code),
    };
  }

  const next = reconcileDocumentsModuleState({
    status: module.status,
    blockingReason: module.blocking_reason,
    requiredLabels: required.map((item) => item.name),
    incompleteLabels: incomplete.map((item) => item.name),
    optionalPendingLabels: optionalPending.map((item) => item.name),
  });
  if (
    module.blocking_reason &&
    !isDocumentRequirementManagedBlocker(module.blocking_reason) &&
    !isWorkflowFieldManagedBlocker(module.blocking_reason)
  ) {
    return {
      found: true,
      changed: false,
      complete: false,
      incompleteCodes: incomplete.map((item) => item.code),
      optionalPendingCodes: optionalPending.map((item) => item.code),
    };
  }
  const changed = module.status !== next.status ||
    module.current_step_code !== next.stepCode ||
    module.current_step_name !== next.stepName ||
    module.progress_percent !== next.progress ||
    module.blocking_reason !== next.blockingReason;
  if (!changed) {
    return {
      found: true,
      changed: false,
      complete: next.complete,
      incompleteCodes: incomplete.map((item) => item.code),
      optionalPendingCodes: optionalPending.map((item) => item.code),
    };
  }

  const note = next.complete
    ? optionalPending.length
      ? `必填资料已齐全；选填文件待审：${optionalPending.map((item) => item.name).join("、")}`
      : "当前实例必填资料已全部审核通过"
    : `必填文件待审核通过：${incomplete.map((item) => orderDocumentTypeLabel(item.code)).join("、")}`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,blocking_reason=?,
         started_at=COALESCE(started_at,?),
         completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,
         updated_at=?
       WHERE id=?`,
    ).bind(
      next.status,
      next.stepCode,
      next.stepName,
      next.progress,
      next.blockingReason,
      now,
      next.status,
      now,
      now,
      module.id,
    ),
    env.DB.prepare(
      `INSERT INTO order_module_history(
        id,organization_id,order_id,module_instance_id,action_code,action_name,
        from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.orderId,
      module.id,
      next.complete ? "documents_required_ready" : "documents_required_blocked",
      next.complete ? "必填资料状态重算完成" : "必填资料状态重算阻断",
      module.current_step_code,
      next.stepCode,
      next.stepName,
      input.actorUserId,
      note,
      now,
    ),
  ]);
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
  return {
    found: true,
    changed: true,
    complete: next.complete,
    incompleteCodes: incomplete.map((item) => item.code),
    optionalPendingCodes: optionalPending.map((item) => item.code),
  };
}
