import { env } from "cloudflare:workers";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, Link, redirect, useNavigate, useNavigation } from "react-router";
import type { Route } from "./+types/admin.order-detail";
import { canEditWorkflowDefinition, requireSessionUser } from "../lib/auth.server";
import {
  statusLabel,
  type OrderWorkflowTransition,
} from "../lib/order-workflow";
import { listOrderWorkflowTransitions } from "../lib/order-workflow.server";
import { runOrderWorkflowAction } from "../lib/order-workflow-action.server";
import { valueOf } from "../lib/validation";
import { Modal } from "../components/Modal";
import { ConfirmAction } from "../components/ConfirmAction";
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
  type OrderModuleCode,
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
  inspectWorkflowVersionSwitchImpact,
  listCurrentWorkflowTasks,
  replaceWorkflowInstanceVersion,
} from "../lib/workflow-execution.server";
import { syncOrderBusinessWorkflow } from "../lib/business-workflow.server";
import {
  loadOrderModuleWorkflowFields,
  type WorkflowFieldState,
} from "../lib/workflow-fields.server";
import {
  ConsignmentReviewActionBar,
  EmbeddedOrderModule,
  action as orderModuleAction,
  loader as orderModuleLoader,
} from "./admin.order-module";
import { reconcileOverseasOrderDeliveryState } from "../lib/overseas-warehouse.server";
import {
  completeWorkflowSupplementTask,
  listOrderSupplementTasks,
} from "../lib/workflow-supplement.server";

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
  customs_clearance_mode: "company" | "customer";
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
  created_at: string;
};
type WarehousePackageLabel = {
  id: string;
  barcode: string;
  package_number: string;
  status: string;
  pieces: number;
  weight_kg: number | null;
  volume_cbm: number | null;
  created_at: string;
  cargo_name: string | null;
  warehouse_name: string | null;
  zone_name: string | null;
  location_name: string | null;
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

type OrderDetailTab =
  | "dossier"
  | "cargo"
  | "transport"
  | "warehouse"
  | "attachments"
  | "costs"
  | "history";

type LinearOrderDrawerTab = "dossier" | "cargo" | "attachments" | "supplements" | "history";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view"),
    id = params.orderId;
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.order_date,o.business_nature,o.business_type,o.transport_terms,o.trade_terms,
      o.exit_port,bp.name exit_port_name,o.overseas_warehouse_id,ow.name overseas_warehouse_name,
      ow.code overseas_warehouse_code,ow.address overseas_warehouse_address,o.overseas_warehouse_address_note,
      o.transit_locations,o.customs_location,o.route_notes,o.customs_clearance_mode,o.customer_id,c.name customer_name,c.code customer_code,
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
  await reconcileOverseasOrderDeliveryState({
    organizationId: current.organizationId,
    orderId: id,
    actorUserId: current.userId,
  });
  const [modules,currentWorkflowTasks,supplementTasks] = await Promise.all([
    listOrderModules(current.organizationId,id),
    listCurrentWorkflowTasks(current.organizationId,id),
    listOrderSupplementTasks(current.organizationId,id),
  ]);
  const workflowSwitchImpact = await inspectWorkflowVersionSwitchImpact(current.organizationId,id);
  const [history, attachments, macro, businessWorkflow, workflowSteps, workflowFormRows, tasks, services, members, customers, transitions, expenseRisk, packageLabels, workflowVersions] =
    await Promise.all([
    env.DB.prepare(
      `SELECT h.id,h.action_name,h.from_status,h.to_status,h.to_step_code,a.display_name actor_name,au.display_name assignee_name,h.notes,h.occurred_at FROM order_workflow_history h LEFT JOIN users a ON a.id=h.actor_user_id LEFT JOIN users au ON au.id=h.assignee_user_id WHERE h.order_id=? AND h.organization_id=? ORDER BY h.occurred_at DESC`,
    )
      .bind(id, current.organizationId)
      .all<History>(),
    env.DB.prepare(
      "SELECT id,file_name,content_type,size_bytes,created_at FROM order_attachments WHERE order_id=? AND organization_id=? ORDER BY created_at DESC",
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
      `SELECT p.id,p.barcode,p.package_number,p.status,p.pieces,p.weight_kg,p.volume_cbm,p.created_at,
              i.cargo_name_cn cargo_name,w.name warehouse_name,z.name zone_name,l.name location_name
         FROM warehouse_packages p
         JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
         LEFT JOIN order_cargo_items i ON i.id=p.cargo_item_id AND i.organization_id=p.organization_id
         LEFT JOIN warehouses w ON w.id=p.warehouse_id AND w.organization_id=p.organization_id
         LEFT JOIN warehouse_locations l ON l.id=p.location_id AND l.organization_id=p.organization_id
         LEFT JOIN warehouse_zones z ON z.id=l.zone_id AND z.organization_id=p.organization_id
        WHERE p.organization_id=? AND s.order_id=?
        ORDER BY p.created_at,p.package_number,p.id`,
    )
      .bind(current.organizationId, id)
      .all<WarehousePackageLabel>(),
    env.DB.prepare(
      `SELECT id,name,version_number FROM workflow_definitions
       WHERE organization_id=? AND lifecycle_status='published' AND validation_status='valid'
         AND status='active' AND road_load_type=? ORDER BY updated_at DESC,version_number DESC`,
    ).bind(current.organizationId,order.business_type).all<WorkflowVersionOption>(),
  ]);
  const requestUrl = new URL(request.url);
  const requestedStepKey = requestUrl.searchParams.get("stage");
  const requestedStepRows = requestedStepKey
    ? workflowFormRows.results.filter((row) => row.step_key === requestedStepKey)
    : [];
  const requestedStepAllowed = requestedStepRows.some((row) =>
    row.step_status === "active" || row.step_status === "completed",
  );
  const selectedStepKey = requestedStepAllowed
    ? requestedStepKey!
    : businessWorkflow?.current_step_key || workflowSteps.results[0]?.step_key || "";
  const currentWorkflowModuleCodes = [
    ...new Set(
      workflowFormRows.results
        .filter((row) => row.step_key === selectedStepKey && row.module_code)
        .map((row) => row.module_code as OrderModuleCode),
    ),
  ];
  const currentWorkflowFields = (
    await Promise.all(
      currentWorkflowModuleCodes.map((moduleCode) =>
        loadOrderModuleWorkflowFields(current.organizationId, id, moduleCode),
      ),
    )
  ).flat();
  const requestedModuleCode = requestUrl.searchParams.get("module") as OrderModuleCode | null;
  const requestedConsignmentSection = requestUrl.searchParams.get("section");
  const selectedConsignmentSection = ["info", "files", "costs"].includes(
    requestedConsignmentSection || "",
  )
    ? (requestedConsignmentSection as "info" | "files" | "costs")
    : "info";
  const embeddedModuleCode = requestedModuleCode && currentWorkflowModuleCodes.includes(requestedModuleCode)
    ? requestedModuleCode
    : currentWorkflowModuleCodes[0] || null;
  let embeddedModuleData: Awaited<ReturnType<typeof orderModuleLoader>> | null = null;
  let embeddedModuleRedirect: string | null = null;
  if (embeddedModuleCode) {
    try {
      embeddedModuleData = await orderModuleLoader({
        request,
        params: { orderId: id, moduleCode: embeddedModuleCode },
        context,
      } as Parameters<typeof orderModuleLoader>[0]);
    } catch (error) {
      if (error instanceof Response && error.status >= 300 && error.status < 400) {
        embeddedModuleRedirect = error.headers.get("Location");
      } else {
        throw error;
      }
    }
  }
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
    selectedStepKey,
    currentWorkflowFields,
    embeddedModuleCode,
    selectedConsignmentSection,
    embeddedModuleData,
    embeddedModuleRedirect,
    modules,
    currentWorkflowTasks,
    supplementTasks,
    workflowVersions: workflowVersions.results,
    workflowSwitchImpact,
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
    packageLabels: packageLabels.results,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const moduleRequest = request.clone();
  const current = await requireSessionUser(request, "order.manage"),
    form = await request.formData();
  const intent = valueOf(form, "intent");
  if(intent==="workflow_supplement_complete"){
    try{
      await completeWorkflowSupplementTask({
        organizationId:current.organizationId,
        orderId:params.orderId,
        taskId:valueOf(form,"taskId"),
        actorUserId:current.userId,
        resolutionNote:valueOf(form,"resolutionNote"),
      });
      await writeAudit({
        request,action:"workflow.supplement.complete",resourceType:"transport_order",
        resourceId:params.orderId,organizationId:current.organizationId,actorUserId:current.userId,
        metadata:{taskId:valueOf(form,"taskId")},
      });
      return{success:"资料补录任务已完成；历史节点保持不变"};
    }catch(error){
      return{formError:error instanceof Error?error.message:"补录任务提交失败"};
    }
  }
  if (intent === "workflow_version_switch") {
    const targetWorkflowId=valueOf(form,"targetWorkflowId");
    const target=await env.DB.prepare(
      `SELECT id,name,road_load_type FROM workflow_definitions
       WHERE id=? AND organization_id=? AND lifecycle_status='published' AND validation_status='valid' AND status='active'`,
    ).bind(targetWorkflowId,current.organizationId).first<{id:string;name:string;road_load_type:string}>();
    if(!target)return{formError:"目标工作流版本无效或尚未发布"};
    const sourceOrder=await env.DB.prepare(
      `SELECT o.id,o.business_type,wi.workflow_id
       FROM transport_orders o
       LEFT JOIN workflow_instances wi ON wi.order_id=o.id AND wi.organization_id=o.organization_id
       WHERE o.id=? AND o.organization_id=?`,
    ).bind(params.orderId,current.organizationId).first<{id:string;business_type:string;workflow_id:string|null}>();
    if(!sourceOrder)return{formError:"订单不存在"};
    if(sourceOrder.business_type!==target.road_load_type)return{formError:"目标工作流与订单整车/拼车类型不一致"};
    if(sourceOrder.workflow_id===target.id)return{success:`订单当前已使用“${target.name}”`};
    if(valueOf(form,"impactConfirmed")!=="1")return{formError:"请先查看影响范围，并在二次确认弹窗中确认切换"};
    const impact=await inspectWorkflowVersionSwitchImpact(current.organizationId,sourceOrder.id);
    if(!impact.allowed)return{formError:impact.reason||"当前阶段不允许切换工作流版本"};
    const orderIds=impact.orderIds;
    const placeholders=orderIds.map(()=>"?").join(",");
    const validOrders=await env.DB.prepare(
      `SELECT COUNT(*) count FROM transport_orders WHERE organization_id=? AND business_type=? AND id IN (${placeholders})`,
    ).bind(current.organizationId,target.road_load_type,...orderIds).first<{count:number}>();
    if(validOrders?.count!==orderIds.length)return{formError:"同一配载批次存在类型不一致订单，已停止切换"};
    const incompatibleOrders=await env.DB.prepare(
      `SELECT o.order_number,wi.current_step_key
       FROM transport_orders o
       LEFT JOIN workflow_instances wi ON wi.order_id=o.id AND wi.organization_id=o.organization_id
       WHERE o.organization_id=? AND o.id IN (${placeholders})
         AND (
           wi.id IS NULL OR NOT EXISTS(
             SELECT 1 FROM workflow_steps target_step
             WHERE target_step.workflow_id=? AND target_step.step_key=wi.current_step_key
               AND target_step.is_active=1
           )
         )`,
    ).bind(current.organizationId,...orderIds,target.id).all<{
      order_number:string;current_step_key:string|null;
    }>();
    if(incompatibleOrders.results.length){
      const numbers=incompatibleOrders.results.map((item)=>item.order_number).join("、");
      return{formError:`目标版本缺少受影响订单的当前节点，已在写入前整体停止：${numbers}`};
    }
    try{
      for(const orderId of orderIds){
        await replaceWorkflowInstanceVersion({
          organizationId:current.organizationId,
          orderId,
          targetWorkflowId:target.id,
          actorUserId:current.userId,
          affectedOrderCount:impact.affectedOrderCount,
        });
        await ensureOrderModules(current.organizationId,orderId);
        await syncOrderBusinessWorkflow({organizationId:current.organizationId,orderId,actorUserId:current.userId,source:"admin"});
      }
      await writeAudit({request,action:"workflow.version.switch",resourceType:"transport_order",resourceId:sourceOrder.id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{targetWorkflowId:target.id,orderIds,currentStepKey:impact.currentStepKey,completedStepCount:impact.completedStepCount,historicalStepsPreserved:true}});
      return{success:orderIds.length>1?`配载批次 ${orderIds.length} 张订单已统一使用“${target.name}”；历史节点未回退`:`订单已使用“${target.name}”；历史节点未回退`};
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
  const moduleCode = new URL(request.url).searchParams.get("module");
  if (moduleCode && orderModuleDefinition(moduleCode)) {
    const result = await orderModuleAction({
      request: moduleRequest,
      params: { orderId: params.orderId, moduleCode },
      context,
    } as unknown as Parameters<typeof orderModuleAction>[0]);
    if (result instanceof Response && result.status >= 300 && result.status < 400) {
      return redirect(`/admin/orders/${params.orderId}`);
    }
    return result;
  }
  if (intent !== "workflow_action") {
    return { formError: "无效的订单操作" };
  }
  const workflowResult = await runOrderWorkflowAction({
    request,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    orderId: params.orderId,
    actionCode: valueOf(form, "actionCode"),
    assigneeUserId: valueOf(form, "assigneeUserId") || null,
    notes: valueOf(form, "notes"),
    bypassAssigneeRestriction: canEditWorkflowDefinition(current),
  });
  if (!("formError" in workflowResult)) return redirect(`/admin/orders/${params.orderId}`);
  return workflowResult;
}

export default function OrderDetail({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const navigate = useNavigate();
  const currentStepKey = loaderData.businessWorkflow?.current_step_key || "";
  const previousStepKey = useRef(currentStepKey);
  const success = actionData && "success" in actionData ? actionData.success : undefined;
  const formError = actionData && "formError" in actionData ? actionData.formError : undefined;
  const documentReviewSignal = actionData && "documentReviewSignal" in actionData
    ? actionData.documentReviewSignal
    : undefined;
  useEffect(() => {
    const previous = previousStepKey.current;
    previousStepKey.current = currentStepKey;
    if (
      previous &&
      currentStepKey &&
      previous !== currentStepKey &&
      loaderData.selectedStepKey !== currentStepKey
    ) {
      navigate(`?stage=${encodeURIComponent(currentStepKey)}#module-business-data`, { replace: true });
    }
  }, [currentStepKey, loaderData.selectedStepKey, navigate]);
  return (
    <LinearOrderWorkspace data={loaderData} busy={busy} success={success} formError={formError} documentReviewSignal={documentReviewSignal} />
  );
}

function LinearOrderWorkspace({
  data,
  busy,
  success,
  formError,
  documentReviewSignal,
}: {
  data: Route.ComponentProps["loaderData"];
  busy: boolean;
  success?: string;
  formError?: string;
  documentReviewSignal?: unknown;
}) {
  const [drawerTab, setDrawerTab] = useState<LinearOrderDrawerTab | null>(null);
  const order = data.order;
  const currentStepKey = data.businessWorkflow?.current_step_key || "";
  const stepRows = new Map<string, WorkflowFormRow[]>();
  for (const row of data.workflowFormRows) stepRows.set(row.step_key, [...(stepRows.get(row.step_key) || []), row]);
  const steps = data.workflowSteps.map((step) => ({ ...step, rows: stepRows.get(step.step_key) || [] }));
  const selectedStep = steps.find((step) => step.step_key === data.selectedStepKey) || steps[0] || null;
  const selectedRows = selectedStep ? uniqueWorkflowModules(selectedStep.rows) : [];
  const currentIndex = Math.max(0, steps.findIndex((step) => step.step_key === currentStepKey));
  const selectedIndex = Math.max(0, steps.findIndex((step) => step.step_key === selectedStep?.step_key));
  const orderCompleted = order.status === "completed";
  const viewingCurrent = orderCompleted || selectedStep?.step_key === currentStepKey;
  const guidance = orderNextGuidance({ orderId: order.id, orderStatus: order.status, modules: data.modules });
  const directAction = directOrderWorkflowAction(data);
  const pendingTasks = selectedStep
    ? uniqueWorkflowTasks(selectedStep.rows).filter((task) => !orderCompleted && task.task_status !== "completed")
    : [];
  const progress = orderCompleted ? 100 : steps.length ? Math.round((currentIndex / steps.length) * 100) : 0;
  const showOuterActionBar = !data.embeddedModuleData;
  const showConsignmentActionBar =
    selectedStep?.step_key === "order_creation" && Boolean(data.embeddedModuleData);
  const responsiblePosition = data.currentWorkflowTasks.find((task) => !orderCompleted && task.status !== "completed")?.position_name
    || orderResponsiblePosition(guidance.moduleCode, order.status).name;

  return (
    <div className="page prototype-page linear-order-page">
      <div className="breadcrumb">运输订单 / {order.order_number} / {selectedStep?.name || "订单资料"}</div>
      <header className="order-head">
        <div className="order-title"><span className="eyebrow">TRANSPORT ORDER / {order.business_type === "ltl" ? "拼车订单" : "整车订单"}</span><h1>{order.order_number}</h1><p>{order.customer_name} · {order.origin_state || ""}{order.origin_city} → {order.destination_state || ""}{order.destination_city}</p></div>
        <div className="current-summary">
          <div className="summary-cell"><span>当前办理</span><b>{orderCompleted ? "订单已完成" : data.businessWorkflow?.current_step_name || order.current_step_name}</b></div>
          <div className="summary-cell"><span>负责岗位 / 人员</span><b>{orderCompleted ? "已归档" : `${responsiblePosition} · ${order.assignee_name || "待分配"}`}</b></div>
          <div className="summary-cell"><span>办理条件</span><b className={guidance.blocker ? "danger" : "ok"}>{orderCompleted ? "全部节点已完成" : guidance.blocker || "当前节点暂无阻断"}</b></div>
        </div>
        <div className="head-actions">
          <span className={`status ${orderCompleted ? "green" : "blue"}`}>{statusLabel(order.status)}</span>
          {data.canManage && <Modal title={`工作流版本 · ${order.order_number}`} triggerLabel="工作流版本" triggerClassName="btn" closeSignal={success} size="wide" dialogClassName="workflow-switch-modal"><WorkflowVersionSwitchForm current={data.businessWorkflow} options={data.workflowVersions} impact={data.workflowSwitchImpact} busy={busy}/></Modal>}
          <button className="btn head-detail-trigger" type="button" onClick={() => setDrawerTab("dossier")}>订单关键资料</button>
          <Link className="btn" to="/admin/orders">返回订单列表</Link>
        </div>
      </header>

      <nav className="workflow" aria-label="订单工作流">
        <div className="workflow-meta"><b>当前节点：{data.businessWorkflow?.current_step_name || order.current_step_name}</b><span className="progress-num">{progress}%</span></div>
        <div className="steps">
          {steps.map((step, index) => {
            const state = step.rows[0]?.step_status || (index < currentIndex ? "completed" : index === currentIndex ? "active" : "pending");
            const accessible = orderCompleted || state === "completed" || step.step_key === currentStepKey;
            const className = `step ${state === "completed" ? "done" : step.step_key === currentStepKey ? "current" : ""}${step.step_key === selectedStep?.step_key ? " selected" : ""}`;
            const content = <><i>{state === "completed" ? "✓" : index + 1}</i><span>{step.name}</span></>;
            return accessible
              ? <Link className={className} key={step.step_key} to={`?stage=${encodeURIComponent(step.step_key)}`}>{content}</Link>
              : <span className={className} key={step.step_key} aria-disabled="true">{content}</span>;
          })}
        </div>
      </nav>

      {success && <div className="alert">{success}</div>}
      {formError && <div className="alert error"><b>当前操作未完成：</b>{formError}</div>}

      <div className="workspace">
        <section className={`node-panel panel${showOuterActionBar ? "" : " without-actionbar"}`}>
          <header className="node-header">
            <div className="node-title"><span className="node-number">{selectedIndex + 1}</span><div><h2>{selectedStep?.name || "订单资料"}</h2><p>{orderCompleted ? "订单已归档；页面内容仅供查看。" : viewingCurrent ? "本页只显示当前节点需要查看和处理的数据。" : "正在查看已完成节点；历史数据只读。"}</p></div></div>
            <div className="node-header-tools">
              <div className="owner-chips"><span className="active">{responsiblePosition}</span><span>{order.assignee_name || "待分配人员"}</span><span>{viewingCurrent ? `${pendingTasks.length} 项待办` : "历史节点"}</span></div>
              <div className="node-reference-actions" aria-label="订单辅助资料">
                <button type="button" onClick={() => setDrawerTab("cargo")}>货物与标签</button>
                <button type="button" onClick={() => setDrawerTab("attachments")}>文件 {data.attachments.length}</button>
                <button type="button" onClick={() => setDrawerTab("history")}>记录 {data.history.length + data.macro.length}</button>
              </div>
            </div>
          </header>
          <div className="node-scroll">
            <SelectedStepSections data={data} rows={selectedRows} selectedStep={selectedStep} viewingCurrent={viewingCurrent} busy={busy} documentReviewSignal={documentReviewSignal} />
            {viewingCurrent && guidance.blocker && <div className="gate"><b>当前阻断</b><span>{guidance.blocker}</span></div>}
          </div>
          {showConsignmentActionBar && data.embeddedModuleData && (
            <ConsignmentReviewActionBar data={data.embeddedModuleData} busy={busy} />
          )}
          {showOuterActionBar && <footer className="actionbar">
            <div className="action-note"><b>{viewingCurrent ? (orderCompleted ? "订单已完成" : guidance.action) : `查看：${selectedStep?.name}`}</b><span>{viewingCurrent ? (guidance.blocker || "保存本节点完整数据后，系统自动重新校验并推进。") : "已完成节点不可重复推进，可查看其业务数据与记录。"}</span></div>
            <div className="action-buttons">
              {!viewingCurrent && <Link className="btn" to={`?stage=${encodeURIComponent(currentStepKey)}`}>返回当前节点</Link>}
              {viewingCurrent && !orderCompleted && (directAction && !guidance.blocker ? (
                <Form method="post" className="linear-primary-form"><input type="hidden" name="intent" value="workflow_action"/><input type="hidden" name="actionCode" value={directAction.actionCode}/>{directAction.assigneeUserId ? <input type="hidden" name="assigneeUserId" value={directAction.assigneeUserId}/> : directAction.requiresAssignee ? <select className="control" name="assigneeUserId" required defaultValue=""><option value="">选择下一处理人</option>{data.members.map((member) => <option key={member.id} value={member.id}>{member.display_name}{member.department_name ? ` · ${member.department_name}` : ""}</option>)}</select> : null}<button className="btn primary" disabled={busy}>{directAction.label}</button></Form>
              ) : data.embeddedModuleRedirect ? (
                <Link className="btn primary" to={data.embeddedModuleRedirect}>打开关联业务单</Link>
              ) : data.embeddedModuleData ? (
                <a className={`btn ${guidance.blocker ? "" : "primary"}`} href="#module-business-data">{guidance.blocker ? "查看阻断并处理" : "定位办理表单"}</a>
              ) : null)}
            </div>
          </footer>}
        </section>
        <LinearOrderSideRail data={data} blocker={guidance.blocker} onOpen={setDrawerTab} />
      </div>
      {drawerTab && <LinearOrderDrawer data={data} activeTab={drawerTab} onTabChange={setDrawerTab} onClose={() => setDrawerTab(null)} />}
    </div>
  );
}

function WorkflowVersionSwitchForm({
  current,
  options,
  impact,
  busy,
}: {
  current: BusinessWorkflow | null;
  options: WorkflowVersionOption[];
  impact: Route.ComponentProps["loaderData"]["workflowSwitchImpact"];
  busy: boolean;
}) {
  const formId = `workflow-version-switch-${current?.workflow_id || "unbound"}`;
  const impactScope = impact.batchNumber
    ? `配载单 ${impact.batchNumber} 内 ${impact.affectedOrderCount} 张订单`
    : "当前订单";
  return <Form id={formId} method="post" className="workflow-switch-form">
    <input type="hidden" name="intent" value="workflow_version_switch"/>
    <div className="table-wrap"><table><thead><tr><th>当前工作流</th><th>当前版本</th><th>当前节点</th></tr></thead><tbody><tr><td><strong>{current?.workflow_name || "尚未生成工作流实例"}</strong></td><td>v{current?.version_number || "—"}</td><td>{current?.current_step_name || "—"}</td></tr></tbody></table></div>
    <label className="field"><span>切换到已发布版本</span><select className="control" name="targetWorkflowId" defaultValue={current?.workflow_id || ""} required><option value="">请选择兼容版本</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name} · v{option.version_number}{option.id === current?.workflow_id ? "（当前）" : ""}</option>)}</select></label>
    <div className={`workflow-switch-note${impact.allowed ? "" : " blocked"}`} role="note">
      <strong>本次影响范围</strong>
      <span>{impactScope}；当前节点“{impact.currentStepName || "待识别"}”，已完成 {impact.completedStepCount} 个历史节点。</span>
      <span>{impact.allowed ? "历史节点、同名字段值和审计快照将保留，仅重建当前及后续门禁。" : impact.reason}</span>
    </div>
    <div className="modal-form-actions">
      <ConfirmAction
        title="二次确认工作流版本切换"
        description={`将影响${impactScope}。系统不会回退已完成节点；旧版字段值会先进入永久审计快照，再把兼容值带入新版本。请确认已检查目标版本。`}
        triggerLabel="查看影响并确认切换"
        confirmLabel="确认切换"
        className="btn primary"
        confirmClassName="primary"
        formId={formId}
        name="impactConfirmed"
        value="1"
        formNoValidate={false}
        pending={busy}
        disabled={!impact.allowed || !options.length}
      />
    </div>
  </Form>;
}

