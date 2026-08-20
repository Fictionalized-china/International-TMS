import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.order-detail";
import { requireSessionUser } from "../lib/auth.server";
import {
  statusLabel,
  type OrderWorkflowTransition,
} from "../lib/order-workflow";
import { listOrderWorkflowTransitions } from "../lib/order-workflow.server";
import { runOrderWorkflowAction } from "../lib/order-workflow-action.server";
import { valueOf } from "../lib/validation";
import { Modal } from "../components/Modal";
import { writeAudit } from "../lib/audit.server";
import {
  ensureOrderModules,
  listOrderModules,
  type OrderModuleInstance,
} from "../lib/order-modules.server";
import {
  composeOrderWorkflow,
  moduleStatusLabels,
  orderModuleDefinition,
} from "../lib/order-modules";
import {
  orderBusinessStages,
  orderModuleAccess,
  orderModuleSequence,
  orderStageAccess,
} from "../lib/order-stage-flow";
import {
  buildStageSnapshots,
  orderNextGuidance,
} from "../lib/order-guidance";
import { orderResponsiblePosition } from "../lib/order-responsibility";
import { canManageOrderModule } from "../lib/position-portal";
import { completionStatusLabels, type OrderCompletionStatus } from "../lib/order-review";
import {
  completeWorkflowTask,
  listCurrentWorkflowTasks,
  replaceWorkflowInstanceVersion,
} from "../lib/workflow-execution.server";
import { syncOrderBusinessWorkflow } from "../lib/business-workflow.server";

