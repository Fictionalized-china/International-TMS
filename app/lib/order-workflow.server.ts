import { env } from "cloudflare:workers";
import {
  ensureOrderModules,
  syncOrderWorkflowSnapshot,
} from "./order-modules.server";
import { missingRequiredWorkflowStepFields } from "./workflow-fields.server";
import { isAssignedOrderApprover } from "./order-workflow";

export type OrderWorkflowTransition = {
  action_code: string;
  action_name: string;
  from_status: string;
  to_status: string;
  target_step_code: string;
  target_step_name: string;
  requires_assignee: number;
  sort_order: number;
};

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  current_step_code: string;
  current_assignee_user_id: string | null;
  shipper_name: string;
  shipper_contact: string | null;
  shipper_phone: string | null;
  consignee_name: string;
  origin_city: string;
  origin_address: string;
  destination_city: string;
  destination_address: string;
  cargo_description: string;
  transport_mode: string;
  requested_pickup_date: string | null;
  exit_port: string | null;
  overseas_warehouse_id: string | null;
  border_port_valid: number;
  overseas_warehouse_valid: number;
};

export async function listOrderWorkflowTransitions(organizationId: string) {
  return (
    await env.DB.prepare(
      "SELECT action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order FROM order_workflow_transitions WHERE organization_id=? AND is_active=1 ORDER BY sort_order,action_code",
    )
      .bind(organizationId)
      .all<OrderWorkflowTransition>()
  ).results;
}