function LinearOrderSideRail({
  data,
  blocker,
  onOpen,
}: {
  data: Route.ComponentProps["loaderData"];
  blocker?: string | null;
  onOpen: (tab: LinearOrderDrawerTab) => void;
}) {
  const order = data.order;
  const received = data.packageLabels.reduce(
    (total, label) => ({
      pieces: total.pieces + Number(label.pieces || 0),
      weight: total.weight + Number(label.weight_kg || 0),
      volume: total.volume + Number(label.volume_cbm || 0),
    }),
    { pieces: 0, weight: 0, volume: 0 },
  );
  const receivedSummary = data.packageLabels.length
    ? `${received.pieces} 件 · ${received.weight.toFixed(2)} KG · ${received.volume.toFixed(3)} CBM`
    : "等待仓库实收";
  const markLabelReady = ["confirmed", "in_execution", "completed"].includes(order.status);

  return <aside className="linear-order-side" aria-label="订单关键资料与快捷查看">
    <section className="linear-side-panel linear-side-panel-clickable" role="button" tabIndex={0} onClick={() => onOpen("dossier")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpen("dossier"); }}>
      <header><b>订单关键资料</b><span>展开 →</span></header>
      <dl className="linear-side-facts">
        <div><dt>客户</dt><dd title={order.customer_name}>{order.customer_name || "—"}</dd></div>
        <div><dt>报价</dt><dd title={order.quote_number || ""}>{order.quote_number || "历史订单"}</dd></div>
        <div><dt>类型</dt><dd>{order.business_type === "ltl" ? "拼车 · 已锁定" : "整车 · 已锁定"}</dd></div>
        <div><dt>货物</dt><dd title={order.cargo_description}>{order.cargo_description || "—"}</dd></div>
        <div><dt>实收</dt><dd title={receivedSummary}>{receivedSummary}</dd></div>
      </dl>
    </section>
    <section className="linear-side-panel">
      <header><b>就地查看</b></header>
      <div className="linear-side-links">
        <button type="button" onClick={() => onOpen("dossier")}><span>订单全部资料</span><i>→</i></button>
        <button type="button" onClick={() => onOpen("dossier")}><span>入仓唛头标签</span><small>{markLabelReady ? "已生成" : "待审核"}</small><i>→</i></button>
        <button type="button" onClick={() => onOpen("cargo")}><span>货物与标签</span><small>{data.packageLabels.length} 张</small><i>→</i></button>
        <button type="button" onClick={() => onOpen("attachments")}><span>文件汇总</span><small>{data.attachments.length} 个</small><i>→</i></button>
        <button type="button" onClick={() => onOpen("supplements")}><span>资料补录</span><small>{data.supplementTasks.filter((item)=>item.status==="open").length} 项待办</small><i>→</i></button>
        <button type="button" onClick={() => onOpen("history")}><span>历史节点与日志</span><small>{data.history.length + data.macro.length} 条</small><i>→</i></button>
      </div>
    </section>
    <section className={`linear-side-panel linear-side-tip${blocker ? " blocked" : ""}`}>
      <header><b>当前提示</b></header>
      <p>{blocker || "页面只显示当前节点需要处理的内容；其他资料可在右侧按需展开。"}</p>
    </section>
  </aside>;
}