type Order = {
  id: string;
  order_number: string;
  order_date: string | null;
  business_nature: string;
  business_type: string;
  transport_terms: string | null;
  trade_terms: string | null;
  exit_port: string | null;
  exit_port_name: string | null;
  overseas_warehouse_id: string | null;
  overseas_warehouse_name: string | null;
  overseas_warehouse_code: string | null;
  overseas_warehouse_address: string | null;
  overseas_warehouse_address_note: string | null;
  transit_locations: string | null;
  customs_location: string | null;
  route_notes: string | null;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  customer_reference: string | null;
  quote_number: string | null;
  shipper_name: string;
  shipper_contact: string | null;
  shipper_phone: string | null;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  origin_address: string;
  consignee_name: string;
  consignee_contact: string | null;
  consignee_phone: string | null;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  destination_address: string;
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  transport_mode: string;
  service_level: string | null;
  requested_pickup_date: string | null;
  requested_delivery_date: string | null;
  status: string;
  source: string;
  special_instructions: string | null;
  current_step_name: string;
  assignee_name: string | null;
  workflow_updated_at: string | null;
  is_overdue: number;
  exception_status: string;
  completion_status: OrderCompletionStatus;
  business_completed_at: string | null;
  settlement_completed_at: string | null;
  created_at: string;
};
type History = {
  id: string;
  action_name: string;
  from_status: string;
  to_status: string;
  to_step_code: string;
  actor_name: string | null;
  assignee_name: string | null;
  notes: string | null;
  occurred_at: string;
};
type Attachment = {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  data_url: string;
  created_at: string;
};
type MacroHistory = {
  id: string;
  step_name: string;
  actor_name: string | null;
  source: string;
  occurred_at: string;
};
type BusinessWorkflow = {
  workflow_id:string;
  workflow_name: string;
  version_number:number;
  current_step_key: string;
  current_step_name: string | null;
  status: string;
};
type WorkflowVersionOption={id:string;name:string;version_number:number};
type BusinessWorkflowStep = {
  step_key: string;
  name: string;
  sort_order: number;
  actor_scope: string | null;
  is_required: number;
  field_count: number;
};
type TaskSummary = {
  module_code: string;
  pending_count: number;
  overdue_count: number;
};
type Service = { service_code: string; service_name: string; status: string };
type Member = {
  id: string;
  display_name: string;
  department_name: string | null;
};
type CustomerOption = { id: string; code: string; name: string };
type ExpenseRisk = {
  receivable_count: number;
  payable_count: number;
  receivable_total: number;
  payable_total: number;
  receivable_confirmed: number;
  payable_confirmed: number;
  receivable_finance_locked: number;
  payable_finance_locked: number;
  pending_warehouse_differences: number;
};
type WorkflowFormRow = {
  step_state_id: string;
  step_key: string;
  step_name: string;
  step_sort_order: number;
  step_status: string;
  module_state_id: string | null;
  module_code: string | null;
  module_name: string | null;
  module_sort_order: number | null;
  module_required: number | null;
  module_status: string | null;
  responsibility_position_code: string | null;
  position_name: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  required_field_count: number;
  optional_field_count: number;
  task_state_id: string | null;
  task_key: string | null;
  task_name: string | null;
  task_status: string | null;
  task_type: string | null;
  task_position_code: string | null;
  task_position_name: string | null;
  task_assignee_user_id: string | null;
  task_instructions: string | null;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view"),
    id = params.orderId;
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.order_date,o.business_nature,o.business_type,o.transport_terms,o.trade_terms,
      o.exit_port,bp.name exit_port_name,o.overseas_warehouse_id,ow.name overseas_warehouse_name,
      ow.code overseas_warehouse_code,ow.address overseas_warehouse_address,o.overseas_warehouse_address_note,
      o.transit_locations,o.customs_location,o.route_notes,o.customer_id,c.name customer_name,c.code customer_code,
      o.customer_reference,q.quote_number,o.shipper_name,o.shipper_contact,o.shipper_phone,o.origin_country,
      o.origin_state,o.origin_city,o.origin_address,o.consignee_name,o.consignee_contact,o.consignee_phone,
      o.destination_country,o.destination_state,o.destination_city,o.destination_address,o.cargo_description,
      o.pieces,o.gross_weight_kg,o.volume_cbm,o.transport_mode,o.service_level,o.requested_pickup_date,
      o.requested_delivery_date,o.status,o.source,o.special_instructions,o.current_step_name,
      au.display_name assignee_name,o.workflow_updated_at,o.is_overdue,o.exception_status,o.completion_status,
      o.business_completed_at,o.settlement_completed_at,o.created_at
     FROM transport_orders o
     JOIN customers c ON c.id=o.customer_id
     LEFT JOIN quotations q ON q.id=o.quotation_id
     LEFT JOIN users au ON au.id=o.current_assignee_user_id
     LEFT JOIN reference_data bp ON bp.organization_id=o.organization_id AND bp.category='border_port' AND bp.code=o.exit_port
     LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
     WHERE o.id=? AND o.organization_id=?`,
  )
    .bind(id, current.organizationId)
    .first<Order>();
  if (!order) throw new Response("订单不存在", { status: 404 });
  const modules = await listOrderModules(current.organizationId, id);
  const currentWorkflowTasks = await listCurrentWorkflowTasks(current.organizationId,id);
  const [history, attachments, macro, businessWorkflow, workflowSteps, workflowFormRows, tasks, services, members, customers, transitions, expenseRisk, workflowVersions] =
    await Promise.all([
    env.DB.prepare(
      `SELECT h.id,h.action_name,h.from_status,h.to_status,h.to_step_code,a.display_name actor_name,au.display_name assignee_name,h.notes,h.occurred_at FROM order_workflow_history h LEFT JOIN users a ON a.id=h.actor_user_id LEFT JOIN users au ON au.id=h.assignee_user_id WHERE h.order_id=? AND h.organization_id=? ORDER BY h.occurred_at DESC`,
    )
      .bind(id, current.organizationId)
      .all<History>(),
    env.DB.prepare(
      "SELECT id,file_name,content_type,size_bytes,data_url,created_at FROM order_attachments WHERE order_id=? AND organization_id=? ORDER BY created_at DESC",
    )
      .bind(id, current.organizationId)
      .all<Attachment>(),
    env.DB.prepare(
      `SELECT wh.id,wh.step_name,u.display_name actor_name,wh.source,wh.occurred_at FROM workflow_instances wi JOIN workflow_history wh ON wh.instance_id=wi.id LEFT JOIN users u ON u.id=wh.actor_user_id WHERE wi.order_id=? AND wi.organization_id=? ORDER BY wh.occurred_at DESC`,
    )
      .bind(id, current.organizationId)
      .all<MacroHistory>(),
    env.DB.prepare(
      `SELECT wi.workflow_id,wd.name workflow_name,wd.version_number,wi.current_step_key,ws.name current_step_name,wi.status
       FROM workflow_instances wi
       JOIN workflow_definitions wd ON wd.id=wi.workflow_id
       LEFT JOIN workflow_steps ws ON ws.workflow_id=wi.workflow_id AND ws.step_key=wi.current_step_key
       WHERE wi.order_id=? AND wi.organization_id=?
       LIMIT 1`,
    )
      .bind(id, current.organizationId)
      .first<BusinessWorkflow>(),
    env.DB.prepare(
      `SELECT ws.step_key,ws.name,ws.sort_order,ws.actor_scope,ws.is_required,
        COUNT(f.id) field_count
       FROM workflow_instances wi
       JOIN workflow_steps ws ON ws.workflow_id=wi.workflow_id AND ws.is_active=1
       LEFT JOIN workflow_step_fields f ON f.workflow_id=ws.workflow_id AND f.step_id=ws.id AND f.is_active=1
       WHERE wi.order_id=? AND wi.organization_id=?
       GROUP BY ws.step_key,ws.name,ws.sort_order,ws.actor_scope,ws.is_required
       ORDER BY ws.sort_order,ws.step_key`,
    )
      .bind(id, current.organizationId)
      .all<BusinessWorkflowStep>(),
    env.DB.prepare(
      `SELECT ss.id step_state_id,ss.step_key,ss.step_name,ss.sort_order step_sort_order,ss.status step_status,
              ms.id module_state_id,ms.module_code,ms.display_name module_name,ms.sort_order module_sort_order,
              ms.is_required module_required,ms.status module_status,ms.responsibility_position_code,
              p.name position_name,omi.assignee_user_id,u.display_name assignee_name,
              (SELECT COUNT(*) FROM workflow_instance_fields f
                WHERE f.instance_id=wi.id AND f.module_code=ms.module_code AND f.is_active=1 AND f.is_required=1) required_field_count,
              (SELECT COUNT(*) FROM workflow_instance_fields f
                WHERE f.instance_id=wi.id AND f.module_code=ms.module_code AND f.is_active=1 AND f.is_required=0) optional_field_count,
              ts.id task_state_id,ts.task_key,ts.name task_name,ts.status task_status,ts.task_type,
              ts.responsibility_position_code task_position_code,tp.name task_position_name,
              ts.assignee_user_id task_assignee_user_id,
              ts.instructions task_instructions
         FROM workflow_instances wi
         JOIN workflow_instance_step_states ss ON ss.instance_id=wi.id
         LEFT JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
         LEFT JOIN workflow_instance_task_states ts ON ts.instance_module_state_id=ms.id
         LEFT JOIN positions p ON p.organization_id=wi.organization_id AND p.code=ms.responsibility_position_code
         LEFT JOIN positions tp ON tp.organization_id=wi.organization_id AND tp.code=ts.responsibility_position_code
         LEFT JOIN order_module_instances omi ON omi.organization_id=wi.organization_id
           AND omi.order_id=wi.order_id AND omi.module_code=ms.module_code
         LEFT JOIN users u ON u.id=omi.assignee_user_id
        WHERE wi.order_id=? AND wi.organization_id=?
        ORDER BY ss.sort_order,ms.sort_order,ts.sort_order`,
    )
      .bind(id, current.organizationId)
      .all<WorkflowFormRow>(),
    env.DB.prepare(
      `SELECT module_code,COUNT(*) pending_count,SUM(CASE WHEN due_at IS NOT NULL AND due_at<? THEN 1 ELSE 0 END) overdue_count FROM order_tasks WHERE order_id=? AND organization_id=? AND status IN ('pending','in_progress') GROUP BY module_code`,
    )
      .bind(new Date().toISOString(), id, current.organizationId)
      .all<TaskSummary>(),
    env.DB.prepare(
      "SELECT service_code,service_name,status FROM order_services WHERE order_id=? AND organization_id=? ORDER BY created_at",
    )
      .bind(id, current.organizationId)
      .all<Service>(),
    env.DB.prepare(
      "SELECT u.id,u.display_name,d.name department_name FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN departments d ON d.id=m.department_id WHERE m.organization_id=? AND m.status='active' AND u.status='active' ORDER BY d.sort_order,u.display_name",
    )
      .bind(current.organizationId)
      .all<Member>(),
    env.DB.prepare(
      "SELECT id,code,name FROM customers WHERE organization_id=? AND status='active' ORDER BY name",
    )
      .bind(current.organizationId)
      .all<CustomerOption>(),
    listOrderWorkflowTransitions(current.organizationId),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM business_expenses e WHERE e.organization_id=? AND e.order_id=? AND e.direction='receivable' AND e.stage!='cancelled') receivable_count,
         (SELECT COUNT(*) FROM business_expenses e WHERE e.organization_id=? AND e.order_id=? AND e.direction='payable' AND e.stage!='cancelled') payable_count,
         COALESCE((SELECT SUM(e.base_amount) FROM business_expenses e WHERE e.organization_id=? AND e.order_id=? AND e.direction='receivable' AND e.stage!='cancelled'),0) receivable_total,
         COALESCE((SELECT SUM(e.base_amount) FROM business_expenses e WHERE e.organization_id=? AND e.order_id=? AND e.direction='payable' AND e.stage!='cancelled'),0) payable_total,
         COALESCE((SELECT confirmed FROM order_expense_direction_controls x WHERE x.organization_id=? AND x.order_id=? AND x.direction='receivable'),0) receivable_confirmed,
         COALESCE((SELECT confirmed FROM order_expense_direction_controls x WHERE x.organization_id=? AND x.order_id=? AND x.direction='payable'),0) payable_confirmed,
         COALESCE((SELECT finance_locked FROM order_expense_direction_controls x WHERE x.organization_id=? AND x.order_id=? AND x.direction='receivable'),0) receivable_finance_locked,
         COALESCE((SELECT finance_locked FROM order_expense_direction_controls x WHERE x.organization_id=? AND x.order_id=? AND x.direction='payable'),0) payable_finance_locked,
         (SELECT COUNT(*) FROM warehouse_receipt_differences d WHERE d.organization_id=? AND d.order_id=? AND d.status='pending') pending_warehouse_differences`,
    )
      .bind(
        current.organizationId,id,current.organizationId,id,
        current.organizationId,id,current.organizationId,id,
        current.organizationId,id,current.organizationId,id,
        current.organizationId,id,current.organizationId,id,
        current.organizationId,id,
      )
      .first<ExpenseRisk>(),
    env.DB.prepare(
      `SELECT id,name,version_number FROM workflow_definitions
       WHERE organization_id=? AND lifecycle_status='published' AND validation_status='valid'
         AND status='active' AND road_load_type=? ORDER BY updated_at DESC,version_number DESC`,
    ).bind(current.organizationId,order.business_type).all<WorkflowVersionOption>(),
  ]);
  return {
    current,
    canManage: current.permissions.includes("order.manage"),
    order,
    history: history.results,
    attachments: attachments.results,
    macro: macro.results,
    businessWorkflow,
    workflowSteps: workflowSteps.results,
    workflowFormRows: workflowFormRows.results,
    modules,
    currentWorkflowTasks,
    workflowVersions: workflowVersions.results,
    tasks: tasks.results,
    services: services.results,
    members: members.results,
    customers: customers.results,
    transitions,
    expenseRisk: expenseRisk || {
      receivable_count: 0,
      payable_count: 0,
      receivable_total: 0,
      payable_total: 0,
      receivable_confirmed: 0,
      payable_confirmed: 0,
      receivable_finance_locked: 0,
      payable_finance_locked: 0,
      pending_warehouse_differences: 0,
    },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "order.manage"),
    form = await request.formData();
  const intent = valueOf(form, "intent");
  if (intent === "workflow_version_switch") {
    const targetWorkflowId=valueOf(form,"targetWorkflowId");
    const target=await env.DB.prepare(
      `SELECT id,name,road_load_type FROM workflow_definitions
       WHERE id=? AND organization_id=? AND lifecycle_status='published' AND validation_status='valid' AND status='active'`,
    ).bind(targetWorkflowId,current.organizationId).first<{id:string;name:string;road_load_type:string}>();
    if(!target)return{formError:"目标工作流版本无效或尚未发布"};
    const sourceOrder=await env.DB.prepare(
      "SELECT id,business_type FROM transport_orders WHERE id=? AND organization_id=?",
    ).bind(params.orderId,current.organizationId).first<{id:string;business_type:string}>();
    if(!sourceOrder)return{formError:"订单不存在"};
    if(sourceOrder.business_type!==target.road_load_type)return{formError:"目标工作流与订单整车/拼车类型不一致"};
    const batchOrders=await env.DB.prepare(
      `SELECT DISTINCT bo2.order_id FROM transport_batch_orders bo1
       JOIN transport_batches b ON b.id=bo1.batch_id AND b.status!='cancelled'
       JOIN transport_batch_orders bo2 ON bo2.batch_id=b.id AND bo2.status!='removed'
       WHERE bo1.organization_id=? AND bo1.order_id=? AND bo1.status!='removed'`,
    ).bind(current.organizationId,sourceOrder.id).all<{order_id:string}>();
    const orderIds=batchOrders.results.length?batchOrders.results.map((item)=>item.order_id):[sourceOrder.id];
    const placeholders=orderIds.map(()=>"?").join(",");
    const validOrders=await env.DB.prepare(
      `SELECT COUNT(*) count FROM transport_orders WHERE organization_id=? AND business_type=? AND id IN (${placeholders})`,
    ).bind(current.organizationId,target.road_load_type,...orderIds).first<{count:number}>();
    if(validOrders?.count!==orderIds.length)return{formError:"同一配载批次存在类型不一致订单，已停止切换"};
    try{
      for(const orderId of orderIds){
        await replaceWorkflowInstanceVersion({organizationId:current.organizationId,orderId,targetWorkflowId:target.id});
        await ensureOrderModules(current.organizationId,orderId);
        await syncOrderBusinessWorkflow({organizationId:current.organizationId,orderId,actorUserId:current.userId,source:"admin"});
      }
      await writeAudit({request,action:"workflow.version.switch",resourceType:"transport_order",resourceId:sourceOrder.id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{targetWorkflowId:target.id,orderIds}});
      return{success:orderIds.length>1?`配载批次 ${orderIds.length} 张订单已统一使用“${target.name}”`:`订单已使用“${target.name}”`};
    }catch(error){return{formError:error instanceof Error?error.message:"工作流版本切换失败"};}
  }
  if (intent === "workflow_task_complete") {
    try {
      await completeWorkflowTask({
        organizationId:current.organizationId,
        orderId:params.orderId,
        taskStateId:valueOf(form,"taskStateId"),
        actorUserId:current.userId,
      });
      await syncOrderBusinessWorkflow({
        organizationId:current.organizationId,
        orderId:params.orderId,
        actorUserId:current.userId,
        source:"admin",
      });
      await writeAudit({
        request,action:"workflow.task.complete",resourceType:"transport_order",
        resourceId:params.orderId,organizationId:current.organizationId,actorUserId:current.userId,
        metadata:{taskStateId:valueOf(form,"taskStateId")},
      });
      return {success:"当前办理步骤已完成，工作流已重新校验"};
    } catch (error) {
      return {formError:error instanceof Error?error.message:"办理步骤提交失败"};
    }
  }
  if (intent === "order_update") {
    const orderId = params.orderId;
    const order = await env.DB.prepare(
      "SELECT id,status FROM transport_orders WHERE id=? AND organization_id=?",
    ).bind(orderId, current.organizationId).first<{ id: string; status: string }>();
    if (!order) return { formError: "订单不存在" };
    if (order.status !== "draft") return { formError: "只有草稿订单可以直接修改；已提交订单请先退回草稿" };
    const customerId = valueOf(form, "customerId");
    const customer = await env.DB.prepare(
      "SELECT id,name FROM customers WHERE id=? AND organization_id=? AND status='active'",
    ).bind(customerId, current.organizationId).first<{ id: string; name: string }>();
    if (!customer) return { formError: "请选择有效客户" };
    const shipperName = valueOf(form, "shipperName");
    const shipperContact = valueOf(form, "shipperContact");
    const shipperPhone = valueOf(form, "shipperPhone");
    const originCity = valueOf(form, "originCity");
    const originAddress = valueOf(form, "originAddress");
    const consigneeName = valueOf(form, "consigneeName");
    const destinationCity = valueOf(form, "destinationCity");
    const destinationAddress = valueOf(form, "destinationAddress");
    const requestedPickupDate = valueOf(form, "requestedPickupDate");
    if (!shipperName || !shipperContact || !shipperPhone || !requestedPickupDate || !originCity || !originAddress || !consigneeName || !destinationCity || !destinationAddress)
      return { formError: "请补齐发货人、联系人、电话、预约提货时间、收发货城市和地址" };
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE transport_orders
          SET customer_id=?,shipper_name=?,shipper_contact=?,shipper_phone=?,
              origin_country=?,origin_state=?,origin_city=?,origin_address=?,
              consignee_name=?,consignee_contact=?,consignee_phone=?,
              destination_country=?,destination_state=?,destination_city=?,destination_address=?,
              requested_pickup_date=?,requested_delivery_date=?,route_notes=?,special_instructions=?,updated_at=?
        WHERE id=? AND organization_id=?`,
      ).bind(
        customerId,
        shipperName,
        shipperContact,
        shipperPhone,
        valueOf(form, "originCountry") || "CN",
        valueOf(form, "originState") || null,
        originCity,
        originAddress,
        consigneeName,
        valueOf(form, "consigneeContact") || null,
        valueOf(form, "consigneePhone") || null,
        valueOf(form, "destinationCountry") || "UZ",
        valueOf(form, "destinationState") || null,
        destinationCity,
        destinationAddress,
        requestedPickupDate,
        valueOf(form, "requestedDeliveryDate") || null,
        null,
        valueOf(form, "notes") || null,
        now,
        orderId,
        current.organizationId,
      ),
      env.DB.prepare(
        "UPDATE shipments SET customer_id=?,current_location=?,updated_at=? WHERE organization_id=? AND order_id=?",
      ).bind(customerId, originCity, now, current.organizationId, orderId),
    ]);
    await writeAudit({
      request,
      action: "order.update_draft",
      resourceType: "transport_order",
      resourceId: orderId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { customerId },
    });
    return { success: "订单基础信息已修改；提交审批前请再次核对货物和费用" };
  }
  if (intent !== "workflow_action")
    return { formError: "无效的订单操作" };
  return runOrderWorkflowAction({
    request,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    orderId: params.orderId,
    actionCode: valueOf(form, "actionCode"),
    assigneeUserId: valueOf(form, "assigneeUserId") || null,
    notes: valueOf(form, "notes"),
  });
}

export default function OrderDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { o } = { o: loaderData.order },
    busy = useNavigation().state !== "idle",
    success = actionData && "success" in actionData ? actionData.success : undefined,
    formError = actionData && "formError" in actionData ? actionData.formError : undefined,
    blockingNotice = buildOrderBlockingNotice(formError),
    cancelActions = loaderData.transitions.filter(
      (transition) =>
        transition.from_status === o.status &&
        transition.to_status === "cancelled",
    );
  return (
    <>
      <header className="page-header order-detail-page-header">
        <div>
          <p className="eyebrow">TRANSPORT ORDER</p>
          <h1>运输订单 · {o.order_number}</h1>
          <p>
            {o.customer_name} · {o.origin_state || ""} {o.origin_city} →{" "}
            {o.destination_state || ""} {o.destination_city}
          </p>
        </div>
        <div className="page-actions" id="order-workflow-actions">
          <span className="status-pill">{statusLabel(o.status)}</span>
          <span className={`status-pill review-status-${o.completion_status}`}>
            {completionStatusLabels[o.completion_status]}
          </span>
          {loaderData.canManage && o.status === "draft" && (
            <Modal
              title={`修改订单 · ${o.order_number}`}
              triggerLabel="修改订单"
              triggerClassName="secondary"
              closeSignal={success}
              size="wide"
            >
              <OrderEditForm
                order={o}
                customers={loaderData.customers}
                busy={busy}
              />
            </Modal>
          )}
          {loaderData.canManage&&loaderData.businessWorkflow&&loaderData.workflowVersions.some((item)=>item.id!==loaderData.businessWorkflow?.workflow_id)&&(
            <Modal title={`使用新规则 · ${o.order_number}`} triggerLabel="使用新规则" triggerClassName="secondary" closeSignal={success}>
              <Form method="post" className="stack">
                <input type="hidden" name="intent" value="workflow_version_switch"/>
                <label className="field"><span>当前版本</span><input value={`${loaderData.businessWorkflow.workflow_name} · v${loaderData.businessWorkflow.version_number}`} readOnly/></label>
                <label className="field"><span>目标已发布版本</span><select name="targetWorkflowId" required defaultValue=""><option value="">请选择</option>{loaderData.workflowVersions.filter((item)=>item.id!==loaderData.businessWorkflow?.workflow_id).map((item)=><option key={item.id} value={item.id}>{item.name} · v{item.version_number}</option>)}</select></label>
                <div className="alert warning">切换后系统按新规则重新校验当前节点；已填业务数据保留。若订单已有配载单，同批全部订单会一起切换。</div>
                <button className="primary" disabled={busy}>确认使用新规则</button>
              </Form>
            </Modal>
          )}
          {loaderData.canManage &&
            cancelActions.map((transition) => (
              <OrderDetailAction
                key={transition.action_code}
                order={o}
                transition={transition}
                members={loaderData.members}
                busy={busy}
                success={success}
              />
            ))}
          <Link className="secondary" to="/admin/orders">
            返回订单工作台
          </Link>
        </div>
      </header>
      {blockingNotice && <OrderBlockingNotice notice={blockingNotice} />}
      {success && <div className="alert success">{success}</div>}
      <OrderBusinessForm data={loaderData} busy={busy} />
    </>
  );
}

function OrderBusinessForm({
  data,
  busy,
}: {
  data: Route.ComponentProps["loaderData"];
  busy: boolean;
}) {
  const order = data.order;
  const guidance = orderNextGuidance({
    orderId: order.id,
    orderStatus: order.status,
    modules: data.modules,
  });
  const directAction = directOrderWorkflowAction(data);
  const currentStepKey = data.businessWorkflow?.current_step_key ?? null;
  const stepRows = new Map<string, WorkflowFormRow[]>();
  for (const row of data.workflowFormRows) {
    const rows = stepRows.get(row.step_key) ?? [];
    rows.push(row);
    stepRows.set(row.step_key, rows);
  }
  const configuredSteps = data.workflowSteps.map((step) => ({
    ...step,
    rows: stepRows.get(step.step_key) ?? [],
  }));
  const currentConfiguredStep =
    configuredSteps.find((step) => step.step_key === currentStepKey) ??
    configuredSteps[0] ??
    null;
  const enabledModules = composeOrderWorkflow(data.modules);
  const configuredModuleCodes = new Set(
    data.workflowFormRows.map((row) => row.module_code).filter(Boolean),
  );
  const unconfiguredModules = enabledModules.filter(
    (module) => !configuredModuleCodes.has(module.module_code),
  );
  const currentPositionName =
    data.currentWorkflowTasks.find((task) => task.status !== "completed")?.position_name ||
    orderResponsiblePosition(guidance.moduleCode, order.status).name;

  return (
    <section className="order-single-form" aria-label="订单业务办理表单">
      <OrderVerticalWorkflow
        order={order}
        modules={data.modules}
        workflow={data.businessWorkflow}
        workflowSteps={data.workflowSteps}
        workflowFormRows={data.workflowFormRows}
      />
      <main className="order-form-sheet">
        <header className="order-form-current">
          <div>
            <span>当前办理</span>
            <h2>{data.businessWorkflow?.current_step_name || order.current_step_name}</h2>
            <p>{guidance.action}</p>
          </div>
          <dl>
            <div><dt>负责岗位</dt><dd>{currentPositionName}</dd></div>
            <div><dt>具体负责人</dt><dd>{order.assignee_name || "待分配"}</dd></div>
            <div className={guidance.blocker ? "blocked" : ""}>
              <dt>办理条件</dt>
              <dd>{guidance.blocker || "当前节点暂无阻断"}</dd>
            </div>
          </dl>
          <div className="order-form-primary-action">
            {directAction && !guidance.blocker ? (
              <Form method="post">
                <input type="hidden" name="intent" value="workflow_action" />
                <input type="hidden" name="actionCode" value={directAction.actionCode} />
                {directAction.assigneeUserId ? (
                  <input type="hidden" name="assigneeUserId" value={directAction.assigneeUserId} />
                ) : directAction.requiresAssignee ? (
                  <select name="assigneeUserId" required defaultValue="">
                    <option value="">选择下一处理人</option>
                    {data.members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.display_name}{member.department_name ? ` · ${member.department_name}` : ""}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button className="primary" disabled={busy}>{directAction.label}</button>
              </Form>
            ) : guidance.moduleCode ? (
              <a className={guidance.blocker ? "secondary" : "primary"} href={`#order-form-module-${guidance.moduleCode}`}>
                {guidance.blocker ? "查看阻断并处理" : "定位当前办理区"}
              </a>
            ) : null}
          </div>
        </header>

        <section className="order-form-section order-form-basics">
          <header>
            <div><span>订单资料</span><h2>基础信息</h2></div>
            {data.canManage && order.status === "draft" && <small>草稿阶段可通过页面顶部“修改订单”调整</small>}
          </header>
          <div className="order-form-data-grid">
            <Info label="客户" value={order.customer_name} />
            <Info label="关联报价" value={order.quote_number} />
            <Info label="订单类型" value={businessTypeLabels[order.business_type] ?? order.business_type} />
            <Info label="发货方" value={order.shipper_name} />
            <Info label="发货联系人" value={[order.shipper_contact, order.shipper_phone].filter(Boolean).join(" · ") || null} />
            <Info label="预约提货" value={order.requested_pickup_date} />
            <Info label="国内提货地址" value={[order.origin_state, order.origin_city, order.origin_address].filter(Boolean).join(" ")} />
            <Info label="境外收货联系人" value={[order.consignee_contact, order.consignee_phone].filter(Boolean).join(" · ") || null} />
            <Info label="境外目的地" value={[order.destination_state, order.destination_city, order.destination_address].filter(Boolean).join(" ")} />
            <Info label="境外目的仓" value={order.overseas_warehouse_name} />
            <Info label="货物摘要" value={`${order.cargo_description || "未填写"} · ${order.pieces} 件 · ${order.gross_weight_kg} KG · ${order.volume_cbm} CBM`} />
            <Info label="备注" value={order.special_instructions} />
          </div>
        </section>

        <div className="order-form-workflow-sections">
          {(currentConfiguredStep ? [currentConfiguredStep] : []).map((step) => {
            const stepIndex = Math.max(0, configuredSteps.findIndex((item) => item.step_key === step.step_key));
            const current = step.step_key === currentStepKey;
            const completed = step.rows[0]?.step_status === "completed";
            const moduleRows = uniqueWorkflowModules(step.rows);
            return (
              <details
                className={`order-form-step ${current ? "current" : ""} ${completed ? "completed" : "future"}`}
                key={step.step_key}
                open={current}
              >
                <summary>
                  <i>{completed ? "✓" : stepIndex + 1}</i>
                  <div><strong>{step.name}</strong><small>{step.actor_scope || "按模组岗位办理"}</small></div>
                  <span>{current ? "当前节点" : completed ? "已完成" : step.is_required ? "后续必办" : "后续可选"}</span>
                </summary>
                <div className="order-form-step-body">
                  {moduleRows.map((row) => {
                    const module = data.modules.find((item) => item.module_code === row.module_code);
                    const tasks = uniqueWorkflowTasks(step.rows.filter((item) => item.module_state_id === row.module_state_id));
                    const pendingTasks = tasks.filter((task) => task.task_status !== "completed");
                    const mine = current && row.module_status !== "completed" && (
                      pendingTasks.length > 0
                        ? pendingTasks.some((task) => {
                            if (task.task_assignee_user_id) return task.task_assignee_user_id === data.current.userId;
                            return (task.task_position_code || row.responsibility_position_code) === data.current.positionCode;
                          })
                        : row.assignee_user_id
                          ? row.assignee_user_id === data.current.userId
                          : row.responsibility_position_code === data.current.positionCode
                    );
                    const editable = Boolean(
                      module &&
                      orderModuleAccess(order.status, module.module_code).canEdit &&
                      canManageOrderModule(data.current, module.module_code),
                    );
                    return (
                      <article
                        className={`order-form-module ${mine ? "mine" : ""} ${row.module_status === "completed" ? "completed" : ""}`}
                        id={`order-form-module-${row.module_code}`}
                        key={row.module_state_id}
                      >
                        <header>
                          <div>
                            <span>{row.module_required ? "必须办理" : "按需办理"}</span>
                            <h3>{row.module_name || orderModuleDefinition(row.module_code || "")?.name || row.module_code}</h3>
                          </div>
                          <div className="order-form-module-meta">
                            {mine && <b>待我处理</b>}
                            <span>{row.position_name || row.responsibility_position_code || "待配置岗位"}</span>
                            <span>{row.assignee_name || "待分配人员"}</span>
                            <em>{workflowFormStatusLabel(row.module_status || module?.status || "not_started")}</em>
                          </div>
                        </header>
                        <div className="order-form-module-summary">
                          <span><b>{row.required_field_count}</b> 个必填字段</span>
                          <span><b>{row.optional_field_count}</b> 个选填字段</span>
                          <span><b>{tasks.length}</b> 个办理步骤</span>
                          {module?.blocking_reason && <span className="blocked">阻断：{module.blocking_reason}</span>}
                        </div>
                        {tasks.length > 0 && (
                          <ol className="order-form-task-list">
                            {tasks.map((task, index) => (
                              <li className={task.task_status === "completed" ? "completed" : ""} key={task.task_state_id || `${row.module_state_id}-${index}`}>
                                <i>{task.task_status === "completed" ? "✓" : index + 1}</i>
                                <div>
                                  <strong>{task.task_name}</strong>
                                  <small>{task.task_position_name || task.task_position_code || row.position_name || "按模组岗位"}{task.task_instructions ? ` · ${task.task_instructions}` : ""}</small>
                                </div>
                                {current && task.task_status !== "completed" && isWorkflowTaskManual(step.step_key, task.task_key || "") ? (
                                  <Form method="post">
                                    <input type="hidden" name="intent" value="workflow_task_complete" />
                                    <input type="hidden" name="taskStateId" value={task.task_state_id || ""} />
                                    <button className="secondary" disabled={busy}>{workflowTaskActionLabel(task.task_type || "manual")}</button>
                                  </Form>
                                ) : task.task_status !== "completed" ? <small>保存本节完整数据后自动完成</small> : null}
                              </li>
                            ))}
                          </ol>
                        )}
                        {row.module_code && (
                          <div className="order-form-module-action">
                            <Link className={current && editable ? "primary" : "secondary"} to={`/admin/orders/${order.id}/modules/${row.module_code}#module-business-data`}>
                              {current && editable ? "填写本节内容" : "查看本节内容"}
                            </Link>
                            {!editable && <small>{current ? "当前账号仅可查看，或本节尚未开放编辑" : "后续节点暂为只读"}</small>}
                          </div>
                        )}
                      </article>
                    );
                  })}
                  {!moduleRows.length && <p className="empty-state">该节点未配置业务模组，但节点本身仍保留在订单流程中。</p>}
                </div>
              </details>
            );
          })}
        </div>

        {unconfiguredModules.length > 0 && !currentConfiguredStep && (
          <details className="order-form-step legacy">
            <summary><i>+</i><div><strong>兼容业务模组</strong><small>当前订单已启用但未挂入冻结工作流的模组</small></div><span>{unconfiguredModules.length} 项</span></summary>
            <div className="order-form-step-body order-form-legacy-modules">
              {unconfiguredModules.map((module) => (
                <Link key={module.id} to={`/admin/orders/${order.id}/modules/${module.module_code}#module-business-data`}>
                  <strong>{module.module_name}</strong><small>{moduleStatusLabels[module.status] || module.status}</small>
                </Link>
              ))}
            </div>
          </details>
        )}

        <details className="order-form-records">
          <summary>附件与办理记录 <span>{data.attachments.length} 个附件 · {data.history.length + data.macro.length} 条记录</span></summary>
          <div className="order-form-record-grid">
            <section>
              <h3>附件</h3>
              {data.attachments.map((attachment) => (
                <a key={attachment.id} href={attachment.data_url} download={attachment.file_name}>{attachment.file_name}</a>
              ))}
              {!data.attachments.length && <small>暂无附件</small>}
            </section>
            <section>
              <h3>最近记录</h3>
              {[...data.history, ...data.macro].slice(0, 8).map((item) => (
                <div key={item.id}><strong>{"action_name" in item ? item.action_name : item.step_name}</strong><small>{new Date(item.occurred_at).toLocaleString("zh-CN")}</small></div>
              ))}
              {!data.history.length && !data.macro.length && <small>暂无记录</small>}
            </section>
          </div>
        </details>
      </main>
    </section>
  );
}

