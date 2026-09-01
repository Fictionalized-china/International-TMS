import { writeAudit } from "./audit.server";
import { executeOrderWorkflowAction } from "./order-workflow.server";

export async function runOrderWorkflowAction(input: {
  request: Request;
  organizationId: string;
  actorUserId: string;
  orderId: string;
  actionCode: string;
  assigneeUserId?: string | null;
  notes?: string | null;
  bypassAssigneeRestriction?: boolean;
  allowPendingAssignment?: boolean;
  atomicStatements?: D1PreparedStatement[];
}) {
  try {
    const result = await executeOrderWorkflowAction({
      organizationId: input.organizationId,
      orderId: input.orderId,
      actionCode: input.actionCode,
      actorUserId: input.actorUserId,
      assigneeUserId: input.assigneeUserId || null,
      notes: input.notes || null,
      bypassAssigneeRestriction: input.bypassAssigneeRestriction,
      allowPendingAssignment: input.allowPendingAssignment,
      atomicStatements: input.atomicStatements,
    });
    await writeAudit({
      request: input.request,
      action: `order.workflow.${input.actionCode}`,
      resourceType: "transport_order",
      resourceId: input.orderId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      metadata: result,
    });
    return {
      success: `${result.orderNumber} 已${result.actionName}，当前节点：${result.stepName}`,
    };
  } catch (error) {
    return {
      formError: error instanceof Error ? error.message : "流程操作失败",
    };
  }
}