function LinearOrderDrawer({
  data,
  activeTab,
  onTabChange,
  onClose,
}: {
  data: Route.ComponentProps["loaderData"];
  activeTab: LinearOrderDrawerTab;
  onTabChange: (tab: LinearOrderDrawerTab) => void;
  onClose: () => void;
}) {
  const order = data.order;
  const markLabelReady = ["confirmed", "in_execution", "completed"].includes(order.status);
  return (
    <div className="linear-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="linear-order-drawer" role="dialog" aria-modal="true" aria-label="订单辅助资料">
        <header className="linear-drawer-head">
          <div><span>TRANSPORT ORDER</span><h2>{order.order_number}</h2></div>
          <button type="button" aria-label="关闭订单资料" title="关闭" onClick={onClose}>×</button>
        </header>
        <nav className="linear-drawer-tabs" aria-label="订单资料分类">
          <DrawerTab active={activeTab === "dossier"} onClick={() => onTabChange("dossier")}>关键资料</DrawerTab>
          <DrawerTab active={activeTab === "cargo"} onClick={() => onTabChange("cargo")}>货物与标签</DrawerTab>
          <DrawerTab active={activeTab === "attachments"} onClick={() => onTabChange("attachments")}>文件 {data.attachments.length}</DrawerTab>
          <DrawerTab active={activeTab === "supplements"} onClick={() => onTabChange("supplements")}>资料补录 {data.supplementTasks.filter((item)=>item.status==="open").length}</DrawerTab>
          <DrawerTab active={activeTab === "history"} onClick={() => onTabChange("history")}>操作记录</DrawerTab>
        </nav>
        <div className={`linear-drawer-body is-${activeTab}`}>
          {activeTab === "dossier" && <>
            <section className={`linear-drawer-section order-mark-portal${markLabelReady ? " ready" : " pending"}`}>
              <h3>入仓唛头标签 <span>{markLabelReady ? "审核通过 · 已生成" : "订单审核通过后生成"}</span></h3>
              <div className="order-mark-portal-body">
                <div>
                  <strong>{markLabelReady ? order.order_number : "暂未生成"}</strong>
                  <p>{markLabelReady ? "条码内容即订单号；客户打印后粘贴至每个外包装。" : "当前订单尚未审核通过，查看、打印和下载入口暂未开放。"}</p>
                </div>
                {markLabelReady && <div className="order-mark-portal-actions">
                  <Link to={`/admin/orders/${order.id}/mark-label`} target="_blank" rel="noreferrer">查看标签</Link>
                  <Link to={`/admin/orders/${order.id}/mark-label`} target="_blank" rel="noreferrer">打开打印页</Link>
                  <a href={`/admin/orders/${order.id}/mark-label?download=1`}>下载 SVG</a>
                </div>}
              </div>
            </section>
            <DrawerSection title="订单来源与责任">
              <DrawerFact label="客户" value={`${order.customer_code} · ${order.customer_name}`} />
              <DrawerFact label="关联报价" value={order.quote_number || "历史订单"} />
              <DrawerFact label="订单类型" value={order.business_type === "ltl" ? "拼车" : "整车"} />
              <DrawerFact label="清关责任" value={order.customs_clearance_mode === "company" ? "公司代办清关" : "客户自理清关"} />
              <DrawerFact label="接单日期" value={order.order_date} />
              <DrawerFact label="当前负责人" value={order.assignee_name || "待分配"} />
            </DrawerSection>
            <DrawerSection title="提货信息">
              <DrawerFact label="发货方" value={order.shipper_name} />
              <DrawerFact label="发货联系人" value={[order.shipper_contact, order.shipper_phone].filter(Boolean).join(" · ")} />
              <DrawerFact label="预约提货" value={order.requested_pickup_date} />
              <DrawerFact label="提货地址" value={[order.origin_country, order.origin_state, order.origin_city, order.origin_address].filter(Boolean).join(" ")} wide />
            </DrawerSection>
            <DrawerSection title="境外目的信息">
              <DrawerFact label="境外联系人" value={[order.consignee_contact, order.consignee_phone].filter(Boolean).join(" · ")} />
              <DrawerFact label="目的地" value={[order.destination_country, order.destination_state, order.destination_city].filter(Boolean).join(" ")} />
              <DrawerFact label="境外目的仓" value={order.overseas_warehouse_name} />
              <DrawerFact label="目的仓地址" value={[order.overseas_warehouse_address, order.overseas_warehouse_address_note].filter(Boolean).join(" · ")} wide />
            </DrawerSection>
            <DrawerSection title="线路与备注">
              <DrawerFact label="出境口岸" value={order.exit_port_name || order.exit_port} />
              <DrawerFact label="清关地" value={order.customs_location} />
              <DrawerFact label="运输线路" value={order.route_notes} wide />
              <DrawerFact label="订单备注" value={order.special_instructions} wide />
            </DrawerSection>
          </>}
          {activeTab === "cargo" && <>
            <DrawerSection title="货物摘要">
              <DrawerFact label="货物名称" value={order.cargo_description} wide />
              <DrawerFact label="件数" value={`${order.pieces} 件`} />
              <DrawerFact label="毛重" value={`${order.gross_weight_kg} KG`} />
              <DrawerFact label="体积" value={`${order.volume_cbm} CBM`} />
              <DrawerFact label="要求送达" value={order.requested_delivery_date} />
            </DrawerSection>
            <section className="linear-drawer-section"><h3>仓库货物标签 <span>{data.packageLabels.length} 张</span></h3><div className="linear-drawer-list">
              {data.packageLabels.map((label) => <article key={label.id}><div><strong>{label.barcode}</strong><span>{label.cargo_name || order.cargo_description} · {label.package_number}</span></div><small>{label.pieces} 件 · {label.weight_kg ?? "—"} KG · {label.volume_cbm ?? "—"} CBM<br/>{label.warehouse_name || "仓库待定"} · {warehousePackageStatusLabel(label.status)}</small></article>)}
              {!data.packageLabels.length && <p className="linear-drawer-empty">尚未生成仓库货物标签。</p>}
            </div></section>
          </>}
          {activeTab === "attachments" && <section className="linear-drawer-section"><h3>订单文件 <span>{data.attachments.length} 个</span></h3><div className="linear-drawer-list">
            {data.attachments.map((attachment) => <article key={attachment.id}><div><strong>{attachment.file_name}</strong><span>{new Date(attachment.created_at).toLocaleString("zh-CN")}</span></div><small>{attachment.content_type}<br/>{(attachment.size_bytes / 1024).toFixed(1)} KB</small><a href={`/admin/document-files/order/${attachment.id}`}>下载</a></article>)}
            {!data.attachments.length && <p className="linear-drawer-empty">当前订单暂无文件。</p>}
          </div></section>}
          {activeTab === "supplements" && <section className="linear-drawer-section"><h3>资料补录 <span>{data.supplementTasks.filter((item)=>item.status==="open").length} 项待办</span></h3><p className="linear-drawer-section-note">工作流规则变化后，已完成节点不会回退；需要补齐或复核的资料集中在此处理并保留审计。</p><div className="linear-drawer-list supplement-task-list">
            {data.supplementTasks.map((task)=><article key={task.id} className={task.status==="open"?"open":"resolved"}>
              <div><strong>{task.field_label}</strong><span>{task.target_step_name||task.target_step_key} · {task.task_kind==="audit_only"?"审计补录":"资料补录"}</span><p>{task.reason}</p>{task.resolution_note&&<p>处理说明：{task.resolution_note}</p>}</div>
              <small>{task.status==="open"?"待处理":task.status==="completed"?`已完成 · ${task.completed_by_name||"系统"}`:"已关闭"}<br/>{new Date(task.created_at).toLocaleString("zh-CN")}</small>
              {task.status==="open"&&<Form method="post" className="supplement-task-form"><input type="hidden" name="intent" value="workflow_supplement_complete"/><input type="hidden" name="taskId" value={task.id}/><input name="resolutionNote" aria-label={`${task.field_label}补录说明`} placeholder="填写补录/复核说明" minLength={2} required/><div><Link className="text-button" to={`/admin/orders/${order.id}/modules/${task.module_code}`}>查看办理位置</Link><button className="text-button">完成补录</button></div></Form>}
            </article>)}
            {!data.supplementTasks.length&&<p className="linear-drawer-empty">当前订单没有资料补录任务。</p>}
          </div></section>}
          {activeTab === "history" && <>
            <section className="linear-drawer-section"><h3>订单状态记录 <span>{data.history.length} 条</span></h3><div className="linear-drawer-timeline">
              {data.history.map((item) => <article key={item.id}><time>{new Date(item.occurred_at).toLocaleString("zh-CN")}</time><div><strong>{item.action_name}</strong><span>{statusLabel(item.from_status)} → {statusLabel(item.to_status)} · {item.actor_name || "系统"}</span>{item.notes && <p>{item.notes}</p>}</div></article>)}
              {!data.history.length && <p className="linear-drawer-empty">暂无订单状态记录。</p>}
            </div></section>
            <section className="linear-drawer-section"><h3>工作流节点记录 <span>{data.macro.length} 条</span></h3><div className="linear-drawer-timeline">
              {data.macro.map((item) => <article key={item.id}><time>{new Date(item.occurred_at).toLocaleString("zh-CN")}</time><div><strong>{item.step_name}</strong><span>{item.actor_name || item.source}</span></div></article>)}
              {!data.macro.length && <p className="linear-drawer-empty">暂无工作流节点记录。</p>}
            </div></section>
          </>}
        </div>
      </aside>
    </div>
  );
}

function DrawerTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button className={active ? "active" : ""} type="button" role="tab" aria-selected={active} onClick={onClick}>{children}</button>;
}

function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="linear-drawer-section"><h3>{title}</h3><div className="linear-drawer-grid">{children}</div></section>;
}

function DrawerFact({ label, value, wide = false }: { label: string; value: string | null | undefined; wide?: boolean }) {
  return <div className={wide ? "wide" : ""}><span>{label}</span><b>{value || "—"}</b></div>;
}

function OrderDossierSection({ order }: { order: Order }) {
  return <section className="section" id="order-dossier"><div className="section-title"><b>订单资料</b><span>报价已确定的资料自动继承，无需重复录入</span></div><div className="grid"><ReadCell label="客户 / 发货方" value={order.customer_name}/><ReadCell label="关联报价" value={order.quote_number}/><ReadCell label="订单类型" value={order.business_type === "ltl" ? "拼车" : "整车"}/><ReadCell label="清关责任" value={order.customs_clearance_mode === "company" ? "公司代办清关" : "客户自理清关"}/><ReadCell label="发货联系人" value={[order.shipper_contact,order.shipper_phone].filter(Boolean).join(" · ")}/><ReadCell label="预约提货" value={order.requested_pickup_date}/><ReadCell label="提货地址" value={[order.origin_state,order.origin_city,order.origin_address].filter(Boolean).join(" ")} className="span2"/><ReadCell label="境外联系人" value={[order.consignee_contact,order.consignee_phone].filter(Boolean).join(" · ")}/><ReadCell label="境外目的仓" value={order.overseas_warehouse_name}/><ReadCell label="货物" value={`${order.cargo_description} · ${order.pieces} 件 · ${order.gross_weight_kg} KG · ${order.volume_cbm} CBM`} className="span2"/><ReadCell label="备注" value={order.special_instructions} className="span2"/></div></section>;
}