function uniqueWorkflowModules(rows: WorkflowFormRow[]) {
  const modules = new Map<string, WorkflowFormRow>();
  for (const row of rows) {
    if (row.module_state_id && !modules.has(row.module_state_id)) modules.set(row.module_state_id, row);
  }
  return [...modules.values()];
}

function uniqueWorkflowTasks(rows: WorkflowFormRow[]) {
  const tasks = new Map<string, WorkflowFormRow>();
  for (const row of rows) {
    if (row.task_state_id && !tasks.has(row.task_state_id)) tasks.set(row.task_state_id, row);
  }
  return [...tasks.values()];
}

function workflowFormStatusLabel(status: string) {
  if (status === "completed") return "已完成";
  if (status === "active" || status === "in_progress") return "办理中";
  if (status === "blocked") return "已阻断";
  if (status === "not_applicable") return "本单不适用";
  return "待办理";
}

function workflowTaskActionLabel(taskType:string) {
  if (taskType === "review") return "确认无误并继续";
  if (taskType === "decision") return "确认决策完成";
  if (taskType === "system") return "重新检查系统结果";
  return "确认本步骤完成";
}

function isWorkflowTaskManual(stepKey:string,taskKey:string) {
  return !taskKey.startsWith("handle_") || stepKey.startsWith("custom_");
}

