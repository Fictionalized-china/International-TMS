import {
  orderDocumentWorkflowMutationAccess,
  type OrderDocumentWorkflowMutationAccess,
} from "./order-document-access";
import { orderDocumentPlacement } from "./order-documents";
import { loadLockedWorkflowStageContext } from "./workflow-instance-stage-gate.server";

export async function loadOrderDocumentWorkflowMutationAccess(
  db: D1Database,
  organizationId: string,
  orderId: string,
  documentCategory: string,
): Promise<OrderDocumentWorkflowMutationAccess> {
  const placement = orderDocumentPlacement(documentCategory);
  if (!placement) {
    return orderDocumentWorkflowMutationAccess({
      documentCategory,
      workflow: {
        locked: false,
        currentStepKey: null,
        steps: [],
        modulePlacements: [],
        fields: [],
      },
    });
  }
  const order = await db.prepare(
    "SELECT status FROM transport_orders WHERE organization_id=? AND id=?",
  ).bind(organizationId, orderId).first<{ status: string }>();
  if (!order) {
    return orderDocumentWorkflowMutationAccess({
      documentCategory,
      workflow: {
        locked: false,
        currentStepKey: null,
        steps: [],
        modulePlacements: [],
        fields: [],
      },
    });
  }
  const workflow = await loadLockedWorkflowStageContext(
    db,
    organizationId,
    orderId,
    placement.moduleCode,
  );
  const access = orderDocumentWorkflowMutationAccess({ documentCategory, workflow });
  if (["completed", "cancelled"].includes(order.status)) {
    return {
      ...access,
      allowed: false,
      reason: "订单已完成或取消，文件仅供查看，不能继续修改",
    };
  }
  return access;
}
