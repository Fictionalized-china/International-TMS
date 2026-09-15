import { env } from "cloudflare:workers";
import {
  ensureOrderModules,
  syncOrderWorkflowSnapshot,
} from "./order-modules.server";
import { missingRequiredWorkflowStepFields } from "./workflow-fields.server";
import {
  assignmentModuleBlocksDispatch,
  canRunOrderWorkflowAction,
  dispatchedOrderWorkflowNeedsReconciliation,
  orderWorkflowTargetAssigneeRequirements,
  shouldRefreshOrderModulesBeforeWorkflowGate,
} from "./order-workflow";
import { assignedOrderNotificationStatement } from "./internal-notifications.server";
import {
  isActiveOrganizationAssignee,
  isActiveOrganizationAssigneeForPositions,
} from "./organization-assignee.server";
import { loadOrderDispatchResponsibilityPolicy } from "./order-assignment-manifest.server";

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
  salesperson_user_id: string | null;
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
  allowPendingAssignment?: boolean;
  prospectiveAssignmentAssigneeUserId?: string | null;
  prospectiveSatisfiedGateFieldKeys?: readonly string[];
}) {
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.status,o.current_step_code,o.current_assignee_user_id,
      COALESCE(q.salesperson_user_id,o.salesperson_user_id) salesperson_user_id,
      o.shipper_name,o.shipper_contact,o.shipper_phone,o.consignee_name,
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
     FROM transport_orders o
     LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
     WHERE o.id=? AND o.organization_id=?`,
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
  const actorPosition = await env.DB.prepare(
    `SELECT p.code FROM memberships m
     JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id
     WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND p.status='active'
     LIMIT 1`,
  ).bind(input.organizationId,input.actorUserId).first<{code:string}>();
  if (!canRunOrderWorkflowAction({
    actionCode: input.actionCode,
    positionCode: actorPosition?.code,
    currentAssigneeUserId: order.current_assignee_user_id,
    salespersonUserId: order.salesperson_user_id,
    currentUserId: input.actorUserId,
    bypassAssigneeRestriction: input.bypassAssigneeRestriction,
  })) {
    const actionOwner: Record<string, string> = {
      submit: "当前订单的业务员",
      cancel_draft: "当前订单的业务员",
      approve: "提交审批时指定的业务主管",
      reject: "提交审批时指定的业务主管",
      cancel_submitted: "提交审批时指定的业务主管",
      dispatch: "业务主管指定的操作主管",
      cancel_confirmed: "业务主管指定的操作主管",
      complete: "当前订单指定的财务会计",
    };
    return {
      ok: false as const,
      reason: `仅${actionOwner[input.actionCode] ?? "当前节点指定负责人"}可以执行“${transition.action_name}”`,
      order,
      transition,
    };
  }
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
    if (shouldRefreshOrderModulesBeforeWorkflowGate(input))
      await ensureOrderModules(input.organizationId, input.orderId);
    const prospectiveSatisfied = new Set(input.prospectiveSatisfiedGateFieldKeys ?? []);
    const missing = (await missingRequiredWorkflowStepFields(
      input.organizationId,
      input.orderId,
      gateStepKey,
    )).filter((field) => !prospectiveSatisfied.has(field.fieldKey));
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
      "SELECT assignee_user_id,status,enabled,is_required FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='assignment'",
    )
      .bind(input.organizationId, input.orderId)
      .first<{
        assignee_user_id: string | null;
        status: string | null;
        enabled: number;
        is_required: number;
      }>();
    if (assignmentModuleBlocksDispatch(assignment ? {
      enabled: assignment.enabled,
      isRequired: assignment.is_required,
    } : null)) {
      if (!input.allowPendingAssignment && assignment?.status !== "completed") {
        return {
          ok: false as const,
          reason: "请先完成当前工作流要求的任务分配并确认派单后再推进订单。",
          order,
          transition,
        };
      }
      const effectiveAssignmentAssignee = input.prospectiveAssignmentAssigneeUserId
        ?? assignment?.assignee_user_id
        ?? null;
      if (!effectiveAssignmentAssignee) {
        return {
          ok: false as const,
          reason: "当前工作流要求任务分配，但尚未设置派单主负责人。",
          order,
          transition,
        };
      }
      if (input.assigneeUserId && input.assigneeUserId !== effectiveAssignmentAssignee) {
        return {
          ok: false as const,
          reason: "派单负责人与任务分配不一致，请从任务分配页重新确认。",
          order,
          transition,
        };
      }
    }
  }
  if (input.assigneeUserId) {
    const validAssignee = await isActiveOrganizationAssignee(
      input.organizationId,
      input.assigneeUserId,
    );
    if (!validAssignee)
      return {
        ok: false as const,
        reason: "请选择部门、岗位下的有效个人账户",
        order,
        transition,
      };
    const dispatchPolicy = input.actionCode === "dispatch"
      ? await loadOrderDispatchResponsibilityPolicy(
          input.organizationId,
          input.orderId,
        )
      : null;
    const expectedPositions: Record<string, readonly string[]> = {
      submit: ["BUSINESS_SUPERVISOR"],
      approve: ["OPERATION_SUPERVISOR"],
    };
    const expectedPositionCodes = dispatchPolicy
      ? [dispatchPolicy.positionCode]
      : expectedPositions[input.actionCode];
    const permissionRequirements = dispatchPolicy
      ? []
      : orderWorkflowTargetAssigneeRequirements(input.actionCode);
    const validTargetAssignee = expectedPositionCodes
      ? permissionRequirements.length
        ? await isActiveOrganizationAssigneeForPositions(
            input.organizationId,input.assigneeUserId,expectedPositionCodes,permissionRequirements,
          )
        : await isActiveOrganizationAssigneeForPositions(
            input.organizationId,input.assigneeUserId,expectedPositionCodes,
          )
      : true;
    if (
      expectedPositionCodes &&
      !validTargetAssignee
    ) {
      const label = dispatchPolicy
        ? dispatchPolicy.source === "legacy"
          ? "操作岗个人账户（旧订单兼容规则）"
          : `锁定工作流首个必办岗位（${dispatchPolicy.positionCode}）个人账户`
        : input.actionCode === "submit"
        ? "具备订单查看权限的业务主管"
        : input.actionCode === "approve"
          ? "具备派单及配载审批权限的操作主管"
          : "配置岗位";
      return {
        ok: false as const,
        reason: dispatchPolicy
          ? `下一处理人必须是有效的${label}`
          : `下一处理人必须是有效的${label}个人账户`,
        order,
        transition,
      };
    }
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
  allowPendingAssignment?: boolean;
  atomicStatements?: D1PreparedStatement[];
  prospectiveAssignmentAssigneeUserId?: string | null;
  prospectiveSatisfiedGateFieldKeys?: readonly string[];
}) {
  const checked = await validateOrderWorkflowAction(input);
  if (!checked.ok) throw new Error(checked.reason);
  const { order, transition } = checked,
    now = new Date().toISOString(),
    historyId = crypto.randomUUID(),
    assignee = input.assigneeUserId || null;
  await env.DB.batch([
    ...(input.atomicStatements ?? []),
    ...(input.actionCode === "approve" && assignee
      ? [env.DB.prepare(
          "UPDATE transport_orders SET operation_supervisor_user_id=? WHERE id=? AND organization_id=?",
        ).bind(assignee, order.id, input.organizationId)]
      : []),
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
    ...(assignee && transition.to_status !== "in_execution"
      ? [assignedOrderNotificationStatement(env.DB, {
          organizationId: input.organizationId,
          orderId: order.id,
          assigneeUserId: assignee,
          actorUserId: input.actorUserId,
          stepName: transition.target_step_name,
          now,
        })]
      : []),
  ]);
  if (transition.to_status === "in_execution") {
    await reconcileDispatchedOrderWorkflow(input.organizationId, order.id, { force: true });
  } else {
    await ensureOrderModules(input.organizationId, order.id);
  }
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

type DispatchedOrderWorkflowSnapshot = {
  status: string;
  current_step_code: string | null;
  current_step_key: string | null;
};

async function loadDispatchedOrderWorkflowSnapshot(
  organizationId: string,
  orderId: string,
) {
  return env.DB.prepare(
    `SELECT o.status,o.current_step_code,wi.current_step_key
       FROM transport_orders o
       LEFT JOIN workflow_instances wi
         ON wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id
      WHERE o.organization_id=? AND o.id=?`,
  ).bind(organizationId, orderId).first<DispatchedOrderWorkflowSnapshot>();
}

export async function reconcileDispatchedOrderWorkflow(
  organizationId: string,
  orderId: string,
  options: { force?: boolean } = {},
) {
  let snapshot = await loadDispatchedOrderWorkflowSnapshot(organizationId, orderId);
  if (!snapshot) return false;
  if (!options.force && !dispatchedOrderWorkflowNeedsReconciliation({
    orderStatus: snapshot.status,
    currentStepCode: snapshot.current_step_code,
    workflowStepKey: snapshot.current_step_key,
  })) return false;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await syncOrderWorkflowSnapshot(organizationId, orderId);
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    snapshot = await loadDispatchedOrderWorkflowSnapshot(organizationId, orderId);
    if (snapshot && !dispatchedOrderWorkflowNeedsReconciliation({
      orderStatus: snapshot.status,
      currentStepCode: snapshot.current_step_code,
      workflowStepKey: snapshot.current_step_key,
    })) return true;
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("派单已保存，但工作流未能进入下一业务节点；系统已停止返回成功，请重试");
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