type OrderBlockingNoticeData = {
  title: string;
  message: string;
  hint: string;
  href: string;
};

function buildOrderBlockingNotice(message?: string): OrderBlockingNoticeData | null {
  if (!message) return null;
  if (message.includes("口岸") || message.includes("目的仓") || message.includes("委托信息")) {
    return {
      title: "订单暂时不能推进",
      message,
      hint: "先补齐委托信息，再回来继续提交审批。",
      href: `#order-form-module-consignment`,
    };
  }
  if (message.includes("货物")) {
    return {
      title: "订单暂时不能推进",
      message,
      hint: "货物信息可在订单详情页随时查看和补充，不再阻断审批提交。",
      href: `#order-form-module-cargo`,
    };
  }
  if (message.includes("费用") || message.includes("应收") || message.includes("应付")) {
    return {
      title: "订单暂时不能推进",
      message,
      hint: "先补录费用，再回来继续推进订单。",
      href: `#order-form-module-costs`,
    };
  }
  return {
    title: "订单暂时不能推进",
    message,
    hint: "请按提示补齐资料后再继续推进。",
    href: "#order-form-module-consignment",
  };
}

function OrderBlockingNotice({ notice }: { notice: OrderBlockingNoticeData }) {
  return (
    <aside className="order-blocking-notice" role="alert" aria-live="assertive">
      <div>
        <span>需要处理</span>
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
        <small>{notice.hint}</small>
      </div>
      <Link className="primary" to={notice.href}>
        查看阻断并处理
      </Link>
    </aside>
  );
}