export async function validateOrderWorkflowAction(input: {
  organizationId: string;
  orderId: string;
  actionCode: string;
  actorUserId: string;
  assigneeUserId?: string | null;
  bypassAssigneeRestriction?: boolean;
}) {
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.status,o.current_step_code,o.current_assignee_user_id,o.shipper_name,o.shipper_contact,o.shipper_phone,o.consignee_name,
      o.origin_city,o.origin_address,o.destination_city,o.destination_address,o.cargo_description,o.transport_mode,
      o.requested_pickup_date,o.exit_port,o.overseas_warehouse_id,
      CASE WHEN EXISTS(
        SELECT 1 FROM reference_data r
        WHERE r.organization_id=o.organization_id AND r.category='border_port' AND r.code=o.exit_port AND r.status='active'
      ) THEN 1 ELSE 0 END border_port_valid,
      CASE WHEN EXISTS(
        SELECT 1 FROM warehouses w
        WHERE w.organization_id=o.organization_id AND w.id=o.overseas_warehouse_id
          AND w.warehouse_role='overseas_destination' AND w.status='active'
      ) THEN 1 ELSE 0 END overseas_warehouse_valid
     FROM transport_orders o WHERE o.id=? AND o.organization_id=?`,
  )
    .bind(input.orderId, input.organizationId)
    .first<OrderRow>();
  if (!order) return { ok: false as const, reason: "订单不存在" };
  const transition = await env.DB.prepare(
    "SELECT action_code,action_name,from_status,to_status,target_step_code,target_step_name,requires_assignee,sort_order FROM order_workflow_transitions WHERE organization_id=? AND action_code=? AND from_status=? AND is_active=1",
  )
    .bind(input.organizationId, input.actionCode, order.status)
    .first<OrderWorkflowTransition>();
  if (!transition)
    return {
      ok: false as const,
      reason: `当前状态“${statusLabel(order.status)}”不能执行该动作`,
      order,
    };
  if (
    input.actionCode === "approve" &&
    !input.bypassAssigneeRestriction &&
    !isAssignedOrderApprover({
      status: order.status,
      currentAssigneeUserId: order.current_assignee_user_id,
      currentUserId: input.actorUserId,
    })
  )
    return {
      ok: false as const,
      reason: order.current_assignee_user_id
        ? "仅提交审批时指定的审批负责人可以审批委托"
        : "当前订单尚未指定审批负责人，请退回草稿后重新提交审批",
      order,
      transition,
    };
  if (transition.requires_assignee && !input.assigneeUserId)
    return {
      ok: false as const,
      reason: "该动作必须指定下一处理人",
      order,
      transition,
    };
  const gateStepByAction: Record<string,string> = {
    submit: "order_creation",
    approve: "consignment_approval",
    dispatch: "task_assignment",
    complete: "completion_review",
  };
  const gateStepKey = gateStepByAction[input.actionCode];
  if (gateStepKey) {
    await ensureOrderModules(input.organizationId, input.orderId);
    const missing = await missingRequiredWorkflowStepFields(
      input.organizationId,
      input.orderId,
      gateStepKey,
    );
    if (missing.length)
      return {
        ok: false as const,
        reason: `请先补齐当前工作流要求的字段：${missing
          .map((field) => `${field.label}（${field.moduleCode}）`)
          .join("、")}`,
        order,
        transition,
      };
  }
  if (input.actionCode === "dispatch") {
    const assignment = await env.DB.prepare(
      "SELECT assignee_user_id,status FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='assignment' AND enabled=1",
    )
      .bind(input.organizationId, input.orderId)
      .first<{ assignee_user_id: string | null; status: string | null }>();
    if (!assignment || assignment.status !== "completed") {
      return {
        ok: false as const,
        reason: "请先完成任务分配并确认派单后再推进订单。",
        order,
        transition,
      };
    }
    if (!assignment.assignee_user_id) {
      return {
        ok: false as const,
        reason: "任务分配未设置派单主负责人，请先确认派单。",
        order,
        transition,
      };
    }
    if (input.assigneeUserId && input.assigneeUserId !== assignment.assignee_user_id) {
      return {
        ok: false as const,
        reason: "派单负责人与任务分配不一致，请从任务分配页重新确认。",
        order,
        transition,
      };
    }
  }
  if (input.assigneeUserId) {
    const member = await env.DB.prepare(
      "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND u.status='active'",
    )
      .bind(input.organizationId, input.assigneeUserId)
      .first();
    if (!member)
      return {
        ok: false as const,
        reason: "指定的处理人无效",
        order,
        transition,
      };
  }
  if (input.actionCode === "complete") {
    await ensureOrderModules(input.organizationId, input.orderId);
    const pending = await env.DB.prepare(
      `SELECT module_name,current_step_name,status
       FROM order_module_instances
       WHERE organization_id=? AND order_id=? AND enabled=1 AND is_required=1 AND status!='completed'
       ORDER BY CASE module_code WHEN 'consignment' THEN 10 WHEN 'cargo' THEN 20 WHEN 'assignment' THEN 30 WHEN 'transport' THEN 40 WHEN 'warehouse' THEN 50 WHEN 'documents' THEN 60 WHEN 'customs' THEN 70 WHEN 'loading' THEN 80 WHEN 'tracking' THEN 90 WHEN 'overseas_warehouse' THEN 100 WHEN 'costs' THEN 110 WHEN 'exceptions' THEN 120 WHEN 'review' THEN 130 ELSE 999 END
       LIMIT 5`,
    )
      .bind(input.organizationId, input.orderId)
      .all<{
        module_name: string;
        current_step_name: string | null;
        status: string;
      }>();
    if (pending.results.length)
      return {
        ok: false as const,
        reason: `以下已启用模块尚未完成：${pending.results
          .map(
            (module) =>
              `${module.module_name}（${module.current_step_name || module.status}）`,
          )
          .join("、")}`,
        order,
        transition,
      };
  }
  return { ok: true as const, order, transition };
}

export async function executeOrderWorkflowAction(input: {
  organizationId: string;
  orderId: string;
  actionCode: string;
  actorUserId: string;
  assigneeUserId?: string | null;
  notes?: string | null;
  bypassAssigneeRestriction?: boolean;
}) {
  const checked = await validateOrderWorkflowAction(input);
  if (!checked.ok) throw new Error(checked.reason);
  const { order, transition } = checked,
    now = new Date().toISOString(),
    historyId = crypto.randomUUID(),
    assignee = input.assigneeUserId || null;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE transport_orders SET status=?,current_step_code=?,current_step_name=?,current_assignee_user_id=?,workflow_updated_at=?,is_overdue=0,confirmed_at=CASE WHEN ?='confirmed' THEN COALESCE(confirmed_at,?) ELSE confirmed_at END,updated_at=? WHERE id=? AND organization_id=? AND status=?`,
    ).bind(
      transition.to_status,
      transition.target_step_code,
      transition.target_step_name,
      assignee,
      now,
      transition.to_status,
      now,
      now,
      order.id,
      input.organizationId,
      order.status,
    ),
    env.DB.prepare(
      "INSERT INTO order_workflow_history(id,organization_id,order_id,action_code,action_name,from_status,to_status,from_step_code,to_step_code,actor_user_id,assignee_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      historyId,
      input.organizationId,
      order.id,
      transition.action_code,
      transition.action_name,
      order.status,
      transition.to_status,
      order.current_step_code,
      transition.target_step_code,
      input.actorUserId,
      assignee,
      input.notes || null,
      now,
    ),
  ]);
  await ensureOrderModules(input.organizationId, order.id);
  if (transition.to_status === "in_execution")
    await syncOrderWorkflowSnapshot(input.organizationId, order.id);
  const snapshot = await env.DB.prepare(
    "SELECT current_step_name FROM transport_orders WHERE organization_id=? AND id=?",
  )
    .bind(input.organizationId, order.id)
    .first<{ current_step_name: string }>();
  return {
    orderNumber: order.order_number,
    actionName: transition.action_name,
    toStatus: transition.to_status,
    stepName: snapshot?.current_step_name ?? transition.target_step_name,
  };
}

export function statusLabel(status: string) {
  return (
    {
      draft: "草稿",
      submitted: "待审批",
      confirmed: "待派单",
      in_execution: "执行中",
      completed: "已完成",
      cancelled: "已取消",
    } as Record<string, string>
  )[status] ?? status;
}