function SelectedStepSections({ data, rows, selectedStep, viewingCurrent, busy, documentReviewSignal }: { data: Route.ComponentProps["loaderData"]; rows: WorkflowFormRow[]; selectedStep: (BusinessWorkflowStep & { rows: WorkflowFormRow[] }) | null; viewingCurrent: boolean; busy: boolean; documentReviewSignal?: unknown }) {
  if (!selectedStep || !rows.length) return <section className="section" id="node-fields"><div className="section-title"><b>本节点业务数据</b><span>当前节点没有配置需要人工填写的字段</span></div><div className="grid"><ReadCell label="节点状态" value="无需人工录入，节点仍按工作流保留" className="span4"/></div></section>;
  const selectedModuleCode = data.embeddedModuleCode;
  const selectedRow = rows.find((row) => row.module_code === selectedModuleCode) || rows[0];
  const selectedFields = data.currentWorkflowFields.filter((field) => field.stepKey === selectedStep.step_key && field.moduleCode === selectedRow.module_code && field.isActive);
  const isOrderCreation = selectedStep.step_key === "order_creation";
  const selectedSection = selectedModuleCode === "cargo" ? "cargo" : data.selectedConsignmentSection;
  const orderCreationFields = data.currentWorkflowFields.filter(
    (field) => field.stepKey === "order_creation" && field.isActive,
  );
  const tabHasRequiredMissing = (tabKey: string) => orderCreationFields.some((field) => {
    if (!field.isRequired || field.present) return false;
    const isDocument = field.fieldType === "attachment" || field.fieldKey.startsWith("document_");
    if (tabKey === "info") return field.moduleCode === "consignment" && !isDocument;
    if (tabKey === "files") return field.moduleCode === "consignment" && isDocument;
    if (tabKey === "cargo") return field.moduleCode === "cargo";
    return tabKey === "costs" && field.moduleCode === "costs";
  });
  const moduleHasRequiredMissing = (moduleCode: string | null) => data.currentWorkflowFields.some(
    (field) => field.isActive && field.stepKey === selectedStep.step_key && field.moduleCode === moduleCode && field.isRequired && !field.present,
  );
  const actionUrl = `/admin/orders/${data.order.id}?stage=${encodeURIComponent(selectedStep.step_key)}&module=${encodeURIComponent(selectedModuleCode || "")}${selectedModuleCode === "consignment" ? `&section=${encodeURIComponent(data.selectedConsignmentSection)}` : ""}`;
  const orderCreationTabs = [
    { key: "info", label: "委托信息", module: "consignment", section: "info" },
    { key: "cargo", label: "货物信息", module: "cargo", section: "" },
    { key: "files", label: "文件管理", module: "consignment", section: "files" },
    { key: "costs", label: "订单费用", module: "consignment", section: "costs" },
  ];
  return <div id="node-fields">
    {isOrderCreation ? (
      <nav className="linear-module-tabs" aria-label="委托资料补充分区">
        {orderCreationTabs.map((tab) => <Link key={tab.key} className={selectedSection === tab.key ? "active" : ""} to={`?stage=${encodeURIComponent(selectedStep.step_key)}&module=${tab.module}${tab.section ? `&section=${tab.section}` : ""}`}>{tab.label}{tabHasRequiredMissing(tab.key) && <b className="tab-required-star" title="存在必填但未填内容" aria-label="存在必填但未填内容">*</b>}</Link>)}
      </nav>
    ) : rows.length > 1 ? (
      <nav className="linear-module-tabs" aria-label="本节点业务分区">{rows.map((row) => <Link key={row.module_state_id || row.module_code} className={row.module_code === selectedModuleCode ? "active" : ""} to={`?stage=${encodeURIComponent(selectedStep.step_key)}&module=${encodeURIComponent(row.module_code || "")}`}>{row.module_name || row.module_code}{moduleHasRequiredMissing(row.module_code) && <b className="tab-required-star" title="存在必填但未填内容" aria-label="存在必填但未填内容">*</b>}</Link>)}</nav>
    ) : null}
    {data.embeddedModuleRedirect ? <section className="section"><div className="section-title"><b>{selectedRow.module_name || "关联业务单"}</b><span>该节点按配载单统一推进</span></div><div className="linear-external-work"><p>拼车订单在仓库生成 PZ 配载单后，由配载单统一记录出境运输并同步全部子订单。</p><Link className="btn primary" to={data.embeddedModuleRedirect}>打开配载单跟踪</Link></div></section> : data.embeddedModuleData ? <EmbeddedOrderModule data={data.embeddedModuleData} busy={busy} actionUrl={actionUrl} consignmentSection={data.selectedConsignmentSection} hideConsignmentActionBar={isOrderCreation} approvalMode={selectedStep.step_key === "consignment_approval"} reviewCloseSignal={documentReviewSignal}/> : <section className="section"><div className="section-title"><b>{selectedRow.module_name || selectedRow.module_code || "业务数据"}</b><span>{viewingCurrent ? "当前节点" : "历史节点"}</span></div><div className="grid">{selectedFields.map((field) => {
      const fieldState = field.present ? "filled" : field.isRequired ? "required-missing" : "optional-empty";
      return <div className={`read-cell workflow-cell ${field.present ? "complete" : field.isRequired ? "missing" : "optional"}`} key={field.id}><span>{field.label}{field.isRequired ? " *" : ""}</span><b>{field.displayValue || "—"}</b><em className={`field-state ${fieldState}`}>{field.present ? "已填" : field.isRequired ? "必填但未填" : "未填"}</em></div>;
    })}</div></section>}
    {!isOrderCreation && <div className="linear-module-summary" aria-label="本节点其他分区状态">{rows.filter((row) => row.module_code !== selectedModuleCode).map((row) => <span key={row.module_state_id || row.module_code}>{row.module_name || row.module_code} · {workflowFormStatusLabel(row.module_status || "not_started")}</span>)}</div>}
  </div>;
}