function OrderModulesByStage({
  orderId,
  orderStatus,
  modules,
  tasks,
}: {
  orderId: string;
  orderStatus: string;
  modules: OrderModuleInstance[];
  tasks: TaskSummary[];
}) {
  const enabledModules = modules.filter((module) => module.enabled === 1);
  const workflowModules = composeOrderWorkflow(modules);
  return (
    <div className="order-stage-list" id="order-module-stages">
      {orderBusinessStages.map((stage) => {
        const stageModules = stage.modules
          .map((moduleCode) =>
            enabledModules.find(
              (module) => module.module_code === moduleCode,
            ),
          )
          .filter((module): module is OrderModuleInstance => Boolean(module));
        const stageAccess = orderStageAccess(orderStatus, stage);
        return (
          <section
            className={`order-stage-group ${stageAccess.canEdit ? "available" : "read-only"}`}
            key={stage.code}
          >
            <header className="order-stage-header">
              <div>
                <h3>{stage.title}</h3>
                <p>{stage.description}</p>
              </div>
              <span>
                {stageAccess.canEdit
                  ? `${stageModules.length} 个模块可办理`
                  : `只读 · ${stageAccess.reason}`}
              </span>
            </header>
            {stageModules.length ? (
              <div className="order-module-grid">
                {stageModules.map((module) => {
                  const definition = orderModuleDefinition(module.module_code);
                  const access = orderModuleAccess(
                    orderStatus,
                    module.module_code,
                  );
                  const task = tasks.find(
                    (item) => item.module_code === module.module_code,
                  );
                  const workflowIndex = workflowModules.findIndex(
                    (item) => item.module_code === module.module_code,
                  );
                  const nextModule =
                    workflowIndex >= 0
                      ? workflowModules[workflowIndex + 1] ?? null
                      : null;
                  return (
                    <Link
                      id={`module-card-${module.module_code}`}
                      className={`order-module-card ${access.canEdit ? "" : "read-only"}`}
                      key={module.id}
                      to={`/admin/orders/${orderId}/modules/${module.module_code}`}
                    >
                      <header>
                        <i>
                          {String(
                            orderModuleSequence(module.module_code),
                          ).padStart(2, "0")}
                        </i>
                        <div>
                          <h3>{module.module_name}</h3>
                          <p>{definition?.description}</p>
                        </div>
                        <span
                          className={`status-pill ${["blocked", "exception", "not_applicable"].includes(module.status) ? "off" : ""}`}
                        >
                          {moduleStatusLabels[module.status] ?? module.status}
                        </span>
                      </header>
                      <div className="module-card-progress">
                        <i style={{ width: `${module.progress_percent}%` }} />
                      </div>
                      <div className="module-card-meta">
                        <span>
                          当前节点
                          <strong>{module.current_step_name || "待开始"}</strong>
                        </span>
                        <span>
                          负责人
                          <strong>{module.assignee_name || "未分配"}</strong>
                        </span>
                        <span>
                          待办
                          <strong
                            className={task?.overdue_count ? "danger-text" : ""}
                          >
                            {task?.pending_count ?? 0}
                            {task?.overdue_count
                              ? ` · 超时 ${task.overdue_count}`
                              : ""}
                          </strong>
                        </span>
                      </div>
                      {module.blocking_reason && (
                        <p className="module-card-blocker">
                          {module.blocking_reason}
                        </p>
                      )}
                      <small className="module-card-next">
                        {module.status === "completed"
                          ? nextModule
                            ? `下一步：进入${nextModule.module_name}，办理${nextModule.current_step_name || "当前节点"}`
                            : "下一步：确认签收及全部模块完成，再办理应收账单"
                          : `当前办理：${module.current_step_name || "进入模块查看待办"}`}
                      </small>
                      <p
                        className={`module-card-access ${access.canEdit ? "available" : "read-only"}`}
                      >
                        {access.canEdit
                          ? "进入办理 →"
                          : `可查看 · ${access.reason}`}
                      </p>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <p className="order-stage-empty">本订单未启用本阶段的可选模块。</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

type OrderMountedPanelKey = "modules" | "dossier" | "cargo" | "costs" | "history" | "attachments";

function parseMountedPanel(value: string | null): OrderMountedPanelKey | null {
  return value === "modules" ||
    value === "dossier" ||
    value === "cargo" ||
    value === "costs" ||
    value === "history" ||
    value === "attachments"
    ? value
    : null;
}

function OrderCommandCenter({
  data,
  mountedPanel,
  onPanelChange,
  busy,
}: {
  data: Route.ComponentProps["loaderData"];
  mountedPanel: OrderMountedPanelKey | null;
  onPanelChange: (panel: OrderMountedPanelKey | null) => void;
  busy: boolean;
}) {
  const order = data.order;
  const guidance = orderNextGuidance({
    orderId: order.id,
    orderStatus: order.status,
    modules: data.modules,
  });
  const currentWorkflowStep = data.businessWorkflow?.current_step_key ?? null;
  const expenseMode = expenseWarningMode(currentWorkflowStep);
  const expenseWarnings = expenseWarningList(data.expenseRisk, expenseMode);
  const gateRows = buildStageGateRows(
    data.modules,
    data.expenseRisk,
    currentWorkflowStep,
  );
  const gateWarnings = gateRows
    .filter((item) => item.blocked && item.kind !== "expense")
    .map((item) => item.message);
  const riskWarnings = gateRows
    .filter((item) => item.blocked)
    .map((item) => item.message);
  const primaryActionLabel = orderPrimaryActionLabel(guidance);
  const activeModule = data.modules.find(
    (module) => module.enabled === 1 && module.module_code === guidance.moduleCode,
  );
  const activeDefinition = activeModule
    ? orderModuleDefinition(activeModule.module_code)
    : null;
  const activeStepIndex = activeDefinition?.steps.findIndex(
    (step) => step.code === activeModule?.current_step_code,
  ) ?? -1;
  const directAction = directOrderWorkflowAction(data);
  const businessStepIndex = Math.max(
    0,
    data.workflowSteps.findIndex(
      (step) => step.step_key === data.businessWorkflow?.current_step_key,
    ),
  );
  const currentWorkTitle = data.businessWorkflow
    ? `${businessStepIndex + 1}. ${data.businessWorkflow.current_step_name || guidance.stage.title.replace(/^\d+\.\s*/, "")}`
    : guidance.stage.title;
  const currentResponsiblePosition = orderResponsiblePosition(
    guidance.moduleCode,
    order.status,
  ).name;
  const openPanel = (panel: OrderMountedPanelKey) =>
    onPanelChange(mountedPanel === panel ? null : panel);
  return (
    <section className="order-console" aria-label="订单指挥台">
      <div className="order-console-id">
        <div>
          <small>订单</small>
          <strong>{order.order_number}</strong>
        </div>
        <div>
          <small>客户</small>
          <strong>{order.customer_name}</strong>
        </div>
        <div>
          <small>线路</small>
          <strong>
            {order.origin_city} → {order.destination_city}
          </strong>
        </div>
        <div>
          <small>状态</small>
          <span className="status-pill">{statusLabel(order.status)}</span>
        </div>
      </div>
      <div className="order-console-main">
        <OrderVerticalWorkflow
          order={order}
          modules={data.modules}
          workflow={data.businessWorkflow}
          workflowSteps={data.workflowSteps}
        />
        <article className="order-now-card">
          <span>当前办理</span>
          <h2>{currentWorkTitle}</h2>
          <p>{guidance.action}</p>
          <div className="order-now-meta">
            <b>负责人：{guidance.owner}</b>
            <b>当前业务负责岗位：{currentResponsiblePosition}</b>
            <b className={guidance.blocker ? "danger-text" : ""}>
              {guidance.blocker ? `阻断：${guidance.blocker}` : "当前节点暂无阻断"}
            </b>
          </div>
          <div className="order-now-actions">
            {directAction && !guidance.blocker ? (
              <>
                <Form method="post" className="order-now-action-form">
                  <input type="hidden" name="intent" value="workflow_action" />
                  <input type="hidden" name="actionCode" value={directAction.actionCode} />
                  {directAction.assigneeUserId ? (
                    <input
                      type="hidden"
                      name="assigneeUserId"
                      value={directAction.assigneeUserId}
                    />
                  ) : directAction.requiresAssignee ? (
                    <select name="assigneeUserId" required defaultValue="">
                      <option value="">选择下一处理人</option>
                      {data.members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.display_name}
                          {member.department_name ? ` · ${member.department_name}` : ""}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button className="primary" disabled={busy}>
                    {directAction.label}
                  </button>
                  <small>{directAction.hint}</small>
                </Form>
                <Link className="secondary" to={guidance.href}>
                  查看模块资料
                </Link>
              </>
            ) : (
              <Link className={guidance.blocker ? "secondary" : "primary"} to={guidance.href}>
                {primaryActionLabel}
              </Link>
            )}
          </div>
          {activeDefinition && (
            <div className="order-now-module">
              <div>
                <small>当前模块</small>
                <strong>{activeDefinition.name}</strong>
                <p>{activeDefinition.description}</p>
              </div>
              <ol>
                {activeDefinition.steps.map((step, index) => (
                  <li
                    key={step.code}
                    className={
                      activeModule?.status === "completed" || index < activeStepIndex
                        ? "completed"
                        : index === activeStepIndex
                          ? "active"
                          : ""
                    }
                  >
                    {step.name}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </article>
        <aside className="order-risk-card">
          <span>风险和门禁</span>
          <strong>{riskWarnings.length ? `${riskWarnings.length} 项待处理` : "当前阶段暂无门禁"}</strong>
          <ul className="order-risk-list">
            {gateRows.map((item) => (
              <li key={item.label} className={item.blocked ? "blocked" : "clear"}>
                <b>{item.label}</b>
                <small>{item.message}</small>
              </li>
            ))}
          </ul>
          {gateRows.length > 0 && (
            <button type="button" className="text-button" onClick={() => openPanel(gateWarnings.length ? "modules" : "costs")}>
              {gateWarnings.length ? "查看门禁详情" : "查看费用"}
            </button>
          )}
        </aside>
      </div>
      <nav className="order-mount-tabs" aria-label="订单挂载内容">
        {[
          ["modules", "模块", `${data.modules.filter((item) => item.enabled === 1).length} 个 · 展开查看`],
          ["dossier", "资料", "展开订单资料"],
          ["cargo", "货物", `${order.pieces} 件 · 展开查看`],
          ["costs", "费用", expenseWarnings.length ? `${expenseWarnings.length} 项待处理 · 展开查看` : "正常 · 展开查看"],
          ["history", "历史", `${data.history.length + data.macro.length} 条 · 展开查看`],
          ["attachments", "附件", `${data.attachments.length} 个 · 展开查看`],
        ].map(([key, label, meta]) => (
          <button
            key={key}
            type="button"
            className={mountedPanel === key ? "active" : ""}
            onClick={() => openPanel(key as OrderMountedPanelKey)}
          >
            <span>{label}</span>
            <small>{meta}</small>
          </button>
        ))}
      </nav>
    </section>
  );
}

function orderPrimaryActionLabel(guidance: ReturnType<typeof orderNextGuidance>) {
  if (guidance.blocker) return "查看阻断并处理";
  if (guidance.action.includes("提交审批")) return "打开资料并提交审批";
  if (guidance.action.includes("审批")) return "打开审核分配";
  if (guidance.action.includes("确认派单")) return "确认派单";
  if (guidance.action.includes("复盘")) return "打开复盘";
  return "打开当前节点";
}

function directOrderWorkflowAction(data: Route.ComponentProps["loaderData"]) {
  const module = (code: string) =>
    data.modules.find((item) => item.enabled === 1 && item.module_code === code);
  const transition = (actionCode: string) =>
    data.transitions.find(
      (item) =>
        item.from_status === data.order.status &&
        item.action_code === actionCode,
    );
  if (data.order.status === "draft") {
    const submit = transition("submit");
    if (!submit) return null;
    // 货物信息改为常驻查看按钮，不再作为工作流门禁阻断提交审批
    const hasOrderBasics = [
      data.order.shipper_name,
      data.order.consignee_name,
      data.order.origin_city,
      data.order.origin_address,
      data.order.destination_city,
      data.order.destination_address,
      data.order.cargo_description,
      data.order.overseas_warehouse_id,
    ].every(Boolean);
    if (!hasOrderBasics) return null;
    return {
      actionCode: "submit",
      label: "提交审批",
      hint: "已检测到委托、线路、目的仓和货物资料齐全。整车/拼车由已接受报价确定，不在此阶段变更。",
      requiresAssignee: Boolean(submit.requires_assignee),
      assigneeUserId: null as string | null,
    };
  }
  if (data.order.status === "confirmed") {
    const dispatch = transition("dispatch");
    if (!dispatch || module("assignment")?.status !== "completed") return null;
    const preferredAssignee =
      ["transport", "warehouse", "documents", "customs", "loading", "tracking"]
        .map((code) => module(code)?.assignee_user_id)
        .find(Boolean) ??
      module("assignment")?.assignee_user_id ??
      null;
    return {
      actionCode: "dispatch",
      label: "确认派单",
      hint: preferredAssignee
        ? "任务分配已完成，确认后订单进入执行。"
        : "任务分配已完成，请选择派单后的下一处理人。",
      requiresAssignee: Boolean(dispatch.requires_assignee),
      assigneeUserId: preferredAssignee,
    };
  }
  return null;
}

function OrderMountedPanel({
  panel,
  data,
}: {
  panel: OrderMountedPanelKey;
  data: Route.ComponentProps["loaderData"];
}) {
  const order = data.order;
  const currentStepKey = data.businessWorkflow?.current_step_key ?? "order_creation";
  const showDomesticDecision = workflowStepReached(
    data.workflowSteps,
    currentStepKey,
    "domestic_execution",
  );
  const showPortDecision = workflowStepReached(
    data.workflowSteps,
    currentStepKey,
    "port_loading",
  );
  const expenseMode = expenseWarningMode(currentStepKey);
  return (
    <section className="panel order-mounted-panel">
      {panel === "modules" && (
        <>
          <div className="panel-header">
            <div>
              <h2>挂载模块</h2>
              <p>只显示本订单已激活的工作模块；进入模块页办理具体内容。</p>
            </div>
            <div className="order-service-tags">
              {data.services.map((service) => (
                <span key={service.service_code}>{service.service_name}</span>
              ))}
              {!data.services.length && <span>基础汽运</span>}
            </div>
          </div>
          <OrderModulesByStage
            orderId={order.id}
            orderStatus={order.status}
            modules={data.modules}
            tasks={data.tasks}
          />
        </>
      )}
      {panel === "dossier" && (
        <>
          <PanelTitle title="订单资料" subtitle="客户、路线、条款、目的仓和流程快照。" />
          <div className="company-profile">
            <Info label="客户" value={`${order.customer_code} · ${order.customer_name}`} />
            <Info label="接单日期" value={order.order_date} />
            {showDomesticDecision && <Info label="仓库分流结果" value={businessTypeLabels[order.business_type] ?? order.business_type} />}
            <Info label="关联报价" value={order.quote_number} />
            <Info label="业务工作流" value={data.businessWorkflow?.workflow_name ?? null} />
            <Info label="当前节点" value={data.businessWorkflow?.current_step_name || order.current_step_name} />
            <Info label="当前负责人" value={order.assignee_name} />
            {showPortDecision && <Info label="口岸/清关" value={[order.exit_port_name || order.exit_port, order.customs_location].filter(Boolean).join(" → ") || "待仓库分流后确定"} />}
            {showPortDecision && <Info label="中转地" value={order.transit_locations} />}
            <Info label="境外目的仓" value={order.overseas_warehouse_name ? `${order.overseas_warehouse_name} · ${order.overseas_warehouse_code || ""}` : null} />
            <Info label="目的仓地址" value={[order.overseas_warehouse_address, order.overseas_warehouse_address_note].filter(Boolean).join(" · ") || null} />
            <Info label="线路说明" value={order.route_notes} />
          </div>
          <div className="route-detail">
            <article>
              <small>发货方</small>
              <h3>{order.shipper_name}</h3>
              <p>{order.origin_country} {order.origin_state || ""} {order.origin_city} {order.origin_address}</p>
              <span>{order.shipper_contact || "—"} · {order.shipper_phone || "—"}</span>
            </article>
            <b>→</b>
            <article>
              <small>收货方</small>
              <h3>{order.consignee_name}</h3>
              <p>{order.destination_country} {order.destination_state || ""} {order.destination_city} {order.destination_address}</p>
              <span>{order.consignee_contact || "—"} · {order.consignee_phone || "—"}</span>
            </article>
          </div>
        </>
      )}
      {panel === "cargo" && (
        <>
          <PanelTitle title="货物与计划" subtitle="货物摘要和客户约定的时间要求。" />
          <div className="company-profile">
            <Info label="货物" value={order.cargo_description} />
            <Info label="件数" value={`${order.pieces} 件`} />
            <Info label="重量" value={`${order.gross_weight_kg} KG`} />
            <Info label="体积" value={`${order.volume_cbm} CBM`} />
            <Info label="要求提货" value={order.requested_pickup_date} />
            <Info label="要求送达" value={order.requested_delivery_date} />
            <Info label="备注" value={order.special_instructions} />
          </div>
        </>
      )}
      {panel === "costs" && (
        <>
          <PanelTitle title="费用状态" subtitle="只显示费用门禁摘要；明细进入费用结算模块处理。" />
          <OrderExpenseRisk orderId={order.id} risk={data.expenseRisk} mode={expenseMode} />
        </>
      )}
      {panel === "history" && (
        <>
          <PanelTitle title="历史记录" subtitle="订单状态流转和端到端业务链路。" />
          <div className="order-history-columns">
            <div className="workflow-history-list">
              {data.history.map((h) => (
                <article key={h.id}>
                  <i></i>
                  <div>
                    <strong>{h.action_name}</strong>
                    <p>{statusLabel(h.from_status)} → {statusLabel(h.to_status)} · 节点 {h.to_step_code}</p>
                    <small>{new Date(h.occurred_at).toLocaleString("zh-CN")} · {h.actor_name || "系统"}</small>
                  </div>
                </article>
              ))}
            </div>
            <div className="workflow-history-list compact">
              {data.macro.map((h) => (
                <article key={h.id}>
                  <i></i>
                  <div>
                    <strong>{h.step_name}</strong>
                    <small>{new Date(h.occurred_at).toLocaleString("zh-CN")} · {h.actor_name || h.source}</small>
                  </div>
                </article>
              ))}
              {!data.macro.length && <p className="empty-state">暂无业务链路记录。</p>}
            </div>
          </div>
        </>
      )}
      {panel === "attachments" && (
        <>
          <PanelTitle title="附件" subtitle="订单相关文件。" />
          <div className="account-list">
            {data.attachments.map((attachment) => (
              <div key={attachment.id}>
                <span>
                  <strong>{attachment.file_name}</strong>
                  <small>{attachment.content_type} · {(attachment.size_bytes / 1024).toFixed(1)} KB</small>
                </span>
                <a className="text-button" href={attachment.data_url} download={attachment.file_name}>下载</a>
              </div>
            ))}
          </div>
          {!data.attachments.length && <p className="empty-state">暂无附件。</p>}
        </>
      )}
    </section>
  );
}

function OrderVerticalWorkflow({
  order,
  modules,
  workflow,
  workflowSteps,
  workflowFormRows = [],
}: {
  order: Order;
  modules: OrderModuleInstance[];
  workflow: BusinessWorkflow | null;
  workflowSteps: BusinessWorkflowStep[];
  workflowFormRows?: WorkflowFormRow[];
}) {
  if (workflow && workflowSteps.length) {
    const currentIndex = Math.max(
      0,
      workflowSteps.findIndex((step) => step.step_key === workflow.current_step_key),
    );
    const done = order.status === "completed" || workflow.status === "completed";
    return (
      <aside className="order-vertical-workflow" aria-label="订单工作流">
        <header>
          <span>订单工作流</span>
          <strong>{workflow.workflow_name}</strong>
        </header>
        <ol>
          {workflowSteps.map((step, index) => {
            const status = done
              ? "completed"
              : index < currentIndex
                ? "completed"
                : index === currentIndex
                  ? "active"
                  : "pending";
            const stepModules = uniqueWorkflowModules(
              workflowFormRows.filter((row) => row.step_key === step.step_key),
            );
            const target =
              stepModules.find((row) => row.module_status !== "completed") ??
              stepModules[0];
            const href = target?.module_code
              ? `/admin/orders/${order.id}/modules/${target.module_code}#module-business-data`
              : `/admin/orders/${order.id}`;
            return (
              <li key={step.step_key} className={status}>
                <Link to={href} title={`打开${step.name}`}>
                  <i>{status === "completed" ? "✓" : index + 1}</i>
                  <div>
                    <strong>{step.name}</strong>
                    <small>
                      {status === "active"
                        ? "当前节点 · 点击办理"
                        : step.is_required
                          ? "必须办理 · 点击查看"
                          : "可选节点 · 点击查看"}
                      {step.field_count ? ` · ${step.field_count} 字段` : ""}
                    </small>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      </aside>
    );
  }
  const snapshots = buildStageSnapshots(order.status, modules);
  return (
    <aside className="order-vertical-workflow" aria-label="订单工作流">
      <header>
        <span>订单工作流</span>
        <strong>模块阶段</strong>
      </header>
      <ol>
        {snapshots.map((snapshot, index) => {
          const target =
            snapshot.activeModules.find((module) => module.status !== "completed") ??
            snapshot.activeModules[0];
          const href = target
            ? `/admin/orders/${order.id}/modules/${target.module_code}#module-business-data`
            : `/admin/orders/${order.id}`;
          return (
            <li key={snapshot.stage.code} className={snapshot.status}>
              <Link to={href} title={`打开${snapshot.stage.shortTitle}`}>
                <i>{snapshot.status === "completed" ? "✓" : index + 1}</i>
                <div>
                  <strong>{snapshot.stage.shortTitle}</strong>
                  <small>
                    {snapshot.status === "active"
                      ? "当前阶段 · 点击办理"
                      : snapshot.status === "skipped"
                        ? "本单无需拼车配载"
                        : `${snapshot.progress}% · 点击查看`}
                  </small>
                </div>
              </Link>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function PanelTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="panel-header">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

type ExpenseWarningMode = "hidden" | "pre_entry" | "settlement";

function workflowStepReached(
  steps: BusinessWorkflowStep[],
  currentStepKey: string,
  targetStepKey: string,
) {
  const current = steps.find((step) => step.step_key === currentStepKey);
  const target = steps.find((step) => step.step_key === targetStepKey);
  return !current || !target || current.sort_order >= target.sort_order;
}

function expenseWarningMode(stepKey: string | null): ExpenseWarningMode {
  if (["reconciliation", "completion_review"].includes(stepKey ?? "")) return "settlement";
  return "hidden";
}

function expenseWarningList(risk: ExpenseRisk, mode: ExpenseWarningMode) {
  if (mode === "hidden") return [];
  const preEntry = [
    risk.receivable_count === 0 ? "未从已接受报价继承应收费用" : null,
  ];
  if (mode === "pre_entry") return preEntry.filter(Boolean) as string[];
  return [
    ...preEntry,
    risk.payable_count === 0 ? "应付未录入" : null,
    risk.receivable_count > 0 && !risk.receivable_confirmed ? "应收未确认" : null,
    risk.payable_count > 0 && !risk.payable_confirmed ? "应付未确认" : null,
    risk.pending_warehouse_differences > 0 ? `${risk.pending_warehouse_differences} 条实收差异待确认` : null,
    risk.receivable_total - risk.payable_total < 0 ? "预计毛利为负" : null,
    !risk.receivable_finance_locked || !risk.payable_finance_locked ? "费用尚未全部财务锁定" : null,
  ].filter(Boolean) as string[];
}

function departureGateWarningList(modules: OrderModuleInstance[]) {
  const module = (code: string) =>
    modules.find((item) => item.enabled === 1 && item.module_code === code);
  return [
    module("warehouse") && module("warehouse")?.status !== "completed"
      ? "装车出库交接未完成"
      : null,
    module("customs") && module("customs")?.status !== "completed"
      ? "报关/转关尚未放行"
      : null,
    module("loading") && module("loading")?.status !== "completed"
      ? "配载批次未确认"
      : null,
  ].filter(Boolean) as string[];
}

function buildStageGateRows(
  modules: OrderModuleInstance[],
  risk: ExpenseRisk,
  stepKey: string | null,
) {
  const rows: Array<{
    kind: "business" | "expense";
    label: string;
    message: string;
    blocked: boolean;
  }> = [];
  const module = (code: string) =>
    modules.find((item) => item.enabled === 1 && item.module_code === code);
  if (stepKey === "domestic_execution") {
    const warehouse = module("warehouse");
    rows.push({
      kind: "business",
      label: "到仓与实收",
      message: warehouse?.status === "completed" ? "到仓、齐套和出库已完成" : "等待到仓收货、实收复核和齐套",
      blocked: Boolean(warehouse && warehouse.status === "blocked"),
    });
  }
  if (["port_loading", "outbound_transport"].includes(stepKey ?? "")) {
    const warnings = departureGateWarningList(modules);
    const definitions = [
      ["装车出库", "装车", "装车出库已完成"],
      ["配载确认", "配载", "已确认或本单无需拼车配载"],
      ["报关放行", "报关", "全部有效报关单已放行"],
    ] as const;
    for (const [label, keyword, clearMessage] of definitions) {
      const warning = warnings.find((item) => item.includes(keyword));
      rows.push({
        kind: "business",
        label,
        message: warning || clearMessage,
        blocked: Boolean(warning),
      });
    }
  }
  const expenseWarnings = expenseWarningList(risk, expenseWarningMode(stepKey));
  if (expenseWarningMode(stepKey) !== "hidden") {
    rows.push({
      kind: "expense",
      label: stepKey === "order_creation" ? "报价应收" : "费用结算",
      message: expenseWarnings.join("；") || (stepKey === "order_creation" ? "已从接受报价继承应收费用" : "应收应付已确认并锁定"),
      blocked: expenseWarnings.length > 0,
    });
  }
  return rows;
}

function OrderAtGlance({
  order,
  workflow,
}: {
  order: Order;
  workflow: BusinessWorkflow | null;
}) {
  return (
    <section className="order-at-glance" aria-label="订单摘要">
      <div>
        <small>客户</small>
        <strong>{order.customer_name}</strong>
        <span>{order.customer_reference || order.customer_code}</span>
      </div>
      <div>
        <small>线路</small>
        <strong>
          {order.origin_city} → {order.destination_city}
        </strong>
        <span>{order.exit_port_name || order.exit_port || "口岸待定"}</span>
      </div>
      <div>
        <small>当前节点</small>
        <strong>{workflow?.current_step_name || order.current_step_name}</strong>
        <span>{workflow?.workflow_name || "订单工作流"}</span>
      </div>
      <div>
        <small>负责人</small>
        <strong>{order.assignee_name || "待分配"}</strong>
        <span>{order.is_overdue ? "已逾期" : "时效正常"}</span>
      </div>
      <div>
        <small>境外目的仓</small>
        <strong>{order.overseas_warehouse_name || "待选择"}</strong>
        <span>{order.overseas_warehouse_code || "仓库资料"}</span>
      </div>
    </section>
  );
}

function OrderDetailAction({
  order,
  transition,
  members,
  busy,
  success,
  triggerClassName,
}: {
  order: Order;
  transition: OrderWorkflowTransition;
  members: Member[];
  busy: boolean;
  success?: string;
  triggerClassName?: string;
}) {
  const dispatch = transition.action_code === "dispatch";
  return (
    <Modal
      title={`${transition.action_name} · ${order.order_number}`}
      triggerLabel={transition.action_name}
      triggerClassName={triggerClassName ?? (dispatch ? "primary" : "secondary")}
      closeSignal={success}
    >
      {({ close }) => (
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="workflow_action" />
          <input type="hidden" name="actionCode" value={transition.action_code} />
          {dispatch && (
            <div className="alert warning workflow-confirm-warning">
              <strong>准备阶段未完成也允许派单</strong>
              <span>
                点击“确认派单”后订单进入已派单状态并开放国内提货运输；出境发运须在配载或直装、装车出库完成后开始。
              </span>
            </div>
          )}
          {!dispatch && (
            <p className="workflow-action-description">
              确认执行“{transition.action_name}”后，订单状态和处理人会立即更新。
            </p>
          )}
          {Boolean(transition.requires_assignee) && (
            <label className="field">
              <span>下一处理人</span>
              <select name="assigneeUserId" required>
                <option value="">请选择</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.display_name}
                    {member.department_name ? ` · ${member.department_name}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>流转备注</span>
            <textarea name="notes" rows={3} maxLength={500} />
          </label>
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={close}>
              返回
            </button>
            <button
              className={transition.to_status === "cancelled" ? "secondary danger" : "primary"}
              disabled={busy}
            >
              确认{transition.action_name}
            </button>
          </div>
        </Form>
      )}
    </Modal>
  );
}

function OrderEditForm({
  order,
  customers,
  busy,
}: {
  order: Order;
  customers: CustomerOption[];
  busy: boolean;
}) {
  return (
    <Form method="post" className="form-grid compact">
      <input type="hidden" name="intent" value="order_update" />
      <label className="field span-2">
        <span>客户</span>
        <select name="customerId" defaultValue={order.customer_id} required>
          <option value="">请选择客户</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>{customer.code} · {customer.name}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>发货人</span>
        <input name="shipperName" defaultValue={order.shipper_name} required />
      </label>
      <label className="field">
        <span>发货联系人</span>
        <input name="shipperContact" defaultValue={order.shipper_contact || ""} required />
      </label>
      <label className="field">
        <span>发货电话</span>
        <input name="shipperPhone" defaultValue={order.shipper_phone || ""} required />
      </label>
      <label className="field">
        <span>起运国家</span>
        <input name="originCountry" defaultValue={order.origin_country || "CN"} />
      </label>
      <label className="field">
        <span>起运省/州</span>
        <input name="originState" defaultValue={order.origin_state || ""} />
      </label>
      <label className="field">
        <span>起运城市</span>
        <input name="originCity" defaultValue={order.origin_city} required />
      </label>
      <label className="field span-2">
        <span>提货地址</span>
        <input name="originAddress" defaultValue={order.origin_address} required />
      </label>
      <label className="field">
        <span>收货人</span>
        <input name="consigneeName" defaultValue={order.consignee_name} required />
      </label>
      <label className="field">
        <span>收货联系人</span>
        <input name="consigneeContact" defaultValue={order.consignee_contact || ""} />
      </label>
      <label className="field">
        <span>收货电话</span>
        <input name="consigneePhone" defaultValue={order.consignee_phone || ""} />
      </label>
      <label className="field">
        <span>目的国家</span>
        <input name="destinationCountry" defaultValue={order.destination_country || "UZ"} />
      </label>
      <label className="field">
        <span>目的省/州</span>
        <input name="destinationState" defaultValue={order.destination_state || ""} />
      </label>
      <label className="field">
        <span>目的城市</span>
        <input name="destinationCity" defaultValue={order.destination_city} required />
      </label>
      <label className="field span-2">
        <span>送货地址</span>
        <input name="destinationAddress" defaultValue={order.destination_address} />
      </label>
      <label className="field">
        <span>预约提货时间</span>
        <input name="requestedPickupDate" type="datetime-local" defaultValue={toDateTimeLocal(order.requested_pickup_date)} required />
      </label>
      <label className="field">
        <span>要求送达日</span>
        <input name="requestedDeliveryDate" type="date" defaultValue={order.requested_delivery_date || ""} />
      </label>
      <label className="field span-2">
        <span>备注</span>
        <textarea name="notes" rows={3} defaultValue={order.special_instructions || ""} />
      </label>
      <button className="primary" disabled={busy}>保存修改</button>
    </Form>
  );
}

function currentOrderRule(status: string) {
  if (status === "draft") return "当前：可完善委托和货物，完成后提交审批。";
  if (status === "submitted") return "当前：审批处理中，资料已冻结；如需修改请先退回草稿。";
  if (status === "confirmed") return "当前：审批已通过，可办理准备与安排，完成后确认派单。";
  if (status === "in_execution") return "当前：已派单；先完成国内提货运输，到仓复核后再办理配载或直装、装车出库和出境跟踪。";
  if (status === "completed") return "当前：订单已完成，全部模块仅供查看。";
  if (status === "cancelled") return "当前：订单已取消，全部模块仅供查看。";
  return "当前：请按页面从上到下依次办理。";
}

function toDateTimeLocal(value: string | null | undefined) {
  if (!value) return "";
  return value.replace(" ", "T").slice(0, 16);
}

function Info({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || "—"}</strong>
    </div>
  );
}
function OrderExpenseRisk({ orderId, risk, mode }: { orderId: string; risk: ExpenseRisk; mode: ExpenseWarningMode }) {
  const warnings = expenseWarningList(risk, mode);
  return (
    <section className="panel order-expense-risk-card">
      <div>
        <span>{mode === "settlement" ? "费用结算" : "报价应收"}</span>
        <strong>应收 {risk.receivable_count} 项 · 应付 {risk.payable_count} 项</strong>
        <small>折算应收 {risk.receivable_total.toFixed(2)} · 应付 {risk.payable_total.toFixed(2)}</small>
      </div>
      <div>
        <span>{mode === "settlement" ? "费用结算风险" : "当前阶段"}</span>
        <strong>{warnings.length ? `${warnings.length} 项待处理` : "无待处理风险"}</strong>
        <small>{warnings.join("；") || (mode === "settlement" ? "应收、应付均已确认并锁定" : "已从接受报价继承应收费用")}</small>
      </div>
      <Link className="secondary" to={`/admin/orders/${orderId}/modules/costs#module-business-data`}>
        {mode === "settlement" ? "进入费用结算" : "查看报价应收"}
      </Link>
    </section>
  );
}

function OrderProgress({
  order,
  modules,
  workflow,
  workflowSteps,
}: {
  order: Order;
  modules: OrderModuleInstance[];
  workflow: BusinessWorkflow | null;
  workflowSteps: BusinessWorkflowStep[];
}) {
  if (workflow && workflowSteps.length)
    return (
      <TemplateOrderProgress
        order={order}
        workflow={workflow}
        workflowSteps={workflowSteps}
      />
    );
  return <ModuleStageProgress order={order} modules={modules} />;
}

function ModuleStageProgress({
  order,
  modules,
}: {
  order: Order;
  modules: OrderModuleInstance[];
}) {
  const snapshots = buildStageSnapshots(order.status, modules);
  const [previewedStageCode, setPreviewedStageCode] = useState<string | null>(
    null,
  );
  const activeSnapshots = snapshots.filter(
    (snapshot) => snapshot.status !== "skipped",
  );
  const percent =
    order.status === "completed"
      ? 100
      : activeSnapshots.length
        ? Math.round(
            activeSnapshots.reduce(
              (total, snapshot) => total + snapshot.progress,
              0,
            ) / activeSnapshots.length,
          )
        : 0;
  const preview =
    snapshots.find((snapshot) => snapshot.stage.code === previewedStageCode) ??
    snapshots.find((snapshot) => snapshot.status === "active") ??
    snapshots.find((snapshot) => snapshot.status === "pending") ??
    snapshots[0];
  const previewTarget =
    preview.activeModules.find((module) => module.status !== "completed") ??
    preview.activeModules[0];
  const previewHref = previewTarget
    ? `/admin/orders/${order.id}/modules/${previewTarget.module_code}#module-business-data`
    : "#order-module-stages";
  return (
    <section className="panel order-overall-progress">
      <div className="panel-header">
        <div>
          <h2>订单工作流</h2>
          <p>
            当前流程由本订单已激活的模块动态组成，未启用模块不会显示或阻断。
          </p>
        </div>
        <strong>{percent}%</strong>
      </div>
      <div className="order-progress-track">
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="order-progress-steps">
        {snapshots.map((snapshot, index) => {
          const target = snapshot.activeModules.find(
            (module) => module.status !== "completed",
          ) ?? snapshot.activeModules[0];
          const currentStep =
            snapshot.status === "skipped"
              ? "本单无需拼车配载"
              : snapshot.status === "completed"
                ? "已完成"
                : target?.current_step_name || "待处理";
          return (
            <button
              type="button"
              key={snapshot.stage.code}
              aria-label={`查看${snapshot.stage.shortTitle}办理信息`}
              aria-pressed={preview.stage.code === snapshot.stage.code}
              className={snapshot.status}
              onMouseEnter={() => setPreviewedStageCode(snapshot.stage.code)}
              onFocus={() => setPreviewedStageCode(snapshot.stage.code)}
              onMouseLeave={() => setPreviewedStageCode(null)}
              onClick={() => setPreviewedStageCode(snapshot.stage.code)}
            >
              <b>{snapshot.status === "completed" ? "✓" : index + 1}</b>
              <span>{snapshot.stage.shortTitle}</span>
              <small>{currentStep}</small>
            </button>
          );
        })}
      </div>
      <div className="order-stage-preview" aria-live="polite">
        <div>
          <small>阶段</small>
          <strong>{preview.stage.title}</strong>
        </div>
        <div>
          <small>当前模块 / 下一步</small>
          <strong>
            {previewTarget
              ? `${previewTarget.module_name} · ${previewTarget.current_step_name || "待处理"}`
              : "本订单未启用此阶段"}
          </strong>
        </div>
        <div>
          <small>负责人 / 阻碍</small>
          <strong>
            {previewTarget
              ? `${previewTarget.assignee_name || "待分配"} · ${previewTarget.blocking_reason || "本阶段暂无阻断"}`
              : "无需处理"}
          </strong>
        </div>
        {previewTarget && (
          <Link className="text-button" to={previewHref}>
            打开当前节点 →
          </Link>
        )}
      </div>
    </section>
  );
}

function TemplateOrderProgress({
  order,
  workflow,
  workflowSteps,
}: {
  order: Order;
  workflow: BusinessWorkflow;
  workflowSteps: BusinessWorkflowStep[];
}) {
  const currentIndex = Math.max(
    0,
    workflowSteps.findIndex((step) => step.step_key === workflow.current_step_key),
  );
  const [previewedStepKey, setPreviewedStepKey] = useState<string | null>(null);
  const percent =
    order.status === "completed" || workflow.status === "completed"
      ? 100
      : workflowSteps.length > 1
        ? Math.round((currentIndex / (workflowSteps.length - 1)) * 100)
        : 0;
  const preview =
    workflowSteps.find((step) => step.step_key === previewedStepKey) ??
    workflowSteps[currentIndex] ??
    workflowSteps[0];
  const nextStep = workflowSteps[currentIndex + 1] ?? null;
  return (
    <section className="panel order-overall-progress">
      <div className="panel-header">
        <div>
          <h2>订单工作流</h2>
          <p>{workflow.workflow_name} · 当前订单按创建时绑定的模板推进。</p>
        </div>
        <strong>{percent}%</strong>
      </div>
      <div className="order-progress-track">
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="order-progress-steps">
        {workflowSteps.map((step, index) => {
          const status =
            order.status === "completed" || workflow.status === "completed"
              ? "completed"
              : index < currentIndex
                ? "completed"
                : index === currentIndex
                  ? "active"
                  : "pending";
          return (
            <button
              type="button"
              key={step.step_key}
              aria-label={`查看${step.name}节点信息`}
              aria-pressed={preview.step_key === step.step_key}
              className={status}
              onMouseEnter={() => setPreviewedStepKey(step.step_key)}
              onFocus={() => setPreviewedStepKey(step.step_key)}
              onMouseLeave={() => setPreviewedStepKey(null)}
              onClick={() => setPreviewedStepKey(step.step_key)}
            >
              <b>{status === "completed" ? "✓" : index + 1}</b>
              <span>{step.name}</span>
              <small>
                {status === "active"
                  ? "当前节点 · 查看"
                  : step.is_required
                    ? "必须办理 · 查看"
                    : "可选节点 · 查看"}
              </small>
            </button>
          );
        })}
      </div>
      <div className="order-stage-preview" aria-live="polite">
        <div>
          <small>模板节点</small>
          <strong>
            {preview.sort_order}. {preview.name}
          </strong>
        </div>
        <div>
          <small>节点要求</small>
          <strong>
            {preview.is_required ? "必须办理" : "可选节点"} ·{" "}
            {preview.field_count ? `${preview.field_count} 个配置字段` : "无配置字段"}
          </strong>
        </div>
        <div>
          <small>默认处理角色</small>
          <strong>{preview.actor_scope || "后台"}</strong>
        </div>
        <Link className="text-button" to="#order-module-stages">
          {nextStep ? `下一节点：${nextStep.name}` : "查看模块办理 →"}
        </Link>
      </div>
    </section>
  );
}

function OrderNextAction({
  order,
  modules,
}: {
  order: Order;
  modules: OrderModuleInstance[];
}) {
  const guidance = orderNextGuidance({
    orderId: order.id,
    orderStatus: order.status,
    modules,
  });
  return (
    <section className="panel order-next-action" aria-label="下一步办理指引">
      <div>
        <small>现在在哪里</small>
        <strong>{guidance.stage.title}</strong>
      </div>
      <div>
        <small>谁来处理</small>
        <strong>{guidance.owner}</strong>
      </div>
      <div>
        <small>下一步做什么</small>
        <strong>{guidance.action}</strong>
      </div>
      <div className={guidance.blocker ? "has-blocker" : ""}>
        <small>是否有阻碍</small>
        <strong>{guidance.blocker || "当前节点暂无阻断"}</strong>
      </div>
      <Link className={guidance.blocker ? "secondary" : "primary"} to={guidance.href}>
        打开当前节点 →
      </Link>
    </section>
  );
}
const businessNatureLabels: Record<string, string> = {
  export: "出口",
  import: "进口",
  transit: "过境",
  domestic: "国内",
};
const businessTypeLabels: Record<string, string> = {
  pending: "待仓库判断",
  ltl: "零担",
  ftl: "整车",
  rail: "铁路",
  sea: "海运",
  air: "空运",
};
export function meta() {
  return [{ title: "订单详情 | International TMS" }];
}