function ReadCell({ label, value, className = "" }: { label: string; value: string | null | undefined; className?: string }) { return <div className={`read-cell ${className}`}><span>{label}</span><b>{value || "—"}</b></div>; }

function OrderBusinessForm({
  data,
  busy,
}: {
  data: Route.ComponentProps["loaderData"];
  busy: boolean;
}) {
  const [activeTab, setActiveTab] = useState<OrderDetailTab>("dossier");
  const [overviewOpen, setOverviewOpen] = useState(false);
  const order = data.order;
  const orderCompleted = order.status === "completed";
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
  const currentStepIndex = Math.max(
    configuredSteps.findIndex((step) => step.step_key === currentConfiguredStep?.step_key),
    0,
  );
  const currentTaskRows = currentConfiguredStep
    ? uniqueWorkflowTasks(currentConfiguredStep.rows)
    : [];
  const pendingTaskCount = orderCompleted
    ? 0
    : currentTaskRows.filter((task) => task.task_status !== "completed").length;
  const currentPositionName =
    data.currentWorkflowTasks.find((task) => task.status !== "completed")?.position_name ||
    orderResponsiblePosition(guidance.moduleCode, order.status).name;
  const currentStepDisplayName = orderCompleted
    ? "订单已完成"
    : data.businessWorkflow?.current_step_name || order.current_step_name;
  const currentAction = orderCompleted ? "查看订单资料与历史记录" : guidance.action;
  const currentPositionDisplay = orderCompleted ? "已归档" : currentPositionName;
  const currentAssigneeDisplay = orderCompleted ? "无需办理" : order.assignee_name || "待分配";
  const currentModuleRows = currentConfiguredStep
    ? uniqueWorkflowModules(currentConfiguredStep.rows)
    : [];
  const tabItems: Array<{ key: OrderDetailTab; label: string; meta: string }> = [
    { key: "dossier", label: "订单资料", meta: "客户与线路" },
    { key: "cargo", label: "货物", meta: `${order.pieces} 件` },
    { key: "transport", label: "运输", meta: "国内与出境" },
    { key: "warehouse", label: "仓库", meta: `${data.packageLabels.length} 张标签` },
    { key: "attachments", label: "文件", meta: `${data.attachments.length} 个` },
    { key: "costs", label: "费用", meta: `${data.expenseRisk.receivable_count + data.expenseRisk.payable_count} 项` },
    { key: "history", label: "日志", meta: `${data.history.length + data.macro.length} 条` },
  ];

  return (
    <section className="order-single-form" aria-label="订单业务办理表单">
      <main className="order-form-sheet">
        <header className="order-form-current">
          <div>
            <span>{orderCompleted ? "订单状态" : "当前办理"}</span>
            <h2>{currentStepDisplayName}</h2>
            <p>{currentAction}</p>
          </div>
          <div className="order-form-current-meta">
            <span>第 {orderCompleted ? configuredSteps.length : currentStepIndex + 1}/{configuredSteps.length || 1} 节点</span>
            <span>{orderCompleted ? "流程已结束" : `${pendingTaskCount} 项待办`}</span>
            <span>{currentPositionDisplay}</span>
            <span>{currentAssigneeDisplay}</span>
            <button
              className="secondary order-overview-toggle"
              type="button"
              onClick={() => setOverviewOpen((open) => !open)}
            >
              {overviewOpen ? "返回当前办理" : "查看订单全貌"}
            </button>
          </div>
        </header>

        <OrderBusinessSummary data={data} />

        {!overviewOpen && (
          <CurrentNodeWorksheet
            data={data}
            step={currentConfiguredStep}
            moduleRows={currentModuleRows}
            orderCompleted={orderCompleted}
            busy={busy}
          />
        )}
        {overviewOpen && (
          <section className="order-overview-workspace" aria-label="订单全貌">
            <header className="order-overview-header">
              <div>
                <span>只读总览</span>
                <h2>订单全貌</h2>
                <small>查看完整流程和业务资料；办理操作仍以当前节点为准。</small>
              </div>
              <button className="secondary" type="button" onClick={() => setOverviewOpen(false)}>返回当前办理</button>
            </header>
            <OrderVerticalWorkflow
              order={order}
              modules={data.modules}
              workflow={data.businessWorkflow}
              workflowSteps={data.workflowSteps}
              workflowFormRows={data.workflowFormRows}
            />
            <nav className="order-detail-tabs" aria-label="订单全貌内容" role="tablist">
              {tabItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === item.key}
                  aria-controls={`order-tab-panel-${item.key}`}
                  className={activeTab === item.key ? "active" : ""}
                  onClick={() => setActiveTab(item.key)}
                >
                  <strong>{item.label}</strong>
                  <small>{item.meta}</small>
                </button>
              ))}
            </nav>
            <div className="order-detail-tab-content">
              {activeTab === "dossier" && <OrderMountedPanel panel="dossier" data={data} />}
              {activeTab === "cargo" && <OrderMountedPanel panel="cargo" data={data} />}
              {activeTab === "transport" && (
                <OrderModuleOverview
                  data={data}
                  title="运输进度"
                  subtitle="国内运输、文件报关、装车与出境运输使用同一组模块状态。"
                  moduleCodes={["transport", "documents", "customs", "loading", "tracking"]}
                />
              )}
              {activeTab === "warehouse" && (
                <OrderModuleOverview
                  data={data}
                  title="仓库进度"
                  subtitle="国内入仓、货物标签和境外仓办理状态集中查看。"
                  moduleCodes={["warehouse", "overseas_warehouse"]}
                  showPackageLabels
                />
              )}
              {activeTab === "attachments" && <OrderMountedPanel panel="attachments" data={data} />}
              {activeTab === "costs" && <OrderMountedPanel panel="costs" data={data} />}
              {activeTab === "history" && <OrderMountedPanel panel="history" data={data} />}
            </div>
          </section>
        )}
      </main>
      <footer className={`order-sticky-action-bar ${!orderCompleted && guidance.blocker ? "blocked" : ""}`}>
        <div className="order-sticky-responsibility">
          <span>{orderCompleted ? "订单状态" : "当前责任"}</span>
          <strong>{orderCompleted ? "业务已完成" : `${currentPositionName} · ${order.assignee_name || "待分配"}`}</strong>
        </div>
        <div className="order-sticky-condition">
          <span>{orderCompleted ? "流程结果" : guidance.blocker ? "阻断原因" : "办理条件"}</span>
          <strong>{orderCompleted ? "全部必办节点已完成" : guidance.blocker || "当前节点暂无阻断"}</strong>
        </div>
        <div className="order-sticky-next">
          <span>{orderCompleted ? "可执行操作" : "当前动作"}</span>
          <strong>{currentAction}</strong>
        </div>
        <div className="order-sticky-primary-action">
          {orderCompleted ? (
            <button className="secondary" type="button" onClick={() => { setActiveTab("history"); setOverviewOpen(true); }}>查看处理记录</button>
          ) : directAction && !guidance.blocker ? (
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
            <Link
              className={guidance.blocker ? "secondary" : "primary"}
              to={`/admin/orders/${order.id}/modules/${guidance.moduleCode}#module-business-data`}
            >
              {guidance.blocker ? "查看阻断并处理" : "办理当前节点"}
            </Link>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

type CurrentWorksheetStep = BusinessWorkflowStep & { rows: WorkflowFormRow[] };
type WorksheetTone = "complete" | "pending" | "blocked";

function CurrentNodeWorksheet({
  data,
  step,
  moduleRows,
  orderCompleted,
  busy,
}: {
  data: Route.ComponentProps["loaderData"];
  step: CurrentWorksheetStep | null;
  moduleRows: WorkflowFormRow[];
  orderCompleted: boolean;
  busy: boolean;
}) {
  if (!step || !moduleRows.length) {
    return (
      <section className="order-node-worksheet empty" id="order-tab-panel-current">
        <strong>当前节点暂未配置业务模组</strong>
        <span>节点仍会保留在流程中，可在“查看订单全貌”中查看完整配置。</span>
      </section>
    );
  }

  return (
    <section className="order-node-worksheet" id="order-tab-panel-current" aria-label="当前节点工作表">
      <header className="order-node-worksheet-header">
        <div>
          <span>当前节点工作表</span>
          <h3>{step.name}</h3>
          <small>默认只显示需要处理的必填项；已完成和选填内容可按需展开。</small>
        </div>
        <div className="order-node-state-legend" aria-label="字段状态说明">
          <span className="complete">已填写</span>
          <span className="pending">待处理/选填</span>
          <span className="blocked">必填缺失/阻断</span>
        </div>
      </header>

      <div className="order-node-module-list">
        {moduleRows.map((row) => {
          const module = data.modules.find((item) => item.module_code === row.module_code);
          const fields = data.currentWorkflowFields.filter(
            (field) => field.isActive && field.stepKey === step.step_key && field.moduleCode === row.module_code,
          );
          const missingRequired = fields.filter((field) => field.isRequired && !field.present);
          const completedFields = fields.filter((field) => field.present);
          const optionalFields = fields.filter((field) => !field.isRequired && !field.present);
          const tasks = uniqueWorkflowTasks(
            step.rows.filter((item) => item.module_state_id === row.module_state_id),
          );
          const pendingTasks = tasks.filter((task) => task.task_status !== "completed");
          const mine = !orderCompleted && row.module_status !== "completed" && (
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
            orderModuleAccess(data.order.status, module.module_code).canEdit &&
            canManageOrderModule(data.current, module.module_code),
          );
          const tone: WorksheetTone = orderCompleted || row.module_status === "completed"
            ? "complete"
            : module?.blocking_reason || missingRequired.length
              ? "blocked"
              : "pending";
          const moduleName = row.module_name || (row.module_code ? orderModuleDefinition(row.module_code)?.name : null) || row.module_code || "未命名模组";
          const moduleHref = row.module_code
            ? `/admin/orders/${data.order.id}/modules/${row.module_code}#module-business-data`
            : null;

          return (
            <article
              className={`order-node-module is-${tone}${mine ? " is-mine" : ""}`}
              id={`order-form-module-${row.module_code}`}
              key={row.module_state_id}
            >
              <header className="order-node-module-header">
                <div className="order-node-module-title">
                  <span>{row.module_required ? "必须办理" : "按需办理"}</span>
                  <strong>{moduleName}</strong>
                </div>
                <div className="order-node-module-meta">
                  {mine && <b>待我处理</b>}
                  <span>{row.position_name || row.responsibility_position_code || "待配置岗位"}</span>
                  <span>{row.assignee_name || "待分配人员"}</span>
                  <em>{orderCompleted ? "已归档" : workflowFormStatusLabel(row.module_status || module?.status || "not_started")}</em>
                  <span>必填缺失 {missingRequired.length}</span>
                </div>
                {moduleHref && (
                  <Link className="secondary order-node-module-open" to={moduleHref}>
                    {editable && !orderCompleted ? "打开办理页" : "查看模组"}
                  </Link>
                )}
              </header>

              {!orderCompleted && module?.blocking_reason && (
                <div className="order-node-blocker" role="alert">
                  <strong>当前阻断</strong>
                  <span>{module.blocking_reason}</span>
                </div>
              )}

              {missingRequired.length > 0 ? (
                <div className="order-node-field-section required">
                  <div className="order-node-field-section-title">
                    <strong>现在需要填写</strong>
                    <span>{missingRequired.length} 项必填内容</span>
                  </div>
                  <div className="order-node-field-grid">
                    {missingRequired.map((field) => (
                      <WorkflowWorksheetField
                        key={field.id}
                        field={field}
                        orderId={data.order.id}
                        tone="blocked"
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="order-node-ready-state">
                  <strong>{orderCompleted ? "本模组已归档" : "必填内容已齐全"}</strong>
                  <span>{orderCompleted ? "可展开查看已保存的数据。" : "可以继续完成本模组的办理步骤。"}</span>
                </div>
              )}

              {completedFields.length > 0 && (
                <details className="order-node-field-details">
                  <summary>已填写字段 <span>{completedFields.length} 项</span></summary>
                  <div className="order-node-field-grid">
                    {completedFields.map((field) => (
                      <WorkflowWorksheetField
                        key={field.id}
                        field={field}
                        orderId={data.order.id}
                        tone="complete"
                      />
                    ))}
                  </div>
                </details>
              )}

              {optionalFields.length > 0 && !orderCompleted && (
                <details className="order-node-field-details optional">
                  <summary>可选字段 <span>{optionalFields.length} 项</span></summary>
                  <div className="order-node-field-grid">
                    {optionalFields.map((field) => (
                      <WorkflowWorksheetField
                        key={field.id}
                        field={field}
                        orderId={data.order.id}
                        tone="pending"
                      />
                    ))}
                  </div>
                </details>
              )}

              {!fields.length && (
                <div className="order-node-no-fields">
                  <strong>本模组没有需要填写的字段</strong>
                  <span>按下方办理步骤推进，不会产生隐藏字段门禁。</span>
                </div>
              )}

              {!orderCompleted && tasks.length > 0 && (
                <ol className="order-node-task-list" aria-label={`${moduleName}办理步骤`}>
                  {tasks.map((task, index) => (
                    <li className={task.task_status === "completed" ? "completed" : "pending"} key={task.task_state_id || `${row.module_state_id}-${index}`}>
                      <i>{task.task_status === "completed" ? "✓" : index + 1}</i>
                      <div>
                        <strong>{task.task_name}</strong>
                        <small>{task.task_position_name || task.task_position_code || row.position_name || "按模组岗位"}{task.task_instructions ? ` · ${task.task_instructions}` : ""}</small>
                      </div>
                      {task.task_status !== "completed" && isWorkflowTaskManual(step.step_key, task.task_key || "") ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="workflow_task_complete" />
                          <input type="hidden" name="taskStateId" value={task.task_state_id || ""} />
                          <button className="secondary" disabled={busy}>{workflowTaskActionLabel(task.task_type || "manual")}</button>
                        </Form>
                      ) : task.task_status !== "completed" ? <small>保存完整数据后自动完成</small> : <small>已完成</small>}
                    </li>
                  ))}
                </ol>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function WorkflowWorksheetField({
  field,
  orderId,
  tone,
}: {
  field: WorkflowFieldState;
  orderId: string;
  tone: WorksheetTone;
}) {
  const statusLabel = tone === "complete" ? "已填写" : tone === "blocked" ? "必填缺失" : "可选";
  return (
    <Link
      className={`order-node-field is-${tone}`}
      to={`/admin/orders/${orderId}/modules/${field.moduleCode}#workflow-field-${field.fieldKey}`}
      title={field.displayValue || field.helpText || field.label}
    >
      <span>
        <b>{field.label}</b>
        <em>{statusLabel}</em>
      </span>
      <strong>{field.displayValue || (tone === "blocked" ? "待填写" : "按需填写")}</strong>
    </Link>
  );
}

function OrderBusinessSummary({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const order = data.order;
  return (
    <section className="order-form-section order-form-basics">
      <header>
        <div>
          <span>订单摘要</span>
          <h2>关键资料常驻显示</h2>
        </div>
        <small>{order.customer_name} · {businessTypeLabels[order.business_type] ?? order.business_type} · {order.cargo_description || "未填写货物名称"}</small>
      </header>
      <div className="order-form-basics-body">
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
      </div>
    </section>
  );
}

function OrderPackageLabels({ labels }: { labels: WarehousePackageLabel[] }) {
  if (!labels.length) return <p className="empty-state">当前订单暂无仓库货物标签。</p>;
  return (
    <section className="order-package-labels" aria-label="仓库货物标签">
      <header>
        <div><strong>货物标签</strong><small>境外仓继续扫描以下国内仓标签；标签出库后仍然有效。</small></div>
        <span>{labels.length} 张</span>
      </header>
      <div className="order-package-label-list">
        {labels.map((label) => (
          <div className="order-package-label-row" key={label.id}>
            <div><code>{label.barcode}</code><small>{label.package_number}</small></div>
            <div><strong>{label.cargo_name || "未关联货物明细"}</strong><small>{label.pieces} 件 · {Number(label.weight_kg || 0).toFixed(2)} KG · {Number(label.volume_cbm || 0).toFixed(3)} CBM</small></div>
            <div><strong>{label.warehouse_name || "仓库待确认"}</strong><small>{[label.zone_name, label.location_name].filter(Boolean).join(" / ") || "库位待确认"}</small></div>
            <span className={`status-pill ${label.status === "dispatched" ? "success" : label.status === "exception" ? "danger" : ""}`}>{warehousePackageStatusLabel(label.status)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function OrderModuleOverview({
  data,
  title,
  subtitle,
  moduleCodes,
  showPackageLabels = false,
}: {
  data: Route.ComponentProps["loaderData"];
  title: string;
  subtitle: string;
  moduleCodes: string[];
  showPackageLabels?: boolean;
}) {
  const modules = moduleCodes
    .map((code) => data.modules.find((module) => module.enabled === 1 && module.module_code === code))
    .filter((module): module is OrderModuleInstance => Boolean(module));
  return (
    <section className="order-tab-panel" role="tabpanel">
      <header className="order-tab-panel-header">
        <div><span>业务总览</span><h2>{title}</h2></div>
        <small>{subtitle}</small>
      </header>
      <div className="order-module-overview-table">
        <div className="order-module-overview-head">
          <span>业务模组</span><span>状态</span><span>当前步骤</span><span>负责人</span><span>进度</span><span>操作</span>
        </div>
        {modules.map((module) => {
          const access = orderModuleAccess(data.order.status, module.module_code);
          return (
            <div className={`order-module-overview-row ${module.blocking_reason ? "blocked" : ""}`} key={module.id}>
              <div><strong>{module.module_name}</strong>{module.blocking_reason && <small>{module.blocking_reason}</small>}</div>
              <span>{moduleStatusLabels[module.status] || module.status}</span>
              <span>{module.current_step_name || "待开始"}</span>
              <span>{module.assignee_name || "待分配"}</span>
              <span>{module.progress_percent}%</span>
              <Link className="text-button" to={`/admin/orders/${data.order.id}/modules/${module.module_code}#module-business-data`}>
                {access.canEdit ? "进入办理" : "查看"}
              </Link>
            </div>
          );
        })}
        {!modules.length && <p className="empty-state">本订单未启用相关业务模组。</p>}
      </div>
      {showPackageLabels && <OrderPackageLabels labels={data.packageLabels} />}
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
              <div className="table-wrap order-module-table"><table>
                <thead><tr><th>顺序 / 模块</th><th>状态</th><th>当前节点</th><th>负责人</th><th>待办</th><th>阻断 / 下一步</th><th>操作</th></tr></thead>
                <tbody>{stageModules.map((module) => {
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
                    <tr
                      id={`module-card-${module.module_code}`}
                      className={access.canEdit ? "" : "read-only"}
                      key={module.id}
                    >
                      <td><Link to={`/admin/orders/${orderId}/modules/${module.module_code}`}><strong>{String(orderModuleSequence(module.module_code)).padStart(2, "0")} · {module.module_name}</strong></Link><small>{definition?.description}</small></td>
                      <td><span className={`status-pill ${["blocked", "exception", "not_applicable"].includes(module.status) ? "off" : ""}`}>{moduleStatusLabels[module.status] ?? module.status}</span><small>{module.progress_percent}%</small></td>
                      <td><strong>{module.current_step_name || "待开始"}</strong></td>
                      <td>{module.assignee_name || "未分配"}</td>
                      <td><strong className={task?.overdue_count ? "danger-text" : ""}>{task?.pending_count ?? 0}{task?.overdue_count ? ` · 超时 ${task.overdue_count}` : ""}</strong></td>
                      <td>{module.blocking_reason ? <span className="danger-text">{module.blocking_reason}</span> : module.status === "completed" ? nextModule ? `下一步：${nextModule.module_name} · ${nextModule.current_step_name || "当前节点"}` : "确认全部模块完成后办理应收账单" : `当前办理：${module.current_step_name || "进入模块查看待办"}`}</td>
                      <td><Link className="text-button" to={`/admin/orders/${orderId}/modules/${module.module_code}`}>{access.canEdit ? "进入办理" : "查看"}</Link><small>{access.canEdit ? "" : access.reason}</small></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
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
            <Info label="清关责任" value={order.customs_clearance_mode === "customer" ? "客户自理清关" : "公司代办清关"} />
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
          <OrderPackageLabels labels={data.packageLabels} />
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
                <a className="text-button" href={`/admin/document-files/order/${attachment.id}`}>下载</a>
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
            const content = (
              <>
                <i>{status === "completed" ? "✓" : index + 1}</i>
                <div>
                  <strong>{step.name}</strong>
                  <small>
                    {status === "active"
                      ? "当前节点"
                      : status === "completed"
                        ? "已完成"
                        : step.is_required
                          ? "后续必办"
                          : "按需办理"}
                  </small>
                </div>
                <span aria-hidden="true">→</span>
              </>
            );
            return (
              <li key={step.step_key} className={status}>
                {status === "pending" ? (
                  <div className="order-workflow-step-entry disabled" aria-disabled="true" title={`${step.name}尚未开放`}>
                    {content}
                  </div>
                ) : (
                  <Link className="order-workflow-step-entry" to={href} title={`打开${step.name}`}>
                    {content}
                  </Link>
                )}
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
          const navigable = snapshot.status === "active" || snapshot.status === "completed";
          const content = (
            <>
              <i>{snapshot.status === "completed" ? "✓" : index + 1}</i>
              <div>
                <strong>{snapshot.stage.shortTitle}</strong>
                <small>
                  {snapshot.status === "active"
                    ? "当前阶段"
                    : snapshot.status === "skipped"
                      ? "本单无需拼车配载"
                      : snapshot.status === "completed"
                        ? "已完成"
                        : "后续阶段"}
                </small>
              </div>
              <span aria-hidden="true">→</span>
            </>
          );
          return (
            <li key={snapshot.stage.code} className={snapshot.status}>
              {navigable ? (
                <Link className="order-workflow-step-entry" to={href} title={`打开${snapshot.stage.shortTitle}`}>
                  {content}
                </Link>
              ) : (
                <div className="order-workflow-step-entry disabled" aria-disabled="true">
                  {content}
                </div>
              )}
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
    <section className="panel order-expense-risk-table">
      <div className="table-wrap"><table><thead><tr><th>费用阶段</th><th>应收</th><th>应付</th><th>风险状态</th><th>风险说明</th><th>操作</th></tr></thead><tbody><tr>
        <td><strong>{mode === "settlement" ? "费用结算" : "报价应收"}</strong></td><td>{risk.receivable_count} 项<small>折算 {risk.receivable_total.toFixed(2)}</small></td><td>{risk.payable_count} 项<small>折算 {risk.payable_total.toFixed(2)}</small></td><td><span className={`status-pill ${warnings.length ? "danger" : "success"}`}>{warnings.length ? `${warnings.length} 项待处理` : "无待处理风险"}</span></td><td>{warnings.join("；") || (mode === "settlement" ? "应收、应付均已确认并锁定" : "已从接受报价继承应收费用")}</td><td><Link className="secondary" to={`/admin/orders/${orderId}/modules/costs#module-business-data`}>{mode === "settlement" ? "进入费用结算" : "查看报价应收"}</Link></td>
      </tr></tbody></table></div>
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
function warehousePackageStatusLabel(status: string) {
  const labels: Record<string, string> = {
    in_stock: "在库，标签有效",
    allocated: "已分配，标签有效",
    dispatched: "已出库，标签有效",
    exception: "异常冻结",
    picked_up: "已提货，标签留档",
    cancelled: "已作废",
  };
  return labels[status] || status;
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
