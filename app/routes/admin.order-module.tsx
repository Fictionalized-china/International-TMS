import { createContext, useContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Form as RouterForm, Link, useActionData, useFetcher, useNavigation, redirect } from "react-router";
import { env } from "cloudflare:workers";
import type { Route } from "./+types/admin.order-module";
import { BatchNumberLink, OrderNumberLink } from "../components/EntityNumberLink";
import { requireSessionUser } from "../lib/auth.server";
import { requireOrderAccess } from "../lib/order-access.server";
import { validatePhone, valueOf } from "../lib/validation";
import { chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import { writeAudit } from "../lib/audit.server";
import { synchronizeOrderDocumentsModuleStatus } from "../lib/documents-module-status.server";
import {
  advanceOrderModule,
  assignOrderModule,
  ensureOrderModules,
  listOrderModules,
  syncCostsModuleStatus,
  syncOrderWorkflowSnapshot,
} from "../lib/order-modules.server";
import { runOrderWorkflowAction } from "../lib/order-workflow-action.server";
import { isAssignedOrderApprover } from "../lib/order-workflow";
import {
  composeOrderWorkflow,
  moduleStatusLabels,
  orderModuleDefinition,
  type OrderModuleCode,
} from "../lib/order-modules";
import {
  orderModuleAccess,
  orderStageForModule,
  orderModuleWorkflowStageAccess,
  type WorkflowStepPosition,
} from "../lib/order-stage-flow";
import { canManageOrderModule } from "../lib/position-portal";
import { transportChargeNameOptions } from "../lib/charge-options";
import { ensureFtlVehicleAndLoads } from "../lib/ftl-vehicle-loads.server";
import { summarizeLoadingSelection } from "../lib/loading-workbench";
import { batchTransportDisplay } from "../lib/batch-transport-display";
import { submitForm } from "../lib/form-submit";
import {
  maxInlineOrderDocumentBytes,
  orderDocumentCanBeHandledInModule,
  orderDocumentPlacement,
  orderDocumentPlacements,
  preDepartureDocumentTypeCodes,
  orderDocumentStages,
  orderDocumentsForModule,
  orderDocumentTypeCodes,
  orderDocumentTypeLabel,
} from "../lib/order-documents";
import { checkOrderDeparture, checkOrderLoadPlan } from "../lib/order-readiness.server";
import { roadStatusLabels } from "../lib/warehouse-actual";
import { syncBatchRoadStatusFromTracking } from "../lib/batch-tracking.server";
import {
  nextOverseasAction,
  overseasOperationProgress,
  overseasOperationStatusLabels,
} from "../lib/overseas-warehouse";
import {
  automaticallyNotifyOverseasArrival,
  completeOverseasOrderDelivery,
  reconcileOverseasOrderDeliveryState,
} from "../lib/overseas-warehouse.server";
import {
  canCreateExpenseFromModule,
  emptyExpenseDirectionControl,
  expenseDirectionNextAction,
  expenseDirectionProgress,
  type ExpenseDirectionControl,
} from "../lib/expense-control";
import {
  generateOrderReview,
  loadOrderReview,
} from "../lib/order-review.server";
import { syncCustomsModuleFromRecords } from "../lib/customs-status.server";
import { Modal } from "../components/Modal";
import { OrganizationAssigneePicker } from "../components/OrganizationAssigneePicker";
import type { OrganizationAssigneeMember } from "../lib/organization-assignee";
import {
  isActiveOrganizationAssignee,
  listActiveOrganizationAssigneeIds,
} from "../lib/organization-assignee.server";
import {
  loadOrderModuleWorkflowFields,
  missingRequiredModuleFields,
  saveOrderCustomWorkflowFieldValue,
  type WorkflowFieldState,
} from "../lib/workflow-fields.server";
import { workflowFieldConfigurationHref } from "../lib/workflow-field-locator";
import {
  hasVisibleRuntimeWorkflowField,
  runtimeWorkflowFieldPolicy,
} from "../lib/workflow-field-runtime";
import {
  cargoDetailFieldGroups,
  orderCreationConsignmentPresentationKeys,
  quotationCargoPresentationKeys,
  quotationConsignmentPresentationKeys,
  quotationCostsPresentationKeys,
  workflowFieldsForStep,
} from "../lib/order-workflow-field-presentation";

type OrderSummary = {
  id: string;
  order_number: string;
  order_date: string;
  quotation_id: string | null;
  quote_number: string | null;
  quotation_currency: string | null;
  quotation_subtotal: number | null;
  quotation_tax_amount: number | null;
  quotation_total_amount: number | null;
  quotation_status: string | null;
  quotation_customer_contact_name: string | null;
  quotation_customer_contact_phone: string | null;
  quotation_salesperson_name: string | null;
  quotation_cargo_description: string | null;
  quotation_notes: string | null;
  quotation_pieces: number | null;
  quotation_gross_weight_kg: number | null;
  quotation_length_cm: number | null;
  quotation_width_cm: number | null;
  quotation_height_cm: number | null;
  quotation_volume_cbm: number | null;
  quotation_valid_until: string | null;
  customer_id: string;
  customer_name: string;
  customer_reference: string | null;
  shipper_name: string;
  shipper_contact: string | null;
  shipper_phone: string | null;
  pickup_address_id: string | null;
  pickup_address_name: string | null;
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
  business_nature: string;
  business_type: string;
  transport_mode: string;
  transport_terms: string | null;
  trade_terms: string | null;
  exit_port: string | null;
  overseas_warehouse_id: string | null;
  overseas_warehouse_name: string | null;
  overseas_warehouse_code: string | null;
  overseas_warehouse_address: string | null;
  overseas_warehouse_address_note: string | null;
  transit_locations: string | null;
  customs_location: string | null;
  customs_clearance_mode: "company" | "customer";
  route_notes: string | null;
  requested_pickup_date: string | null;
  requested_delivery_date: string | null;
  cargo_ready_at: string | null;
  ro_agent: string | null;
  special_instructions: string | null;
  requires_transloading: number;
  requires_transit_customs: number;
  current_assignee_user_id: string | null;
  status: string;
};

const embeddedModuleFormAction = createContext<string | undefined>(undefined);

function Form(props: ComponentProps<typeof RouterForm>) {
  const inheritedAction = useContext(embeddedModuleFormAction);
  return <RouterForm {...props} action={props.action ?? inheritedAction} />;
}
type OrderService = {
  service_code: string;
  service_name: string;
  status: string;
};
type Member = OrganizationAssigneeMember;
function canEditWorkflowDefinitionInUi(user: {
  positionCode?: string | null;
  roleCodes: string[];
}) {
  return (
    ["BOSS", "DEVELOPER"].includes(user.positionCode ?? "") ||
    user.roleCodes.some((code) => ["boss", "developer", "owner"].includes(code))
  );
}
type ReferenceOption = { code: string; name: string };
type Task = {
  id: string;
  module_code: string;
  title: string;
  priority: string;
  status: string;
  assignee_name: string | null;
  due_at: string | null;
  created_at: string;
};
type History = {
  id: string;
  action_name: string;
  from_step_code: string | null;
  to_step_name: string | null;
  actor_name: string | null;
  notes: string | null;
  occurred_at: string;
};
type Cargo = {
  id: string;
  cargo_name_cn: string;
  cargo_name_en: string | null;
  hs_code: string | null;
  overseas_hs_code: string | null;
  package_type: string;
  package_count: number;
  pieces_per_package: number;
  gross_weight_per_package_kg: number;
  net_weight_per_package_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  volume_per_package_cbm: number;
  declared_value: number;
  currency: string;
  origin_country: string | null;
  brand_model: string | null;
  marks: string | null;
  special_attributes: string | null;
  notes: string | null;
  image_count: number;
};
type Attachment = {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  document_category: string | null;
  description: string | null;
  public_to_customer: number | null;
  review_status: string | null;
};
type Booking = {
  id: string;
  booking_number: string;
  booking_type: string;
  carrier_name: string | null;
  planned_departure_at: string | null;
  status: string;
};
type Batch = {
  id: string;
  carrier_id: string | null;
  batch_number: string;
  batch_name: string;
  origin_location: string;
  destination_location: string;
  planned_departure_at: string | null;
  planned_arrival_at: string | null;
  border_port: string | null;
  transit_location: string | null;
  route_notes: string | null;
  carrier_name: string | null;
  warehouse_name: string | null;
  status: string;
  road_status: string;
  vehicle_count: number;
  load_count: number;
  package_count: number;
  assigned_order_count: number;
  order_count: number;
  order_numbers: string | null;
  overseas_carrier_name: string | null;
  overseas_vehicle_type: string | null;
  overseas_vehicle_count: number;
  overseas_vehicle_plate: string | null;
  overseas_driver_name: string | null;
  overseas_driver_phone: string | null;
};
type WarehouseDispatchReport = {
  id: string;
  dispatch_number: string;
  status: string;
  vehicle_plate: string;
  driver_name: string;
  carrier_name: string | null;
  notes: string | null;
  item_count: number;
  loaded_count: number;
  created_at: string;
  dispatched_at: string | null;
  creator_name: string | null;
  dispatcher_name: string | null;
};
type Shipment = {
  id: string;
  shipment_number: string;
  status: string;
  current_location: string | null;
  last_event_at: string | null;
};
type Expense = {
  id: string;
  source_type: string | null;
  direction: string;
  stage: string;
  charge_code: string;
  charge_name: string;
  counterparty_name: string | null;
  currency: string;
  quantity: number;
  unit_price: number;
  amount: number;
  exchange_rate: number;
  tax_rate: number;
  tax_amount: number;
  occurred_on: string | null;
  is_internal: number;
  foreign_account_no: string | null;
  notes: string | null;
};
type QuoteCharge = {
  id: string;
  charge_code: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  exchange_rate: number;
};
type Carrier = {
  id: string;
  carrier_scope: string;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
};
type CarrierDriverOption = {
  id: string;
  carrier_id: string;
  name: string;
  phone: string | null;
  license_number: string | null;
};
type CarrierVehicleOption = {
  id: string;
  carrier_id: string;
  plate_number: string;
  vehicle_type: string | null;
};
type Warehouse = {
  id: string;
  name: string;
  warehouse_role: string | null;
};
type WarehouseCargoActual = {
  cargo_item_id: string;
  actual_record_count: number;
  actual_packages: number | null;
  actual_pieces: number | null;
  actual_weight_kg: number | null;
  actual_volume_cbm: number | null;
  actual_dimensions: string | null;
  actual_package_types: string | null;
  receipt_numbers: string | null;
  first_received_at: string | null;
  last_received_at: string | null;
};
type WarehouseReceiptDetail = {
  id: string;
  receipt_number: string;
  received_at: string;
  cargo_complete: number;
  has_exception: number;
  exception_notes: string | null;
  total_packages: number;
  total_pieces: number;
  total_weight_kg: number;
  total_volume_cbm: number;
  notes: string | null;
  evidence_note: string | null;
  operator_name: string | null;
  warehouse_name: string;
  zone_name: string;
  location_name: string;
  location_code: string;
};
type WarehousePackageLabelRow = {
  id: string;
  cargo_item_id: string | null;
  line_no: number | null;
  cargo_name_cn: string | null;
  package_number: string;
  barcode: string;
  pieces: number;
  weight_kg: number | null;
  volume_cbm: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  status: string;
  warehouse_name: string | null;
  zone_name: string | null;
  location_name: string | null;
  location_code: string | null;
  created_at: string;
};
function warehousePackageTypeLabel(value: string) {
  const labels: Record<string, string> = {
    carton: "纸箱",
    pallet: "托盘",
    wooden_case: "木箱",
    bag: "袋装",
    drum: "桶装",
    bundle: "捆装",
    other: "其他",
    mixed: "混合包装",
  };
  return labels[value] || value;
}
function warehousePackageTypesLabel(value: string | null) {
  if (!value) return "—";
  return value.split(",").map((item) => warehousePackageTypeLabel(item)).join("、");
}
function warehousePackageStatusText(status: string) {
  const labels: Record<string, string> = {
    in_stock: "在库",
    allocated: "已分配待出库",
    dispatched: "已出库",
    exception: "异常冻结",
    picked_up: "已提货",
    cancelled: "已作废",
  };
  return labels[status] || status;
}
type LoadingCandidate = {
  id: string;
  order_number: string;
  customer_name: string;
  status: string;
  order_date: string | null;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  package_count: number;
  exit_port: string;
  customs_location: string;
  route_code: string;
  domestic_warehouse_name: string;
  overseas_warehouse_name: string;
};

const assignmentNativeFieldKeys = new Set([
  "approval_result",
  "operator",
  "primary_operator",
  "module_assignees",
  "assignment_due_at",
  "assignment_notes",
  "assignment_scope",
  "pre_payable_expenses",
]);
const quotationStatusLabels: Record<string, string> = {
  draft: "草稿",
  sent: "待客户确认",
  accepted: "客户已接受",
  rejected: "客户已拒绝",
  cancelled: "已作废",
};
const orderStatusLabels: Record<string, string> = {
  draft: "草稿",
  submitted: "待审批",
  confirmed: "已审核，待派单",
  in_execution: "执行中",
  completed: "已完成",
  cancelled: "已取消",
};
const businessNatureLabels: Record<string, string> = {
  export: "出口",
  import: "进口",
  transit: "过境",
  domestic: "国内",
};

async function loadModuleWorkflowStageAccess(
  organizationId: string,
  orderId: string,
  moduleCode: OrderModuleCode,
) {
  const state = await env.DB.prepare(
    `SELECT wi.workflow_id,wi.current_step_key
     FROM workflow_instances wi
     WHERE wi.organization_id=? AND wi.order_id=?
     LIMIT 1`,
  )
    .bind(organizationId, orderId)
    .first<{ workflow_id: string; current_step_key: string | null }>();
  if (!state) return orderModuleWorkflowStageAccess(moduleCode, null, []);
  const steps = await env.DB.prepare(
    `SELECT step_key,name AS step_name,sort_order
     FROM workflow_steps
     WHERE workflow_id=? AND is_active=1
     ORDER BY sort_order,id`,
  )
    .bind(state.workflow_id)
    .all<{ step_key: string; step_name: string; sort_order: number }>();
  const configuredPlacement = await env.DB.prepare(
    `SELECT s.step_key
     FROM workflow_step_modules m
     JOIN workflow_steps s ON s.id=m.step_id AND s.workflow_id=m.workflow_id
     WHERE m.workflow_id=? AND m.module_code=? AND m.is_active=1 AND s.is_active=1
     ORDER BY s.sort_order,m.sort_order LIMIT 1`,
  ).bind(state.workflow_id,moduleCode).first<{step_key:string}>();
  const positions: WorkflowStepPosition[] = steps.results.map((step) => ({
    stepKey: step.step_key,
    stepName: step.step_name,
    sortOrder: step.sort_order,
  }));
  return orderModuleWorkflowStageAccess(
    moduleCode,
    state.current_step_key,
    positions,
    configuredPlacement?.step_key ?? null,
  );
}
type CustomsRecord = {
  id: string;
  clearance_stage: string;
  declaration_number: string | null;
  declaration_type: string | null;
  declaration_mode: string | null;
  document_provider: string | null;
  broker_name: string | null;
  broker_contact: string | null;
  cutoff_at: string | null;
  declared_at: string | null;
  released_at: string | null;
  transit_customs: number;
  inspection_required: number;
  inspection_notes: string | null;
  quarantine_required: number;
  quarantine_notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};
type CustomsDeclaration = {
  id: string;
  customs_record_id: string;
  clearance_stage: string;
  declaration_number: string;
  declaration_type: string;
  declaration_title: string;
  declaring_company: string;
  declared_at: string;
  declared_amount: number;
  currency: string;
  gross_weight_kg: number;
  released_at: string | null;
  status: string;
  is_deleted: number;
  is_redeclared: number;
  is_amended: number;
  is_inspected: number;
  change_reason: string | null;
  created_at: string;
  updated_at: string;
};
type TransportAssignment = {
  id: string;
  leg_type: string;
  carrier_name: string | null;
  vehicle_type: string | null;
  vehicle_count: number;
  loading_mode: string | null;
  plate_number: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  freight_amount: number;
  freight_currency: string;
  origin_location: string | null;
  destination_location: string | null;
  border_port: string | null;
  planned_departure_at: string | null;
  planned_arrival_at: string | null;
  status: string;
};
type Waybill = {
  id: string;
  waybill_number: string;
  shipper_name: string | null;
  consignee_name: string | null;
  documents_verified: number;
  accompanying_at: string | null;
  status: string;
};
type TrackingMilestone = {
  id: string;
  milestone_code: string;
  milestone_name: string;
  event_at: string;
  location: string | null;
  vehicle_reference: string | null;
  notes: string | null;
  visible_to_customer: number;
};
type ExpenseControl = {
  business_locked: number;
  finance_locked: number;
  business_locked_at: string | null;
  finance_locked_at: string | null;
  receivable_recorded_at: string | null;
  payable_recorded_at: string | null;
  closed_at: string | null;
  notes: string | null;
};
type OverseasOperation = {
  id: string | null;
  batch_id: string;
  batch_number: string;
  road_status: string;
  warehouse_id: string | null;
  warehouse_name: string | null;
  status: string | null;
  actual_arrival_at: string | null;
  notified_at: string | null;
  appointment_at: string | null;
  pickup_at: string | null;
  pickup_contact: string | null;
  pickup_proof_reference: string | null;
  notes: string | null;
  batch_order_count: number;
  picked_up_order_count: number;
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view"),
    orderId = params.orderId,
    moduleCode = params.moduleCode;
  await requireOrderAccess(current, orderId);
  const definition = orderModuleDefinition(moduleCode);
  if (!definition) throw new Response("订单模块不存在", { status: 404 });
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname.includes(`/admin/orders/${orderId}/modules/`)) {
    const stage = orderStageForModule(moduleCode);
    const query = new URLSearchParams({
      stage: stage?.code || "order_creation",
      module: moduleCode,
    });
    throw redirect(`/admin/orders/${orderId}?${query}#module-business-data`);
  }
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.order_date,o.quotation_id,q.quote_number,q.currency quotation_currency,q.subtotal quotation_subtotal,q.tax_amount quotation_tax_amount,q.total_amount quotation_total_amount,q.status quotation_status,
            COALESCE(q.customer_contact_name,o.shipper_contact) quotation_customer_contact_name,
            COALESCE(q.customer_contact_phone,o.shipper_phone) quotation_customer_contact_phone,
            salesperson.display_name quotation_salesperson_name,
            COALESCE(q.cargo_description,o.cargo_description) quotation_cargo_description,
            COALESCE(q.notes,o.special_instructions) quotation_notes,
            COALESCE(q.pieces,o.pieces) quotation_pieces,
            COALESCE(q.gross_weight_kg,o.gross_weight_kg) quotation_gross_weight_kg,
            q.estimated_length_cm quotation_length_cm,q.estimated_width_cm quotation_width_cm,
            q.estimated_height_cm quotation_height_cm,COALESCE(q.volume_cbm,o.volume_cbm) quotation_volume_cbm,
            q.valid_until quotation_valid_until,
            o.customer_id,c.name customer_name,o.customer_reference,o.shipper_name,o.shipper_contact,o.shipper_phone,
            o.pickup_address_id,pickup_address.label pickup_address_name,
            o.origin_country,o.origin_state,o.origin_city,o.origin_address,o.consignee_name,o.consignee_contact,o.consignee_phone,o.destination_country,o.destination_state,o.destination_city,o.destination_address,o.business_nature,o.business_type,o.transport_mode,o.transport_terms,o.trade_terms,o.exit_port,o.overseas_warehouse_id,ow.name overseas_warehouse_name,ow.code overseas_warehouse_code,ow.address overseas_warehouse_address,o.overseas_warehouse_address_note,o.transit_locations,o.customs_location,o.customs_clearance_mode,o.route_notes,o.requested_pickup_date,o.requested_delivery_date,o.cargo_ready_at,o.ro_agent,o.special_instructions,o.requires_transloading,o.requires_transit_customs,o.current_assignee_user_id,o.status
     FROM transport_orders o
     JOIN customers c ON c.id=o.customer_id
     LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
     LEFT JOIN users salesperson ON salesperson.id=COALESCE(q.salesperson_user_id,o.salesperson_user_id)
     LEFT JOIN customer_addresses pickup_address ON pickup_address.id=o.pickup_address_id AND pickup_address.customer_id=o.customer_id
     LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
     WHERE o.id=? AND o.organization_id=?`,
  )
    .bind(orderId, current.organizationId)
    .first<OrderSummary>();
  if (!order) throw new Response("订单不存在", { status: 404 });
  if (moduleCode === "tracking" && order.business_type === "ltl") {
    const activeBatch = await env.DB.prepare(
      `SELECT b.id
       FROM transport_batch_orders bo
       JOIN transport_batches b
         ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
       WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
         AND b.status!='cancelled' AND b.batch_number LIKE 'PZ-%'
       ORDER BY b.updated_at DESC
       LIMIT 1`,
    )
      .bind(current.organizationId, orderId)
      .first<{ id: string }>();
    if (activeBatch) {
      throw redirect(
        `/admin/loading/${activeBatch.id}?fromOrderId=${encodeURIComponent(orderId)}`,
      );
    }
  }
  if (moduleCode === "customs") {
    await syncCustomsModuleFromRecords(current.organizationId, orderId, current.userId);
  }
  if (moduleCode === "tracking" || moduleCode === "overseas_warehouse") {
    await syncBatchTrackingMilestonesFromOrder(current.organizationId, orderId, current.userId);
    await syncBatchStateFromTrackingMilestones(current.organizationId, orderId, current.userId);
  }
  if (moduleCode === "tracking") {
    await syncTrackingModuleFromMilestones(current.organizationId, orderId, current.userId);
  }
  if (moduleCode === "overseas_warehouse") {
    await syncOverseasOperationFromBatch(current.organizationId, orderId, current.userId);
    await reconcileOverseasOrderDeliveryState({
      organizationId: current.organizationId,
      orderId,
      actorUserId: current.userId,
    });
  }
  const modules = await listOrderModules(current.organizationId, orderId);
  const module = modules.find((item) => item.module_code === moduleCode);
  if (!module) throw new Response("订单模块不存在", { status: 404 });
  const taskFilter = moduleCode === "assignment" ? "" : "AND t.module_code=?";
  const taskBindings =
    moduleCode === "assignment"
      ? [orderId, current.organizationId]
      : [orderId, current.organizationId, moduleCode];
  const [members, tasks, history, cargo] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id,u.display_name,
              d.id department_id,d.name department_name,
              p.id position_id,p.name position_name
       FROM memberships m
       JOIN users u ON u.id=m.user_id
       JOIN departments d
         ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.status='active'
       JOIN positions p
         ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
        AND p.department_code=d.code
       WHERE m.organization_id=? AND m.status='active' AND u.status='active'
       ORDER BY d.sort_order,p.sort_order,u.display_name`,
    )
      .bind(current.organizationId)
      .all<Member>(),
    env.DB.prepare(
      `SELECT t.id,t.module_code,t.title,t.priority,t.status,u.display_name assignee_name,t.due_at,t.created_at FROM order_tasks t LEFT JOIN users u ON u.id=t.assignee_user_id WHERE t.order_id=? AND t.organization_id=? ${taskFilter} ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,t.created_at DESC`,
    )
      .bind(...taskBindings)
      .all<Task>(),
    env.DB.prepare(
      `SELECT h.id,h.action_name,h.from_step_code,h.to_step_name,u.display_name actor_name,h.notes,h.occurred_at FROM order_module_history h LEFT JOIN users u ON u.id=h.actor_user_id WHERE h.module_instance_id=? AND h.organization_id=? ORDER BY h.occurred_at DESC`,
    )
      .bind(module.id, current.organizationId)
      .all<History>(),
    env.DB.prepare(
      `SELECT i.id,i.cargo_name_cn,i.cargo_name_en,i.hs_code,i.overseas_hs_code,i.package_type,i.package_count,i.pieces_per_package,i.gross_weight_per_package_kg,i.net_weight_per_package_kg,i.length_cm,i.width_cm,i.height_cm,i.volume_per_package_cbm,i.declared_value,i.currency,i.origin_country,i.brand_model,i.marks,i.special_attributes,i.notes,(SELECT COUNT(*) FROM order_cargo_images img WHERE img.cargo_item_id=i.id) image_count FROM order_cargo_items i WHERE i.order_id=? AND i.organization_id=? ORDER BY i.line_no`,
    )
      .bind(orderId, current.organizationId)
      .all<Cargo>(),
  ]);
  const [attachments, bookings, batches, shipments] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id,a.file_name,a.content_type,a.size_bytes,a.created_at,m.document_category,m.description,m.public_to_customer,m.review_status FROM order_attachments a LEFT JOIN order_document_metadata m ON m.attachment_id=a.id WHERE a.order_id=? AND a.organization_id=? ORDER BY a.created_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<Attachment>(),
    env.DB.prepare(
      `SELECT b.id,b.booking_number,b.booking_type,c.name carrier_name,b.planned_departure_at,b.status FROM booking_records b LEFT JOIN carriers c ON c.id=b.carrier_id WHERE b.order_id=? AND b.organization_id=? ORDER BY b.created_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<Booking>(),
    env.DB.prepare(
      `SELECT b.id,b.carrier_id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.planned_departure_at,b.planned_arrival_at,b.border_port,b.transit_location,b.route_notes,b.status,b.road_status,c.name carrier_name,w.name warehouse_name,
              b.overseas_carrier_name,b.overseas_vehicle_type,b.overseas_vehicle_count,b.overseas_vehicle_plate,b.overseas_driver_name,b.overseas_driver_phone,
              (SELECT COUNT(*) FROM transport_batch_vehicles v WHERE v.batch_id=b.id AND v.status!='cancelled') vehicle_count,
              (SELECT COUNT(*) FROM transport_vehicle_loads l WHERE l.batch_id=b.id) load_count,
              (SELECT COUNT(*) FROM transport_batch_orders bo3 JOIN order_cargo_packages p ON p.order_id=bo3.order_id AND p.status!='cancelled' WHERE bo3.batch_id=b.id AND bo3.status!='removed') package_count,
              (SELECT COUNT(DISTINCT p.order_id) FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id WHERE l.batch_id=b.id) assigned_order_count,
              (SELECT COUNT(*) FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.status!='removed') order_count,
              (SELECT GROUP_CONCAT(o2.order_number, '、') FROM transport_batch_orders bo2 JOIN transport_orders o2 ON o2.id=bo2.order_id WHERE bo2.batch_id=b.id AND bo2.status!='removed') order_numbers
       FROM transport_batches b
       LEFT JOIN carriers c ON c.id=b.carrier_id
       LEFT JOIN warehouses w ON w.id=b.warehouse_id
       WHERE b.organization_id=? AND (b.order_id=? OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.order_id=? AND bo.status!='removed'))
       ORDER BY b.created_at DESC`,
    )
      .bind(current.organizationId, orderId, orderId)
      .all<Batch>(),
    env.DB.prepare(
      `SELECT s.id,s.shipment_number,s.status,s.current_location,(SELECT MAX(e.event_at) FROM shipment_events e WHERE e.shipment_id=s.id) last_event_at FROM shipments s WHERE s.order_id=? AND s.organization_id=? ORDER BY s.created_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<Shipment>(),
  ]);
  const [expenses, quotationCharges, services, carriers] = await Promise.all([
    env.DB.prepare(
      `SELECT id,source_type,direction,stage,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,tax_rate,tax_amount,occurred_on,is_internal,foreign_account_no,notes FROM business_expenses WHERE order_id=? AND organization_id=? ORDER BY created_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<Expense>(),
    order.quotation_id
      ? env.DB.prepare(
          `SELECT id,charge_code,description,quantity,unit_price,amount,exchange_rate
           FROM quotation_charges
           WHERE quotation_id=?
           ORDER BY sort_order,id`,
        )
          .bind(order.quotation_id)
          .all<QuoteCharge>()
      : Promise.resolve({ results: [] as QuoteCharge[] }),
    env.DB.prepare(
      `SELECT service_code,service_name,status FROM order_services WHERE order_id=? AND organization_id=? ORDER BY created_at`,
    )
      .bind(orderId, current.organizationId)
      .all<OrderService>(),
    env.DB.prepare(
      `SELECT id,carrier_scope,name,contact_name,contact_phone,contact_email FROM carriers WHERE organization_id=? AND status='active' ORDER BY name`,
    )
      .bind(current.organizationId)
      .all<Carrier>(),
  ]);
  const [carrierDrivers, carrierVehicles, warehouses, loadingCandidates] = await Promise.all([
    env.DB.prepare(
      `SELECT id,carrier_id,name,phone,license_number
       FROM carrier_drivers
       WHERE organization_id=? AND status='active'
       ORDER BY name`,
    )
      .bind(current.organizationId)
      .all<CarrierDriverOption>(),
    env.DB.prepare(
      `SELECT id,carrier_id,plate_number,vehicle_type
       FROM carrier_vehicles
       WHERE organization_id=? AND status='active'
       ORDER BY plate_number`,
    )
      .bind(current.organizationId)
      .all<CarrierVehicleOption>(),
    env.DB.prepare(
      `SELECT id,name,warehouse_role FROM warehouses WHERE organization_id=? AND status='active'
       ORDER BY CASE warehouse_role WHEN 'domestic_collection' THEN 1 WHEN 'port' THEN 2 ELSE 3 END,code,name`,
    )
      .bind(current.organizationId)
      .all<Warehouse>(),
    ["loading", "warehouse"].includes(moduleCode) && order.business_type === "ltl"
      ? env.DB.prepare(
          `SELECT o.id,o.order_number,c.name customer_name,o.status,o.order_date,
                  COALESCE(SUM(i.package_count*i.pieces_per_package),0) pieces,
                  COALESCE(SUM(i.package_count*i.gross_weight_per_package_kg),0) gross_weight_kg,
                  COALESCE(SUM(i.package_count*i.volume_per_package_cbm),0) volume_cbm,
                  COUNT(DISTINCT p.id) package_count,
                  o.exit_port,o.customs_location,o.route_notes route_code,
                  ow.name overseas_warehouse_name,
                  (SELECT w.name FROM warehouse_receipts wr
                   JOIN shipments ws ON ws.id=wr.shipment_id
                   JOIN warehouses w ON w.id=wr.warehouse_id
                   WHERE wr.organization_id=o.organization_id AND ws.order_id=o.id
                     AND wr.status='completed' AND wr.cargo_complete=1
                   ORDER BY wr.received_at DESC LIMIT 1) domestic_warehouse_name
           FROM transport_orders o
           JOIN customers c ON c.id=o.customer_id
           JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
           LEFT JOIN order_cargo_items i ON i.order_id=o.id AND i.organization_id=o.organization_id
           LEFT JOIN order_cargo_packages p ON p.order_id=o.id AND p.organization_id=o.organization_id AND p.status!='cancelled'
           WHERE o.organization_id=? AND o.id<>? AND o.business_type='ltl'
             AND o.status IN ('confirmed','in_execution')
             AND o.origin_country=? AND COALESCE(o.origin_state,'')=COALESCE(?,'') AND o.origin_city=?
              AND o.destination_country=? AND COALESCE(o.destination_state,'')=COALESCE(?,'') AND o.destination_city=?
              AND o.exit_port=? AND o.customs_location=?
              AND o.overseas_warehouse_id=?
              AND EXISTS(
                SELECT 1 FROM warehouse_receipts wr
                JOIN shipments ws ON ws.id=wr.shipment_id
                WHERE ws.order_id=o.id AND wr.status='completed' AND wr.cargo_complete=1
                  AND wr.warehouse_id=(
                    SELECT current_wr.warehouse_id
                    FROM warehouse_receipts current_wr
                    JOIN shipments current_ws ON current_ws.id=current_wr.shipment_id
                    WHERE current_wr.organization_id=? AND current_ws.order_id=?
                      AND current_wr.status='completed' AND current_wr.cargo_complete=1
                    ORDER BY current_wr.received_at DESC LIMIT 1
                  )
              )
             AND EXISTS(
               SELECT 1 FROM order_cargo_packages px
               WHERE px.organization_id=o.organization_id AND px.order_id=o.id AND px.status!='cancelled'
             )
             AND NOT EXISTS(
               SELECT 1 FROM transport_batch_orders bo
               JOIN transport_batches b ON b.id=bo.batch_id
               WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id
                 AND bo.status!='removed' AND b.status!='cancelled'
             )
           GROUP BY o.id,o.order_number,c.name,o.status,o.order_date,ow.name
           ORDER BY o.order_date,o.order_number
           LIMIT 12`,
        )
          .bind(
            current.organizationId,
            orderId,
            order.origin_country,
            order.origin_state,
            order.origin_city,
            order.destination_country,
            order.destination_state,
            order.destination_city,
            order.exit_port,
            order.customs_location,
            order.overseas_warehouse_id,
            current.organizationId,
            orderId,
          )
          .all<LoadingCandidate>()
      : Promise.resolve({ results: [] as LoadingCandidate[] }),
  ]);
  const [customsRecords, customsDeclarations, transportAssignments, waybills] = await Promise.all([
    env.DB.prepare(
      `SELECT id,clearance_stage,declaration_number,declaration_type,declaration_mode,document_provider,broker_name,broker_contact,cutoff_at,declared_at,released_at,transit_customs,inspection_required,inspection_notes,quarantine_required,quarantine_notes,status,created_at,updated_at FROM order_customs_records WHERE order_id=? AND organization_id=? ORDER BY clearance_stage,created_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<CustomsRecord>(),
    env.DB.prepare(
      `SELECT d.id,d.customs_record_id,r.clearance_stage,d.declaration_number,d.declaration_type,
              d.declaration_title,d.declaring_company,d.declared_at,d.declared_amount,d.currency,
              d.gross_weight_kg,d.released_at,d.status,d.is_deleted,d.is_redeclared,d.is_amended,
              d.is_inspected,d.change_reason,d.created_at,d.updated_at
       FROM order_customs_declarations d
       JOIN order_customs_records r ON r.id=d.customs_record_id AND r.organization_id=d.organization_id
       WHERE d.order_id=? AND d.organization_id=?
       ORDER BY CASE r.clearance_stage WHEN 'origin' THEN 1 WHEN 'transit' THEN 2 ELSE 3 END,d.created_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<CustomsDeclaration>(),
    env.DB.prepare(
      `SELECT a.id,a.leg_type,COALESCE(c.name,a.carrier_name) carrier_name,a.vehicle_type,a.vehicle_count,a.loading_mode,a.plate_number,a.driver_name,a.driver_phone,a.freight_amount,a.freight_currency,a.origin_location,a.destination_location,a.border_port,a.planned_departure_at,a.planned_arrival_at,a.status FROM order_transport_assignments a LEFT JOIN carriers c ON c.id=a.carrier_id WHERE a.order_id=? AND a.organization_id=? ORDER BY CASE a.leg_type WHEN 'first_mile' THEN 1 WHEN 'main' THEN 2 ELSE 3 END,a.created_at`,
    )
      .bind(orderId, current.organizationId)
      .all<TransportAssignment>(),
    env.DB.prepare(
      `SELECT id,waybill_number,shipper_name,consignee_name,documents_verified,accompanying_at,status FROM order_waybills WHERE order_id=? AND organization_id=? ORDER BY created_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<Waybill>(),
  ]);
  const [trackingMilestones, expenseControl, overseasOperation, expenseDirectionControls] = await Promise.all([
    env.DB.prepare(
      `SELECT id,milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer FROM order_tracking_milestones WHERE order_id=? AND organization_id=? ORDER BY event_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<TrackingMilestone>(),
    env.DB.prepare(
      `SELECT business_locked,finance_locked,business_locked_at,finance_locked_at,receivable_recorded_at,payable_recorded_at,closed_at,notes FROM order_expense_controls WHERE order_id=? AND organization_id=?`,
    )
      .bind(orderId, current.organizationId)
      .first<ExpenseControl>(),
    env.DB.prepare(
      `SELECT op.id,op.batch_id,b.batch_number,b.road_status,op.warehouse_id,w.name warehouse_name,op.status,
              COALESCE(op.batch_id,b.id) batch_id,
              op.actual_arrival_at,op.notified_at,op.appointment_at,op.pickup_at,op.pickup_contact,
              op.pickup_proof_reference,op.notes,
              (SELECT COUNT(*) FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.status!='removed') batch_order_count,
              (SELECT COUNT(*) FROM overseas_warehouse_operations x WHERE x.batch_id=b.id AND x.status='picked_up') picked_up_order_count
       FROM transport_batch_orders bo
       JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
       LEFT JOIN overseas_warehouse_operations op ON op.batch_id=b.id AND op.order_id=bo.order_id AND op.organization_id=bo.organization_id
       LEFT JOIN warehouses w ON w.id=COALESCE(op.warehouse_id,?) AND w.organization_id=bo.organization_id
       WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND b.status!='cancelled'
       ORDER BY b.created_at DESC LIMIT 1`,
    )
      .bind(order.overseas_warehouse_id, current.organizationId, orderId)
      .first<OverseasOperation>(),
    env.DB.prepare(
      `SELECT direction,confirmed,business_reviewed,finance_reviewed,business_locked,finance_locked
       FROM order_expense_direction_controls WHERE organization_id=? AND order_id=? ORDER BY direction`,
    )
      .bind(current.organizationId, orderId)
      .all<ExpenseDirectionControl>(),
  ]);
  const warehouseFlow = moduleCode === "warehouse"
    ? await (async () => {
        const [operation, inboundTimes, packageStatuses, receipts] = await Promise.all([
        env.DB.prepare(
          `SELECT
             EXISTS(SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=? AND s.order_id=?) received,
             EXISTS(SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=? AND s.order_id=? AND r.status='completed' AND r.cargo_complete=1) inbound_ready,
             (SELECT d.status FROM warehouse_dispatches d JOIN shipments s ON s.id=d.shipment_id WHERE d.organization_id=? AND s.order_id=? ORDER BY d.created_at DESC LIMIT 1) dispatch_status,
             (SELECT COUNT(*) FROM warehouse_receipt_differences rd WHERE rd.organization_id=? AND rd.order_id=? AND rd.status='pending') pending_difference_count,
             (SELECT MAX(max_difference_percent) FROM warehouse_receipt_differences rd WHERE rd.organization_id=? AND rd.order_id=? AND rd.status='pending') max_difference_percent`,
        ).bind(current.organizationId,orderId,current.organizationId,orderId,current.organizationId,orderId,current.organizationId,orderId,current.organizationId,orderId).first<{received:number;inbound_ready:number;dispatch_status:string|null;pending_difference_count:number;max_difference_percent:number|null}>(),
        env.DB.prepare(
          `SELECT MIN(r.received_at) first_inbound_at,MAX(r.received_at) last_inbound_at,COUNT(DISTINCT r.id) receipt_count
           FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id
           WHERE r.organization_id=? AND s.order_id=? AND r.status!='cancelled'`,
        ).bind(current.organizationId,orderId).first<{first_inbound_at:string|null;last_inbound_at:string|null;receipt_count:number}>(),
        env.DB.prepare(
          `SELECT p.status,
                  COUNT(*) package_count,
                  (SELECT COUNT(*) FROM warehouse_package_movements m WHERE m.organization_id=p.organization_id AND m.package_id=p.id AND m.operation_type='move') move_count
           FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id
           WHERE p.organization_id=? AND s.order_id=?
           GROUP BY p.status`,
        ).bind(current.organizationId,orderId).all<{status:string;package_count:number;move_count:number}>(),
        env.DB.prepare(
          `SELECT r.id,r.receipt_number,r.received_at,r.cargo_complete,r.has_exception,r.exception_notes,
                  r.total_packages,r.total_pieces,r.total_weight_kg,r.total_volume_cbm,r.notes,r.evidence_note,
                  u.display_name operator_name,w.name warehouse_name,z.name zone_name,
                  l.name location_name,l.code location_code
             FROM warehouse_receipts r
             JOIN shipments s ON s.id=r.shipment_id AND s.organization_id=r.organization_id
             JOIN warehouses w ON w.id=r.warehouse_id AND w.organization_id=r.organization_id
             JOIN warehouse_locations l ON l.id=r.location_id AND l.organization_id=r.organization_id
             JOIN warehouse_zones z ON z.id=l.zone_id AND z.organization_id=r.organization_id
             LEFT JOIN users u ON u.id=r.received_by_user_id
            WHERE r.organization_id=? AND s.order_id=? AND r.status='completed'
            ORDER BY r.received_at DESC,r.id DESC`,
         ).bind(current.organizationId,orderId).all<WarehouseReceiptDetail>(),
        ]);
        const [cargoActuals, packageLabels, loadPlan] = await Promise.all([
         env.DB.prepare(
          `SELECT i.id cargo_item_id,
                  COUNT(r.id) actual_record_count,
                  SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_packages END) actual_packages,
                  SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_pieces END) actual_pieces,
                  SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_weight_kg END) actual_weight_kg,
                  SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_volume_cbm END) actual_volume_cbm,
                  GROUP_CONCAT(DISTINCT CASE WHEN r.id IS NOT NULL THEN printf('%g × %g × %g',ri.actual_length_cm,ri.actual_width_cm,ri.actual_height_cm) END) actual_dimensions,
                  GROUP_CONCAT(DISTINCT CASE WHEN r.id IS NOT NULL THEN r.package_type END) actual_package_types,
                  GROUP_CONCAT(DISTINCT CASE WHEN r.id IS NOT NULL THEN r.receipt_number END) receipt_numbers,
                  MIN(CASE WHEN r.id IS NOT NULL THEN r.received_at END) first_received_at,
                  MAX(CASE WHEN r.id IS NOT NULL THEN r.received_at END) last_received_at
             FROM order_cargo_items i
             LEFT JOIN warehouse_receipt_items ri
               ON ri.cargo_item_id=i.id AND ri.organization_id=i.organization_id
             LEFT JOIN warehouse_receipts r
               ON r.id=ri.receipt_id AND r.organization_id=ri.organization_id
              AND r.status='completed'
            WHERE i.organization_id=? AND i.order_id=?
            GROUP BY i.id
            ORDER BY i.line_no,i.id`,
        ).bind(current.organizationId,orderId).all<WarehouseCargoActual>(),
        env.DB.prepare(
          `SELECT p.id,p.cargo_item_id,i.line_no,i.cargo_name_cn,p.package_number,p.barcode,
                  p.pieces,p.weight_kg,p.volume_cbm,p.length_cm,p.width_cm,p.height_cm,p.status,
                  w.name warehouse_name,z.name zone_name,l.name location_name,l.code location_code,p.created_at
             FROM warehouse_packages p
             JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
             LEFT JOIN order_cargo_items i ON i.id=p.cargo_item_id AND i.organization_id=p.organization_id
             LEFT JOIN warehouses w ON w.id=p.warehouse_id AND w.organization_id=p.organization_id
             LEFT JOIN warehouse_locations l ON l.id=p.location_id AND l.organization_id=p.organization_id
             LEFT JOIN warehouse_zones z ON z.id=l.zone_id AND z.organization_id=p.organization_id
            WHERE p.organization_id=? AND s.order_id=?
            ORDER BY COALESCE(i.line_no,9999),p.created_at,p.package_number,p.id`,
         ).bind(current.organizationId,orderId).all<WarehousePackageLabelRow>(),
         checkOrderLoadPlan(current.organizationId, orderId),
        ]);
        return {
          received:Boolean(operation?.received),
          inboundReady:Boolean(operation?.inbound_ready),
          loadPlanReady:loadPlan.ready,
          loadPlanReasons:loadPlan.reasons,
          dispatchStatus:operation?.dispatch_status ?? null,
          pendingDifferenceCount:operation?.pending_difference_count ?? 0,
          maxDifferencePercent:operation?.max_difference_percent ?? null,
          firstInboundAt:inboundTimes?.first_inbound_at ?? null,
          lastInboundAt:inboundTimes?.last_inbound_at ?? null,
          receiptCount:inboundTimes?.receipt_count ?? 0,
          packageStatuses:packageStatuses.results,
          receipts:receipts.results,
          cargoActuals:cargoActuals.results,
          packageLabels:packageLabels.results,
        };
      })()
    : null;
  const warehouseActuals = moduleCode === "loading"
    ? await env.DB.prepare(
        `SELECT
                (SELECT COUNT(DISTINCT r.id)
                   FROM warehouse_receipts r
                   JOIN shipments s ON s.id=r.shipment_id
                  WHERE r.organization_id=? AND s.order_id=? AND r.status='completed') receipt_count,
                (SELECT COUNT(*)
                   FROM warehouse_packages p
                   JOIN shipments s ON s.id=p.shipment_id
                  WHERE p.organization_id=? AND s.order_id=?) actual_packages,
                COALESCE((SELECT SUM(p.pieces)
                   FROM warehouse_packages p
                   JOIN shipments s ON s.id=p.shipment_id
                  WHERE p.organization_id=? AND s.order_id=?),0) actual_pieces,
                COALESCE((SELECT SUM(p.weight_kg)
                   FROM warehouse_packages p
                   JOIN shipments s ON s.id=p.shipment_id
                  WHERE p.organization_id=? AND s.order_id=?),0) actual_weight_kg,
                COALESCE((SELECT SUM(p.volume_cbm)
                   FROM warehouse_packages p
                   JOIN shipments s ON s.id=p.shipment_id
                  WHERE p.organization_id=? AND s.order_id=?),0) actual_volume_cbm,
                EXISTS(
                  SELECT 1 FROM warehouse_receipts rx
                  JOIN shipments sx ON sx.id=rx.shipment_id
                  WHERE sx.order_id=? AND rx.organization_id=?
                    AND rx.status='completed' AND rx.cargo_complete=1
                ) counting_completed
        `,
      )
        .bind(
          current.organizationId, orderId,
          current.organizationId, orderId,
          current.organizationId, orderId,
          current.organizationId, orderId,
          current.organizationId, orderId,
          orderId, current.organizationId,
        )
        .first<{
          receipt_count: number;
          actual_packages: number;
          actual_pieces: number;
          actual_weight_kg: number;
          actual_volume_cbm: number;
          counting_completed: number;
        }>()
    : null;
  const warehouseDispatches = moduleCode === "loading"
    ? await env.DB.prepare(
        `SELECT d.id,d.dispatch_number,d.status,d.vehicle_plate,d.driver_name,d.carrier_name,d.notes,
                COUNT(DISTINCT di.id) item_count,
                COUNT(DISTINCT CASE WHEN di.status='loaded' THEN di.id END) loaded_count,
                d.created_at,d.dispatched_at,creator.display_name creator_name,dispatcher.display_name dispatcher_name
           FROM warehouse_dispatches d
           JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
           JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
           JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
           LEFT JOIN users creator ON creator.id=d.created_by_user_id
           LEFT JOIN users dispatcher ON dispatcher.id=d.dispatched_by_user_id
          WHERE d.organization_id=? AND s.order_id=? AND d.status!='cancelled'
          GROUP BY d.id
          ORDER BY d.created_at DESC`,
      )
        .bind(current.organizationId, orderId)
        .all<WarehouseDispatchReport>()
    : { results: [] as WarehouseDispatchReport[] };
  const loadingReferences = moduleCode === "loading"
    ? await Promise.all(
        ["border_port", "customs_place", "transit_place", "route"].map((category) =>
          env.DB.prepare(
            "SELECT code,name FROM reference_data WHERE organization_id=? AND category=? AND status='active' ORDER BY sort_order,code",
          )
            .bind(current.organizationId, category)
            .all<ReferenceOption>(),
        ),
      ).then(([borderPorts, customsPlaces, transitPlaces, routes]) => ({
        borderPorts: borderPorts.results,
        customsPlaces: customsPlaces.results,
        transitPlaces: transitPlaces.results,
        routes: routes.results,
      }))
    : { borderPorts: [], customsPlaces: [], transitPlaces: [], routes: [] };
  const orderReview = moduleCode === "review"
    ? await loadOrderReview(env.DB, current.organizationId, orderId)
    : null;
  const trackingDepartureGate =
    moduleCode === "tracking"
      ? await checkOrderDeparture(current.organizationId, orderId)
      : null;
  const workflowFields = await loadOrderModuleWorkflowFields(
    current.organizationId,
    orderId,
    definition.code,
  );
  const quotationCostWorkflowFields = definition.code === "consignment"
    ? await loadOrderModuleWorkflowFields(current.organizationId, orderId, "costs")
    : [];
  const workflowStageAccess = await loadModuleWorkflowStageAccess(
    current.organizationId,
    orderId,
    definition.code,
  );
  const baseAccess = orderModuleAccess(order.status, moduleCode);
  const dynamicStageEdit = workflowStageAccess.customPlacement &&
    workflowStageAccess.available && !["completed","cancelled"].includes(order.status);
  const policyRemediationEdit = workflowFields.some(
    (field)=>field.isActive && field.isRequired && !field.present,
  ) && !["completed","cancelled"].includes(order.status);
  return {
    current,
    order,
    access: {
      ...baseAccess,
      canEdit: (baseAccess.canEdit || dynamicStageEdit || policyRemediationEdit) && workflowStageAccess.available,
      reason: workflowStageAccess.reason || (dynamicStageEdit || policyRemediationEdit ? null : baseAccess.reason),
    },
    workflowStageAccess,
    module,
    definition,
    modules,
    members: members.results,
    tasks: tasks.results,
    history: history.results,
    cargo: cargo.results,
    attachments: attachments.results,
    bookings: bookings.results,
    batches: batches.results,
    shipments: shipments.results,
    expenses: expenses.results,
    quotationCharges: quotationCharges.results,
    services: services.results,
    carriers: carriers.results,
    carrierDrivers: carrierDrivers.results,
    carrierVehicles: carrierVehicles.results,
    warehouses: warehouses.results,
    loadingCandidates: loadingCandidates.results,
    customsRecords: customsRecords.results,
    customsDeclarations: customsDeclarations.results,
    transportAssignments: transportAssignments.results,
    waybills: waybills.results,
    trackingMilestones: trackingMilestones.results,
    expenseControl: expenseControl ?? null,
    overseasOperation: overseasOperation ?? null,
    expenseDirectionControls: expenseDirectionControls.results,
    warehouseFlow,
    warehouseActuals,
    warehouseDispatches: warehouseDispatches.results,
    loadingReferences,
    orderReview,
    trackingDepartureGate,
    workflowFields,
    quotationCostWorkflowFields,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "order.view"),
    orderId = params.orderId,
    moduleCode = params.moduleCode,
    form = await request.formData(),
    intent = valueOf(form, "intent");
  await requireOrderAccess(current, orderId);
  const expenseEntryContext = valueOf(form, "expenseEntryContext");
  const expensePolicyModuleCode =
    intent === "expense_add" && canCreateExpenseFromModule(moduleCode, expenseEntryContext)
      ? "costs"
      : moduleCode;
  if (!orderModuleDefinition(moduleCode)) return { formError: "模块不存在" };
  if (
    moduleCode === "loading" &&
    ["document_upload", "document_review", "document_metadata_update"].includes(intent)
  ) {
    return { formError: "装车出库前文件由仓库端上传并确认，管理后台仅同步查看" };
  }
  const isConsignmentApprovalAction =
    moduleCode === "consignment" &&
    intent === "workflow_action" &&
    valueOf(form, "actionCode") === "approve";
  const order = await env.DB.prepare(
    `SELECT status,business_type,shipper_name,origin_country,origin_state,origin_city,origin_address,
            consignee_name,destination_country,destination_state,destination_city,destination_address,
            exit_port,transit_locations,customs_location,route_notes,overseas_warehouse_id,
            requires_transloading,requires_transit_customs,current_assignee_user_id
     FROM transport_orders WHERE id=? AND organization_id=?`,
  )
    .bind(orderId, current.organizationId)
    .first<{
      status:string;business_type:string;shipper_name:string;origin_country:string;origin_state:string|null;origin_city:string;origin_address:string;
      consignee_name:string;destination_country:string;destination_state:string|null;destination_city:string;destination_address:string;
      exit_port:string|null;transit_locations:string|null;customs_location:string|null;route_notes:string|null;overseas_warehouse_id:string|null;
      requires_transloading:number;requires_transit_customs:number;current_assignee_user_id:string|null;
    }>();
  if (!order) return { formError: "订单不存在" };
  const isConsignmentDocumentReviewAction =
    ["consignment", "documents"].includes(moduleCode) &&
    intent === "document_review";
  const workflowAdministrator = canEditWorkflowDefinitionInUi(current);
  const isAssignedConsignmentApprover = isAssignedOrderApprover({
    status: order.status,
    currentAssigneeUserId: order.current_assignee_user_id,
    currentUserId: current.userId,
  }) || (workflowAdministrator && order.status === "submitted");
  const canApproveConsignment =
    (isConsignmentApprovalAction || isConsignmentDocumentReviewAction) &&
    isAssignedConsignmentApprover;
  if (!canManageOrderModule(current, moduleCode) && !canApproveConsignment && !workflowAdministrator) {
    return { formError: "当前岗位可以查看本模块，但没有提交业务操作的权限" };
  }
  const moduleWorkflowFields = await loadOrderModuleWorkflowFields(
    current.organizationId,
    orderId,
    moduleCode as Parameters<typeof loadOrderModuleWorkflowFields>[2],
  );
  const expenseValidationWorkflowFields = expensePolicyModuleCode === moduleCode
    ? moduleWorkflowFields
    : await loadOrderModuleWorkflowFields(
      current.organizationId,
      orderId,
      expensePolicyModuleCode as Parameters<typeof loadOrderModuleWorkflowFields>[2],
    );
  const fieldPolicy = (fieldKey: string, fallbackRequired = false) =>
    workflowFieldPolicy(expenseValidationWorkflowFields, fieldKey, fallbackRequired);
  const requiredFieldMissing = (
    fieldKey: string,
    value: unknown,
    fallbackRequired = false,
  ) => {
    const policy = fieldPolicy(fieldKey, fallbackRequired);
    return (
      policy.visible &&
      policy.required &&
      (value === null || value === undefined || String(value).trim() === "")
    );
  };
  const missingRequiredDocumentUploads = async (
    sourceModule: OrderModuleCode,
  ) => {
    const requiredPlacements = orderDocumentPlacements.filter(
      (placement) =>
        placement.moduleCode === sourceModule &&
        (sourceModule !== "customs" ||
          preDepartureDocumentTypeCodes.has(placement.documentCode)) &&
        fieldPolicy(
          placement.fieldKey,
          placement.requiredByDefault,
        ).visible &&
        fieldPolicy(
          placement.fieldKey,
          placement.requiredByDefault,
        ).required,
    );
    if (!requiredPlacements.length) return [];
    const uploaded = await env.DB.prepare(
      `SELECT DISTINCT document_category
       FROM order_document_metadata
       WHERE organization_id=? AND order_id=?
         AND review_status IN ('approved','archived')`,
    )
      .bind(current.organizationId, orderId)
      .all<{ document_category: string }>();
    const uploadedCodes = new Set(
      uploaded.results.map((item) => item.document_category),
    );
    return requiredPlacements
      .filter((placement) => !uploadedCodes.has(placement.documentCode))
      .map((placement) => orderDocumentTypeLabel(placement.documentCode));
  };
  const stageAccess = await loadModuleWorkflowStageAccess(
    current.organizationId,
    orderId,
    moduleCode as OrderModuleCode,
  );
  const access = orderModuleAccess(order.status, moduleCode);
  const dynamicStageEdit = stageAccess.customPlacement &&
    stageAccess.available && !["completed","cancelled"].includes(order.status);
  const policyRemediationEdit = (await missingRequiredModuleFields(
    current.organizationId,
    orderId,
    moduleCode as OrderModuleCode,
  )).length > 0 && !["completed","cancelled"].includes(order.status);
  const isSubmittedConsignmentApproval =
    canApproveConsignment && order.status === "submitted";
  if (!stageAccess.available && !isSubmittedConsignmentApproval)
    return { formError: stageAccess.reason || "当前业务阶段尚未开放本模块" };
  if (
    !access.canEdit && !dynamicStageEdit && !policyRemediationEdit &&
    !isSubmittedConsignmentApproval &&
    !(moduleCode === "review" && intent === "generate_order_review")
  )
    return { formError: access.reason || "当前订单状态不允许办理该模块" };
  if (intent === "workflow_action") {
    const actionCode = valueOf(form, "actionCode");
    if (moduleCode === "consignment" && actionCode === "approve") {
      const missingDocuments = await missingRequiredDocumentUploads("consignment");
      if (missingDocuments.length) return { formError: `请先审核通过：${missingDocuments.join("、")}` };
    }
    const result = await runOrderWorkflowAction({
      request,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      orderId,
      actionCode,
      assigneeUserId: valueOf(form, "assigneeUserId") || null,
      notes: valueOf(form, "notes"),
      bypassAssigneeRestriction: workflowAdministrator,
    });
    if (
      !("formError" in result) &&
      moduleCode === "consignment" &&
      actionCode === "approve"
    ) {
      return redirect(`/admin/orders/${orderId}`);
    }
    if (!("formError" in result) && moduleCode === "consignment" && actionCode === "submit") {
      return redirect(`/admin/orders/${orderId}`);
    }
    return result;
  }
  if (intent === "advance" && order.business_type === "ltl" && moduleCode === "loading")
    return { formError: "零担订单的拼车配载由配载批次操作自动推进" };
  try {
    if (intent === "workflow_field_save") {
      await saveOrderCustomWorkflowFieldValue({
        organizationId: current.organizationId,
        orderId,
        fieldId: valueOf(form, "fieldId"),
        value: valueOf(form, "fieldValue"),
        actorUserId: current.userId,
      });
      await syncOrderWorkflowSnapshot(current.organizationId, orderId);
      return { success: "字段已保存，必填状态已重新检查" };
    }
    if (intent === "loading_route_select" && moduleCode === "loading") {
      const businessType = order.business_type;
      const exitPort = valueOf(form, "exitPort");
      const customsLocation = valueOf(form, "customsLocation");
      const transitLocations = valueOf(form, "transitLocations");
      const routeCode = valueOf(form, "routeCode");
      if (!["ftl", "ltl"].includes(businessType))
        return { formError: "整车/拼车未从报价固定，无法继续该节点" };
      if (!exitPort || !customsLocation)
        return { formError: "请选择出境口岸和清关地" };
      const referenceRows = await env.DB.prepare(
        `SELECT category,code FROM reference_data
         WHERE organization_id=? AND status='active'
           AND category IN ('border_port','customs_place','transit_place')`,
      )
        .bind(current.organizationId)
        .all<{ category: string; code: string }>();
      const referenceValid = (category: string, value: string) =>
        referenceRows.results.some((item) => item.category === category && item.code === value);
      if (!referenceValid("border_port", exitPort)) return { formError: "请选择基础数据中启用的出境口岸" };
      if (!referenceValid("customs_place", customsLocation)) return { formError: "请选择基础数据中启用的清关地" };
      if (transitLocations && !referenceValid("transit_place", transitLocations))
        return { formError: "请选择基础数据中启用的中转地" };
      const counting = await env.DB.prepare(
        `SELECT EXISTS(
           SELECT 1 FROM warehouse_sorting_batches b
           JOIN shipments s ON s.id=b.shipment_id
           WHERE b.organization_id=? AND s.order_id=? AND b.status='verified'
         ) ready`,
      )
        .bind(current.organizationId, orderId)
        .first<{ ready: number }>();
      if (!counting?.ready)
        return { formError: "仓库尚未完成收货清点与齐套复核，暂不能提交配载/装车参数" };
      const linkedBatch = await env.DB.prepare(
        `SELECT b.id,COUNT(DISTINCT bo2.order_id) order_count
         FROM transport_batch_orders bo
         JOIN transport_batches b ON b.id=bo.batch_id AND b.status!='cancelled'
         LEFT JOIN transport_batch_orders bo2 ON bo2.batch_id=b.id AND bo2.status!='removed'
         WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
         GROUP BY b.id
         ORDER BY b.created_at DESC
         LIMIT 1`,
      )
        .bind(current.organizationId, orderId)
        .first<{ id: string; order_count: number }>();
      const preparationChanged =
        exitPort !== (order.exit_port || "") ||
        customsLocation !== (order.customs_location || "") ||
        routeCode !== (order.route_notes || "") ||
        transitLocations !== (order.transit_locations || "");
      if (linkedBatch && linkedBatch.order_count > 1 && preparationChanged) {
        return { formError: "本订单已进入正式PZ配载单。请先执行重新配载，不能只修改其中一票的线路参数" };
      }
      const now = new Date().toISOString();
      const moduleRow = await env.DB.prepare(
        "SELECT id,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='loading'",
      )
        .bind(current.organizationId, orderId)
        .first<{ id: string; current_step_code: string | null }>();
      if (!moduleRow) return { formError: "配载选择模块尚未初始化，请刷新页面后重试" };
      const statements = [
        env.DB.prepare(
          `UPDATE transport_orders
           SET exit_port=?,customs_location=?,transit_locations=?,route_notes=?,updated_at=?
           WHERE organization_id=? AND id=?`,
        ).bind(
          exitPort,
          customsLocation,
          transitLocations || null,
          routeCode,
          now,
          current.organizationId,
          orderId,
        ),
        env.DB.prepare(
          `UPDATE order_module_instances
           SET enabled=1,status='in_progress',current_step_code='selecting',current_step_name=?,
               progress_percent=25,started_at=COALESCE(started_at,?),completed_at=NULL,
               blocking_reason=NULL,updated_at=? WHERE id=?`,
        ).bind(
          businessType === "ltl" ? "已选择拼车" : "已选择整车",
          now,
          now,
          moduleRow.id,
        ),
        env.DB.prepare(
          `INSERT INTO order_module_history(
            id,organization_id,order_id,module_instance_id,action_code,action_name,
            from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          crypto.randomUUID(), current.organizationId, orderId, moduleRow.id,
          "loading_route_select", "填写装车参数", moduleRow.current_step_code,
          "selecting", businessType === "ltl" ? "已选择拼车" : "已选择整车",
          current.userId, `依据仓库实收数据确定${businessType === "ltl" ? "拼车" : "整车"}；口岸 ${exitPort}；清关地 ${customsLocation}；线路 ${routeCode || "未填写"}`, now,
        ),
      ];
      if (linkedBatch) {
        statements.push(
          env.DB.prepare(
            `UPDATE transport_batches
             SET border_port=?,customs_location=?,transit_location=?,route_notes=?,updated_at=?
             WHERE id=? AND organization_id=?`,
          ).bind(
            exitPort,
            customsLocation,
            transitLocations || null,
            routeCode,
            now,
            linkedBatch.id,
            current.organizationId,
          ),
        );
      }
      await env.DB.batch(statements);
      if (businessType === "ftl") {
        await ensureFtlPlanningBatch(current.organizationId, orderId, current.userId);
      }
      await ensureOrderModules(current.organizationId, orderId);
      await syncOrderWorkflowSnapshot(current.organizationId, orderId);
      return {
        success: businessType === "ltl"
          ? "已读取报价类型为拼车，当前页面已开放可配载订单工作台"
          : "已读取报价类型为整车，下一步请安排车辆并完成装车出库交接",
      };
    }
    if (intent === "outbound_transport_resource_save" && moduleCode === "loading") {
      const batchId = valueOf(form, "batchId");
      const carrierId = valueOf(form, "carrierId");
      const vehicleMasterId = valueOf(form, "vehicleMasterId");
      const driverMasterId = valueOf(form, "driverMasterId");
      const overseasVehicleCount = Math.max(1, Number(valueOf(form, "overseasVehicleCount") || 1));
      if (!batchId || !carrierId || !vehicleMasterId || !driverMasterId)
        return { formError: "请选择境外承运商及其名下车辆和司机" };
      const [carrier, vehicle, driver] = await Promise.all([
        env.DB.prepare("SELECT id,name FROM carriers WHERE id=? AND organization_id=? AND status='active' AND carrier_scope='overseas'")
          .bind(carrierId, current.organizationId).first<{ id: string; name: string }>(),
        env.DB.prepare("SELECT id,plate_number,vehicle_type FROM carrier_vehicles WHERE id=? AND carrier_id=? AND organization_id=? AND status='active'")
          .bind(vehicleMasterId, carrierId, current.organizationId).first<{ id: string; plate_number: string; vehicle_type: string | null }>(),
        env.DB.prepare("SELECT id,name,phone FROM carrier_drivers WHERE id=? AND carrier_id=? AND organization_id=? AND status='active'")
          .bind(driverMasterId, carrierId, current.organizationId).first<{ id: string; name: string; phone: string | null }>(),
      ]);
      if (!carrier || !vehicle || !driver)
        return { formError: "所选境外承运商、车辆或司机已停用，请重新选择" };
      if (!vehicle.vehicle_type || !vehicle.plate_number || !driver.name || !driver.phone)
        return { formError: "所选车辆或司机主数据不完整，请先到承运商管理补齐车型、车牌和司机电话" };
      const overseasCarrierName = carrier.name;
      const overseasVehicleType = vehicle.vehicle_type;
      const overseasVehiclePlate = vehicle.plate_number.toUpperCase();
      const overseasDriverName = driver.name;
      const overseasDriverPhone = driver.phone;
      const linked = await env.DB.prepare(
        `SELECT 1 FROM transport_batch_orders
         WHERE organization_id=? AND batch_id=? AND order_id=? AND status!='removed'`,
      ).bind(current.organizationId, batchId, orderId).first();
      if (!linked) return { formError: "当前装车单与订单不匹配，请刷新页面后重试" };
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE transport_batches
         SET carrier_id=?,overseas_carrier_name=?,overseas_vehicle_type=?,overseas_vehicle_count=?,
             overseas_vehicle_plate=?,overseas_driver_name=?,overseas_driver_phone=?,updated_at=?
         WHERE id=? AND organization_id=?`,
      ).bind(
        carrierId, overseasCarrierName, overseasVehicleType, overseasVehicleCount,
        overseasVehiclePlate, overseasDriverName, overseasDriverPhone,
        now, batchId, current.organizationId,
      ).run();
      if (order.business_type === "ftl") {
        await ensureFtlVehicleAndLoads({
          organizationId: current.organizationId,
          orderId,
          batchId,
          carrierId,
          vehicleMasterId,
          driverMasterId,
          carrierName: overseasCarrierName,
          vehicleType: overseasVehicleType,
          plateNumber: overseasVehiclePlate,
          driverName: overseasDriverName,
          driverPhone: overseasDriverPhone,
          actorUserId: current.userId,
          now,
        });
      }
      const linkedOrders = await linkedBatchOrderIds(current.organizationId, orderId);
      let failedSyncCount = 0;
      for (const linkedOrderId of linkedOrders) {
        try {
          await syncOrderWorkflowSnapshot(current.organizationId, linkedOrderId);
        } catch (error) {
          failedSyncCount += 1;
          console.error("Failed to synchronize an order workflow snapshot", {
            linkedOrderId,
            error,
          });
        }
      }
      return {
        success: failedSyncCount
          ? `境外承运方和车辆信息已保存；${failedSyncCount} 票订单的流程快照暂未同步，请稍后重试`
          : "境外承运方和车辆信息已保存，并同步到当前装车单的全部订单",
      };
    }
    if (intent === "generate_order_review" && moduleCode === "review") {
      const now = new Date().toISOString();
      const reviewValues = [
        ["customer_dispute_summary", valueOf(form, "customerDisputeSummary")],
        ["review_result", valueOf(form, "reviewConclusion")],
        ["review_improvements", valueOf(form, "improvementNotes")],
      ] as const;
      const missingReviewFields = reviewValues
        .filter(([fieldKey, value]) => requiredFieldMissing(fieldKey, value))
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingReviewFields.length)
        return { formError: `请填写当前模板要求的字段：${missingReviewFields.join("、")}` };
      const result = await generateOrderReview(env.DB, {
        organizationId: current.organizationId,
        orderId,
        userId: current.userId,
        now,
        customerDisputeSummary: valueOf(form, "customerDisputeSummary"),
        reviewConclusion: valueOf(form, "reviewConclusion"),
        improvementNotes: valueOf(form, "improvementNotes"),
      });
      await writeAudit({
        request,
        action: "order.review.generate",
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: {
          completionStatus: result.completionStatus,
          blockers: result.blockers.map((item) => item.code),
        },
      });
      return {
        success: result.blockers.length
          ? `复盘已生成，仍有 ${result.blockers.length} 项阻断，请按提示处理后重新生成`
          : `复盘已生成：${result.label}`,
      };
    }
    if (intent === "assign") {
      await assignOrderModule({
        organizationId: current.organizationId,
        orderId,
        moduleCode,
        assigneeUserId: valueOf(form, "assigneeUserId"),
        actorUserId: current.userId,
        dueAt: valueOf(form, "dueAt") || null,
        notes: valueOf(form, "notes"),
      });
      await writeAudit({
        request,
        action: "order.module.assign",
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: { moduleCode },
      });
      return {
        success: "模块负责人和任务已分配，请在任务分配页点击“确认派单”后推进订单状态。",
      };
    }
    if (intent === "assign_other" && moduleCode === "assignment") {
      const targetModuleCode = valueOf(form, "targetModuleCode");
      const targetDefinition = orderModuleDefinition(targetModuleCode);
      if (!targetDefinition) return { formError: "目标模块不存在" };
      const assigneeUserId = valueOf(form, "assigneeUserId");
      if (!assigneeUserId)
        return { formError: "请按部门、岗位选择具体个人账户" };
      const assignmentValues = [
        ["module_assignees", assigneeUserId],
        ["assignment_due_at", valueOf(form, "dueAt")],
        ["assignment_notes", valueOf(form, "notes")],
      ] as const;
      const missingAssignmentFields = assignmentValues
        .filter(([fieldKey, value]) => requiredFieldMissing(fieldKey, value))
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingAssignmentFields.length)
        return { formError: `请填写当前模板要求的字段：${missingAssignmentFields.join("、")}` };
      await assignOrderModule({
        organizationId: current.organizationId,
        orderId,
        moduleCode: targetModuleCode,
        assigneeUserId,
        actorUserId: current.userId,
        dueAt: valueOf(form, "dueAt") || null,
        notes: valueOf(form, "notes"),
      });
      await writeAudit({
        request,
        action: "order.module.assign",
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: {
          moduleCode: targetModuleCode,
          source: "assignment_center",
        },
      });
      return {
        success: `${targetDefinition.name}负责人已分配，请在任务分配页点击“确认派单”后推进订单状态。`,
      };
    }
    if (intent === "assign_bulk" && moduleCode === "assignment") {
      const assigneeUserId = valueOf(form, "assigneeUserId");
      if (!assigneeUserId)
        return { formError: "请按部门、岗位选择具体个人账户" };
      let targetCodes = Array.from(
        new Set(form.getAll("targetModuleCode").map(String).filter(Boolean)),
      );
      const modules = await listOrderModules(current.organizationId, orderId);
      if (!targetCodes.length && !fieldPolicy("assignment_scope").required)
        targetCodes = modules
          .filter((item) => item.enabled === 1 && item.module_code !== "assignment")
          .map((item) => item.module_code);
      const assignmentValues = [
        ["module_assignees", assigneeUserId],
        ["assignment_scope", targetCodes.length ? targetCodes.join(",") : ""],
        ["assignment_due_at", valueOf(form, "dueAt")],
        ["assignment_notes", valueOf(form, "notes")],
      ] as const;
      const missingAssignmentFields = assignmentValues
        .filter(([fieldKey, value]) => requiredFieldMissing(fieldKey, value))
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingAssignmentFields.length)
        return { formError: `请填写当前模板要求的字段：${missingAssignmentFields.join("、")}` };
      if (!targetCodes.length) return { formError: "当前没有可分配的模块" };
      const assignable = modules.filter(
        (item) =>
          item.enabled === 1 &&
          item.module_code !== "assignment" &&
          targetCodes.includes(item.module_code) &&
          !["completed", "not_applicable"].includes(item.status),
      );
      if (!assignable.length)
        return { formError: "选中的模块无需分配或已经完成" };
      for (const item of assignable) {
        await assignOrderModule({
          organizationId: current.organizationId,
          orderId,
          moduleCode: item.module_code,
          assigneeUserId,
          actorUserId: current.userId,
          dueAt: valueOf(form, "dueAt") || null,
          notes: valueOf(form, "notes"),
        });
      }
      await writeAudit({
        request,
        action: "order.module.assign.bulk",
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: {
          moduleCodes: assignable.map((item) => item.module_code),
          assigneeUserId,
        },
      });
      return { success: `已批量分配 ${assignable.length} 个模块，待确认派单后进度推进。` };
    }
    if (intent === "assign_manifest_confirm" && moduleCode === "assignment") {
      if (order.status !== "confirmed")
        return { formError: "订单当前状态不是“待派单”，无法确认派单" };
      const modules = await listOrderModules(current.organizationId, orderId);
      const dispatchModuleCodes = new Set(["transport", "tracking", "costs"]);
      const assignable = modules.filter(
        (item) =>
          item.enabled === 1 &&
          dispatchModuleCodes.has(item.module_code) &&
          !["completed", "not_applicable"].includes(item.status),
      );
      const selections = assignable.map((item) => ({
        module: item,
        assigneeUserId: valueOf(form, `moduleAssignee_${item.module_code}`),
      }));
      const missing = selections.filter((item) => !item.assigneeUserId);
      if (missing.length)
        return {
          formError: `请为以下业务模组选择具体负责人：${missing
            .map((item) => item.module.module_name)
            .join("、")}`,
        };
      const activeMemberIds = await listActiveOrganizationAssigneeIds(
        current.organizationId,
      );
      const invalid = selections.find((item) => !activeMemberIds.has(item.assigneeUserId));
      if (invalid)
        return { formError: `${invalid.module.module_name}选择的负责人不是当前组织有效成员` };
      const mainAssigneeUserId = valueOf(form, "assigneeUserId");
      if (!mainAssigneeUserId || !activeMemberIds.has(mainAssigneeUserId))
        return { formError: "请选择有效的主操作员" };

      for (const selection of selections) {
        await assignOrderModule({
          organizationId: current.organizationId,
          orderId,
          moduleCode: selection.module.module_code,
          assigneeUserId: selection.assigneeUserId,
          actorUserId: current.userId,
          dueAt: null,
          notes: valueOf(form, "notes"),
        });
      }
      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE order_module_instances SET assignee_user_id=?,blocking_reason=NULL,updated_at=? WHERE organization_id=? AND order_id=? AND module_code='assignment' AND enabled=1",
      )
        .bind(mainAssigneeUserId, now, current.organizationId, orderId)
        .run();
      const workflowResult = await runOrderWorkflowAction({
        request,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        orderId,
        actionCode: "dispatch",
        assigneeUserId: mainAssigneeUserId,
        notes: valueOf(form, "notes"),
        bypassAssigneeRestriction: canEditWorkflowDefinitionInUi(current),
        allowPendingAssignment: true,
        atomicStatements: [
          env.DB.prepare(
            "UPDATE order_module_instances SET status='completed',current_step_code='assigned',current_step_name='分配完成',progress_percent=100,assignee_user_id=?,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=? WHERE organization_id=? AND order_id=? AND module_code='assignment' AND enabled=1",
          ).bind(mainAssigneeUserId, now, now, now, current.organizationId, orderId),
          env.DB.prepare(
            "UPDATE order_tasks SET status='completed',completed_at=?,updated_at=? WHERE organization_id=? AND order_id=? AND module_code='assignment' AND status IN ('pending','in_progress')",
          ).bind(now, now, current.organizationId, orderId),
        ],
      });
      if ("formError" in workflowResult) return workflowResult;
      await writeAudit({
        request,
        action: "order.module.assignment.manifest_confirm",
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: {
          mainAssigneeUserId,
          assignments: selections.map((item) => ({
            moduleCode: item.module.module_code,
            assigneeUserId: item.assigneeUserId,
          })),
        },
      });
      return redirect(`/admin/orders/${orderId}`);
    }
    if (intent === "confirm_dispatch" && moduleCode === "assignment") {
      if (order.status !== "confirmed")
        return { formError: "订单当前状态不是“待派单”，无法确认派单" };
      const assigneeUserId = valueOf(form, "assigneeUserId");
      if (!assigneeUserId) return { formError: "请选择派单主负责人" };
      const modules = await listOrderModules(current.organizationId, orderId);
      const unassignedModules = modules.filter(
        (item) =>
          item.enabled === 1 &&
          item.module_code !== "assignment" &&
          !["completed", "not_applicable"].includes(item.status) &&
          !item.assignee_user_id,
      );
      if (unassignedModules.length)
        return {
          formError: `请先完成以下模块分配后再确认派单：${unassignedModules
            .map((item) => item.module_name)
            .join("、")}`,
        };
      if (!(await isActiveOrganizationAssignee(current.organizationId, assigneeUserId)))
        return { formError: "请选择部门、岗位下的有效个人账户" };
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE order_module_instances SET status='completed',current_step_code='assigned',current_step_name='分配完成',progress_percent=100,assignee_user_id=?,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=? WHERE organization_id=? AND order_id=? AND module_code='assignment' AND enabled=1",
        ).bind(
          assigneeUserId,
          now,
          now,
          now,
          current.organizationId,
          orderId,
        ),
        env.DB.prepare(
          "UPDATE order_tasks SET status='completed',completed_at=?,updated_at=? WHERE organization_id=? AND order_id=? AND module_code='assignment' AND status IN ('pending','in_progress')",
        ).bind(now, now, current.organizationId, orderId),
      ]);
      await writeAudit({
        request,
        action: "order.module.assignment.confirm_dispatch",
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: {
          assigneeUserId,
          status: "confirmed",
        },
      });
      return runOrderWorkflowAction({
        request,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        orderId,
        actionCode: "dispatch",
        assigneeUserId,
        notes: valueOf(form, "notes"),
      });
    }
    if (intent === "warehouse_difference_confirm" && moduleCode === "warehouse") {
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE warehouse_receipt_differences SET status='confirmed',fee_impact_confirmed=1,confirmed_by_user_id=?,confirmed_at=?,updated_at=? WHERE organization_id=? AND order_id=? AND status='pending'").bind(current.userId,now,now,current.organizationId,orderId),
        env.DB.prepare("UPDATE order_tasks SET status='completed',completed_at=?,updated_at=? WHERE organization_id=? AND order_id=? AND module_code='warehouse' AND task_type='warehouse_difference' AND status IN ('pending','in_progress')").bind(now,now,current.organizationId,orderId),
      ]);
      await writeAudit({request,action:"warehouse.actual.difference.confirm",resourceType:"transport_order",resourceId:orderId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{feeImpactConfirmed:true}});
      return { success: "仓库实收差异及费用影响已确认，结算阻断已解除" };
    }
    if (intent === "overseas_arrival" && moduleCode === "overseas_warehouse") {
      return { formError: "境外到仓不能在运营后台手工确认，请进入订单指定的境外目的仓扫码入库并完成清点" };
    }
    if (intent === "advance") {
      await advanceOrderModule({
        organizationId: current.organizationId,
        orderId,
        moduleCode,
        actorUserId: current.userId,
        notes: valueOf(form, "notes"),
      });
      await writeAudit({
        request,
        action: "order.module.advance",
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: { moduleCode },
      });
      return { success: "模块工作流已推进" };
    }
    if (intent === "task_complete") {
      const taskId = valueOf(form, "taskId"),
        now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE order_tasks SET status='completed',completed_at=?,updated_at=? WHERE id=? AND order_id=? AND organization_id=?",
      )
        .bind(now, now, taskId, orderId, current.organizationId)
        .run();
      return { success: "任务已完成" };
    }
    if (intent === "customs_declaration_save") {
      if (moduleCode !== "customs") return { formError: "只能在报关模块登记申报单" };
      const declarationId = valueOf(form, "declarationId") || null;
      const clearanceStage = valueOf(form, "clearanceStage") || "origin";
      if (!["origin", "transit", "destination"].includes(clearanceStage))
        return { formError: "报关作业阶段无效" };
      let declarationNumber = valueOf(form, "declarationNumber");
      let declarationType = valueOf(form, "declarationType");
      let declarationTitle = valueOf(form, "declarationTitle");
      let declaringCompany = valueOf(form, "declaringCompany");
      let declaredAt = valueOf(form, "declaredAt");
      const declaredAmount = Number(valueOf(form, "declaredAmount") || 0);
      let currency = valueOf(form, "currency").toUpperCase();
      const grossWeightKg = Number(valueOf(form, "grossWeightKg") || 0);
      const isDeleted = form.has("isDeleted");
      const changeReason = valueOf(form, "changeReason");
      const requestedStatus = valueOf(form, "status") || "declared";
      const declarationStatus = isDeleted ? "cancelled" : requestedStatus;
      if (!["declared", "released", "cancelled"].includes(declarationStatus))
        return { formError: "申报单状态无效" };
      const customsRequiredValues = [
        ["declaration_stage", clearanceStage, true],
        ["declaration_status", declarationStatus, true],
        ["declaration_number", declarationNumber, true],
        ["declaration_type", declarationType, true],
        ["declaration_title", declarationTitle, true],
        ["declaring_company", declaringCompany, true],
        ["declared_at", declaredAt, true],
        ["declared_amount", valueOf(form, "declaredAmount"), true],
        ["declaration_currency", currency, true],
        ["declaration_gross_weight", valueOf(form, "grossWeightKg"), true],
        ["declaration_change_reason", changeReason, false],
      ] as const;
      const missingCustomsFields = customsRequiredValues
        .filter(([fieldKey, value, fallback]) =>
          requiredFieldMissing(fieldKey, value, fallback),
        )
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingCustomsFields.length)
        return { formError: `请填写当前模板要求的字段：${missingCustomsFields.join("、")}` };
      if (!Number.isFinite(declaredAmount) || declaredAmount < 0 || !Number.isFinite(grossWeightKg) || grossWeightKg < 0)
        return { formError: "申报金额和毛重必须是大于等于 0 的数字" };
      if (
        isDeleted &&
        fieldPolicy("declaration_change_reason").visible &&
        !changeReason
      )
        return { formError: "删单时请填写变更原因" };
      let releasedAt = valueOf(form, "releasedAt") || null;
      if (
        declarationStatus === "released" &&
        requiredFieldMissing("customs_release", releasedAt, true)
      )
        return { formError: "确认放行前请填写放行日期" };
      if (declarationStatus === "released") {
        const missingDocuments = await missingRequiredDocumentUploads("customs");
        if (missingDocuments.length)
          return {
            formError: `确认报关放行前请先上传并审核：${missingDocuments.join("、")}`,
          };
      }
      const now = new Date().toISOString();
      declarationNumber ||= `AUTO-CUS-${orderId.slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;
      declarationType ||= "未配置";
      declarationTitle ||= "未配置";
      declaringCompany ||= "未配置";
      declaredAt ||= now;
      currency ||= "USD";
      if (declarationStatus === "released" && !releasedAt) releasedAt = now;
      let customsRecordId = valueOf(form, "customsRecordId") || null;
      if (customsRecordId) {
        const existingRecord = await env.DB.prepare(
          "SELECT id FROM order_customs_records WHERE id=? AND organization_id=? AND order_id=? AND clearance_stage=?",
        ).bind(customsRecordId, current.organizationId, orderId, clearanceStage).first<{ id: string }>();
        if (!existingRecord) return { formError: "所选报关任务不存在或阶段不一致" };
      } else {
        const existingRecord = await env.DB.prepare(
          "SELECT id FROM order_customs_records WHERE organization_id=? AND order_id=? AND clearance_stage=? AND status!='cancelled' ORDER BY created_at LIMIT 1",
        ).bind(current.organizationId, orderId, clearanceStage).first<{ id: string }>();
        customsRecordId = existingRecord?.id ?? crypto.randomUUID();
        if (!existingRecord) {
          await env.DB.prepare(
            `INSERT INTO order_customs_records(id,organization_id,order_id,clearance_stage,status,created_by_user_id,created_at,updated_at)
             VALUES(?,?,?,?,'draft',?,?,?)`,
          ).bind(customsRecordId, current.organizationId, orderId, clearanceStage, current.userId, now, now).run();
        }
      }
      try {
        if (declarationId) {
          const existing = await env.DB.prepare(
            "SELECT id FROM order_customs_declarations WHERE id=? AND organization_id=? AND order_id=?",
          ).bind(declarationId, current.organizationId, orderId).first<{ id: string }>();
          if (!existing) return { formError: "要更新的申报单不存在" };
          await env.DB.prepare(
            `UPDATE order_customs_declarations
             SET customs_record_id=?,declaration_number=?,declaration_type=?,declaration_title=?,declaring_company=?,
               declared_at=?,declared_amount=?,currency=?,gross_weight_kg=?,released_at=?,status=?,is_deleted=?,
               is_redeclared=?,is_amended=?,is_inspected=?,change_reason=?,updated_at=?
             WHERE id=? AND organization_id=? AND order_id=?`,
          ).bind(
            customsRecordId,declarationNumber,declarationType,declarationTitle,declaringCompany,
            declaredAt,declaredAmount,currency,grossWeightKg,declarationStatus === "released" ? releasedAt : null,
            declarationStatus,isDeleted ? 1 : 0,form.has("isRedeclared") ? 1 : 0,
            form.has("isAmended") ? 1 : 0,form.has("isInspected") ? 1 : 0,changeReason || null,
            now,declarationId,current.organizationId,orderId,
          ).run();
        } else {
          const id = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO order_customs_declarations(
               id,organization_id,order_id,customs_record_id,declaration_number,declaration_type,declaration_title,
               declaring_company,declared_at,declared_amount,currency,gross_weight_kg,released_at,status,is_deleted,
               is_redeclared,is_amended,is_inspected,change_reason,created_by_user_id,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).bind(
            id,current.organizationId,orderId,customsRecordId,declarationNumber,declarationType,declarationTitle,
            declaringCompany,declaredAt,declaredAmount,currency,grossWeightKg,
            declarationStatus === "released" ? releasedAt : null,declarationStatus,isDeleted ? 1 : 0,
            form.has("isRedeclared") ? 1 : 0,form.has("isAmended") ? 1 : 0,form.has("isInspected") ? 1 : 0,
            changeReason || null,current.userId,now,now,
          ).run();
        }
      } catch (error) {
        if (String(error).includes("UNIQUE")) return { formError: "同一订单的报关单号不能重复" };
        throw error;
      }
      await syncCustomsModuleFromRecords(current.organizationId, orderId, current.userId);
      await writeAudit({
        request,
        action: declarationId ? "order.customs_declaration.update" : "order.customs_declaration.create",
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: { declarationId, declarationNumber, clearanceStage, declarationStatus, isDeleted },
      });
      return { success: isDeleted ? "申报单已标记删单" : declarationStatus === "released" ? "申报单已确认放行" : "申报单已保存" };
    }
    if (intent === "customs_save") {
      if (moduleCode !== "customs") return { formError: "只能在报关模块登记" };
      const recordId = valueOf(form, "recordId") || null;
      const clearanceStage = valueOf(form, "clearanceStage") || "origin";
      if (!['origin', 'transit', 'destination'].includes(clearanceStage))
        return { formError: "报关作业阶段无效" };
      const now = new Date().toISOString();
      const customsStatus = valueOf(form, "status") || "draft";
      const declarationNumber = valueOf(form, "declarationNumber");
      if (["declared", "inspecting", "released"].includes(customsStatus) && !declarationNumber)
        return { formError: "请先填写报关单号，再完成申报或放行" };
      if (customsStatus === "released") {
        const missingDocuments = await missingRequiredDocumentUploads("customs");
        if (missingDocuments.length)
          return { formError: `确认报关放行前请先上传并审核：${missingDocuments.join("、")}` };
      }
      const declaredAt =
        valueOf(form, "declaredAt") ||
        (["declared", "inspecting", "released"].includes(customsStatus) ? now : null);
      const releasedAt =
        valueOf(form, "releasedAt") || (customsStatus === "released" ? now : null);
      if (recordId) {
        const existing = await env.DB.prepare(
          "SELECT id FROM order_customs_records WHERE id=? AND organization_id=? AND order_id=?",
        )
          .bind(recordId, current.organizationId, orderId)
          .first<{ id: string }>();
        if (!existing) return { formError: "要更新的报关记录不存在" };
        await env.DB.prepare(
          `UPDATE order_customs_records
           SET clearance_stage=?,declaration_number=?,declaration_type=?,declaration_mode=?,document_provider=?,
             broker_name=?,broker_contact=?,cutoff_at=?,declared_at=?,released_at=?,transit_customs=?,
             inspection_required=?,inspection_notes=?,quarantine_required=?,quarantine_notes=?,status=?,updated_at=?
           WHERE id=? AND organization_id=? AND order_id=?`,
        )
          .bind(
            clearanceStage,
            declarationNumber || null,
            valueOf(form, "declarationType") || null,
            valueOf(form, "declarationMode") || null,
            valueOf(form, "documentProvider") || null,
            valueOf(form, "brokerName") || null,
            valueOf(form, "brokerContact") || null,
            valueOf(form, "cutoffAt") || null,
            declaredAt,
            releasedAt,
            form.has("transitCustoms") ? 1 : 0,
            form.has("inspectionRequired") ? 1 : 0,
            valueOf(form, "inspectionNotes") || null,
            form.has("quarantineRequired") ? 1 : 0,
            valueOf(form, "quarantineNotes") || null,
            customsStatus,
            now,
            recordId,
            current.organizationId,
            orderId,
          )
          .run();
      } else {
        await env.DB.prepare(
          `INSERT INTO order_customs_records(id,organization_id,order_id,clearance_stage,declaration_number,declaration_type,declaration_mode,document_provider,broker_name,broker_contact,cutoff_at,declared_at,released_at,transit_customs,inspection_required,inspection_notes,quarantine_required,quarantine_notes,status,created_by_user_id,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
          .bind(
            crypto.randomUUID(),
            current.organizationId,
            orderId,
            clearanceStage,
            declarationNumber || null,
            valueOf(form, "declarationType") || null,
            valueOf(form, "declarationMode") || null,
            valueOf(form, "documentProvider") || null,
            valueOf(form, "brokerName") || null,
            valueOf(form, "brokerContact") || null,
            valueOf(form, "cutoffAt") || null,
            declaredAt,
            releasedAt,
            form.has("transitCustoms") ? 1 : 0,
            form.has("inspectionRequired") ? 1 : 0,
            valueOf(form, "inspectionNotes") || null,
            form.has("quarantineRequired") ? 1 : 0,
            valueOf(form, "quarantineNotes") || null,
            customsStatus,
            current.userId,
            now,
            now,
          )
          .run();
      }
      await syncCustomsModuleFromRecords(current.organizationId, orderId, current.userId);
      return { success: "报关/清关记录已保存" };
    }
    if (intent === "transport_assignment") {
      if (moduleCode !== "transport")
        return { formError: "只能在运输安排模块派车" };
      const now = new Date().toISOString();
      const carrierId = valueOf(form, "carrierId") || null;
      let carrierName = valueOf(form, "carrierName");
      const vehicleMasterId = valueOf(form, "vehicleMasterId");
      const driverMasterId = valueOf(form, "driverMasterId");
      let vehicleType = valueOf(form, "vehicleType").trim();
      let plateNumber = valueOf(form, "plateNumber").trim().toUpperCase();
      let driverName = valueOf(form, "driverName").trim();
      let driverPhone = valueOf(form, "driverPhone").trim();
      let driverIdNumber = valueOf(form, "driverIdNumber").trim();
      const plannedDepartureAt = valueOf(form, "plannedDepartureAt");
      const plannedArrivalAt = valueOf(form, "plannedArrivalAt");
      const legType = valueOf(form, "legType") || "first_mile";
      const destinationWarehouseId = valueOf(form, "destinationWarehouseId");
      const chargeName = valueOf(form, "chargeName").trim();
      const freightCurrency = valueOf(form, "freightCurrency") || "CNY";
      const freightQuantity = Number(valueOf(form, "freightQuantity") || 1);
      const freightUnitPrice = Number(valueOf(form, "freightUnitPrice"));
      const freightExchangeRate = Number(valueOf(form, "freightExchangeRate") || 1);
      const payableFieldValues = [
        ["domestic_payable_charge_name", chargeName],
        ["domestic_freight_currency", freightCurrency],
        ["domestic_payable_exchange_rate", valueOf(form, "freightExchangeRate")],
        ["domestic_payable_quantity", valueOf(form, "freightQuantity")],
        ["domestic_freight_amount", valueOf(form, "freightUnitPrice")],
      ] as const;
      const payableEnabled = payableFieldValues.some(([fieldKey]) => fieldPolicy(fieldKey).visible);
      const missingPayableFields = payableFieldValues
        .filter(([fieldKey, value]) => requiredFieldMissing(fieldKey, value, true))
        .map(([fieldKey]) => fieldPolicy(fieldKey, true).label || fieldKey);
      const resourceMasterStatements: D1PreparedStatement[] = [];
      if (carrierId) {
        const carrier = await env.DB.prepare(
          "SELECT name FROM carriers WHERE id=? AND organization_id=? AND status='active' AND carrier_scope='domestic'",
        ).bind(carrierId, current.organizationId).first<{ name: string }>();
        if (!carrier) return { formError: "请选择有效的启用承运商" };
        carrierName = carrierName || carrier.name;
        if (vehicleMasterId === "__new__") {
          plateNumber = valueOf(form, "newVehiclePlateNumber").trim().toUpperCase();
          vehicleType = valueOf(form, "newVehicleType").trim();
          const capacityWeight = Number(valueOf(form, "newVehicleCapacityWeight") || 0);
          const capacityVolume = Number(valueOf(form, "newVehicleCapacityVolume") || 0);
          if (!/^[\p{L}A-Z0-9·-]{4,20}$/u.test(plateNumber)) return { formError: "请输入 4-20 位有效车牌号" };
          if (vehicleType.length < 2) return { formError: "请填写新车辆车型" };
          if (!Number.isFinite(capacityWeight) || capacityWeight < 0 || !Number.isFinite(capacityVolume) || capacityVolume < 0)
            return { formError: "车辆载重和容积不能为负数" };
          const duplicateVehicle = await env.DB.prepare(
            "SELECT carrier_id FROM carrier_vehicles WHERE organization_id=? AND plate_number=?",
          ).bind(current.organizationId,plateNumber).first<{carrier_id:string}>();
          if (duplicateVehicle) return { formError: duplicateVehicle.carrier_id === carrierId ? "该承运商已登记此车牌，请直接从下拉列表选择" : "该车牌已登记在其他承运商名下" };
          resourceMasterStatements.push(env.DB.prepare(
            `INSERT INTO carrier_vehicles(id,organization_id,carrier_id,plate_number,vehicle_type,capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,'active',?,?)`,
          ).bind(crypto.randomUUID(),current.organizationId,carrierId,plateNumber,vehicleType,capacityWeight,capacityVolume,now,now));
        } else if (vehicleMasterId) {
          const vehicle = await env.DB.prepare(
            `SELECT plate_number,vehicle_type FROM carrier_vehicles
             WHERE id=? AND organization_id=? AND carrier_id=? AND status='active'`,
          ).bind(vehicleMasterId, current.organizationId, carrierId).first<{
            plate_number: string;
            vehicle_type: string | null;
          }>();
          if (!vehicle) return { formError: "请选择当前承运商名下的有效车辆" };
          plateNumber = vehicle.plate_number.trim().toUpperCase();
          vehicleType = vehicle.vehicle_type || vehicleType;
        }
        if (driverMasterId === "__new__") {
          driverName = valueOf(form, "newDriverName").trim();
          driverPhone = valueOf(form, "newDriverPhone").trim();
          driverIdNumber = valueOf(form, "newDriverLicenseNumber").trim();
          if (driverName.length < 2) return { formError: "新司机姓名至少需要 2 个字符" };
          const phoneError = validatePhone(driverPhone, "司机电话");
          if (phoneError) return { formError: phoneError };
          const duplicateDriver = await env.DB.prepare(
            "SELECT id FROM carrier_drivers WHERE organization_id=? AND carrier_id=? AND name=?",
          ).bind(current.organizationId,carrierId,driverName).first();
          if (duplicateDriver) return { formError: "该承运商已登记同名司机，请直接从下拉列表选择" };
          resourceMasterStatements.push(env.DB.prepare(
            `INSERT INTO carrier_drivers(id,organization_id,carrier_id,name,phone,license_number,status,created_at,updated_at)
             VALUES(?,?,?,?,?,?,'active',?,?)`,
          ).bind(crypto.randomUUID(),current.organizationId,carrierId,driverName,driverPhone,driverIdNumber || null,now,now));
        } else if (driverMasterId) {
          const driver = await env.DB.prepare(
            `SELECT name,phone,license_number FROM carrier_drivers
             WHERE id=? AND organization_id=? AND carrier_id=? AND status='active'`,
          ).bind(driverMasterId, current.organizationId, carrierId).first<{
            name: string;
            phone: string | null;
            license_number: string | null;
          }>();
          if (!driver) return { formError: "请选择当前承运商名下的有效司机" };
          driverName = driver.name;
          driverPhone = driver.phone || driverPhone;
          driverIdNumber = driver.license_number || driverIdNumber;
        }
      }
      if (!carrierName) return { formError: "请选择国内承运商" };
      let destinationWarehouse: { id: string; name: string } | null = null;
      if (legType === "first_mile") {
        if (!destinationWarehouseId)
          return { formError: "请选择国内段终点仓库" };
        destinationWarehouse = await env.DB.prepare(
          `SELECT id,name FROM warehouses
           WHERE id=? AND organization_id=? AND status='active'
             AND warehouse_role IN ('domestic_collection','port')`,
        )
          .bind(destinationWarehouseId, current.organizationId)
          .first<{ id: string; name: string }>();
        if (!destinationWarehouse)
          return { formError: "请选择有效的国内集货仓或口岸仓" };
      }
      if (missingPayableFields.length)
        return { formError: `请填写国内运输应付信息：${missingPayableFields.join("、")}` };
      if (payableEnabled && (
        !Number.isFinite(freightQuantity) || freightQuantity <= 0 ||
        !Number.isFinite(freightUnitPrice) || freightUnitPrice <= 0 ||
        !Number.isFinite(freightExchangeRate) || freightExchangeRate <= 0
      )) return { formError: "请填写有效的预计应付数量、单价和汇率" };
      const freightAmount = payableEnabled ? freightQuantity * freightUnitPrice : 0;
      const transportRequiredValues = [
        ["domestic_carrier_id", carrierId || carrierName, true],
        ["domestic_vehicle_type", vehicleType, false],
        ["domestic_vehicle_count", valueOf(form, "vehicleCount"), false],
        ["domestic_loading_mode", order.business_type, false],
        ["domestic_plate_number", plateNumber, true],
        ["domestic_driver_name", driverName, true],
        ["domestic_driver_phone", driverPhone, false],
        ["domestic_driver_id_number", driverIdNumber, false],
        ["domestic_planned_departure_at", plannedDepartureAt, true],
        ["domestic_planned_arrival_at", plannedArrivalAt, true],
        ["domestic_loading_requirements", valueOf(form, "loadingRequirements"), false],
        ["domestic_transport_notes", valueOf(form, "notes"), false],
      ] as const;
      const missingTransportFields = transportRequiredValues
        .filter(([fieldKey, value, fallback]) =>
          requiredFieldMissing(fieldKey, value, fallback),
        )
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingTransportFields.length)
        return {
          formError: `请填写当前模板要求的字段：${missingTransportFields.join("、")}`,
        };
      const originLocation=[order.origin_country,order.origin_state,order.origin_city].filter(Boolean).join(" ");
      const destinationLocation = legType === "first_mile"
        ? destinationWarehouse?.name || ""
        : [order.destination_country,order.destination_state,order.destination_city].filter(Boolean).join(" ");
      const existingDomesticAssignment = legType === "first_mile"
        ? await env.DB.prepare(
            `SELECT id FROM order_transport_assignments
             WHERE organization_id=? AND order_id=? AND leg_type='first_mile' AND status!='cancelled'
             ORDER BY created_at LIMIT 1`,
          ).bind(current.organizationId, orderId).first<{ id: string }>()
        : null;
      const assignmentId = existingDomesticAssignment?.id ?? crypto.randomUUID();
      const vehicleCount = Math.max(1, Math.trunc(Number(valueOf(form, "vehicleCount") || 1)));
      const transportStatements: D1PreparedStatement[] = existingDomesticAssignment
        ? [env.DB.prepare(
            `UPDATE order_transport_assignments
             SET carrier_id=?,carrier_name=?,vehicle_type=?,vehicle_count=vehicle_count+?,
                 loading_mode=?,plate_number=?,driver_name=?,driver_phone=?,driver_id_number=?,
                 freight_amount=?,freight_currency=?,origin_location=?,destination_location=?,
                 destination_warehouse_id=?,planned_departure_at=?,planned_arrival_at=?,
                 loading_requirements=?,notes=?,status='planned',updated_at=?
             WHERE id=? AND organization_id=?`,
          ).bind(
            carrierId, carrierName || null, vehicleType || null, vehicleCount,
            order.business_type, plateNumber, driverName, driverPhone || null,
            driverIdNumber || null, freightAmount, freightCurrency,
            originLocation, destinationLocation, destinationWarehouseId || null,
            plannedDepartureAt, plannedArrivalAt, valueOf(form, "loadingRequirements") || null,
            valueOf(form, "notes") || null, now, assignmentId, current.organizationId,
          )]
        : [env.DB.prepare(
            `INSERT INTO order_transport_assignments(
               id,organization_id,order_id,leg_type,carrier_id,carrier_name,vehicle_type,
               vehicle_count,loading_mode,plate_number,driver_name,driver_phone,driver_id_number,
               freight_amount,freight_currency,origin_location,destination_location,
               destination_warehouse_id,border_port,transit_location,route_country,
               planned_departure_at,planned_arrival_at,loading_requirements,notes,status,
               created_by_user_id,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).bind(
            assignmentId, current.organizationId, orderId, legType, carrierId, carrierName || null,
            vehicleType || null, vehicleCount, order.business_type,
            plateNumber, driverName, driverPhone || null,
            driverIdNumber || null, freightAmount, freightCurrency,
            originLocation, destinationLocation, destinationWarehouseId || null,
            order.exit_port || null, order.transit_locations || null,
            `${order.origin_country} → ${order.destination_country}`, plannedDepartureAt,
            plannedArrivalAt, valueOf(form, "loadingRequirements") || null,
            valueOf(form, "notes") || null, "planned", current.userId, now, now,
          )];
      transportStatements.unshift(...resourceMasterStatements);
      if (legType === "first_mile") {
        const vehicleTotal = await env.DB.prepare(
          "SELECT COUNT(*) total FROM domestic_waybill_vehicles WHERE assignment_id=? AND status!='cancelled'",
        ).bind(assignmentId).first<{ total: number }>();
        for (let offset = 0; offset < vehicleCount; offset += 1) {
          transportStatements.push(env.DB.prepare(
            `INSERT INTO domestic_waybill_vehicles(
               id,organization_id,assignment_id,vehicle_sequence,vehicle_type,plate_number,
               driver_name,driver_phone,driver_id_number,planned_pickup_at,status,notes,
               created_by_user_id,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,'planned',?,?,?,?)`,
          ).bind(
            crypto.randomUUID(), current.organizationId, assignmentId,
            (vehicleTotal?.total ?? 0) + offset + 1, vehicleType || null,
            plateNumber, driverName, driverPhone || null,
            driverIdNumber || null, plannedDepartureAt,
            valueOf(form, "notes") || null, current.userId, now, now,
          ));
        }
      }
      if (payableEnabled) {
        const existingExpense = await env.DB.prepare(
          `SELECT id,stage FROM business_expenses
           WHERE organization_id=? AND source_type='transport_assignment' AND source_id=?`,
        ).bind(current.organizationId, assignmentId).first<{ id: string; stage: string }>();
        if (existingExpense && existingExpense.stage !== "estimated") {
          return { formError: "国内运输应付费用已经确认，不能从运输安排覆盖；请到费用结算模块修改" };
        }
        transportStatements.push(existingExpense
          ? env.DB.prepare(
            `UPDATE business_expenses SET
               order_id=?,charge_code='DOMESTIC_FREIGHT',charge_name=?,counterparty_name=?,
               currency=?,quantity=?,unit_price=?,amount=?,exchange_rate=?,base_amount=?,notes=?,updated_at=?
             WHERE id=? AND organization_id=?`,
          ).bind(
            orderId, chargeName, carrierName, freightCurrency, freightQuantity,
            freightUnitPrice, freightAmount, freightExchangeRate,
            freightAmount * freightExchangeRate, valueOf(form, "expenseNotes") || null,
            now, existingExpense.id, current.organizationId,
          )
          : env.DB.prepare(
          `INSERT INTO business_expenses(
             id,organization_id,order_id,direction,stage,charge_code,charge_name,
             counterparty_name,currency,quantity,unit_price,amount,exchange_rate,
             base_amount,notes,created_by_user_id,created_at,updated_at,source_type,source_id
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          crypto.randomUUID(), current.organizationId, orderId,
          "payable", "estimated", "DOMESTIC_FREIGHT", chargeName,
          carrierName, freightCurrency, freightQuantity, freightUnitPrice,
          freightAmount, freightExchangeRate, freightAmount * freightExchangeRate,
          valueOf(form, "expenseNotes") || null, current.userId, now, now,
          "transport_assignment", assignmentId,
        ));
      }
      await env.DB.batch(transportStatements);
      await syncCostsModuleStatus(current.organizationId, orderId, now);
      const module = await env.DB.prepare("SELECT id,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='transport' AND enabled=1").bind(current.organizationId,orderId).first<{id:string;current_step_code:string|null}>();
      if(module){
        await env.DB.batch([
          env.DB.prepare("UPDATE order_module_instances SET status='in_progress',current_step_code='arranged',current_step_name='已录入运输安排',progress_percent=25,started_at=COALESCE(started_at,?),completed_at=NULL,blocking_reason=NULL,updated_at=? WHERE id=?").bind(now,now,module.id),
          env.DB.prepare("INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),current.organizationId,orderId,module.id,"transport_arranged","保存运输安排",module.current_step_code,"arranged","已录入运输安排",current.userId,`国内运输安排 ${assignmentId} 已保存`,now),
        ]);
        await syncOrderWorkflowSnapshot(current.organizationId,orderId);
      }
      return {
        success: existingDomesticAssignment
          ? "国内运输安排已更新，并已追加提货车辆"
          : "国内运输安排已保存；等待国内提货和仓库累计收货",
        actionKind: "transport_assignment" as const,
      };
    }
    if (intent === "waybill_create") {
      if (moduleCode !== "transport")
        return { formError: "只能在运输安排模块建立运单" };
      const now = new Date().toISOString();
      const requestedWaybillNumber = valueOf(form, "waybillNumber");
      const waybillValues = [
        ["waybill_number", requestedWaybillNumber],
        ["waybill_accompanying_at", valueOf(form, "accompanyingAt")],
        ["waybill_shipper_instructions", valueOf(form, "shipperInstructions")],
        ["waybill_customs_notes", valueOf(form, "customsNotes")],
        ["waybill_accompanying_documents", valueOf(form, "accompanyingDocuments")],
        ["waybill_documents_verified", form.has("documentsVerified") ? "1" : ""],
      ] as const;
      const missingWaybillFields = waybillValues
        .filter(([fieldKey, value]) => requiredFieldMissing(fieldKey, value))
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingWaybillFields.length)
        return { formError: `请填写当前模板要求的字段：${missingWaybillFields.join("、")}` };
      const number =
        requestedWaybillNumber ||
        `AUTO-WB-${orderId.slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;
      await env.DB.prepare(
        `INSERT INTO order_waybills(id,organization_id,order_id,waybill_number,shipper_name,shipper_address,consignee_name,consignee_address,shipper_instructions,customs_notes,accompanying_documents,documents_verified,accompanying_at,status,created_by_user_id,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`,
      )
        .bind(
          crypto.randomUUID(),
          current.organizationId,
          orderId,
          number,
          order.shipper_name,
          order.origin_address,
          order.consignee_name,
          order.destination_address,
          valueOf(form, "shipperInstructions") || null,
          valueOf(form, "customsNotes") || null,
          valueOf(form, "accompanyingDocuments") || null,
          form.has("documentsVerified") ? 1 : 0,
          valueOf(form, "accompanyingAt") || null,
          current.userId,
          now,
          now,
        )
        .run();
      return { success: "运输运单已建立" };
    }
    if (intent === "tracking_option_toggle") {
      if (moduleCode !== "tracking")
        return { formError: "只能在运输执行与跟踪模块设置可选节点" };
      const optionCode = valueOf(form, "optionCode");
      const column =
        optionCode === "transloaded"
          ? "requires_transloading"
          : optionCode === "transit_customs"
            ? "requires_transit_customs"
            : null;
      if (!column) return { formError: "可选运输节点无效" };
      const enabled = valueOf(form, "enabled") === "1" ? 1 : 0;
      await env.DB.prepare(
        `UPDATE transport_orders SET ${column}=?,updated_at=? WHERE id=? AND organization_id=?`,
      )
        .bind(enabled, new Date().toISOString(), orderId, current.organizationId)
        .run();
      return {
        success: `${optionCode === "transloaded" ? "换装" : "转关"}节点已${enabled ? "开启" : "关闭"}`,
      };
    }
    if (intent === "tracking_add") {
      if (moduleCode !== "tracking")
        return { formError: "只能在运输执行与跟踪模块更新节点" };
      const eventAt = valueOf(form, "eventAt") || new Date().toISOString();
      const milestoneCode = valueOf(form, "milestoneCode") || "border_arrived";
      if (milestoneCode === "transloaded" && !order.requires_transloading)
        return { formError: "换装节点尚未开启，请先打开换装开关" };
      if (milestoneCode === "transit_customs" && !order.requires_transit_customs)
        return { formError: "转关节点尚未开启，请先打开转关开关" };
      const milestoneName =
        trackingManualMilestoneOptions.find(([code]) => code === milestoneCode)?.[1] ||
        valueOf(form, "milestoneName") ||
        "运输节点";
      const location = valueOf(form, "location") || null;
      const vehicleReference = valueOf(form, "vehicleReference") || null;
      const notes = valueOf(form, "notes") || null;
      const visibleToCustomer = valueOf(form, "visibleToCustomer") === "0" ? 0 : 1;
      const linkedOrderIds = batchSynchronizedTrackingMilestones.has(milestoneCode)
        ? await linkedBatchOrderIds(current.organizationId, orderId)
        : [orderId];
      if(order.business_type === "ltl" && linkedOrderIds.length > 1 && milestoneCode === "exported")
        return { formError: "拼车订单请在配载单的出境门禁统一确认实际出境，系统会同步全部子订单" };
      if(milestoneCode === "station_arrived")
        return { formError: "到达境外目的仓不能手工登记，请由订单指定的境外目的仓扫码入库并完成清点" };
      const trackingValues = [
        ["tracking_milestone", milestoneCode],
        ["tracking_milestone_name", milestoneName],
        ["tracking_event_at", valueOf(form, "eventAt")],
        ["tracking_location", location],
        ["tracking_vehicle", vehicleReference],
        ["tracking_notes", notes],
        ["visible_to_customer", valueOf(form, "visibleToCustomer")],
      ] as const;
      const missingTrackingFields = trackingValues
        .filter(([fieldKey, value]) => requiredFieldMissing(fieldKey, value))
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingTrackingFields.length)
        return { formError: `请填写当前模板要求的字段：${missingTrackingFields.join("、")}` };
      if (milestoneCode === "border_arrived") {
        const departureReadiness = await checkOrderDeparture(
          current.organizationId,
          orderId,
          vehicleReference || undefined,
        );
        if (!departureReadiness.ready)
          return {
            formError: `尚不能登记到达出境口岸：${departureReadiness.reasons.join("；")}`,
          };
      } else {
        const recorded = await env.DB.prepare(
          `SELECT milestone_code
           FROM order_tracking_milestones
           WHERE organization_id=? AND order_id=?`,
        )
          .bind(current.organizationId, orderId)
          .all<{ milestone_code: string }>();
        const recordedCodes = new Set(recorded.results.map((item) => item.milestone_code));
        const requiredPrevious: Record<string, string> = {
          exported: "border_arrived",
          transloaded: "exported",
          transit_customs: "exported",
          foreign_entered: "exported",
          customs_cleared: "foreign_entered",
          station_arrived: "customs_cleared",
        };
        const previousCode = requiredPrevious[milestoneCode];
        if (previousCode && !recordedCodes.has(previousCode)) {
          const previousName = trackingManualMilestoneOptions.find(
            ([code]) => code === previousCode,
          )?.[1];
          return { formError: `请先完成“${previousName || previousCode}”，再登记当前节点` };
        }
      }
      if (milestoneCode === "exported") {
        const blockers: string[] = [];
        for (const targetOrderId of linkedOrderIds) {
          const readiness = await checkOrderDeparture(
            current.organizationId,
            targetOrderId,
            vehicleReference || undefined,
          );
          if (!readiness.ready) blockers.push(...readiness.reasons);
        }
        if (blockers.length)
          return { formError: `尚不能登记出境：${[...new Set(blockers)].join("；")}` };
      }
      const now = new Date().toISOString();
      const shipmentStatus = milestoneCode === "border_arrived" ? "customs" : "in_transit";
      const statements = linkedOrderIds.flatMap((targetOrderId) => [
        env.DB.prepare(
          `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer,created_by_user_id,created_at)
           SELECT ?,?,?,?,?,?,?,?,?,?,?,?
           WHERE NOT EXISTS(
             SELECT 1 FROM order_tracking_milestones
             WHERE organization_id=? AND order_id=? AND milestone_code=? AND event_at=?
           )`,
        ).bind(
          crypto.randomUUID(),
          current.organizationId,
          targetOrderId,
          milestoneCode,
          milestoneName,
          eventAt,
          location,
          vehicleReference,
          notes,
          visibleToCustomer,
          current.userId,
          now,
          current.organizationId,
          targetOrderId,
          milestoneCode,
          eventAt,
        ),
        env.DB.prepare(
          `UPDATE shipments
           SET status=?,
               current_location=COALESCE(?,current_location),
               updated_at=?
           WHERE organization_id=? AND order_id=? AND status!='cancelled'
             AND id=(SELECT latest.id FROM shipments latest WHERE latest.organization_id=? AND latest.order_id=? ORDER BY COALESCE(latest.updated_at,latest.created_at) DESC,latest.created_at DESC LIMIT 1)`,
        ).bind(shipmentStatus, location, now, current.organizationId, targetOrderId, current.organizationId, targetOrderId),
      ]);
      await env.DB.batch(statements);
      if (batchSynchronizedTrackingMilestones.has(milestoneCode)) {
        await syncBatchTrackingMilestonesFromOrder(
          current.organizationId,
          orderId,
          current.userId,
        );
        if (order.business_type === "ftl") {
          await ensureFtlBatchFromTracking(
            current.organizationId,
            orderId,
            current.userId,
            milestoneCode,
            eventAt,
            location,
          );
        }
      }
      for (const targetOrderId of linkedOrderIds) {
        await syncTrackingModuleStatus(
          current.organizationId,
          targetOrderId,
          current.userId,
          milestoneCode,
          now,
        );
      }
      if (batchSynchronizedTrackingMilestones.has(milestoneCode)) {
        await syncBatchStateFromTrackingMilestones(current.organizationId, orderId, current.userId);
      }
      return {
        success:
          linkedOrderIds.length > 1
            ? `运输节点已更新，并同步同一配载单 ${linkedOrderIds.length} 票订单`
            : "运输节点已更新",
      };
    }
    if (intent === "expense_add" || intent === "expense_update") {
      if (
        intent === "expense_update"
          ? moduleCode !== "costs"
          : !canCreateExpenseFromModule(moduleCode, expenseEntryContext)
      ) return { formError: "只能在订单费用或费用结算模块录入" };
      const direction = valueOf(form, "direction") || "receivable";
      if (!["receivable", "payable"].includes(direction))
        return { formError: "费用方向无效" };
      const expenseId = valueOf(form, "expenseId");
      const existingExpense = intent === "expense_update"
        ? await env.DB.prepare(
            "SELECT id,direction FROM business_expenses WHERE id=? AND organization_id=? AND order_id=?",
          )
            .bind(expenseId, current.organizationId, orderId)
            .first<{ id: string; direction: string }>()
        : null;
      if (intent === "expense_update" && !existingExpense)
        return { formError: "费用记录不存在或已被删除" };
      const directionControl = await env.DB.prepare(
        "SELECT business_locked,finance_locked FROM order_expense_direction_controls WHERE organization_id=? AND order_id=? AND direction=?",
      )
        .bind(current.organizationId, orderId, direction)
        .first<{ business_locked: number; finance_locked: number }>();
      if (directionControl?.business_locked || directionControl?.finance_locked)
        return { formError: "该方向费用已锁定，不能修改原费用；后续请走调整或补充费用" };
      if (existingExpense && existingExpense.direction !== direction) {
        const originalControl = await env.DB.prepare(
          "SELECT business_locked,finance_locked FROM order_expense_direction_controls WHERE organization_id=? AND order_id=? AND direction=?",
        )
          .bind(current.organizationId, orderId, existingExpense.direction)
          .first<{ business_locked: number; finance_locked: number }>();
        if (originalControl?.business_locked || originalControl?.finance_locked)
          return { formError: "原费用方向已经锁定，不能更改费用方向" };
      }
      const expenseValues = [
        ["expense_direction", valueOf(form, "direction")],
        ["expense_charge_code", valueOf(form, "chargeCode")],
        ["expense_charge_name", valueOf(form, "chargeName")],
        ["expense_counterparty", valueOf(form, "counterpartyName")],
        ["expense_currency", valueOf(form, "currency")],
        ["expense_exchange_rate", valueOf(form, "exchangeRate")],
        ["expense_quantity", valueOf(form, "quantity")],
        ["expense_unit_price", valueOf(form, "unitPrice")],
        ["expense_tax_rate", valueOf(form, "taxRate")],
        ["expense_occurred_on", valueOf(form, "occurredOn")],
        ["expense_foreign_account_no", valueOf(form, "foreignAccountNo")],
        ["expense_is_internal", valueOf(form, "isInternal")],
        ["expense_notes", valueOf(form, "notes")],
      ] as const;
      const missingExpenseFields = expenseValues
        .filter(([fieldKey, value]) => requiredFieldMissing(fieldKey, value))
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingExpenseFields.length)
        return { formError: `请填写当前模板要求的字段：${missingExpenseFields.join("、")}` };
      const quantity = Number(valueOf(form, "quantity") || 1);
      const unitPrice = Number(valueOf(form, "unitPrice") || 0);
      const exchangeRate = Number(valueOf(form, "exchangeRate") || 1);
      const taxRate = Number(valueOf(form, "taxRate") || 0);
      if (!Number.isFinite(quantity) || quantity <= 0)
        return { formError: "费用数量必须是大于 0 的数字" };
      if (!Number.isFinite(unitPrice) || unitPrice < 0)
        return { formError: "费用单价必须是大于或等于 0 的数字" };
      if (!Number.isFinite(exchangeRate) || exchangeRate <= 0)
        return { formError: "费用汇率必须是大于 0 的数字" };
      if (!Number.isFinite(taxRate) || taxRate < 0)
        return { formError: "费用税率必须是大于或等于 0 的数字" };
      const amount = quantity * unitPrice;
      const now = new Date().toISOString();
      const values = {
        chargeCode: valueOf(form, "chargeCode") || "OTHER",
        chargeName: valueOf(form, "chargeName") || "其他费用",
        counterpartyName: valueOf(form, "counterpartyName") || null,
        currency: valueOf(form, "currency") || "CNY",
        notes: valueOf(form, "notes") || null,
        occurredOn: valueOf(form, "occurredOn") || null,
        isInternal: valueOf(form, "isInternal") === "1" ? 1 : 0,
        foreignAccountNo: valueOf(form, "foreignAccountNo") || null,
      };
      const targetExpenseId = existingExpense?.id || crypto.randomUUID();
      if (existingExpense) {
        await env.DB.prepare(
          `UPDATE business_expenses
              SET direction=?,charge_code=?,charge_name=?,counterparty_name=?,currency=?,quantity=?,unit_price=?,amount=?,exchange_rate=?,base_amount=?,notes=?,updated_at=?,tax_rate=?,tax_amount=?,occurred_on=?,is_internal=?,foreign_account_no=?
            WHERE id=? AND organization_id=? AND order_id=?`,
        )
          .bind(
            direction, values.chargeCode, values.chargeName, values.counterpartyName,
            values.currency, quantity, unitPrice, amount, exchangeRate,
            amount * exchangeRate, values.notes, now, taxRate,
            (amount * taxRate) / 100, values.occurredOn, values.isInternal,
            values.foreignAccountNo, targetExpenseId, current.organizationId, orderId,
          )
          .run();
      } else {
        await env.DB.prepare(
          `INSERT INTO business_expenses(id,organization_id,order_id,direction,stage,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,base_amount,notes,created_by_user_id,created_at,updated_at,tax_rate,tax_amount,occurred_on,is_internal,foreign_account_no)
           VALUES(?,?,?,?,'estimated',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
          .bind(
            targetExpenseId, current.organizationId, orderId, direction,
            values.chargeCode, values.chargeName, values.counterpartyName,
            values.currency, quantity, unitPrice, amount, exchangeRate,
            amount * exchangeRate, values.notes, current.userId, now, now,
            taxRate, (amount * taxRate) / 100, values.occurredOn,
            values.isInternal, values.foreignAccountNo,
          )
          .run();
      }
      await syncCostsModuleStatus(current.organizationId, orderId, now);
      await syncOrderWorkflowSnapshot(current.organizationId, orderId);
      await writeAudit({
        request,
        action: existingExpense ? "expense.update" : "expense.create",
        resourceType: "business_expense",
        resourceId: targetExpenseId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: {
          orderId,
          direction,
          chargeCode: values.chargeCode,
          chargeName: values.chargeName,
          currency: values.currency,
          quantity,
          unitPrice,
          amount,
          exchangeRate,
          entryContext: expenseEntryContext || "costs",
        },
      });
      return {
        actionKind: existingExpense ? "expense_updated" : "expense_added",
        success: existingExpense ? "费用已更新" : "应收/应付费用已录入",
      };
    }
    if (intent === "expense_direction_control") {
      if (moduleCode !== "costs") return { formError: "只能在费用模块审核" };
      if (order.status === "draft")
        return { formError: "草稿阶段只允许预录费用；订单进入执行后再确认、审核和锁定" };
      const direction = valueOf(form, "direction") as "receivable" | "payable";
      const controlAction = valueOf(form, "controlAction");
      if (!["receivable", "payable"].includes(direction))
        return { formError: "费用方向无效" };
      if (!["confirm", "business_review", "finance_review", "business_lock", "finance_lock"].includes(controlAction))
        return { formError: "费用审核动作无效" };
      const expenses = await env.DB.prepare(
        "SELECT COUNT(*) total,SUM(CASE WHEN counterparty_name IS NULL OR TRIM(counterparty_name)='' THEN 1 ELSE 0 END) missing_counterparty FROM business_expenses WHERE organization_id=? AND order_id=? AND direction=? AND stage!='cancelled'",
      )
        .bind(current.organizationId, orderId, direction)
        .first<{ total: number; missing_counterparty: number }>();
      if ((expenses?.total ?? 0) === 0)
        return { formError: `请先录入${direction === "receivable" ? "应收" : "应付"}费用` };
      if ((expenses?.missing_counterparty ?? 0) > 0)
        return { formError: "存在未填写往来单位的费用，不能确认" };
      const existing =
        (await env.DB.prepare(
          "SELECT direction,confirmed,business_reviewed,finance_reviewed,business_locked,finance_locked FROM order_expense_direction_controls WHERE organization_id=? AND order_id=? AND direction=?",
        )
          .bind(current.organizationId, orderId, direction)
          .first<ExpenseDirectionControl>()) || emptyExpenseDirectionControl(direction);
      if (controlAction === "business_review" && !existing.confirmed)
        return { formError: "请先确认该方向费用" };
      if (controlAction === "finance_review" && !existing.business_reviewed)
        return { formError: "请先完成业务审核" };
      if (controlAction === "business_lock" && !existing.business_reviewed)
        return { formError: "请先完成业务审核" };
      if (controlAction === "finance_lock" && !existing.finance_reviewed)
        return { formError: "请先完成财务审核" };
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,updated_at)
         VALUES(?,?,?,?) ON CONFLICT(order_id,direction) DO UPDATE SET updated_at=excluded.updated_at`,
      )
        .bind(current.organizationId, orderId, direction, now)
        .run();
      const updates = {
        confirm: "confirmed=1,confirmed_by_user_id=?,confirmed_at=?",
        business_review: "business_reviewed=1,business_reviewed_by_user_id=?,business_reviewed_at=?",
        finance_review: "finance_reviewed=1,finance_reviewed_by_user_id=?,finance_reviewed_at=?",
        business_lock: "business_locked=1,business_locked_by_user_id=?,business_locked_at=?",
        finance_lock: "finance_locked=1,finance_locked_by_user_id=?,finance_locked_at=?",
      } as const;
      await env.DB.prepare(
        `UPDATE order_expense_direction_controls SET ${updates[controlAction as keyof typeof updates]},notes=COALESCE(?,notes),updated_at=? WHERE organization_id=? AND order_id=? AND direction=?`,
      )
        .bind(
          current.userId,
          now,
          valueOf(form, "notes") || null,
          now,
          current.organizationId,
          orderId,
          direction,
        )
        .run();
      if (controlAction === "confirm")
        await env.DB.prepare(
          "UPDATE business_expenses SET stage='confirmed',updated_at=? WHERE organization_id=? AND order_id=? AND direction=? AND stage='estimated'",
        )
          .bind(now, current.organizationId, orderId, direction)
          .run();
      await syncCostsModuleStatus(current.organizationId, orderId, now);
      await syncOrderWorkflowSnapshot(current.organizationId, orderId);
      await writeAudit({
        request,
        action: `expense.${direction}.${controlAction}`,
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: { direction, controlAction },
      });
      const labels: Record<string, string> = {
        confirm: "费用已确认",
        business_review: "业务审核已完成",
        finance_review: "财务审核已完成",
        business_lock: "业务已锁定",
        finance_lock: "财务已锁定",
      };
      return { success: `${direction === "receivable" ? "应收" : "应付"}${labels[controlAction]}` };
    }
    if (intent === "expense_control") {
      if (moduleCode !== "costs") return { formError: "只能在费用模块锁定" };
      const now = new Date().toISOString();
      const lockType = valueOf(form, "lockType");
      const business = lockType === "business" ? 1 : 0;
      const finance = lockType === "finance" ? 1 : 0;
      await env.DB.prepare(
        `INSERT INTO order_expense_controls(order_id,organization_id,business_locked,finance_locked,business_locked_by_user_id,finance_locked_by_user_id,business_locked_at,finance_locked_at,notes,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(order_id) DO UPDATE SET
           business_locked=CASE WHEN excluded.business_locked=1 THEN 1 ELSE order_expense_controls.business_locked END,
           finance_locked=CASE WHEN excluded.finance_locked=1 THEN 1 ELSE order_expense_controls.finance_locked END,
           business_locked_by_user_id=COALESCE(excluded.business_locked_by_user_id,order_expense_controls.business_locked_by_user_id),
           finance_locked_by_user_id=COALESCE(excluded.finance_locked_by_user_id,order_expense_controls.finance_locked_by_user_id),
           business_locked_at=COALESCE(excluded.business_locked_at,order_expense_controls.business_locked_at),
           finance_locked_at=COALESCE(excluded.finance_locked_at,order_expense_controls.finance_locked_at),
           notes=COALESCE(excluded.notes,order_expense_controls.notes),updated_at=excluded.updated_at`,
      )
        .bind(
          orderId,
          current.organizationId,
          business,
          finance,
          business ? current.userId : null,
          finance ? current.userId : null,
          business ? now : null,
          finance ? now : null,
          valueOf(form, "notes") || null,
          now,
        )
        .run();
      return { success: lockType === "finance" ? "财务已锁定" : "业务已锁定" };
    }
    if (intent === "document_upload") {
      const quickReviewAttachmentId = valueOf(form, "quickReviewAttachmentId");
      if (quickReviewAttachmentId) {
        if (moduleCode !== "documents")
          return { formError: "文件审核请在文件中心办理" };
        const now = new Date().toISOString();
        await env.DB.prepare(
          "UPDATE order_document_metadata SET review_status='approved',reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE attachment_id=? AND order_id=? AND organization_id=?",
        )
          .bind(
            current.userId,
            now,
            now,
            quickReviewAttachmentId,
            orderId,
            current.organizationId,
          )
          .run();
        await synchronizeOrderDocumentsModuleStatus({
          organizationId: current.organizationId,
          orderId,
          actorUserId: current.userId,
          now,
          source: "admin_review",
        });
        return { success: "文件已审核通过" };
      }
      const files = form
        .getAll("attachments")
        .filter((item): item is File => item instanceof File && item.size > 0);
      if (!files.length) return { formError: "请选择文件" };
      if (files.length > 1) return { formError: "请在对应文件框中一次上传一个文件" };
      const documentCategory = valueOf(form, "documentCategory");
      if (!orderDocumentTypeCodes.has(documentCategory))
        return { formError: "文件类型无效，请从对应的专用上传框提交" };
      const placement = orderDocumentPlacement(documentCategory);
      if (
        moduleCode !== "documents" &&
        !orderDocumentCanBeHandledInModule(documentCategory, moduleCode as OrderModuleCode)
      )
        return { formError: "请在该文件对应的业务节点上传" };
      const documentValues = [
        [
          placement?.fieldKey || "document_attachment",
          files.length ? "1" : "",
          placement?.requiredByDefault ?? true,
        ],
        ["document_category", documentCategory],
        ["document_attachment", files.length ? "1" : ""],
        ["document_description", valueOf(form, "documentDescription")],
        ["document_public_to_customer", valueOf(form, "publicToCustomer")],
      ] as readonly (readonly [string, string, boolean?])[];
      const missingDocumentFields = documentValues
        .filter(([fieldKey, value, fallbackRequired]) =>
          requiredFieldMissing(fieldKey, value, fallbackRequired),
        )
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingDocumentFields.length)
        return { formError: `请填写当前模板要求的字段：${missingDocumentFields.join("、")}` };
      const allowed = new Set([
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "image/jpeg",
        "image/png",
        "image/webp",
      ]);
      if (
        files.some(
          (file) =>
            file.size > maxInlineOrderDocumentBytes || !allowed.has(file.type),
        )
      )
        return {
          formError:
            "仅支持PDF、Word、Excel和图片；当前数据库直存模式下单个文件不能超过1.2MB",
        };
      const order = await env.DB.prepare(
        "SELECT customer_id FROM transport_orders WHERE id=? AND organization_id=?",
      )
        .bind(orderId, current.organizationId)
        .first<{ customer_id: string }>();
      if (!order) return { formError: "订单不存在" };
      const now = new Date().toISOString();
      const statements = [];
      for (const file of files) {
        const attachmentId = crypto.randomUUID();
        statements.push(
          env.DB.prepare(
            "INSERT INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)",
          ).bind(
            attachmentId,
            current.organizationId,
            orderId,
            order.customer_id,
            file.name,
            file.type,
            file.size,
            await toDataUrl(file),
            current.userId,
            now,
          ),
          env.DB.prepare(
            "INSERT INTO order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,updated_at) VALUES(?,?,?,?,?,?,?,?)",
          ).bind(
            attachmentId,
            current.organizationId,
            orderId,
             documentCategory,
             valueOf(form, "documentDescription") || orderDocumentTypeLabel(documentCategory),
            valueOf(form, "publicToCustomer") === "1" ? 1 : 0,
            "pending",
            now,
          ),
        );
      }
      await env.DB.batch(statements);
      await synchronizeOrderDocumentsModuleStatus({
        organizationId: current.organizationId,
        orderId,
        actorUserId: current.userId,
        now,
        source: "admin_upload",
      });
      return { success: `${orderDocumentTypeLabel(documentCategory)}已上传并进入审核` };
    }
    if (intent === "document_review") {
      const attachmentId = valueOf(form, "attachmentId");
      const target = await env.DB.prepare(
        "SELECT document_category FROM order_document_metadata WHERE attachment_id=? AND order_id=? AND organization_id=?",
      ).bind(attachmentId, orderId, current.organizationId).first<{ document_category: string }>();
      if (!target) return { formError: "要审核的文件不存在" };
      if (
        target.document_category === "consignment_letter" &&
        !isAssignedConsignmentApprover
      )
        return { formError: "仅提交审批时指定的审批负责人可以审核委托书" };
      if (
        target.document_category !== "consignment_letter" &&
        !canManageOrderModule(current, moduleCode)
      )
        return { formError: "当前岗位没有审核该文件的权限" };
      if (
        moduleCode !== "documents" &&
        !orderDocumentCanBeHandledInModule(target.document_category, moduleCode as OrderModuleCode)
      )
        return { formError: "请在该文件对应的业务节点审核" };
      const status = valueOf(form, "reviewStatus");
      if (!["approved", "rejected", "archived"].includes(status))
        return { formError: "审核状态无效" };
      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE order_document_metadata SET review_status=?,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE attachment_id=? AND order_id=? AND organization_id=?",
      )
        .bind(
          status,
          current.userId,
          now,
          now,
          attachmentId,
          orderId,
          current.organizationId,
        )
        .run();
      await synchronizeOrderDocumentsModuleStatus({
        organizationId: current.organizationId,
        orderId,
        actorUserId: current.userId,
        now,
        source: "admin_review",
      });
      let deliveryCompleted = false;
      if (
        moduleCode === "overseas_warehouse" &&
        target.document_category === "delivery_receipt" &&
        ["approved", "archived"].includes(status)
      ) {
        const operation = await env.DB.prepare(
          `SELECT status FROM overseas_warehouse_operations
            WHERE organization_id=? AND order_id=? AND status!='cancelled'
            ORDER BY created_at DESC LIMIT 1`,
        ).bind(current.organizationId, orderId).first<{ status: string }>();
        if (operation?.status === "picked_up") {
          await completeOverseasOrderDelivery({
            organizationId: current.organizationId,
            orderId,
            actorUserId: current.userId,
            occurredAt: now,
          });
          deliveryCompleted = true;
        }
      }
      return {
        success: deliveryCompleted
            ? "签收单已审核通过；自提签收记录已归档"
            : "文件审核状态已更新",
        documentReviewSignal: `${attachmentId}:${now}`,
      };
    }
    if (intent === "document_metadata_update") {
      const attachmentId = valueOf(form, "attachmentId");
      const target = await env.DB.prepare(
        "SELECT document_category FROM order_document_metadata WHERE attachment_id=? AND order_id=? AND organization_id=?",
      ).bind(attachmentId, orderId, current.organizationId).first<{ document_category: string }>();
      if (!target) return { formError: "要修改的文件不存在" };
      if (
        moduleCode !== "documents" &&
        !orderDocumentCanBeHandledInModule(target.document_category, moduleCode as OrderModuleCode)
      )
        return { formError: "请在该文件对应的业务节点修改" };
      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE order_document_metadata SET description=?,public_to_customer=?,review_status='pending',reviewed_by_user_id=NULL,reviewed_at=NULL,updated_at=? WHERE attachment_id=? AND order_id=? AND organization_id=?",
      ).bind(
        valueOf(form, "documentDescription") || orderDocumentTypeLabel(target.document_category),
        valueOf(form, "publicToCustomer") === "1" ? 1 : 0,
        now,
        attachmentId,
        orderId,
        current.organizationId,
      ).run();
      await synchronizeOrderDocumentsModuleStatus({
        organizationId: current.organizationId,
        orderId,
        actorUserId: current.userId,
        now,
        source: "admin_review",
      });
      return { success: "文件信息已修改，请重新审核" };
    }
    return { formError: "无效操作" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作失败";
    await env.DB.prepare(
      "UPDATE order_module_instances SET status='blocked',blocking_reason=?,updated_at=? WHERE organization_id=? AND order_id=? AND module_code=? AND status!='completed'",
    )
      .bind(
        message,
        new Date().toISOString(),
        current.organizationId,
        orderId,
        moduleCode,
      )
      .run();
    return { formError: message };
  }
}

async function syncTrackingModuleStatus(
  organizationId: string,
  orderId: string,
  actorUserId: string,
  milestoneCode: string,
  now: string,
) {
  const mapping: Record<string, { step: string; name: string; progress: number; complete?: boolean }> = {
    departed: { step: "departed", name: "已登记发车", progress: 15 },
    border_arrived: { step: "transit", name: "到达出境口岸", progress: 28 },
    exported: { step: "transit", name: "已出境", progress: 40 },
    transloaded: { step: "transit", name: "已换装", progress: 46 },
    transit_customs: { step: "transit", name: "转关处理中", progress: 52 },
    foreign_entered: { step: "transit", name: "国外已入境", progress: 64 },
    customs_cleared: { step: "customs_cleared", name: "目的地清关完成", progress: 82 },
    station_arrived: { step: "arrived", name: "到达境外目的仓", progress: 100, complete: true },
  };
  const next = mapping[milestoneCode];
  if (!next) return;
  const recorded = await env.DB.prepare(
    `SELECT MAX(CASE milestone_code
       WHEN 'departed' THEN 15
       WHEN 'border_arrived' THEN 28
       WHEN 'exported' THEN 40
       WHEN 'transloaded' THEN 46
       WHEN 'transit_customs' THEN 52
       WHEN 'foreign_entered' THEN 64
       WHEN 'customs_cleared' THEN 82
       WHEN 'station_arrived' THEN 100
       ELSE 0 END) progress
     FROM order_tracking_milestones
     WHERE organization_id=? AND order_id=?`,
  )
    .bind(organizationId, orderId)
    .first<{ progress: number | null }>();
  const effectiveProgress = Math.max(next.progress, recorded?.progress ?? 0);
  const effectiveComplete = effectiveProgress >= 100 || Boolean(next.complete);
  const effectiveStep = effectiveProgress >= 100
    ? "arrived"
    : effectiveProgress >= 82
      ? "customs_cleared"
      : effectiveProgress >= 28
        ? "transit"
        : next.step;
  const effectiveName = effectiveProgress >= 100
    ? "到达境外目的仓"
    : effectiveProgress >= 82
      ? "目的地清关完成"
      : effectiveProgress >= 40
        ? "出境运输中"
        : next.name;
  const module = await env.DB.prepare(
    "SELECT id,status,current_step_code,progress_percent FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='tracking' AND enabled=1",
  )
    .bind(organizationId, orderId)
    .first<{
      id: string;
      status: string;
      current_step_code: string | null;
      progress_percent: number;
    }>();
  if (!module) return;
  if (module.status === "completed" && module.current_step_code === effectiveStep) return;
  if ((module.progress_percent ?? 0) > effectiveProgress && module.current_step_code === effectiveStep) return;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
         blocking_reason=NULL,started_at=COALESCE(started_at,?),
         completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE completed_at END,
         updated_at=?
       WHERE id=?`,
    ).bind(
      effectiveComplete ? "completed" : "in_progress",
      effectiveStep,
      effectiveName,
      effectiveProgress,
      now,
      effectiveComplete ? "completed" : "in_progress",
      now,
      now,
      module.id,
    ),
    env.DB.prepare(
      "INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      organizationId,
      orderId,
      module.id,
      "tracking_status_sync",
      "保存运输节点后自动同步",
      module.current_step_code,
      effectiveStep,
      effectiveName,
      actorUserId,
      `运输节点：${milestoneCode}`,
      now,
    ),
  ]);
  await syncOrderWorkflowSnapshot(organizationId, orderId);
}

async function syncTrackingModuleFromMilestones(
  organizationId: string,
  orderId: string,
  actorUserId: string,
) {
  const latest = await env.DB.prepare(
    `SELECT milestone_code
     FROM order_tracking_milestones
     WHERE organization_id=? AND order_id=?
     ORDER BY CASE milestone_code
       WHEN 'station_arrived' THEN 100
       WHEN 'customs_cleared' THEN 82
       WHEN 'foreign_entered' THEN 64
       WHEN 'transit_customs' THEN 52
       WHEN 'transloaded' THEN 46
       WHEN 'exported' THEN 40
       WHEN 'border_arrived' THEN 28
       WHEN 'departed' THEN 15
       ELSE 0 END DESC,
       event_at DESC,created_at DESC
     LIMIT 1`,
  )
    .bind(organizationId, orderId)
    .first<{ milestone_code: string }>();
  if (!latest) return;
  await syncTrackingModuleStatus(
    organizationId,
    orderId,
    actorUserId,
    latest.milestone_code,
    new Date().toISOString(),
  );
}

const batchSynchronizedTrackingMilestones = new Set([
  "departed",
  "border_arrived",
  "exported",
  "transloaded",
  "transit_customs",
  "foreign_entered",
  "customs_cleared",
  "station_arrived",
]);

async function linkedBatchOrderIds(organizationId: string, orderId: string) {
  const batch = await env.DB.prepare(
    `SELECT batch_id
     FROM transport_batch_orders
     WHERE organization_id=? AND order_id=? AND status!='removed'
     ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(organizationId, orderId)
    .first<{ batch_id: string }>();
  if (!batch) return [orderId];
  const orders = await env.DB.prepare(
    `SELECT order_id
     FROM transport_batch_orders
     WHERE organization_id=? AND batch_id=? AND status!='removed'
     ORDER BY sequence_no,order_id`,
  )
    .bind(organizationId, batch.batch_id)
    .all<{ order_id: string }>();
  const ids = orders.results.map((item) => item.order_id);
  return ids.includes(orderId) ? ids : [orderId, ...ids];
}

async function linkedBatchContext(organizationId: string, orderId: string) {
  const batch = await env.DB.prepare(
    `SELECT batch_id
     FROM transport_batch_orders
     WHERE organization_id=? AND order_id=? AND status!='removed'
     ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(organizationId, orderId)
    .first<{ batch_id: string }>();
  if (!batch) return { batchId: null, orderIds: [orderId] };
  const orders = await env.DB.prepare(
    `SELECT order_id
     FROM transport_batch_orders
     WHERE organization_id=? AND batch_id=? AND status!='removed'
     ORDER BY sequence_no,order_id`,
  )
    .bind(organizationId, batch.batch_id)
    .all<{ order_id: string }>();
  const orderIds = orders.results.map((item) => item.order_id);
  return {
    batchId: batch.batch_id,
    orderIds: orderIds.includes(orderId) ? orderIds : [orderId, ...orderIds],
  };
}

async function ensureFtlPlanningBatch(
  organizationId: string,
  orderId: string,
  actorUserId: string,
) {
  const linked = await linkedBatchContext(organizationId, orderId);
  if (linked.batchId) return linked.batchId;
  const now = new Date().toISOString();
  const order = await env.DB.prepare(
    `SELECT order_number,origin_country,origin_state,origin_city,
            destination_country,destination_state,destination_city,
            exit_port,customs_location,transit_locations,route_notes,overseas_warehouse_id,current_assignee_user_id,
            (SELECT wr.warehouse_id FROM warehouse_receipts wr
             JOIN shipments s ON s.id=wr.shipment_id
             WHERE s.order_id=transport_orders.id AND wr.status='completed' AND wr.cargo_complete=1
             ORDER BY wr.received_at DESC LIMIT 1) domestic_warehouse_id
     FROM transport_orders
     WHERE organization_id=? AND id=? AND business_type='ftl'`,
  ).bind(organizationId, orderId).first<{
    order_number: string;
    origin_country: string;
    origin_state: string | null;
    origin_city: string;
    destination_country: string;
    destination_state: string | null;
    destination_city: string;
    exit_port: string | null;
    customs_location: string | null;
    transit_locations: string | null;
    route_notes: string | null;
    overseas_warehouse_id: string | null;
    current_assignee_user_id: string | null;
    domestic_warehouse_id: string | null;
  }>();
  if (!order) return null;
  const seq = await env.DB.prepare(
    "SELECT COUNT(*)+1 next FROM transport_batches WHERE organization_id=? AND batch_number LIKE 'FTL-%'",
  ).bind(organizationId).first<{ next: number }>();
  const batchId = crypto.randomUUID();
  const batchNumber = `FTL-${now.slice(0, 10).replaceAll("-", "")}-${String(seq?.next ?? 1).padStart(3, "0")}`;
  const origin = [order.origin_country, order.origin_state, order.origin_city].filter(Boolean).join(" ");
  const destination = [order.destination_country, order.destination_state, order.destination_city].filter(Boolean).join(" ");
  const keyPart = (value: string | null | undefined) => (value ?? "").trim().toLocaleLowerCase();
  const routeKey = [
    `${keyPart(order.origin_country)}|${keyPart(order.origin_state)}|${keyPart(order.origin_city)}>${keyPart(order.destination_country)}|${keyPart(order.destination_state)}|${keyPart(order.destination_city)}`,
    keyPart(order.exit_port),
    keyPart(order.customs_location),
    keyPart(order.domestic_warehouse_id),
    keyPart(order.overseas_warehouse_id),
  ].join("|");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO transport_batches(
        id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,
        status,notes,route_key,warehouse_id,created_by_user_id,created_at,updated_at,border_port,customs_location,transit_location,route_notes,road_status
      ) VALUES(?,?,?,?,?,?,?,'planning',?,?,?,?,?,?,?,?,?,?,'waiting_loading')`,
    ).bind(
      batchId, organizationId, orderId, batchNumber, `${order.order_number} 整车装车单`, origin, destination,
      "整车方案确认后自动建立；用于统一登记境外承运资源、装车出库和出境运输。",
      routeKey, order.domestic_warehouse_id || null, actorUserId || order.current_assignee_user_id || null, now, now,
      order.exit_port || null, order.customs_location || null, order.transit_locations || null,
      order.route_notes || null,
    ),
    env.DB.prepare(
      `INSERT INTO transport_batch_orders(
        id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at
      ) VALUES(?,?,?,?,1,'planned',?,?,?)`,
    ).bind(crypto.randomUUID(), organizationId, batchId, orderId, actorUserId, now, now),
  ]);
  return batchId;
}

async function ensureFtlBatchFromTracking(
  organizationId: string,
  orderId: string,
  actorUserId: string,
  milestoneCode: string,
  eventAt: string,
  location: string | null,
) {
  const linked = await linkedBatchContext(organizationId, orderId);
  const now = new Date().toISOString();
  let batchId = linked.batchId;
  if (!batchId) {
    const order = await env.DB.prepare(
      `SELECT order_number,origin_country,origin_state,origin_city,destination_country,destination_state,destination_city,
              exit_port,transit_locations,current_assignee_user_id
       FROM transport_orders WHERE organization_id=? AND id=? AND business_type='ftl'`,
    ).bind(organizationId, orderId).first<{
      order_number: string;
      origin_country: string;
      origin_state: string | null;
      origin_city: string;
      destination_country: string;
      destination_state: string | null;
      destination_city: string;
      exit_port: string | null;
      transit_locations: string | null;
      current_assignee_user_id: string | null;
    }>();
    if (!order) return;
    const seq = await env.DB.prepare(
      "SELECT COUNT(*)+1 next FROM transport_batches WHERE organization_id=? AND batch_number LIKE 'FTL-%'",
    ).bind(organizationId).first<{ next: number }>();
    batchId = crypto.randomUUID();
    const batchNumber = `FTL-${now.slice(0,10).replaceAll("-","")}-${String(seq?.next ?? 1).padStart(3,"0")}`;
    const origin = [order.origin_country, order.origin_state, order.origin_city].filter(Boolean).join(" ");
    const destination = [order.destination_country, order.destination_state, order.destination_city].filter(Boolean).join(" ");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,status,notes,route_key,created_by_user_id,created_at,updated_at,border_port,transit_location,road_status,actual_departure_at)
         VALUES(?,?,?,?,?,?,?,'departed',?,?,?,?,?,?,?,'outbound_in_transit',?)`,
      ).bind(
        batchId,
        organizationId,
        orderId,
        batchNumber,
        `${order.order_number} 整车直装`,
        origin,
        destination,
        "整车订单自动生成的直装批次，用于出境后状态同步",
        [order.origin_country, order.origin_state, order.origin_city, ">", order.destination_country, order.destination_state, order.destination_city].filter(Boolean).join("|").toLowerCase(),
        actorUserId || order.current_assignee_user_id || null,
        now,
        now,
        order.exit_port || location || null,
        order.transit_locations || null,
        eventAt,
      ),
      env.DB.prepare(
        "INSERT INTO transport_batch_orders(id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at) VALUES(?,?,?,?,1,'departed',?,?,?)",
      ).bind(crypto.randomUUID(), organizationId, batchId, orderId, actorUserId, now, now),
    ]);
  }
  const roadStatus =
    milestoneCode === "station_arrived"
      ? "overseas_arrived"
      : "outbound_in_transit";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE transport_batches
       SET status=CASE WHEN ?='overseas_arrived' THEN 'arrived' ELSE 'departed' END,
           road_status=?,
           actual_departure_at=COALESCE(actual_departure_at,?),
           actual_arrival_at=CASE WHEN ?='overseas_arrived' THEN COALESCE(actual_arrival_at,?) ELSE actual_arrival_at END,
           border_port=COALESCE(NULLIF(?,''),border_port),
           updated_at=?
       WHERE id=? AND organization_id=?`,
    ).bind(roadStatus, roadStatus, eventAt, roadStatus, eventAt, location || "", now, batchId, organizationId),
    env.DB.prepare(
      "UPDATE transport_batch_orders SET status=CASE WHEN ?='overseas_arrived' THEN 'arrived' ELSE 'departed' END,updated_at=? WHERE batch_id=? AND organization_id=? AND status!='removed'",
    ).bind(roadStatus, now, batchId, organizationId),
  ]);
  await syncOrderWorkflowSnapshot(organizationId, orderId);
}

async function syncBatchTrackingMilestonesFromOrder(
  organizationId: string,
  orderId: string,
  actorUserId: string,
) {
  const repairLimit = 8;
  const linkedOrderIds = await linkedBatchOrderIds(organizationId, orderId);
  if (linkedOrderIds.length <= 1) return;
  type SharedMilestone={
      milestone_code: string;
      milestone_name: string;
      event_at: string;
      location: string | null;
      vehicle_reference: string | null;
      notes: string | null;
      visible_to_customer: number;
      created_at: string;
  };
  const sharedByEvent=new Map<string,SharedMilestone>();
  for(const orderChunk of chunkD1Values(linkedOrderIds,1)){
    const milestones=await env.DB.prepare(
      `SELECT milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer,created_at
       FROM order_tracking_milestones
       WHERE organization_id=? AND order_id IN (${d1Placeholders(orderChunk.length)})
       ORDER BY event_at,created_at`,
    ).bind(organizationId,...orderChunk).all<SharedMilestone>();
    for(const item of milestones.results)if(batchSynchronizedTrackingMilestones.has(item.milestone_code)){
      const signature=`${item.milestone_code}\u0000${item.event_at}`;
      if(!sharedByEvent.has(signature))sharedByEvent.set(signature,item);
    }
  }
  const shared=[...sharedByEvent.values()];
  if (!shared.length) return;
  const now = new Date().toISOString();
  const insertResult=await env.DB.prepare(
    `WITH target_orders AS (
       SELECT DISTINCT CAST(value AS TEXT) order_id FROM json_each(?)
     ),
     shared_milestones AS (
       SELECT
         CAST(key AS INTEGER) source_order,
         CAST(json_extract(value,'$.milestone_code') AS TEXT) milestone_code,
         CAST(json_extract(value,'$.milestone_name') AS TEXT) milestone_name,
         CAST(json_extract(value,'$.event_at') AS TEXT) event_at,
         json_extract(value,'$.location') location,
         json_extract(value,'$.vehicle_reference') vehicle_reference,
         json_extract(value,'$.notes') notes,
         CAST(json_extract(value,'$.visible_to_customer') AS INTEGER) visible_to_customer,
         COALESCE(NULLIF(CAST(json_extract(value,'$.created_at') AS TEXT),''),?) created_at
       FROM json_each(?)
     ),
     insertable AS (
       SELECT *,ROW_NUMBER() OVER(
         PARTITION BY milestone_code,event_at ORDER BY source_order
       ) insert_rank
       FROM shared_milestones
     )
     INSERT INTO order_tracking_milestones(
       id,organization_id,order_id,milestone_code,milestone_name,event_at,
       location,vehicle_reference,notes,visible_to_customer,created_by_user_id,created_at
     )
     SELECT lower(hex(randomblob(16))),?,target.order_id,
       milestone.milestone_code,milestone.milestone_name,milestone.event_at,
       milestone.location,milestone.vehicle_reference,milestone.notes,
       milestone.visible_to_customer,?,milestone.created_at
     FROM target_orders target
     CROSS JOIN insertable milestone
     WHERE milestone.insert_rank=1 AND NOT EXISTS(
       SELECT 1 FROM order_tracking_milestones existing
       WHERE existing.organization_id=? AND existing.order_id=target.order_id
         AND existing.milestone_code=milestone.milestone_code
         AND existing.event_at=milestone.event_at
     )`,
  ).bind(
    JSON.stringify(linkedOrderIds),
    now,
    JSON.stringify(shared),
    organizationId,
    actorUserId,
    organizationId,
  ).run();
  const repairCandidates=await env.DB.prepare(
    `WITH target_orders AS (
       SELECT DISTINCT CAST(value AS TEXT) order_id FROM json_each(?)
     ),
     milestone_progress AS (
       SELECT target.order_id,
              MAX(CASE milestone.milestone_code
                WHEN 'departed' THEN 15
                WHEN 'border_arrived' THEN 28
                WHEN 'exported' THEN 40
                WHEN 'transloaded' THEN 46
                WHEN 'transit_customs' THEN 52
                WHEN 'foreign_entered' THEN 64
                WHEN 'customs_cleared' THEN 82
                WHEN 'station_arrived' THEN 100
                ELSE 0 END) progress
       FROM target_orders target
       JOIN order_tracking_milestones milestone
         ON milestone.organization_id=? AND milestone.order_id=target.order_id
        AND milestone.milestone_code IN (
          'departed','border_arrived','exported','transloaded',
          'transit_customs','foreign_entered','customs_cleared','station_arrived'
        )
       GROUP BY target.order_id
     )
     SELECT target.order_id
     FROM target_orders target
     JOIN milestone_progress progress ON progress.order_id=target.order_id
     JOIN order_module_instances module
       ON module.organization_id=? AND module.order_id=target.order_id
      AND module.module_code='tracking' AND module.enabled=1
     WHERE module.status!='completed'
       AND (
         COALESCE(module.progress_percent,0)<progress.progress
         OR module.status IN ('not_started','blocked','exception')
         OR (
           COALESCE(module.progress_percent,0)<=progress.progress
           AND COALESCE(module.current_step_code,'')<>CASE
             WHEN progress.progress>=100 THEN 'arrived'
             WHEN progress.progress>=82 THEN 'customs_cleared'
             WHEN progress.progress>=28 THEN 'transit'
             ELSE 'departed'
           END
         )
       )
     ORDER BY CASE WHEN target.order_id=? THEN 0 ELSE 1 END,target.order_id
     LIMIT ?`,
  ).bind(
    JSON.stringify(linkedOrderIds),
    organizationId,
    organizationId,
    orderId,
    repairLimit+1,
  ).all<{order_id:string}>();
  for (const candidate of repairCandidates.results.slice(0,repairLimit)) {
    await syncTrackingModuleFromMilestones(organizationId,candidate.order_id,actorUserId);
  }
  if(repairCandidates.results.length>repairLimit){
    console.info("Deferred linked tracking module repairs to a later bounded pass",{
      orderId,
      insertedMilestones:Number(insertResult.meta.changes||0),
      deferredCountAtLeast:repairCandidates.results.length-repairLimit,
    });
  }
}

async function syncBatchStateFromTrackingMilestones(
  organizationId: string,
  orderId: string,
  actorUserId: string,
) {
  const context = await linkedBatchContext(organizationId, orderId);
  if (!context.batchId || context.orderIds.length <= 1) return;

  await syncBatchRoadStatusFromTracking(
    organizationId,
    context.batchId,
    context.orderIds,
    new Date().toISOString(),
  );
  void actorUserId;
}

async function syncOverseasOperationFromBatch(
  organizationId: string,
  orderId: string,
  actorUserId: string,
) {
  const context = await linkedBatchContext(organizationId, orderId);
  if (!context.batchId) return;
  const batch = await env.DB.prepare(
    "SELECT id,road_status,actual_arrival_at FROM transport_batches WHERE id=? AND organization_id=? AND status!='cancelled'",
  )
    .bind(context.batchId, organizationId)
    .first<{ id: string; road_status: string; actual_arrival_at: string | null }>();
  if (!batch || !["overseas_arrived", "waiting_pickup", "pickup_completed"].includes(batch.road_status)) return;

  const orders = await env.DB.prepare(
    `SELECT bo.order_id,o.overseas_warehouse_id
     FROM transport_batch_orders bo
     JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'`,
  )
    .bind(organizationId, context.batchId)
    .all<{ order_id: string; overseas_warehouse_id: string | null }>();
  if (!orders.results.length) return;

  const now = new Date().toISOString();
  const arrivalAt = batch.actual_arrival_at || now;
  const statements = orders.results
    .filter((item) => item.overseas_warehouse_id)
    .flatMap((item) => [
      env.DB.prepare(
        `INSERT INTO overseas_warehouse_operations(id,organization_id,batch_id,order_id,warehouse_id,status,actual_arrival_at,updated_by_user_id,created_at,updated_at)
         VALUES(?,?,?,?,?,'arrived',?,?,?,?)
         ON CONFLICT(batch_id,order_id) DO UPDATE SET
           warehouse_id=COALESCE(overseas_warehouse_operations.warehouse_id,excluded.warehouse_id),
           status=CASE WHEN overseas_warehouse_operations.status='waiting_arrival' THEN 'arrived' ELSE overseas_warehouse_operations.status END,
           actual_arrival_at=COALESCE(overseas_warehouse_operations.actual_arrival_at,excluded.actual_arrival_at),
           updated_by_user_id=excluded.updated_by_user_id,
           updated_at=excluded.updated_at`,
      ).bind(
        crypto.randomUUID(),
        organizationId,
        context.batchId,
        item.order_id,
        item.overseas_warehouse_id,
        arrivalAt,
        actorUserId,
        now,
        now,
      ),
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status='in_progress',
             current_step_code='arrived',
             current_step_name='等待系统通知客户',
             progress_percent=MAX(progress_percent,25),
             started_at=COALESCE(started_at,?),
             blocking_reason=NULL,
             updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1 AND status!='completed'
           AND (COALESCE(progress_percent,0)<25 OR current_step_code='arrived')`,
      ).bind(now, now, organizationId, item.order_id),
    ]);
  if (!statements.length) return;
  await env.DB.batch(statements);
  for (const item of orders.results) {
    await automaticallyNotifyOverseasArrival({
      organizationId,
      orderId: item.order_id,
      actorUserId,
      occurredAt: arrivalAt,
    });
    await syncOrderWorkflowSnapshot(organizationId, item.order_id);
  }
}

export default function OrderModulePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { order, module, definition } = loaderData,
    busy = useNavigation().state !== "idle",
    manage =
      (canManageOrderModule(loaderData.current, definition.code) || canEditWorkflowDefinitionInUi(loaderData.current)) &&
      loaderData.access.canEdit,
    canApproveConsignment =
      isAssignedOrderApprover({
        status: order.status,
        currentAssigneeUserId: order.current_assignee_user_id,
        currentUserId: loaderData.current.userId,
      }) || (order.status === "submitted" && canEditWorkflowDefinitionInUi(loaderData.current));
  const actionMessage =
    actionData && "formError" in actionData
      ? actionData.formError
      : actionData && "success" in actionData
        ? actionData.success
        : null;
  const actionFailed = Boolean(actionData && "formError" in actionData);
  useEffect(() => {
    if (!actionData || !("success" in actionData) || !("actionKind" in actionData) || actionData.actionKind !== "transport_assignment") return;
    document.querySelector(".module-workflow-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [actionData]);
  const currentIndex = Math.max(
    0,
    definition.steps.findIndex(
      (step) => step.code === module.current_step_code,
    ),
  );
  const orderedModules = composeOrderWorkflow(loaderData.modules);
  const moduleIndex = orderedModules.findIndex(
    (item) => item.module_code === definition.code,
  );
  const nextModule =
    module.status === "completed" && moduleIndex >= 0
      ? orderedModules[moduleIndex + 1] ?? null
      : null;
  return (
    <>
      <header className="page-header module-page-header">
        <div>
          <p className="eyebrow">
            ORDER MODULE · {definition.code.toUpperCase()}
          </p>
          <h1>{definition.name}</h1>
          <p>
            <Link to={`/admin/orders/${order.id}`}>{order.order_number}</Link> ·{" "}
            {order.customer_name} · {order.origin_city} →{" "}
            {order.destination_city}
          </p>
        </div>
        <div className="page-actions">
          <span
            className={`status-pill ${["blocked", "exception"].includes(module.status) ? "danger" : module.status === "not_applicable" ? "off" : ""}`}
          >
            {moduleStatusLabels[module.status] ?? module.status}
          </span>
          {definition.code === "warehouse" && (
            <Form method="post" action="/switch-site" className="module-header-warehouse-form">
              <input type="hidden" name="target" value="warehouse" />
              <input
                type="hidden"
                name="warehouseTo"
                value={`/warehouse/acceptance?orderId=${order.id}&returnTo=${encodeURIComponent(`/admin/orders/${order.id}/modules/warehouse`)}`}
              />
              <button className="primary">进入仓库端</button>
            </Form>
          )}
          <Link className="secondary" to={`/admin/orders/${order.id}`}>
            返回订单中心
          </Link>
          {nextModule && (
            <Link
              className="primary"
              to={`/admin/orders/${order.id}/modules/${nextModule.module_code}`}
            >
              下一步：{nextModule.module_name}
            </Link>
          )}
        </div>
      </header>
      {actionMessage && (
        <div className={`alert ${actionFailed ? "error" : "success"}`}>
          {actionMessage}
        </div>
      )}
      {!loaderData.access.canEdit && (
        <div className="alert module-access-note">
          <strong>当前为只读状态</strong>
          <span>{loaderData.access.reason}</span>
        </div>
      )}
      <section className="panel module-workflow-panel">
        <div className="panel-header">
          <div>
            <h2>模块工作流</h2>
            <p>{definition.description}</p>
          </div>
          <strong>{module.progress_percent}%</strong>
        </div>
        <div className="module-progress-track">
          <i style={{ width: `${module.progress_percent}%` }} />
        </div>
        <div className="module-stepper">
          {definition.steps.map((step, index) => (
            <a
              key={step.code}
              href="#module-business-data"
              title={`前往“${step.name}”办理区域`}
              aria-label={`前往“${step.name}”办理区域`}
              className={
                index < currentIndex || module.status === "completed"
                  ? "completed"
                  : index === currentIndex
                    ? module.status === "blocked"
                      ? "blocked"
                      : "active"
                    : "pending"
              }
            >
              <b>
                {index < currentIndex || module.status === "completed"
                  ? "✓"
                  : index + 1}
              </b>
              <span>{step.name}</span>
              <small>
                {index < currentIndex || module.status === "completed"
                  ? index < definition.steps.length - 1
                    ? `已完成 · 下一步 ${definition.steps[index + 1].name}`
                    : nextModule
                      ? `已完成 · 下一模块 ${nextModule.module_name}`
                      : "已完成 · 返回订单中心"
                  : index === currentIndex
                    ? "当前办理 · 点击进入"
                    : "后续步骤 · 点击查看"}
              </small>
            </a>
          ))}
        </div>
        {definition.code !== "loading" && (
          <ModuleNextGuidance
            orderId={order.id}
            moduleStatus={module.status}
            steps={definition.steps}
            currentIndex={currentIndex}
            nextModule={nextModule}
          />
        )}
        {module.blocking_reason && (
          <div className="module-blocker">
            <strong>当前阻断原因</strong>
            <span>{module.blocking_reason}</span>
          </div>
        )}
      </section>
      <div className="module-detail-grid">
        <section className="panel" id="module-business-data">
          <div className="panel-header">
            <div>
              <h2>{definition.code === "loading" ? "仓库作业状态" : "1. 模块业务数据"}</h2>
              <p>
                {definition.code === "loading"
                  ? "本页只读展示仓库端配载、装车和出库结果。"
                  : "先按页面从上到下完成业务资料和实际操作。"}
              </p>
            </div>
          </div>
          {loaderData.workflowStageAccess.available || canApproveConsignment ? (
            <>
              {definition.code !== "loading" && definition.code !== "overseas_warehouse" && (
                <ModuleSourceDocuments
                  code={definition.code}
                  data={loaderData}
                  manage={manage}
                  canApproveConsignment={canApproveConsignment}
                  busy={busy}
                  reviewCloseSignal={
                    actionData && "documentReviewSignal" in actionData
                      ? actionData.documentReviewSignal
                      : undefined
                  }
                />
              )}
              <ModuleBusinessData
                code={definition.code}
                data={loaderData}
                manage={manage}
                canApproveConsignment={canApproveConsignment}
                busy={busy}
                reviewCloseSignal={
                  actionData && "documentReviewSignal" in actionData
                    ? actionData.documentReviewSignal
                    : undefined
                }
              />
              {!(["consignment", "transport", "loading"] as OrderModuleCode[]).includes(definition.code) && (
                <WorkflowFieldChecklist
                  fields={loaderData.workflowFields.filter(
                    (field) =>
                      !field.isBuiltIn &&
                      (definition.code !== "assignment" ||
                        !assignmentNativeFieldKeys.has(field.fieldKey)),
                  )}
                  manage={manage}
                  busy={busy}
                />
              )}
            </>
          ) : (
            <div className="module-future-stage">
              <strong>本模块将在后续阶段开放</strong>
              <p>{loaderData.workflowStageAccess.reason}</p>
              <Link className="secondary" to={`/admin/orders/${order.id}`}>
                返回订单中心查看当前节点
              </Link>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

export function EmbeddedOrderModule({
  data,
  busy,
  actionUrl,
  workflowStepKey,
  consignmentSection = "info",
  hideConsignmentActionBar = false,
  approvalMode = false,
  reviewCloseSignal,
}: {
  data: Route.ComponentProps["loaderData"];
  busy: boolean;
  actionUrl: string;
  workflowStepKey?: string | null;
  consignmentSection?: "info" | "files" | "costs";
  hideConsignmentActionBar?: boolean;
  approvalMode?: boolean;
  reviewCloseSignal?: unknown;
}) {
  const scopedData = {
    ...data,
    workflowFields: workflowFieldsForStep(
      data.workflowFields,
      workflowStepKey ?? data.workflowStageAccess.currentStepKey,
    ),
  };
  const { order, definition } = scopedData;
  const manage =
    (canManageOrderModule(scopedData.current, definition.code) || canEditWorkflowDefinitionInUi(scopedData.current)) && scopedData.access.canEdit;
  const canApproveConsignment = isAssignedOrderApprover({
    status: order.status,
    currentAssigneeUserId: order.current_assignee_user_id,
    currentUserId: scopedData.current.userId,
  }) || (order.status === "submitted" && canEditWorkflowDefinitionInUi(scopedData.current));
  const compactApproval = definition.code === "consignment" && approvalMode && order.status === "submitted";

  if (!scopedData.workflowStageAccess.available && !canApproveConsignment) {
    return (
      <div className="module-future-stage">
        <strong>当前节点尚未开放办理</strong>
        <p>{scopedData.workflowStageAccess.reason}</p>
      </div>
    );
  }

  return (
    <embeddedModuleFormAction.Provider value={actionUrl}>
      <div className="linear-module-embedded" id="module-business-data">
        {!scopedData.access.canEdit && (
          <div className="alert module-access-note">
            <strong>当前为只读状态</strong>
            <span>{scopedData.access.reason}</span>
          </div>
        )}
        {!compactApproval && definition.code !== "loading" &&
          definition.code !== "overseas_warehouse" &&
          (definition.code !== "consignment" ||
            !hideConsignmentActionBar ||
            consignmentSection === "files") && (
          <ModuleSourceDocuments
            code={definition.code}
            data={scopedData}
            manage={manage}
            canApproveConsignment={canApproveConsignment}
            busy={busy}
            reviewCloseSignal={reviewCloseSignal}
          />
        )}
        {compactApproval ? (
          <OrderApprovalReview
            data={scopedData}
            manage={manage}
            canApproveConsignment={canApproveConsignment}
            busy={busy}
          />
        ) : (
          <ModuleBusinessData
            code={definition.code}
            data={scopedData}
            manage={manage}
            canApproveConsignment={canApproveConsignment}
            busy={busy}
            reviewCloseSignal={reviewCloseSignal}
            consignmentSection={definition.code === "consignment" && hideConsignmentActionBar ? consignmentSection : undefined}
            showConsignmentActionBar={!hideConsignmentActionBar}
          />
        )}
        {!(["consignment", "transport", "loading"] as OrderModuleCode[]).includes(definition.code) && (
          <WorkflowFieldChecklist
            fields={scopedData.workflowFields.filter(
              (field) =>
                !field.isBuiltIn &&
                (definition.code !== "assignment" ||
                  !assignmentNativeFieldKeys.has(field.fieldKey)),
            )}
            manage={manage}
            busy={busy}
          />
        )}
      </div>
    </embeddedModuleFormAction.Provider>
  );
}

export function ConsignmentReviewActionBar({
  data,
  busy,
}: {
  data: Route.ComponentProps["loaderData"];
  busy: boolean;
}) {
  const manage =
    (canManageOrderModule(data.current, "consignment") || canEditWorkflowDefinitionInUi(data.current)) && data.access.canEdit;
  const canApproveConsignment = isAssignedOrderApprover({
    status: data.order.status,
    currentAssigneeUserId: data.order.current_assignee_user_id,
    currentUserId: data.current.userId,
  }) || (data.order.status === "submitted" && canEditWorkflowDefinitionInUi(data.current));

  if (manage && data.order.status === "draft") {
    return (
      <Form method="post" className="consignment-submit-bar">
        <div>
          <strong>委托资料复核完成后，直接提交审批</strong>
          <span>系统只检查当前有效必填项；选填项和已停用的旧字段不会阻断。</span>
        </div>
        <div>
          <input type="hidden" name="intent" value="workflow_action" />
          <input type="hidden" name="actionCode" value="submit" />
          <OrganizationAssigneePicker
            members={data.members}
            name="assigneeUserId"
            idPrefix="consignment-approver"
            personLabel="审批负责人"
          />
          <button className="primary" disabled={busy}>提交审批</button>
        </div>
      </Form>
    );
  }
  if (canApproveConsignment) {
    return (
      <Form method="post" className="consignment-submit-bar">
        <div>
          <strong>委托资料审批</strong>
          <span>请核对委托信息、货物信息、订单费用和委托书后审批。</span>
        </div>
        <div>
          <input type="hidden" name="intent" value="workflow_action" />
          <input type="hidden" name="actionCode" value="approve" />
          <button className="primary" disabled={busy || !data.cargo.length}>审批通过</button>
        </div>
      </Form>
    );
  }
  return null;
}

function ModuleNextGuidance({
  orderId,
  moduleStatus,
  steps,
  currentIndex,
  nextModule,
}: {
  orderId: string;
  moduleStatus: string;
  steps: { code: string; name: string }[];
  currentIndex: number;
  nextModule: {
    module_code: string;
    module_name: string;
    current_step_name: string | null;
  } | null;
}) {
  const completedStep =
    moduleStatus === "completed"
      ? steps[steps.length - 1]
      : currentIndex > 0
        ? steps[currentIndex - 1]
        : null;
  const currentStep =
    moduleStatus === "completed" ? null : steps[currentIndex] ?? steps[0];
  if (moduleStatus === "completed" && nextModule)
    return (
      <div className="module-next-guidance">
        <span>✓ “{completedStep?.name || "本模块"}”已完成。</span>
        <Link
          to={`/admin/orders/${orderId}/modules/${nextModule.module_code}#module-business-data`}
        >
          下一步：进入“{nextModule.module_name}”，办理“{nextModule.current_step_name || "当前节点"}” →
        </Link>
        <small>进入后按页面从上到下保存业务数据，系统会按已保存事实自动同步节点。</small>
      </div>
    );
  if (moduleStatus === "completed")
    return (
      <div className="module-next-guidance">
        <span>✓ “{completedStep?.name || "本模块"}”已完成。</span>
        <Link to={`/admin/orders/${orderId}`}>
          下一步：返回订单中心，确认签收及其他必经模块均已完成 →
        </Link>
        <small>订单出境后进入“费用结算”，分别办理应收/应付对账、发票、收付款和核销。</small>
      </div>
    );
  return (
    <div className="module-next-guidance">
      {completedStep ? (
        <span>✓ “{completedStep.name}”已完成。</span>
      ) : (
        <span>当前从“{currentStep?.name || "业务办理"}”开始。</span>
      )}
      <a href="#module-business-data">
        下一步：进入下方业务数据，办理“{currentStep?.name || "当前节点"}” ↓
      </a>
      <small>完成实际业务记录并保存后，能自动判断的节点会自动推进。</small>
    </div>
  );
}

function WorkflowFieldChecklist({
  fields,
  manage,
  busy,
  compact = false,
}: {
  fields: WorkflowFieldState[];
  manage: boolean;
  busy: boolean;
  compact?: boolean;
}) {
  const visible = fields.filter((field) => field.isActive);
  if (!visible.length) return null;
  const missing = visible.filter((field) => field.isRequired && !field.present);
  if (compact) {
    return (
      <section className="workflow-field-checklist compact" aria-label="当前模块字段要求">
        <div>
          <strong>补充业务字段</strong>
          <small>
            必填 {visible.filter((field) => field.isRequired).length} 项 · 选填 {visible.filter((field) => !field.isRequired).length} 项；本页集中显示已有内容，空白项表示尚未填写。
          </small>
        </div>
        <span className={`status-pill ${missing.length ? "danger" : "success"}`}>
          {missing.length ? `缺 ${missing.length} 项必填` : "必填项已齐"}
        </span>
      </section>
    );
  }
  return (
    <section className="workflow-field-checklist workflow-field-form-sheet order-create-section" aria-label="当前模块字段要求">
      <header>
        <div>
          <strong>补充业务字段</strong>
          <small>工作流模板为当前节点增加的填写项</small>
        </div>
        <span>{missing.length ? `还有 ${missing.length} 项必填内容未完成` : "必填内容已完成"}</span>
      </header>
      <div className="order-create-table-grid workflow-requirement-form-grid">
        {visible.map((field) =>
          field.isBuiltIn ? (
            <a
              className={`field workflow-requirement-cell${field.present ? " ready" : field.isRequired ? " missing" : ""}`}
              href={`#workflow-field-${field.fieldKey}`}
              key={field.id}
            >
              <span>
                {field.label}
                {field.isRequired && <b className="required-mark" aria-label="必填">*</b>}
              </span>
              <strong>{field.displayValue || ""}</strong>
              <small>{field.present ? "查看或修改" : field.isRequired ? "填写" : "选填"}</small>
            </a>
          ) : (
            <div className={`field workflow-requirement-cell${field.present ? " ready" : field.isRequired ? " missing" : ""}`} key={field.id}>
              <span>
                {field.label}
                {field.isRequired && <b className="required-mark" aria-label="必填">*</b>}
              </span>
              {manage ? <CustomWorkflowFieldForm field={field} busy={busy} /> : <strong>{field.displayValue || ""}</strong>}
              <small className="workflow-field-runtime-source">来源节点：{field.stepName || field.stepKey} · <Link to={workflowFieldConfigurationHref({workflowId:field.workflowId,stepKey:field.stepKey,moduleCode:field.moduleCode,fieldKey:field.fieldKey})}>配置显示规则</Link></small>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function CustomWorkflowFieldForm({ field, busy }: { field: WorkflowFieldState; busy: boolean }) {
  const options = (field.optionsText || "")
    .split(/\r?\n|,/)
    .map((option) => option.trim())
    .filter(Boolean)
    .map((option) => {
      const [value, label] = option.split("|");
      return { value, label: label || value };
    });
  const type = field.fieldType === "datetime" ? "datetime-local" : field.fieldType === "amount" ? "number" : field.fieldType;
  return (
    <Form method="post" className="workflow-custom-field-form">
      <input type="hidden" name="intent" value="workflow_field_save" />
      <input type="hidden" name="fieldId" value={field.id} />
      {field.fieldType === "textarea" ? (
        <textarea name="fieldValue" defaultValue={field.displayValue || ""} required={field.isRequired} rows={2} />
      ) : ["select", "multiselect"].includes(field.fieldType) && options.length ? (
        <select name="fieldValue" defaultValue={field.displayValue || ""} required={field.isRequired}>
          <option value="">请选择</option>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : (
        <input
          name="fieldValue"
          type={["number", "date", "datetime-local"].includes(type) ? type : "text"}
          step={type === "number" ? "any" : undefined}
          defaultValue={field.displayValue || ""}
          required={field.isRequired}
        />
      )}
      <button className="secondary" disabled={busy}>保存</button>
    </Form>
  );
}

function workflowFieldPolicy(
  fields: WorkflowFieldState[],
  fieldKey: string,
  fallbackRequired = false,
) {
  return runtimeWorkflowFieldPolicy(fields, fieldKey, fallbackRequired);
}

function ModuleField({
  fields,
  fieldKey,
  label,
  className = "field",
  fallbackRequired = false,
  children,
}: {
  fields: WorkflowFieldState[];
  fieldKey: string;
  label: string;
  className?: string;
  fallbackRequired?: boolean;
  children: (required: boolean) => ReactNode;
}) {
  const policy = workflowFieldPolicy(fields, fieldKey, fallbackRequired);
  if (!policy.visible) return null;
  return (
    <label id={`workflow-field-${fieldKey}`} className={className} data-workflow-field={fieldKey}>
      <span>
        {policy.label || label}
        {policy.required && (
          <b className="required-mark" aria-label="必填">
            *
          </b>
        )}
      </span>
      {children(policy.required)}
    </label>
  );
}

function WorkflowInfo({
  fields,
  fieldKey,
  label,
  value,
  className,
}: {
  fields: WorkflowFieldState[];
  fieldKey: string;
  label: string;
  value: string;
  className?: string;
}) {
  const policy = workflowFieldPolicy(fields, fieldKey);
  if (!policy.visible) return null;
  const configured = fields.find((field) => field.fieldKey === fieldKey);
  const present = configured ? configured.present : Boolean(value.trim());
  const state = present ? (policy.required ? "filled" : undefined) : policy.required ? "required-missing" : "optional-empty";
  return (
    <Info
      label={`${policy.label || label}${policy.required ? " *" : ""}`}
      value={value}
      className={[className, "workflow-info-cell", state].filter(Boolean).join(" ")}
      state={state}
    />
  );
}

function DocumentReviewPreview({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.content_type.startsWith("image/");
  const isPdf = attachment.content_type === "application/pdf";
  return <section className="document-review-preview">
    <header>
      <div>
        <strong>{attachment.file_name}</strong>
        <span>{(attachment.size_bytes / 1024).toFixed(1)} KB · {attachment.description || "无文件说明"}</span>
      </div>
      <span className="status-pill">{documentReviewLabel(attachment.review_status)}</span>
    </header>
    <div className={`document-review-canvas ${!isImage && !isPdf ? "unsupported" : ""}`}>
      {isImage && <img src={`/admin/document-files/order/${attachment.id}?mode=view`} alt={attachment.file_name} loading="lazy" />}
      {isPdf && <object data={`/admin/document-files/order/${attachment.id}?mode=view`} type="application/pdf" aria-label={attachment.file_name}>
        <p>PDF 无法在当前浏览器内预览，请使用下方按钮打开。</p>
      </object>}
      {!isImage && !isPdf && <div className="document-review-fallback">
        <strong>当前文件格式不支持页内预览</strong>
        <span>请打开或下载原文件后审核。</span>
      </div>}
    </div>
    <footer className="row-actions">
      <a className="secondary" href={`/admin/document-files/order/${attachment.id}?mode=view`} target="_blank" rel="noreferrer">在新窗口打开</a>
      <a className="secondary" href={`/admin/document-files/order/${attachment.id}`}>下载原文件</a>
    </footer>
  </section>;
}

function documentReviewCloseSignal(signal: unknown, attachmentId: string) {
  return typeof signal === "string" && signal.startsWith(`${attachmentId}:`)
    ? signal
    : undefined;
}

function ModuleSourceDocuments({
  code,
  data,
  manage,
  canApproveConsignment,
  busy,
  reviewCloseSignal,
}: {
  code: OrderModuleCode;
  data: Route.ComponentProps["loaderData"];
  manage: boolean;
  canApproveConsignment: boolean;
  busy: boolean;
  reviewCloseSignal?: unknown;
}) {
  if (code === "documents" || code === "transport") return null;
  const placements = orderDocumentsForModule(code)
    .map((placement) => ({
      ...placement,
      policy: workflowFieldPolicy(
        data.workflowFields,
        placement.fieldKey,
        placement.requiredByDefault,
      ),
    }))
    .filter((placement) => {
      if (placement.documentCode === "transshipment_order" && !data.order.requires_transloading)
        return false;
      if (code !== "overseas_warehouse") return true;
      const operationStatus = data.overseasOperation?.status;
      return operationStatus === "picked_up";
    })
    .filter((placement) => placement.policy.visible);
  if (!placements.length) return null;
  const canEditDocs = code !== "loading" && manage;

  return (
    <section className="source-document-section" id="module-source-documents" aria-label="本节点文件">
      <header>
        <div>
          <h3>{code === "loading" ? "装车出库前文件门禁" : "本节点文件"}</h3>
          <p>{code === "loading" ? "发票、装箱单与报关资料由仓库端在创建装车任务时上传、预览并确认；管理后台只读同步文件与审核状态。" : "文件在实际取得的业务节点上传，上传后自动汇总到文件中心查看和归档。"}</p>
        </div>
        {code !== "loading" && <Link className="secondary" to={`/admin/orders/${data.order.id}/modules/documents`}>
          查看文件汇总
        </Link>}
      </header>
      <div className="source-document-grid">
        {placements.map((placement) => {
          const files = data.attachments.filter(
            (attachment) => attachment.document_category === placement.documentCode,
          );
          const latest = files[0];
          const ready = files.some((file) =>
            ["approved", "archived"].includes(file.review_status || ""),
          );
          const pendingReview = latest?.review_status === "pending";
          const rejected = latest?.review_status === "rejected";
          const documentState = ready
            ? "filled"
            : pendingReview
              ? "optional-empty"
              : rejected || placement.policy.required
                ? "required-missing"
                : "optional-empty";
          const documentStateLabel = ready
            ? "已填"
            : pendingReview
              ? "已上传待审核"
              : rejected
                ? "审核退回"
                : placement.policy.required
                  ? "必填但未填"
                  : "未填";
          const lockedAfterApproval =
            placement.documentCode === "consignment_letter" &&
            ["approved", "archived"].includes(latest?.review_status || "");
          const canReviewDocument =
            code !== "loading" &&
            (placement.documentCode === "consignment_letter"
              ? canApproveConsignment
              : manage);
          return (
            <article
              key={placement.documentCode}
              className={`source-document-row ${ready && placement.policy.required ? "ready" : pendingReview ? "optional-empty" : rejected || placement.policy.required ? "required-missing" : "optional-empty"}`}
            >
              <div className="source-document-name">
                <strong>
                  {placement.document.name}
                  {placement.policy.required && (
                    <b className="required-mark" aria-label="必填">*</b>
                  )}
                </strong>
                <small>{placement.document.hint}</small>
              </div>
              <div className="source-document-current">
                <span className={`field-state ${documentState}`}>
                  {documentStateLabel}
                </span>
                <small title={latest?.file_name}>{latest ? `${latest.file_name} · ${documentReviewLabel(latest.review_status)}` : "尚无文件"}</small>
              </div>
              {latest ? <div className="row-actions source-document-actions">
                <a className="text-button" href={`/admin/document-files/order/${latest.id}?mode=view`} target="_blank" rel="noreferrer">查看</a>
                {canEditDocs && !lockedAfterApproval ? <Modal title={`编辑文件 · ${placement.document.name}`} triggerLabel="编辑" triggerClassName="text-button">
                  <div className="stack">
                    <Form method="post" className="stack">
                      <input type="hidden" name="intent" value="document_metadata_update" />
                      <input type="hidden" name="attachmentId" value={latest.id} />
                      <label className="field"><span>文件说明</span><textarea name="documentDescription" rows={3} defaultValue={latest.description || ""} placeholder="版本、用途或补充说明" /></label>
                      <label className="field"><span>客户可见范围</span><select name="publicToCustomer" defaultValue={latest.public_to_customer ? "1" : "0"}><option value="0">仅内部</option><option value="1">客户门户可见</option></select></label>
                      <button className="primary" disabled={busy}>保存文件信息</button>
                    </Form>
                    <Form method="post" encType="multipart/form-data" className="stack document-replace-form">
                      <input type="hidden" name="intent" value="document_upload" />
                      <input type="hidden" name="documentCategory" value={placement.documentCode} />
                      <input type="hidden" name="documentDescription" value={latest.description || ""} />
                      <input type="hidden" name="publicToCustomer" value={latest.public_to_customer ? "1" : "0"} />
                      <label className="field"><span>替换文件</span><input name="attachments" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required /></label>
                      <button className="secondary" disabled={busy}>上传替换文件</button>
                    </Form>
                  </div>
                </Modal> : code !== "loading" ? <button type="button" className="text-button" disabled title={lockedAfterApproval ? "委托书已审核通过，不可编辑" : undefined}>编辑</button> : null}
                {canReviewDocument && !lockedAfterApproval ? <Modal key={`review:${latest.id}:${documentReviewCloseSignal(reviewCloseSignal, latest.id) ?? "idle"}`} title={`审核文件 · ${placement.document.name}`} triggerLabel="审核" triggerClassName="text-button" size="wide" closeSignal={documentReviewCloseSignal(reviewCloseSignal, latest.id)}>
                  <Form method="post" className="stack">
                    <input type="hidden" name="intent" value="document_review" />
                    <input type="hidden" name="attachmentId" value={latest.id} />
                    <DocumentReviewPreview attachment={latest} />
                    <label className="field"><span>审核结果</span><select name="reviewStatus" defaultValue={latest.review_status === "rejected" ? "rejected" : "approved"}><option value="approved">审核通过</option><option value="rejected">退回修改</option></select></label>
                    <button className="primary" disabled={busy}>确认审核结果</button>
                  </Form>
                </Modal> : code !== "loading" ? <button type="button" className="text-button" disabled title={lockedAfterApproval ? "委托书已审核通过" : placement.documentCode === "consignment_letter" ? "仅当前指定的审批负责人可审核" : undefined}>审核</button> : <span className="muted">仓库已同步</span>}
              </div> : canEditDocs ? <Form method="post" encType="multipart/form-data" className="source-document-upload-form">
                <input type="hidden" name="intent" value="document_upload" />
                <input type="hidden" name="documentCategory" value={placement.documentCode} />
                <input type="hidden" name="documentDescription" value="" />
                <input type="hidden" name="publicToCustomer" value="0" />
                <label className="document-upload-button">
                  <input className="document-upload-input" name="attachments" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required disabled={busy} onChange={(event) => { if (event.currentTarget.files?.length) submitForm(event.currentTarget.form); }} />
                  <span>{busy ? "正在上传…" : "选择并上传"}</span>
                </label>
              </Form> : <span className="muted">只读</span>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AssignmentManifestWorkbench({
  modules,
  members,
  mainAssigneeUserId,
  canSubmit,
  busy,
}: {
  modules: Route.ComponentProps["loaderData"]["modules"];
  members: Member[];
  mainAssigneeUserId: string;
  canSubmit: boolean;
  busy: boolean;
}) {
  const moduleLabels: Record<string, string> = {
    transport: "国内运输",
    tracking: "出境运输",
    costs: "对账结算",
  };
  const [assignees, setAssignees] = useState<Record<string, string>>(() =>
    Object.fromEntries(modules.map((module) => [module.module_code, module.assignee_user_id || ""])),
  );
  const [mainAssignee, setMainAssignee] = useState(mainAssigneeUserId);

  return (
    <Form method="post" className="assignment-manifest">
      <input type="hidden" name="intent" value="assign_manifest_confirm" />
      <div className="assignment-manifest-gate">
        <span>!</span>
        <p>本节点必须由主管把每个业务模组分配到具体人员；确认后才进入国内运输。</p>
      </div>
      <section className="assignment-manifest-section">
        <header><strong>业务模组负责人</strong><span>按业务顺序流转到具体人员</span></header>
        <div className="table-wrap">
          <table className="assignment-manifest-table">
            <thead><tr><th>业务模组</th><th>执行人（部门 → 岗位 → 个人）</th><th>顺序</th><th>状态</th></tr></thead>
            <tbody>
              {modules.map((module, index) => {
                return <tr key={module.id}>
                  <td><strong>{moduleLabels[module.module_code] || module.module_name}</strong><small>{module.current_step_name || "未开始"}</small></td>
                  <td><OrganizationAssigneePicker
                    members={members}
                    name={`moduleAssignee_${module.module_code}`}
                    idPrefix={`module-assignee-${module.module_code}`}
                    value={assignees[module.module_code] || ""}
                    onChange={(nextAssignee) => {
                      setAssignees((current) => ({ ...current, [module.module_code]: nextAssignee }));
                    }}
                    personLabel="具体负责人"
                  /></td>
                  <td>{String(index + 1).padStart(2, "0")}</td>
                  <td><span className={`assignment-row-status${assignees[module.module_code] ? " ready" : ""}`}>{assignees[module.module_code] ? "待确认" : "待分配"}</span></td>
                </tr>;
              })}
              {!modules.length && <tr><td colSpan={4} className="empty-state">当前没有需要分配的业务模组</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="assignment-manifest-section assignment-manifest-extra">
        <header><strong>派单补充</strong><span>办理期限第一期不显示</span></header>
        <div className="assignment-manifest-fields">
          <OrganizationAssigneePicker
            members={members}
            name="assigneeUserId"
            idPrefix="assignment-main-assignee"
            value={mainAssignee}
            onChange={setMainAssignee}
            personLabel="主操作员"
          />
          <label className="wide"><span>派单说明</span><textarea className="control filled" name="notes" rows={2} placeholder="如需特别说明可填写" /></label>
        </div>
      </section>
      <footer className="assignment-manifest-footer">
        <div><strong>确认派单并进入国内运输</strong><span>系统保存全部负责人后推进订单，不再需要逐行点击保存。</span></div>
        <button className="primary" disabled={busy || !canSubmit || !modules.length}>确认派单并进入国内运输 →</button>
      </footer>
    </Form>
  );
}

type WorkflowDisplayItem = {
  fieldKey: string;
  label: string;
  value: ReactNode;
  present: boolean;
};

function WorkflowFieldValueList({
  fields,
  items,
}: {
  fields: WorkflowFieldState[];
  items: WorkflowDisplayItem[];
}) {
  const visibleItems = items.filter((item) =>
    workflowFieldPolicy(fields, item.fieldKey).visible,
  );
  if (!visibleItems.length) return null;
  return <div className="cargo-workflow-values">
    {visibleItems.map((item) => {
      const policy = workflowFieldPolicy(fields, item.fieldKey);
      return <div
        className={policy.required && !item.present ? "required-missing" : item.present ? "filled" : "optional-empty"}
        data-workflow-field={item.fieldKey}
        key={item.fieldKey}
      >
        <small>{policy.label || item.label}{policy.required ? " *" : ""}</small>
        <strong>{item.present ? item.value : "—"}</strong>
      </div>;
    })}
  </div>;
}

function cargoWorkflowDisplayItems(item: Cargo): WorkflowDisplayItem[] {
  const text = (value: string | null | undefined) => Boolean(value?.trim());
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  return [
    { fieldKey: "cargo_name_cn", label: "中文品名", value: item.cargo_name_cn, present: text(item.cargo_name_cn) },
    { fieldKey: "cargo_name_en", label: "英文品名", value: item.cargo_name_en, present: text(item.cargo_name_en) },
    { fieldKey: "hs_code", label: "国内 HS Code", value: item.hs_code, present: text(item.hs_code) },
    { fieldKey: "overseas_hs_code", label: "境外 HS Code", value: item.overseas_hs_code, present: text(item.overseas_hs_code) },
    { fieldKey: "package_type", label: "包装类型", value: warehousePackageTypeLabel(item.package_type), present: text(item.package_type) },
    { fieldKey: "package_count", label: "包装数", value: item.package_count, present: positive(item.package_count) },
    { fieldKey: "pieces_per_package", label: "每包装件数", value: item.pieces_per_package, present: positive(item.pieces_per_package) },
    { fieldKey: "gross_weight_per_package_kg", label: "单包装毛重 KG", value: `${item.gross_weight_per_package_kg} KG`, present: positive(item.gross_weight_per_package_kg) },
    { fieldKey: "net_weight_per_package_kg", label: "单包装净重 KG", value: `${item.net_weight_per_package_kg} KG`, present: positive(item.net_weight_per_package_kg) },
    { fieldKey: "length_cm", label: "长度 CM", value: `${item.length_cm} CM`, present: positive(item.length_cm) },
    { fieldKey: "width_cm", label: "宽度 CM", value: `${item.width_cm} CM`, present: positive(item.width_cm) },
    { fieldKey: "height_cm", label: "高度 CM", value: `${item.height_cm} CM`, present: positive(item.height_cm) },
    { fieldKey: "volume_per_package_cbm", label: "单包装体积 CBM", value: `${item.volume_per_package_cbm.toFixed(4)} CBM`, present: positive(item.volume_per_package_cbm) },
    { fieldKey: "declared_value", label: "申报货值", value: item.declared_value.toLocaleString(), present: positive(item.declared_value) },
    { fieldKey: "currency", label: "货值币种", value: item.currency, present: text(item.currency) },
    { fieldKey: "origin_country_cargo", label: "货物原产国", value: item.origin_country, present: text(item.origin_country) },
    { fieldKey: "brand_model", label: "品牌 / 型号", value: item.brand_model, present: text(item.brand_model) },
    { fieldKey: "marks", label: "唛头", value: item.marks, present: text(item.marks) },
    { fieldKey: "special_attributes", label: "货物属性", value: item.special_attributes, present: text(item.special_attributes) },
    { fieldKey: "cargo_images", label: "货物图片", value: `${item.image_count} 张`, present: item.image_count > 0 },
    { fieldKey: "cargo_notes", label: "货物备注", value: item.notes, present: text(item.notes) },
  ];
}

function CargoWorkflowData({
  data,
}: {
  data: Route.ComponentProps["loaderData"];
}) {
  const fields = data.workflowFields;
  const visibleGroups = cargoDetailFieldGroups.filter((group) =>
    hasVisibleRuntimeWorkflowField(fields, group.fieldKeys),
  );
  const showQuotationSummary = hasVisibleRuntimeWorkflowField(
    fields,
    quotationCargoPresentationKeys,
  );
  const showDetailFields = visibleGroups.length > 0;
  const totalPackages = data.cargo.reduce((sum, item) => sum + item.package_count, 0);
  const totalWeight = data.cargo.reduce(
    (sum, item) => sum + item.package_count * item.gross_weight_per_package_kg,
    0,
  );
  const totalVolume = data.cargo.reduce(
    (sum, item) => sum + item.package_count * item.volume_per_package_cbm,
    0,
  );
  return <div className="module-business-stack">
    {showQuotationSummary && <WorkflowInformationGroup
      title="询价报价确认的货物摘要"
      hint="以下内容来自订单锁定的询价报价节点，并严格按该工作流版本的显示和必填规则呈现。"
      fields={fields}
      items={[
        { fieldKey: "quotation_cargo_description", label: "货物描述", value: data.order.quotation_cargo_description || "" },
        { fieldKey: "quotation_notes", label: "报价备注", value: data.order.quotation_notes || "" },
        { fieldKey: "quotation_pieces", label: "预计件数", value: data.order.quotation_pieces ? `${data.order.quotation_pieces} 件` : "" },
        { fieldKey: "quotation_gross_weight_kg", label: "预计重量 KG", value: data.order.quotation_gross_weight_kg ? `${data.order.quotation_gross_weight_kg} KG` : "" },
        { fieldKey: "quotation_length_cm", label: "预计长度 CM", value: data.order.quotation_length_cm ? `${data.order.quotation_length_cm} CM` : "" },
        { fieldKey: "quotation_width_cm", label: "预计宽度 CM", value: data.order.quotation_width_cm ? `${data.order.quotation_width_cm} CM` : "" },
        { fieldKey: "quotation_height_cm", label: "预计高度 CM", value: data.order.quotation_height_cm ? `${data.order.quotation_height_cm} CM` : "" },
        { fieldKey: "quotation_volume_cbm", label: "预计体积 CBM", value: data.order.quotation_volume_cbm ? `${data.order.quotation_volume_cbm} CBM` : "" },
      ]}
    />}
    <WorkflowInformationGroup
      title="货物明细合计"
      hint="合计值只在对应明细字段设置为显示时出现；隐藏字段的数据仍保留审计，不在页面泄露。"
      fields={fields}
      items={[
        { fieldKey: "cargo_name_cn", label: "货物明细", value: data.cargo.length ? `${data.cargo.length} 条` : "" },
        { fieldKey: "package_count", label: "包装数", value: totalPackages ? `${totalPackages} 箱/托/件` : "" },
        { fieldKey: "gross_weight_per_package_kg", label: "总毛重", value: totalWeight ? `${totalWeight.toFixed(3)} KG` : "" },
        { fieldKey: "volume_per_package_cbm", label: "总体积", value: totalVolume ? `${totalVolume.toFixed(4)} CBM` : "" },
      ]}
    />
    {showDetailFields ? <div className="table-wrap module-record-table cargo-workflow-table">
      <table>
        <thead><tr>{visibleGroups.map((group) => <th key={group.label}>{group.label}</th>)}</tr></thead>
        <tbody>
          {data.cargo.map((item) => {
            const displayItems = cargoWorkflowDisplayItems(item);
            return <tr key={item.id}>{visibleGroups.map((group) => <td key={group.label}>
              <WorkflowFieldValueList
                fields={fields}
                items={displayItems.filter((displayItem) => group.fieldKeys.some((fieldKey) => fieldKey === displayItem.fieldKey))}
              />
            </td>)}</tr>;
          })}
          {!data.cargo.length && <tr><td colSpan={visibleGroups.length} className="empty-state">暂无货物明细。</td></tr>}
        </tbody>
      </table>
    </div> : (
      <div className="alert workflow-hidden-data-note">
        当前工作流已将委托资料补充中的货物明细字段全部设为隐藏；历史数据仍保留，只是不在本节点显示。
      </div>
    )}
    {showDetailFields && <Link
      className="secondary module-external-link"
      to={`/admin/orders/${data.order.id}/operations#cargo`}
    >
      查看历史货物明细
    </Link>}
  </div>;
}

function ModuleBusinessData({
  code,
  data,
  manage,
  canApproveConsignment,
  busy,
  reviewCloseSignal,
  consignmentSection,
  showConsignmentActionBar = true,
}: {
  code: OrderModuleCode;
  data: Route.ComponentProps["loaderData"];
  manage: boolean;
  canApproveConsignment: boolean;
  busy: boolean;
  reviewCloseSignal?: unknown;
  consignmentSection?: "info" | "files" | "costs";
  showConsignmentActionBar?: boolean;
}) {
  const activeBatch = data.batches.find((item) => item.status !== "cancelled");
  const [domesticCarrierId, setDomesticCarrierId] = useState("");
  const [domesticVehicleId, setDomesticVehicleId] = useState("");
  const [domesticDriverId, setDomesticDriverId] = useState("");
  const [transportView, setTransportView] = useState<"create" | "records">(
    manage ? "create" : "records",
  );
  const moduleActionData = useActionData() as
    | { actionKind?: string; success?: string; formError?: string }
    | undefined;
  const domesticVehicle = data.carrierVehicles.find((item) => item.id === domesticVehicleId);
  const domesticDriver = data.carrierDrivers.find((item) => item.id === domesticDriverId);

  useEffect(() => {
    if (
      code === "transport" &&
      moduleActionData?.actionKind === "transport_assignment" &&
      moduleActionData.success
    ) {
      setTransportView("records");
    }
  }, [code, moduleActionData]);

  if (code === "cargo")
    return <CargoWorkflowData data={data} />;
  if (code === "documents")
    return (
      <div className="module-business-stack dense-module-stack">
        <section className="order-document-stages">
          {orderDocumentStages.map((stage) => (
            <section className="order-document-stage" key={stage.code}>
              <header>
                <div>
                  <h3>{stage.name}</h3>
                  <p>{stage.hint}</p>
                </div>
                <span className="status-pill">
                  {stage.documents.filter((document) =>
                    data.attachments.some(
                      (attachment) =>
                        attachment.document_category === document.code &&
                        ["approved", "archived"].includes(
                          attachment.review_status || "pending",
                        ),
                    ),
                  ).length}
                  /{stage.documents.length} 已就绪
                </span>
              </header>
              <div className="table-wrap module-record-table order-document-stage-table"><table><thead><tr><th>文件类型</th><th>用途说明</th><th>当前状态</th><th>最新文件</th><th>审核状态</th></tr></thead><tbody>
                {stage.documents.map((document) => {
                  const files = data.attachments.filter(
                    (attachment) => attachment.document_category === document.code,
                  );
                  const latest = files[0];
                  return (
                    <tr className={files.some((file) => ["approved", "archived"].includes(file.review_status || "")) ? "completed-row" : ""} key={document.code}>
                      <td><strong>{document.name}</strong></td>
                      <td>{document.hint}</td>
                      <td><span className={`status-pill ${files.length ? "success" : "off"}`}>{files.length ? `${files.length} 份` : "待上传"}</span></td>
                      <td title={latest?.file_name}>{latest?.file_name || "请到对应业务节点上传"}</td>
                      <td>{latest ? documentReviewLabel(latest.review_status) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody></table></div>
            </section>
          ))}
          <p className="document-storage-note">
            支持 PDF、Word、Excel 和图片；当前数据库直存模式单个文件上限 1.2MB，后续接入对象存储后可提高。
          </p>
        </section>
        <div className="table-wrap module-record-table">
          <table>
            <thead>
              <tr>
                <th>文件</th>
                <th>分类/说明</th>
                <th>公开</th>
                <th>上传时间</th>
                <th>审核</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.attachments.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.file_name}</strong>
                    <small>{(item.size_bytes / 1024).toFixed(1)} KB</small>
                  </td>
                  <td>
                    {documentCategoryLabel(item.document_category)}
                    <small>{item.description || "—"}</small>
                  </td>
                  <td>{item.public_to_customer ? "客户可见" : "仅内部"}</td>
                  <td>{new Date(item.created_at).toLocaleString("zh-CN")}</td>
                  <td>
                    <span className="status-pill">
                      {documentReviewLabel(item.review_status)}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <a
                        className="text-button"
                        href={`/admin/document-files/order/${item.id}?mode=view`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看
                      </a>
                      {manage ? <Modal title={`编辑文件 · ${item.file_name}`} triggerLabel="编辑" triggerClassName="text-button">
                        <div className="stack">
                          <Form method="post" className="stack">
                            <input type="hidden" name="intent" value="document_metadata_update" />
                            <input type="hidden" name="attachmentId" value={item.id} />
                            <label className="field"><span>文件说明</span><textarea name="documentDescription" rows={3} defaultValue={item.description || ""} /></label>
                            <label className="field"><span>客户可见范围</span><select name="publicToCustomer" defaultValue={item.public_to_customer ? "1" : "0"}><option value="0">仅内部</option><option value="1">客户门户可见</option></select></label>
                            <button className="primary" disabled={busy}>保存文件信息</button>
                          </Form>
                          {item.document_category && <Form method="post" encType="multipart/form-data" className="stack document-replace-form">
                            <input type="hidden" name="intent" value="document_upload" />
                            <input type="hidden" name="documentCategory" value={item.document_category} />
                            <input type="hidden" name="documentDescription" value={item.description || ""} />
                            <input type="hidden" name="publicToCustomer" value={item.public_to_customer ? "1" : "0"} />
                            <label className="field"><span>替换文件</span><input name="attachments" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required /></label>
                            <button className="secondary" disabled={busy}>上传替换文件</button>
                          </Form>}
                        </div>
                      </Modal> : <button type="button" className="text-button" disabled>编辑</button>}
                      {(item.document_category === "consignment_letter"
                        ? canApproveConsignment
                        : manage) ? <Modal key={`review:${item.id}:${documentReviewCloseSignal(reviewCloseSignal, item.id) ?? "idle"}`} title={`审核文件 · ${item.file_name}`} triggerLabel="审核" triggerClassName="text-button" size="wide" closeSignal={documentReviewCloseSignal(reviewCloseSignal, item.id)}>
                        <Form method="post" className="stack">
                          <input
                            type="hidden"
                            name="intent"
                            value="document_review"
                          />
                          <input
                            type="hidden"
                            name="attachmentId"
                            value={item.id}
                          />
                          <DocumentReviewPreview attachment={item} />
                          <label className="field"><span>审核结果</span><select name="reviewStatus" defaultValue={item.review_status === "rejected" ? "rejected" : "approved"}><option value="approved">审核通过</option><option value="rejected">退回修改</option><option value="archived">审核通过并归档</option></select></label>
                          <button className="primary" disabled={busy}>确认审核结果</button>
                        </Form>
                      </Modal> : <button
                        type="button"
                        className="text-button"
                        disabled
                        title={item.document_category === "consignment_letter"
                          ? "仅当前指定的审批负责人可审核"
                          : undefined}
                      >审核</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.attachments.length && <p className="empty-state">暂无文件。</p>}
        <Link
          className="secondary module-external-link"
          to="/admin/workbenches/documents"
        >
          进入跨订单文件中心
        </Link>
      </div>
    );
  if (code === "customs") {
    const activeDeclarations = data.customsDeclarations.filter((item) => item.is_deleted !== 1 && item.status !== "cancelled");
    const activeOriginDeclarations = activeDeclarations.filter((item) => item.clearance_stage === "origin");
    const releasedOriginCount = activeOriginDeclarations.filter((item) => item.status === "released").length;
    const deletedCount = data.customsDeclarations.length - activeDeclarations.length;
    return (
      <div className="module-business-stack dense-module-stack">
        {manage && (
          <details className="expandable module-create-dialog" open={!activeDeclarations.length}>
            <summary>新增报关单</summary>
            <CustomsDeclarationForm busy={busy} fields={data.workflowFields} />
          </details>
        )}
        <ModuleSummaryTable items={[
          { label: "有效起运地报关单", value: activeOriginDeclarations.length, detail: "张" },
          { label: "起运地已放行", value: releasedOriginCount, detail: "张" },
          { label: "待放行", value: activeOriginDeclarations.length - releasedOriginCount, detail: "张" },
          { label: "删单 / 作废", value: deletedCount, detail: "张，不计有效单据" },
        ]} />
        <div className="table-wrap module-record-table">
          <table>
            <thead>
              <tr>
                <th>阶段 / 报关单号</th>
                <th>申报抬头 / 公司</th>
                <th>金额 / 毛重</th>
                <th>日期</th>
                <th>标记</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.customsDeclarations.map((x) => {
                const identityMissing = customsValueMissing(x.declaration_number) || customsValueMissing(x.declaration_type);
                const companyMissing = customsValueMissing(x.declaration_title) || customsValueMissing(x.declaring_company);
                const cargoDataMissing = customsValueMissing(x.currency) || Number(x.declared_amount) <= 0 || Number(x.gross_weight_kg) <= 0;
                const dateMissing = customsValueMissing(x.declared_at) || (x.status === "released" && customsValueMissing(x.released_at));
                const pendingRelease = x.is_deleted !== 1 && x.status !== "cancelled" && x.status !== "released";
                return <tr key={x.id}>
                  <td className={identityMissing ? "customs-missing-cell" : undefined}>
                    <strong>{customsStageLabel(x.clearance_stage)}</strong>
                    <small>{customsDisplayValue(x.declaration_number)} · {customsDisplayValue(x.declaration_type)}</small>
                  </td>
                  <td className={companyMissing ? "customs-missing-cell" : undefined}>
                    {customsDisplayValue(x.declaration_title)}
                    <small>{customsDisplayValue(x.declaring_company)}</small>
                  </td>
                  <td className={cargoDataMissing ? "customs-missing-cell" : undefined}>
                    {customsValueMissing(x.currency) || Number(x.declared_amount) <= 0 ? <CustomsMissingValue /> : <>{x.currency} {Number(x.declared_amount).toLocaleString()}</>}
                    <small>{Number(x.gross_weight_kg) > 0 ? `${Number(x.gross_weight_kg).toLocaleString()} KG` : <CustomsMissingValue />}</small>
                  </td>
                  <td className={dateMissing ? "customs-missing-cell" : undefined}>
                    申报 {customsValueMissing(x.declared_at) ? <CustomsMissingValue /> : formatDateTime(x.declared_at)}
                    <small>放行 {pendingRelease ? <span className="muted">待放行后生成</span> : customsValueMissing(x.released_at) ? <CustomsMissingValue /> : formatDateTime(x.released_at)}</small>
                  </td>
                  <td>
                    <CustomsDeclarationFlags declaration={x} />
                  </td>
                  <td>
                    <span className={`status-pill ${x.status === "released" ? "success" : x.is_deleted || x.status === "cancelled" ? "off" : ""}`}>
                      {customsDeclarationStatusLabel(x)}
                    </span>
                  </td>
                  <td>
                    <CustomsDeclarationAction declaration={x} manage={manage} busy={busy} fields={data.workflowFields} />
                  </td>
                </tr>;
              })}
              {!data.customsDeclarations.length && (
                <tr className="customs-empty-declaration-row">
                  {["阶段 / 报关单号", "申报抬头 / 公司", "金额 / 毛重", "申报 / 放行日期", "业务标记", "状态"].map((label) => (
                    <td key={label} className="customs-missing-cell"><CustomsMissingValue label={label} /></td>
                  ))}
                  <td><span className="muted">请先新增报关单</span></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Link
          className="secondary module-external-link"
          to={`/admin/workbenches/customs?q=${encodeURIComponent(data.order.order_number)}`}
        >
          进入跨订单报关工作台（已按本订单筛选）
        </Link>
      </div>
    );
  }
  if (code === "transport")
    return (
      <div className="module-business-stack dense-module-stack transport-operation-workbench">
        <nav className="transport-view-tabs" role="tablist" aria-label="国内运输业务分区">
          {manage && <button
            type="button"
            id="transport-create-tab"
            role="tab"
            aria-selected={transportView === "create"}
            aria-controls="transport-create-panel"
            className={transportView === "create" ? "active" : ""}
            onClick={() => setTransportView("create")}
          >
            新增运输安排
          </button>}
          <button
            type="button"
            id="transport-records-tab"
            role="tab"
            aria-selected={transportView === "records"}
            aria-controls="transport-records-panel"
            className={transportView === "records" ? "active" : ""}
            onClick={() => setTransportView("records")}
          >
            已有运输安排
            <span>{data.transportAssignments.length}</span>
          </button>
        </nav>
        {manage && <section
          id="transport-create-panel"
          role="tabpanel"
          aria-labelledby="transport-create-tab"
          className="transport-view-panel transport-create-panel"
          hidden={transportView !== "create"}
        >
          <div className="module-toolbar transport-entry-forms">
              <Form method="post" className="form-grid compact transport-arrangement-form transport-compact-form">
                <input
                  type="hidden"
                  name="intent"
                  value="transport_assignment"
                />
                <div className="transport-cost-heading span-2">
                  <strong>先安排承运商并登记预计应付</strong>
                  <span>由业务员在国内运输开始时确认；保存后同步生成国内运输应付明细。</span>
                </div>
                <input type="hidden" name="legType" value="first_mile" />
                <input type="hidden" name="carrierName" />
                <input type="hidden" name="carrierContact" />
                <input type="hidden" name="carrierPhone" />
                <fieldset className="transport-payable-fields span-2">
                  <legend>承运商与预计应付</legend>
                  <ModuleField
                    fields={data.workflowFields}
                    fieldKey="domestic_carrier_id"
                    label="国内承运商"
                    className="field transport-carrier-field"
                    fallbackRequired
                  >
                    {(required) => <select
                      name="carrierId"
                      value={domesticCarrierId}
                      required={required}
                      onChange={(event) => {
                        setDomesticCarrierId(event.currentTarget.value);
                        setDomesticVehicleId("");
                        setDomesticDriverId("");
                        const option = event.currentTarget.selectedOptions[0];
                        const form = event.currentTarget.form;
                        const carrierName = form?.elements.namedItem("carrierName") as HTMLInputElement | null;
                        const carrierContact = form?.elements.namedItem("carrierContact") as HTMLInputElement | null;
                        const carrierPhone = form?.elements.namedItem("carrierPhone") as HTMLInputElement | null;
                        if (carrierName) carrierName.value = option?.dataset.name ?? "";
                        if (carrierContact) carrierContact.value = option?.dataset.contact ?? "";
                        if (carrierPhone) carrierPhone.value = option?.dataset.phone ?? "";
                      }}
                    >
                      <option value="">请选择承运商</option>
                      {data.carriers.filter((x) => x.carrier_scope === "domestic").map((x) => (
                        <option
                          key={x.id}
                          value={x.id}
                          data-name={x.name}
                          data-contact={x.contact_name || ""}
                          data-phone={x.contact_phone || ""}
                        >
                          {x.name}{x.contact_phone ? ` · ${x.contact_phone}` : ""}
                        </option>
                      ))}
                    </select>}
                  </ModuleField>
                  <ModuleField fields={data.workflowFields} fieldKey="domestic_payable_charge_name" label="应付费用名称" fallbackRequired>
                    {(required) => <select name="chargeName" defaultValue="国内汽运费" required={required}>
                      <option value="">请选择费用名称</option>
                      {transportChargeNameOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}
                    </select>}
                  </ModuleField>
                  <ModuleField fields={data.workflowFields} fieldKey="domestic_freight_currency" label="币种" className="field compact-money-field" fallbackRequired>
                    {(required) => <select name="freightCurrency" defaultValue="CNY" required={required}>
                      <option value="CNY">CNY</option>
                      <option value="USD">USD</option>
                      <option value="KZT">KZT</option>
                      <option value="UZS">UZS</option>
                      <option value="RUB">RUB</option>
                    </select>}
                  </ModuleField>
                  <ModuleField fields={data.workflowFields} fieldKey="domestic_payable_exchange_rate" label="汇率" className="field compact-money-field" fallbackRequired>
                    {(required) => <input name="freightExchangeRate" type="number" min="0.000001" step="0.000001" defaultValue="1" required={required} />}
                  </ModuleField>
                  <ModuleField fields={data.workflowFields} fieldKey="domestic_payable_quantity" label="数量" className="field compact-money-field" fallbackRequired>
                    {(required) => <input name="freightQuantity" type="number" min="0.0001" step="0.0001" defaultValue="1" required={required} />}
                  </ModuleField>
                  <ModuleField fields={data.workflowFields} fieldKey="domestic_freight_amount" label="单价" className="field compact-money-field" fallbackRequired>
                    {(required) => <input name="freightUnitPrice" type="number" min="0.01" step="0.01" required={required} />}
                  </ModuleField>
                  <label className="field transport-payable-notes">
                    <span>费用备注</span>
                    <input name="expenseNotes" placeholder="选填" />
                  </label>
                </fieldset>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_plate_number" label="国内车辆" fallbackRequired>
                  {(required) => <select name="vehicleMasterId" value={domesticVehicleId} onChange={(event) => setDomesticVehicleId(event.currentTarget.value)} required={required} disabled={!domesticCarrierId}>
                    <option value="">{domesticCarrierId ? "请选择车辆" : "请先选择承运商"}</option>
                    {data.carrierVehicles.filter((item) => item.carrier_id === domesticCarrierId).map((item) => (
                      <option key={item.id} value={item.id}>{item.plate_number}{item.vehicle_type ? ` · ${item.vehicle_type}` : ""}</option>
                    ))}
                    {domesticCarrierId && <option value="__new__">＋ 新建未登记车辆并立即使用</option>}
                  </select>}
                </ModuleField>
                {domesticVehicleId === "__new__" && <fieldset className="transport-resource-inline-fields span-2"><legend>新车辆快速建档</legend><label className="field"><span>车牌号 <b>*</b></span><input name="newVehiclePlateNumber" required maxLength={20} placeholder="例如 湘AT0831"/></label><label className="field"><span>车型 <b>*</b></span><input name="newVehicleType" required maxLength={80} placeholder="例如 13.5 米高栏"/></label><label className="field compact-money-field"><span>载重 KG</span><input name="newVehicleCapacityWeight" type="number" min="0" step="0.001" defaultValue="0"/></label><label className="field compact-money-field"><span>容积 CBM</span><input name="newVehicleCapacityVolume" type="number" min="0" step="0.001" defaultValue="0"/></label></fieldset>}
                <input type="hidden" name="plateNumber" value={domesticVehicle?.plate_number || ""} />
                <ModuleField fields={data.workflowFields} fieldKey="domestic_vehicle_type" label="国内车型" fallbackRequired>
                  {(required) => <input name="vehicleType" value={domesticVehicle?.vehicle_type || ""} readOnly required={required} placeholder="选择车辆后自动带出" />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_vehicle_count" label="车辆数目">
                  {(required) => <input name="vehicleCount" type="number" min="1" step="1" defaultValue="1" required={required} />}
                </ModuleField>
                <input type="hidden" name="loadingMode" value={data.order.business_type} />
                <ModuleField fields={data.workflowFields} fieldKey="domestic_driver_name" label="国内司机姓名" fallbackRequired>
                  {(required) => <select name="driverMasterId" value={domesticDriverId} onChange={(event) => setDomesticDriverId(event.currentTarget.value)} required={required} disabled={!domesticCarrierId}>
                    <option value="">{domesticCarrierId ? "请选择司机" : "请先选择承运商"}</option>
                    {data.carrierDrivers.filter((item) => item.carrier_id === domesticCarrierId).map((item) => (
                      <option key={item.id} value={item.id}>{item.name}{item.phone ? ` · ${item.phone}` : ""}</option>
                    ))}
                    {domesticCarrierId && <option value="__new__">＋ 新建未登记司机并立即使用</option>}
                  </select>}
                </ModuleField>
                {domesticDriverId === "__new__" && <fieldset className="transport-resource-inline-fields span-2"><legend>新司机快速建档</legend><label className="field"><span>司机姓名 <b>*</b></span><input name="newDriverName" required maxLength={80}/></label><label className="field"><span>司机电话 <b>*</b></span><input name="newDriverPhone" type="tel" inputMode="tel" pattern="[+0-9 \(\)\-]{6,30}" title="只能输入数字、空格、括号、短横线和开头的加号" required maxLength={30}/></label><label className="field"><span>证件号</span><input name="newDriverLicenseNumber" maxLength={80}/></label></fieldset>}
                <input type="hidden" name="driverName" value={domesticDriver?.name || ""} />
                <ModuleField fields={data.workflowFields} fieldKey="domestic_driver_phone" label="国内司机手机号" fallbackRequired>
                  {(required) => <input name="driverPhone" value={domesticDriver?.phone || ""} readOnly required={required} placeholder="选择司机后自动带出" />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_driver_id_number" label="国内司机证件号">
                  {(required) => <input name="driverIdNumber" value={domesticDriver?.license_number || ""} readOnly required={required} placeholder="选择司机后自动带出" />}
                </ModuleField>
                <div className="transport-route-row span-2">
                  <div className="transport-route-stop">
                    <span>国内提货起点</span>
                    <strong>{[data.order.origin_country,data.order.origin_state,data.order.origin_city].filter(Boolean).join(" ") || "订单尚未填写起运地"}</strong>
                    <small>继承订单信息</small>
                  </div>
                  <span className="transport-route-arrow" aria-hidden="true">→</span>
                  <label className="transport-route-destination">
                    <span>国内入仓终点 <b className="required-mark">*</b></span>
                    <select name="destinationWarehouseId" defaultValue="" required>
                      <option value="">请选择国内集货仓或口岸仓</option>
                      {data.warehouses
                        .filter((warehouse) => ["domestic_collection", "port"].includes(warehouse.warehouse_role || ""))
                        .map((warehouse) => (
                          <option key={warehouse.id} value={warehouse.id}>
                            {warehouse.name} · {warehouse.warehouse_role === "port" ? "口岸仓" : "国内集货仓"}
                          </option>
                        ))}
                    </select>
                    <small>保存后自动进入所选仓库的待验收列表</small>
                  </label>
                  <span className="transport-route-arrow" aria-hidden="true">→</span>
                  <div className="transport-route-stop">
                    <span>境外目的地</span>
                    <strong>{[data.order.destination_country,data.order.destination_state,data.order.destination_city].filter(Boolean).join(" ") || "订单尚未填写目的地"}</strong>
                    <small>后续出境运输使用</small>
                  </div>
                </div>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_planned_departure_at" label="计划提货时间" className="field transport-time-field" fallbackRequired>
                  {(required) => <input name="plannedDepartureAt" type="datetime-local" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_planned_arrival_at" label="计划到仓时间" className="field transport-time-field" fallbackRequired>
                  {(required) => <input name="plannedArrivalAt" type="datetime-local" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_loading_requirements" label="国内装载要求" className="field transport-compact-note">
                  {(required) => <textarea name="loadingRequirements" rows={1} required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_transport_notes" label="国内运输备注" className="field transport-compact-note">
                  {(required) => <textarea name="notes" rows={1} required={required} />}
                </ModuleField>
                <button className="primary" disabled={busy}>
                  {busy ? "保存中…" : "保存运输安排"}
                </button>
              </Form>
          </div>
        </section>}
        <section
          id="transport-records-panel"
          role="tabpanel"
          aria-labelledby="transport-records-tab"
          className="transport-view-panel transport-records-panel"
          hidden={transportView !== "records"}
        >
          <BusinessSubsection
            title="国内运输安排与派车"
            hint="记录国内提货承运商、车辆、司机、时间和预计运费。"
          >
            <div className="table-wrap module-record-table compact-record-table">
              <table>
                <thead>
                  <tr>
                    <th>承运商/车辆</th>
                    <th>司机</th>
                    <th>线路</th>
                    <th>计划</th>
                    <th>运费</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {data.transportAssignments.map((x) => (
                    <tr key={x.id}>
                      <td>
                        <strong>{x.carrier_name || "待定"}</strong>
                        <small>
                          {x.loading_mode === "ftl" ? "整车" : x.loading_mode === "ltl" ? "拼车" : "装车方式待定"} · {x.vehicle_type || "车型待定"} × {x.vehicle_count || 1} 辆 · {x.plate_number || "车牌待定"}
                        </small>
                      </td>
                      <td>
                        {x.driver_name || "—"}
                        <small>{x.driver_phone || "—"}</small>
                      </td>
                      <td>
                        {x.origin_location || "—"} →{" "}
                        {x.destination_location || "—"}
                        <small>{x.border_port || "口岸待定"}</small>
                      </td>
                      <td>
                        {formatDateTime(x.planned_departure_at)}
                        <small>至 {formatDateTime(x.planned_arrival_at)}</small>
                      </td>
                      <td>
                        {x.freight_currency} {x.freight_amount.toLocaleString()}
                      </td>
                      <td><span className="status-pill">{transportAssignmentStatusLabel(x.status)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.transportAssignments.length && (
              <div className="transport-empty-records">
                <span>暂无国内运输安排。</span>
                {manage && <button type="button" className="secondary" onClick={() => setTransportView("create")}>返回新增运输安排</button>}
              </div>
            )}
          </BusinessSubsection>
          {data.transportAssignments.length > 0 && (
            <div className="transport-next-step-banner">
              <div>
                <strong>国内运输安排已完成</strong>
                <span>运输信息已保存，可以进入仓库验收收货。</span>
              </div>
              <Link className="btn primary" to={`/admin/orders/${data.order.id}?stage=warehouse_receiving&module=warehouse`}>
                下一步：仓库验收收货 →
              </Link>
            </div>
          )}
        </section>
      </div>
    );
  if (code === "loading") {
    const isFtl = data.order.business_type === "ftl";
    const isLtl = data.order.business_type === "ltl";
    const hasWarehouseActuals = Boolean(data.warehouseActuals?.counting_completed);
    const loadingPreparationReady = Boolean(
      data.order.exit_port &&
      data.order.customs_location &&
      data.order.overseas_warehouse_id,
    );
    const warehouseTargetPath = !hasWarehouseActuals
      ? "/warehouse/acceptance"
      : isLtl && !activeBatch
        ? "/warehouse/consolidation"
        : "/warehouse/outbound";
    const warehouseActionText = !hasWarehouseActuals
      ? "进入仓库端验收收货"
      : isLtl && !activeBatch
        ? "进入仓库端货物配载"
        : isLtl && activeBatch?.status === "planning"
          ? "进入仓库端生成装车任务"
          : "进入仓库端扫码装车与出库";
    const stageLabel = !hasWarehouseActuals
      ? "待验收收货"
      : !isFtl && !isLtl
        ? "等待报价确定订单类型"
        : isLtl && !activeBatch
          ? "待货物配载"
          : isLtl && activeBatch?.status === "planning"
            ? "配载单已生成，待装车任务"
            : activeBatch?.status === "loading"
              ? "装车任务已生成，待出库交接"
              : activeBatch?.road_status
                ? roadStatusLabels[activeBatch.road_status] || activeBatch.road_status
                : "待仓库装车出库";
    const plannedPackages = data.cargo.reduce((sum, item) => sum + item.package_count, 0);
    const plannedPieces = data.cargo.reduce((sum, item) => sum + item.package_count * item.pieces_per_package, 0);
    const plannedWeight = data.cargo.reduce((sum, item) => sum + item.package_count * item.gross_weight_per_package_kg, 0);
    const plannedVolume = data.cargo.reduce((sum, item) => sum + item.package_count * item.volume_per_package_cbm, 0);
    const activeBatchResource = activeBatch ? batchTransportDisplay(activeBatch) : null;
    const hasWarehouseReceipt = Boolean(data.warehouseActuals?.receipt_count);
    return (
      <div className="module-business-stack dense-module-stack">
        <BusinessSubsection title="订单与仓库同步状态" hint="管理端只读展示仓库作业结果，实际配载、装车和出库在仓库端办理。">
          <div className="table-wrap module-record-table operation-sheet-table">
            <table>
              <thead><tr><th>订单号</th><th>客户</th><th>订单类型</th><th>仓库办理状态</th></tr></thead>
              <tbody><tr>
                <td><strong><OrderNumberLink id={data.order.id} number={data.order.order_number}/></strong></td>
                <td>{data.order.customer_name}</td>
                <td>{isFtl ? "整车 · 一单一车" : isLtl ? "拼车 · 多单一车" : "报价尚未确定"}</td>
                <td><span className={`status-pill ${hasWarehouseActuals ? "success" : ""}`}>{stageLabel}</span></td>
              </tr></tbody>
            </table>
          </div>
        </BusinessSubsection>

        <BusinessSubsection
          title="订单创建与仓库实收对比"
          hint="订单创建口径来自货物明细；仓库尚未收货时实收行保持为空，收货后自动同步。"
        >
          <div className="table-wrap module-record-table operation-sheet-table cargo-comparison-summary-table">
            <table>
              <thead><tr><th>数据口径</th><th>包装数</th><th>件数</th><th>重量 KG</th><th>体积 CBM</th><th>同步状态</th></tr></thead>
              <tbody>
                <tr><td><strong>订单创建</strong></td><td>{plannedPackages}</td><td>{plannedPieces}</td><td>{plannedWeight.toFixed(2)}</td><td>{plannedVolume.toFixed(3)}</td><td>订单货物明细</td></tr>
                <tr><td><strong>仓库实收</strong></td><td>{hasWarehouseReceipt ? data.warehouseActuals?.actual_packages : "—"}</td><td>{hasWarehouseReceipt ? data.warehouseActuals?.actual_pieces : "—"}</td><td>{hasWarehouseReceipt ? Number(data.warehouseActuals?.actual_weight_kg).toFixed(2) : "—"}</td><td>{hasWarehouseReceipt ? Number(data.warehouseActuals?.actual_volume_cbm).toFixed(3) : "—"}</td><td>{hasWarehouseReceipt ? `${data.warehouseActuals?.receipt_count} 张收货单` : "待仓库清点"}</td></tr>
              </tbody>
            </table>
          </div>
        </BusinessSubsection>

        <BusinessSubsection
          title="出口运输与装车状态"
          hint={isLtl
            ? "拼车订单由仓库端选择整票订单、生成 PZ 配载单、生成装车任务并完成扫码出库。"
            : "整车订单不走拼车配载，由仓库端按单生成装车任务并完成扫码出库。"}
        >
          <div className="table-wrap module-record-table operation-sheet-table">
            <table>
              <thead><tr><th>运输线路</th><th>出境口岸</th><th>清关地</th><th>境外目的仓</th></tr></thead>
              <tbody><tr><td>{data.order.route_notes || "待仓库补充"}</td><td>{data.order.exit_port || "待仓库补充"}</td><td>{data.order.customs_location || "待仓库补充"}</td><td>{data.order.overseas_warehouse_name || "未设置"}</td></tr></tbody>
            </table>
          </div>

          <div className="table-wrap module-record-table operation-sheet-table loading-batch-table">
            <table>
              <thead><tr><th>配载 / 运输单</th><th>订单</th><th>承运商</th><th>车辆（车牌 / 车型）</th><th>司机（姓名 / 电话）</th><th>已分配包装</th><th>类型</th><th>状态</th></tr></thead>
              <tbody>{activeBatch ? <tr>
                <td><strong><BatchNumberLink id={activeBatch.id} number={activeBatch.batch_number}/></strong><small>{activeBatch.batch_name}</small></td>
                <td>{activeBatch.order_count} 票<small>{activeBatch.order_numbers || data.order.order_number}</small></td>
                <td>{activeBatchResource?.carrier}</td>
                <td>{activeBatchResource?.vehicle}<small>{activeBatch.vehicle_count} 辆已登记</small></td>
                <td>{activeBatchResource?.driver}</td>
                <td>{activeBatch.load_count} 个</td>
                <td>{isLtl ? "仓库配载单" : "整车运输单"}</td>
                <td><span className="status-pill">{roadStatusLabels[activeBatch.road_status] || activeBatch.road_status}</span></td>
              </tr> : <tr><td colSpan={8} className="empty-state">{isLtl ? "仓库端尚未生成 PZ 配载单。" : "仓库端尚未生成装车任务。"}</td></tr>}</tbody>
            </table>
          </div>

          <div className="table-wrap module-record-table operation-sheet-table warehouse-dispatch-report-table">
            <table>
              <thead><tr><th>装车出库任务</th><th>装车进度</th><th>车辆 / 司机</th><th>仓库上报状态</th><th>交接人 / 时间</th><th>交接备注</th></tr></thead>
              <tbody>{data.warehouseDispatches.map((dispatch) => <tr key={dispatch.id}>
                <td><strong>{dispatch.dispatch_number}</strong><small>创建：{formatDateTime(dispatch.created_at)} · {dispatch.creator_name || "仓库操作员"}</small></td>
                <td>{dispatch.loaded_count}/{dispatch.item_count}<small>{dispatch.loaded_count === dispatch.item_count ? "货物已全部装车" : "扫码装车中"}</small></td>
                <td>{dispatch.vehicle_plate}<small>{dispatch.driver_name} · {dispatch.carrier_name || "承运商待补"}</small></td>
                <td><span className={`status-pill ${dispatch.status === "dispatched" ? "success" : ""}`}>{dispatch.status === "dispatched" ? "已上报出库交接" : "装车中"}</span></td>
                <td>{dispatch.dispatcher_name || "—"}<small>{formatDateTime(dispatch.dispatched_at)}</small></td>
                <td>{dispatch.notes || "—"}</td>
              </tr>)}{!data.warehouseDispatches.length && <tr><td colSpan={6} className="empty-state">仓库端尚未创建装车出库任务。</td></tr>}</tbody>
            </table>
          </div>

          {!hasWarehouseActuals && (
            <div className="alert warning">
              <strong>仓库状态：</strong>尚未完成验收收货并确认货齐。
            </div>
          )}
          {hasWarehouseActuals && !isFtl && !isLtl && (
            <div className="alert danger">
              <strong>订单状态：</strong>询价报价尚未确定整车或拼车，仓库不能建立装车流程。
            </div>
          )}
          {hasWarehouseActuals && isLtl && !loadingPreparationReady && (
            <div className="alert warning">
              <strong>待仓库补充：</strong>生成配载单时确认出境口岸、清关地和境外目的仓。
            </div>
          )}

          <div className="loading-next-action">
            <div>
              <strong>实际操作统一在仓库端完成</strong>
              <span>完成后，仓库端会自动回写本节点和订单工作流状态。</span>
            </div>
            <WarehouseSiteButton
              orderId={data.order.id}
              targetPath={warehouseTargetPath}
              returnModuleCode="loading"
              className="primary"
            >
              {warehouseActionText}
            </WarehouseSiteButton>
          </div>
        </BusinessSubsection>
      </div>
    );
  }
  if (code === "tracking") {
    const selectableTrackingMilestones = trackingManualMilestoneOptions.filter(
      ([value]) =>
        value !== "station_arrived" &&
        (value !== "transloaded" || Boolean(data.order.requires_transloading)) &&
        (value !== "transit_customs" || Boolean(data.order.requires_transit_customs)),
    );
    const displayedTrackingMilestones = trackingManualMilestoneOptions.filter(
      ([value]) =>
        value !== "transloaded" && value !== "transit_customs" ||
        value === "transloaded" &&
          (Boolean(data.order.requires_transloading) ||
            data.trackingMilestones.some((item) => item.milestone_code === value)) ||
        value === "transit_customs" &&
          (Boolean(data.order.requires_transit_customs) ||
            data.trackingMilestones.some((item) => item.milestone_code === value)),
    );
    return (
      <div className="module-business-stack dense-module-stack">
        <BusinessSubsection title="运输节点进度" hint="进入本页首先查看必经运输节点、当前状态、发生时间和地点。" tag="后续接入接口自动推进">
          <div className="table-wrap module-record-table tracking-progress-table">
            <table>
              <thead><tr><th>顺序</th><th>运输节点</th><th>类型</th><th>当前状态</th><th>发生时间</th><th>地点</th></tr></thead>
              <tbody>{displayedTrackingMilestones.map(([value, label], index) => {
                const item = data.trackingMilestones.find((x) => x.milestone_code === value);
                return <tr className={item ? "completed-row" : ""} key={value}>
                  <td>{String(index + 1).padStart(2, "0")}</td>
                  <td><strong>{label}</strong></td>
                  <td>{trackingOptionalMilestones.has(value) ? "可选节点" : "必经节点"}</td>
                  <td><span className={`status-pill ${item ? "success" : "off"}`}>{item ? "已完成" : trackingOptionalMilestones.has(value) ? "待实际发生" : "待更新"}</span></td>
                  <td>{item ? formatDateTime(item.event_at) : "—"}</td>
                  <td>{item?.location || "—"}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </BusinessSubsection>
        {manage && (!data.trackingDepartureGate || data.trackingDepartureGate.ready) && (
          <BusinessSubsection className="tracking-node-entry-section" title="登记运输节点" hint="按实际发生登记节点；换装、转关未发生可跳过，目的仓入库由仓库扫码自动完成。">
            <Form method="post" className="form-grid compact tracking-node-entry-form">
              <input type="hidden" name="intent" value="tracking_add" />
              {!workflowFieldPolicy(data.workflowFields, "tracking_milestone").visible && <input type="hidden" name="milestoneCode" value="border_arrived" />}
              {!workflowFieldPolicy(data.workflowFields, "tracking_milestone_name").visible && <input type="hidden" name="milestoneName" value="到达出境口岸" />}
              {!workflowFieldPolicy(data.workflowFields, "visible_to_customer").visible && <input type="hidden" name="visibleToCustomer" value="1" />}
              <ModuleField fields={data.workflowFields} fieldKey="tracking_milestone" label="运输节点" fallbackRequired>
                {(required) => <select name="milestoneCode" defaultValue="border_arrived" required={required}>
                  {selectableTrackingMilestones.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="tracking_milestone_name" label="节点名称">
                {(required) => <input name="milestoneName" defaultValue="到达出境口岸" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="tracking_event_at" label="发生时间" fallbackRequired>
                {(required) => <input name="eventAt" type="datetime-local" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="tracking_location" label="地点" fallbackRequired>
                {(required) => <input name="location" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="tracking_vehicle" label="车辆/换装车号">
                {(required) => <input name="vehicleReference" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="tracking_notes" label="说明">
                {(required) => <input name="notes" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="visible_to_customer" label="客户可见" className="field span-2" fallbackRequired>
                {(required) => <select name="visibleToCustomer" defaultValue="1" required={required}><option value="1">同步客户门户</option><option value="0">仅内部可见</option></select>}
              </ModuleField>
              <button className="primary tracking-node-submit" disabled={busy}>
                保存运输节点
              </button>
            </Form>
          </BusinessSubsection>
        )}
        <BusinessSubsection
          title="运单跟踪"
          hint="按顺序汇总出境口岸、出境、国外入境、目的地清关和境外目的仓到仓；换装与转关按实际发生情况登记。"
        >
          <div className="table-wrap module-record-table compact-record-table">
            <table>
              <thead><tr><th>运单号</th><th>当前位置</th><th>最后更新时间</th><th>状态</th></tr></thead>
              <tbody>
                {data.shipments.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.shipment_number}</strong></td>
                    <td>{item.current_location || ""}</td>
                    <td>{item.last_event_at ? new Date(item.last_event_at).toLocaleString("zh-CN") : ""}</td>
                    <td>{item.status}</td>
                  </tr>
                ))}
                {!data.shipments.length && <tr><td colSpan={4} className="empty-state">暂无正式运单，仍可先登记订单级运输节点。</td></tr>}
              </tbody>
            </table>
          </div>
        </BusinessSubsection>
        <BusinessSubsection
          title="节点记录"
          hint="每次更新保留地点、车辆、说明以及客户可见范围。"
        >
          <div className="table-wrap module-record-table compact-record-table">
            <table>
              <thead><tr><th>节点</th><th>发生时间</th><th>地点</th><th>车辆/换装车号</th><th>可见范围</th><th>说明</th></tr></thead>
              <tbody>
                {data.trackingMilestones.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.milestone_name}</strong></td>
                    <td>{formatDateTime(item.event_at)}</td>
                    <td>{item.location || ""}</td>
                    <td>{item.vehicle_reference || ""}</td>
                    <td>{item.visible_to_customer ? "客户可见" : "仅内部"}</td>
                    <td>{item.notes || ""}</td>
                  </tr>
                ))}
                {!data.trackingMilestones.length && <tr><td colSpan={6} className="empty-state">暂无运输节点记录。</td></tr>}
              </tbody>
            </table>
          </div>
        </BusinessSubsection>
        {manage && (
          <details className="tracking-option-table tracking-option-settings" aria-label="可选运输节点">
            <summary><span>可选运输节点设置</span><small>换装、转关仅在实际发生时启用</small></summary>
            <div className="table-wrap module-record-table">
              <table>
                <thead><tr><th>节点</th><th>适用场景</th><th>当前设置</th><th>操作</th></tr></thead>
                <tbody>
                  {([
                    ["transloaded", "换装", "运输途中发生车辆或载具更换", Boolean(data.order.requires_transloading)],
                    ["transit_customs", "转关", "运输途中需要办理转关手续", Boolean(data.order.requires_transit_customs)],
                  ] as const).map(([optionCode, label, hint, enabled]) => <tr key={optionCode}>
                    <td><strong>{label}</strong></td>
                    <td>{hint}</td>
                    <td><span className={`status-pill ${enabled ? "success" : "off"}`}>{enabled ? "已启用" : "未启用"}</span></td>
                    <td><Form method="post">
                      <input type="hidden" name="intent" value="tracking_option_toggle" />
                      <input type="hidden" name="optionCode" value={optionCode} />
                      <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
                      <button type="submit" className="text-button" disabled={busy}>{enabled ? "停用" : "启用"}</button>
                    </Form></td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    );
  }
  if (code === "overseas_warehouse") {
    const operation = data.overseasOperation;
    const operationStatus = operation?.status || "waiting_arrival";
    const signedReceiptApproved = data.attachments.some(
      (attachment) =>
        attachment.document_category === "delivery_receipt" &&
        ["approved", "archived"].includes(attachment.review_status || ""),
    );
    const selfPickupCompleted = data.module.status === "completed";
    const progress = selfPickupCompleted
      ? 100
      : overseasOperationProgress[operationStatus] || 0;
    const operationRank: Record<string, number> = {
      waiting_arrival: 0,
      arrived: 1,
      notified: 2,
      appointment: 2,
      picked_up: 3,
    };
    const operationStepDone = (status: string) =>
      (operationRank[operationStatus] || 0) >= operationRank[status];
    const canConfirmArrival = Boolean(
      operation &&
        ["outbound_in_transit", "overseas_arrived", "waiting_pickup"].includes(
          operation.road_status,
        ) &&
        operationStatus === "waiting_arrival",
    );
    return (
      <div className="module-business-stack dense-module-stack">
        <BusinessSubsection
          title="境外仓办理进度"
          hint="境外仓完成扫码入库与清点后，运输跟踪即结束并自动通知客户；客户到仓后逐件扫码，确认出库即完成自提签收。"
        >
          <div className="table-wrap module-record-table overseas-progress-table" aria-live="polite">
            <table>
              <thead><tr><th>当前状态</th><th>完成进度</th><th>下一步</th></tr></thead>
              <tbody><tr>
                <td><strong>{selfPickupCompleted ? "客户已自提并签收" : overseasOperationStatusLabels[operationStatus] || operationStatus}</strong></td>
                <td>{progress}%</td>
                <td>{selfPickupCompleted ? "进入费用结算" : nextOverseasAction(operationStatus)}</td>
              </tr></tbody>
            </table>
          </div>
          <div className="table-wrap module-record-table overseas-step-table">
            <table>
              <thead><tr><th>顺序</th><th>业务节点</th><th>当前状态</th></tr></thead>
              <tbody>{[
                ["arrived", "目的仓到仓", operationStepDone("arrived")],
                ["notified", "自动通知客户", operationStepDone("notified")],
                ["signed", "扫码自提签收", operationStepDone("picked_up")],
              ].map(([status, label, done], index) => <tr className={done ? "completed-row" : ""} key={String(status)}>
                <td>{String(index + 1).padStart(2, "0")}</td>
                <td><strong>{label}</strong></td>
                <td><span className={`status-pill ${done ? "success" : "off"}`}>{done ? "已完成" : "待办理"}</span></td>
              </tr>)}</tbody>
            </table>
          </div>
        </BusinessSubsection>

        <BusinessSubsection
          title="批次与目的仓"
          hint="一票订单只读取报价及委托资料中已选的境外目的仓，不在后续重复填写地址。"
        >
          <div className="table-wrap module-record-table overseas-batch-table">
            <table>
              <thead><tr><th>配载批次</th><th>批次状态</th><th>境外目的仓</th><th>目的仓地址</th><th>批次提货进度</th></tr></thead>
              <tbody><tr>
                <td><strong>{operation?<BatchNumberLink id={operation.batch_id} number={operation.batch_number}/>:"—"}</strong></td>
                <td>{operation ? roadStatusLabels[operation.road_status] || operation.road_status : "—"}</td>
                <td>{data.order.overseas_warehouse_name ? `${data.order.overseas_warehouse_name} · ${data.order.overseas_warehouse_code || ""}` : "—"}</td>
                <td>{[data.order.overseas_warehouse_address,data.order.overseas_warehouse_address_note].filter(Boolean).join(" · ") || "—"}</td>
                <td>{operation ? `${operation.picked_up_order_count}/${operation.batch_order_count} 票` : "—"}</td>
              </tr></tbody>
            </table>
          </div>
        </BusinessSubsection>

        {!operation && (
          <p className="alert warning">
            当前订单尚未进入有效配载批次，请先完成配载、装车和出境确认。
          </p>
        )}
        {operation && operationStatus === "waiting_arrival" && !canConfirmArrival && (
          <p className="alert warning">
            当前批次尚未确认出境；请先在配载批次完成装车出库和出境确认。
          </p>
        )}

        {manage && canConfirmArrival && data.order.overseas_warehouse_id && (
          <BusinessSubsection
            title="1. 境外目的仓收货清点"
            hint="到仓状态只由境外目的仓扫码入库和清点确认触发；拼车运输单全部子订单清点完成后统一结束境外运输。"
          >
            <div className="loading-next-action">
              <strong>下一步由境外目的仓办理</strong>
              <span>仓库人员扫描本票货物标签，登记实收并选择“清点无误”。</span>
              <WarehouseSiteButton
                orderId={data.order.id}
                targetPath={`/warehouse/inbound?warehouseId=${encodeURIComponent(data.order.overseas_warehouse_id)}`}
                returnModuleCode="overseas_warehouse"
                className="primary"
              >
                去境外目的仓扫码收货
              </WarehouseSiteButton>
            </div>
          </BusinessSubsection>
        )}

        {manage && ["notified", "appointment"].includes(operationStatus) && (
          <BusinessSubsection title="2. 客户扫码自提签收" hint={`系统已于 ${formatDateTime(operation?.notified_at) || "到仓时"} 自动通知客户；无需登记预约，客户到仓后逐件扫码并在弹窗内确认收货。`}>
            <div className="loading-next-action">
              <strong>下一步由境外目的仓办理</strong>
              <span>客户到仓后扫描本票全部货物条码，并在货物核对弹窗内确认收货；此处无需重复确认。</span>
              {data.order.overseas_warehouse_id && <WarehouseSiteButton
                orderId={data.order.id}
                targetPath={`/warehouse/pickup?warehouseId=${encodeURIComponent(data.order.overseas_warehouse_id)}`}
                returnModuleCode="overseas_warehouse"
                className="primary"
              >
                去境外仓扫码自提签收
              </WarehouseSiteButton>}
            </div>
          </BusinessSubsection>
        )}

        {operationStatus === "picked_up" && (
          <BusinessSubsection title="3. 扫码自提签收记录" hint="客户已在境外仓核对全部货物条码并确认收货；系统一次完成自提出库、签收并进入费用结算。签收单可后续在文件中心补充归档，但不再阻断流程。">
            <div className="table-wrap overseas-completion-table">
              <table>
                <thead><tr><th>订单</th><th>客户</th><th>配载/运输单</th><th>目的仓</th><th>到仓</th><th>通知</th><th>扫码确认收货</th><th>签收单归档</th><th>结果</th></tr></thead>
                <tbody><tr>
                  <td><strong><OrderNumberLink id={data.order.id} number={data.order.order_number}/></strong></td>
                  <td>{data.order.customer_name}</td>
                  <td>{operation?<BatchNumberLink id={operation.batch_id} number={operation.batch_number}/>:"—"}</td>
                  <td>{data.order.overseas_warehouse_name || "—"}</td>
                  <td>{formatDateTime(operation?.actual_arrival_at) || "—"}</td>
                  <td>{formatDateTime(operation?.notified_at) || "—"}</td>
                  <td><strong>{formatDateTime(operation?.pickup_at) || "—"}</strong><small>{operation?.pickup_contact || "客户自提"}</small></td>
                  <td><span className={`status-pill ${signedReceiptApproved ? "" : "off"}`}>{signedReceiptApproved ? "已归档" : "选填"}</span></td>
                  <td><span className={`status-pill ${selfPickupCompleted ? "" : "off"}`}>{selfPickupCompleted ? "自提签收完成" : "正在同步"}</span></td>
                </tr></tbody>
              </table>
            </div>
            {selfPickupCompleted && <div className="loading-next-action">
              <strong>扫码自提签收已完成</strong>
              <span>境外仓扫码自提结果与订单工作流已同步，下一步进入费用结算。</span>
              <Link className="primary" to={`/admin/orders/${data.order.id}/modules/costs`}>进入费用结算</Link>
            </div>}
          </BusinessSubsection>
        )}
      </div>
    );
  }
  if (code === "costs") {
    const directionControl = (direction: "receivable" | "payable") =>
      data.expenseDirectionControls.find((item) => item.direction === direction) ||
      emptyExpenseDirectionControl(direction);
    const settlementOpen = ["reconciliation", "completion_review"].includes(
      data.workflowStageAccess.currentStepKey ?? "",
    );
    return (
      <div className="module-business-stack dense-module-stack">
        {data.order.status === "draft" && (
          <div className="alert warning">
            提交审批前的应收费用由“已接受报价”自动继承；应付费用在国内运输安排确定承运商和运价时自动生成。
          </div>
        )}
        {!settlementOpen && data.order.status !== "draft" && (
          <div className="alert">
            当前阶段只显示并允许费用预录；费用确认、业务审核、财务审核和锁定将在“对账结算”阶段自动开放。
          </div>
        )}
        <div className="module-toolbar">
          {manage && settlementOpen && (
            <details className="expandable module-create-dialog">
              <summary>新增费用</summary>
              <ExpenseCreateForm fields={data.workflowFields} busy={busy}/>
            </details>
          )}
          <span className="status-pill">应收、应付分别确认和锁定</span>
        </div>
        <ModuleSummaryTable items={[
          { label: "应收", value: moneyTotal(data.expenses, "receivable").toFixed(2), detail: "折算汇总" },
          { label: "应付", value: moneyTotal(data.expenses, "payable").toFixed(2), detail: "折算汇总" },
          { label: "预计利润", value: (moneyTotal(data.expenses, "receivable") - moneyTotal(data.expenses, "payable")).toFixed(2), detail: "未含跨币种展示差异" },
          { label: "费用风险", value: data.expenses.length === 0 ? "尚未预录" : ["receivable", "payable"].some((direction) => !directionControl(direction as "receivable" | "payable").confirmed) ? "存在未确认费用" : "费用已确认", detail: "正式门禁在对账环节校验" },
        ]} />
        {(["receivable", "payable"] as const).map((direction) => {
          const control = directionControl(direction);
          const rows = data.expenses.filter((item) => item.direction === direction);
          const locked = Boolean(control.business_locked || control.finance_locked);
          return (
            <BusinessSubsection
              key={direction}
              title={direction === "receivable" ? "应收费用台账" : "应付费用台账"}
              hint="高密度展示费用明细；未锁定费用可直接编辑，审核与锁定流程在表格下方办理。"
            >
              <div className="expense-ledger-head">
                <div>
                  <strong>{rows.length} 笔</strong>
                  <span>折算汇总 {moneyTotal(data.expenses, direction).toFixed(2)}</span>
                </div>
                {manage && (
                  <span className={`status-pill ${locked ? "off" : ""}`}>
                    {locked ? "已锁定，只读" : "可新增、可编辑"}
                  </span>
                )}
              </div>
              <div className="table-wrap module-record-table expense-ledger-table">
                <table>
                  <thead>
                    <tr>
                      <th>费用名称</th>
                      <th>币种</th>
                      <th>汇率</th>
                      <th>数量</th>
                      <th>单价</th>
                      <th>金额</th>
                      <th>往来单位</th>
                      <th>摘要</th>
                      <th>发生日期</th>
                      <th>内部</th>
                      <th>税率/税金</th>
                      <th>国外账单号</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((expense) => (
                      <tr key={expense.id}>
                        <td><strong>{expense.charge_name}</strong><small>{expense.charge_code}</small></td>
                        <td>{expense.currency}</td>
                        <td>{expense.exchange_rate}</td>
                        <td>{expense.quantity}</td>
                        <td>{expense.unit_price.toLocaleString()}</td>
                        <td><strong>{expense.amount.toLocaleString()}</strong></td>
                        <td>{expense.counterparty_name || "待确认"}</td>
                        <td>{expense.notes || "—"}</td>
                        <td>{expense.occurred_on || "—"}</td>
                        <td>{expense.is_internal ? "是" : "否"}</td>
                        <td>{expense.tax_rate}%<small>{expense.tax_amount.toLocaleString()}</small></td>
                        <td>{expense.foreign_account_no || "—"}</td>
                        <td>{expenseStageLabel(expense.stage)}</td>
                        <td>
                          {manage && !locked ? (
                            <Modal
                              title={`编辑${direction === "receivable" ? "应收" : "应付"}费用`}
                              triggerLabel="编辑"
                              triggerClassName="text-button"
                              size="wide"
                            >
                              <ExpenseEditForm
                                expense={expense}
                                fields={data.workflowFields}
                                busy={busy}
                              />
                            </Modal>
                          ) : (
                            <span className="muted">只读</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!rows.length && (
                      <tr><td colSpan={14} className="empty-state">暂无{direction === "receivable" ? "应收" : "应付"}费用，请点击上方“新增费用”。</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <ExpenseDirectionWorkflow
                direction={direction}
                control={control}
                hasExpenses={rows.length > 0}
                manage={manage && settlementOpen}
                busy={busy}
              />
            </BusinessSubsection>
          );
        })}
        <Link
          className="secondary module-external-link"
          to="/admin/workbenches/costs"
        >
          进入跨订单汽运费用
        </Link>
      </div>
    );
  }
  if (code === "assignment") {
    const dispatchModuleCodes = new Set(["transport", "tracking", "costs"]);
    const assignableModules = data.modules.filter(
      (item) =>
        item.enabled === 1 &&
        dispatchModuleCodes.has(item.module_code) &&
        !["completed", "not_applicable"].includes(item.status),
    );
    const assignmentModule = data.modules.find((item) => item.module_code === "assignment");
    if (data.order.status === "submitted") {
      return <div className="assignment-waiting-note"><strong>等待委托审核</strong><span>委托审批通过后，本页自动开放任务分配。</span></div>;
    }
    return <AssignmentManifestWorkbench
      modules={assignableModules}
      members={data.members}
      mainAssigneeUserId={assignmentModule?.assignee_user_id || data.order.current_assignee_user_id || ""}
      canSubmit={data.order.status === "confirmed"}
      busy={busy}
    />;
  }
  if (code === "consignment") {
    const customFields = data.workflowFields.filter(
      (field) => field.isActive && !field.isBuiltIn,
    );
    const showInfo = !consignmentSection || consignmentSection === "info";
    const showCosts = !consignmentSection || consignmentSection === "costs";
    const showQuotationInformation = hasVisibleRuntimeWorkflowField(
      data.workflowFields,
      quotationConsignmentPresentationKeys,
    );
    const showOrderCreationInformation = hasVisibleRuntimeWorkflowField(
      data.workflowFields,
      orderCreationConsignmentPresentationKeys,
    );
    const showQuotationCosts = hasVisibleRuntimeWorkflowField(
      data.quotationCostWorkflowFields,
      quotationCostsPresentationKeys,
    );
    const quotationChargePolicy = workflowFieldPolicy(
      data.quotationCostWorkflowFields,
      "quotation_charge_items",
    );
    const inheritedReceivablePolicy = workflowFieldPolicy(
      data.quotationCostWorkflowFields,
      "pre_receivable_expenses",
    );
    const showQuotationChargeTable = quotationChargePolicy.visible || inheritedReceivablePolicy.visible;
    const supplementalExpenses = data.expenses.filter(
      (expense) => !["quotation", "quotation_charge"].includes(expense.source_type || ""),
    );
    return (
      <div className="module-business-stack consignment-business-stack">
        {showInfo && <section className="consignment-form-sheet" aria-label="委托信息">
          <header>
            <div>
              <h3>委托信息</h3>
              <p>报价和客户资料自动继承；这里只复核订单事实，不重复录入货物、文件和费用。</p>
            </div>
            <OrderNumberLink className="status-pill" id={data.order.id} number={data.order.order_number}/>
          </header>

          {showQuotationInformation && <WorkflowInformationGroup
            title="询价报价确认资料"
            hint="只展示当前订单锁定工作流在第一步设为显示的字段；必填状态沿用该版本规则。"
            fields={data.workflowFields}
            items={[
              { fieldKey: "quotation_customer_contact_name", label: "客户联系人", value: data.order.quotation_customer_contact_name || "" },
              { fieldKey: "quotation_customer_contact_phone", label: "联系电话", value: data.order.quotation_customer_contact_phone || "" },
              { fieldKey: "quotation_salesperson_user_id", label: "业务员", value: data.order.quotation_salesperson_name || "" },
              { fieldKey: "quotation_customs_clearance_mode", label: "清关办理方式", value: data.order.customs_clearance_mode === "customer" ? "客户自理清关" : "公司代办清关" },
              { fieldKey: "quotation_origin_region", label: "起运地区", value: [data.order.origin_country,data.order.origin_state,data.order.origin_city].filter(Boolean).join(" / ") },
              { fieldKey: "quotation_pickup_address", label: "提货地址", value: data.order.origin_address || "" },
              { fieldKey: "quotation_destination_region", label: "目的地区", value: [data.order.destination_country,data.order.destination_state,data.order.destination_city].filter(Boolean).join(" / ") },
              { fieldKey: "quotation_destination_warehouse_id", label: "目的仓库", value: data.order.overseas_warehouse_name || "" },
              { fieldKey: "quotation_destination_warehouse_note", label: "目的地备注", value: data.order.overseas_warehouse_address_note || "" },
            ]}
          />}

          {showOrderCreationInformation && <WorkflowInformationGroup
            title="订单基础"
            fields={data.workflowFields}
            items={[
              { fieldKey: "customer_id", label: "委托客户", value: data.order.customer_name || "" },
              { fieldKey: "quotation_id", label: "已接受报价", value: data.order.quote_number || "" },
              { fieldKey: "order_date", label: "接单日期", value: data.order.order_date || "" },
              { fieldKey: "business_nature", label: "业务性质", value: businessNatureLabels[data.order.business_nature] || data.order.business_nature || "" },
            ]}
          />}

          {showOrderCreationInformation && <WorkflowInformationGroup
            title="客户与起运地"
            fields={data.workflowFields}
            items={[
              { fieldKey: "shipper_customer_id", label: "发货方", value: data.order.shipper_name || "" },
              { fieldKey: "pickup_address_id", label: "常用提货地", value: data.order.pickup_address_name || data.order.origin_address || "" },
              { fieldKey: "shipper_contact", label: "客户联系人", value: data.order.shipper_contact || "" },
              { fieldKey: "shipper_phone", label: "联系电话", value: data.order.shipper_phone || "" },
              { fieldKey: "origin_country", label: "起运国家/地区", value: data.order.origin_country || "" },
              { fieldKey: "origin_state", label: "起运省/州", value: data.order.origin_state || "" },
              { fieldKey: "origin_city", label: "起运城市", value: data.order.origin_city || "" },
              { fieldKey: "origin_address", label: "提货地址", value: data.order.origin_address || "" },
            ]}
          />}

          {showOrderCreationInformation && <WorkflowInformationGroup
            title="收货人与境外目的仓"
            fields={data.workflowFields}
            items={[
              { fieldKey: "consignee_name", label: "收货人", value: data.order.consignee_name || "" },
              { fieldKey: "consignee_contact", label: "收货联系人", value: data.order.consignee_contact || "" },
              { fieldKey: "consignee_phone", label: "收货联系电话", value: data.order.consignee_phone || "" },
              { fieldKey: "destination_country", label: "目的国家/地区", value: data.order.destination_country || "" },
              { fieldKey: "destination_state", label: "目的省/州", value: data.order.destination_state || "" },
              { fieldKey: "destination_city", label: "目的城市", value: data.order.destination_city || "" },
              { fieldKey: "destination_address", label: "送货地址", value: data.order.destination_address || "" },
              { fieldKey: "overseas_warehouse_id", label: "境外目的仓", value: data.order.overseas_warehouse_name || "" },
              { fieldKey: "overseas_warehouse_address_note", label: "目的仓地址备注", value: data.order.overseas_warehouse_address_note || "" },
            ]}
          />}

          {showOrderCreationInformation && <WorkflowInformationGroup
            title="时间与备注"
            fields={data.workflowFields}
            items={[
              { fieldKey: "requested_pickup_date", label: "预约提货时间", value: data.order.requested_pickup_date || "" },
              { fieldKey: "cargo_ready_at", label: "货好时间", value: data.order.cargo_ready_at ? formatDateTime(data.order.cargo_ready_at) : "" },
              { fieldKey: "requested_delivery_date", label: "要求送达日", value: data.order.requested_delivery_date || "" },
              { fieldKey: "ro_agent", label: "RO 代理", value: data.order.ro_agent || "" },
              { fieldKey: "special_instructions", label: "备注", value: data.order.special_instructions || "" },
            ]}
          />}

          {!showQuotationInformation && !showOrderCreationInformation && !customFields.length && (
            <div className="alert workflow-hidden-data-note">当前工作流已将本节标准字段全部设为隐藏；历史值仍保留审计。</div>
          )}

          {customFields.length > 0 && (
            <div className="consignment-form-group">
              <h4>模板补充字段</h4>
              <div className="table-wrap">
                <table className="consignment-custom-table">
                  <thead><tr><th>字段</th><th>填写要求</th><th>当前内容</th></tr></thead>
                  <tbody>{customFields.map((field) => (
                    <tr key={field.id} className={field.present ? "ready" : field.isRequired ? "missing" : ""}>
                      <td><strong>{field.label}{field.isRequired && <sup>*</sup>}</strong><small className="subline">{field.helpText || "业务补充信息"}</small></td>
                      <td><span className={`field-state ${field.present && field.isRequired ? "filled" : field.isRequired ? "required-missing" : "optional-empty"}`}>{field.present ? "已填" : field.isRequired ? "必填但未填" : "未填"}</span></td>
                      <td><div className="consignment-custom-field-control">{manage ? <CustomWorkflowFieldForm field={field} busy={busy} /> : <span>{field.displayValue || ""}</span>}<div className="consignment-custom-field-source"><span>来源节点：{field.stepName || field.stepKey}</span><Link className="text-button" to={workflowFieldConfigurationHref({workflowId:field.workflowId,stepKey:field.stepKey,moduleCode:field.moduleCode,fieldKey:field.fieldKey})}>配置显示规则</Link></div></div></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}
        </section>}

        {showCosts && <section className="consignment-form-sheet" aria-label="订单费用">
          <header>
            <div><h3>订单费用</h3><p>报价费用自动继承且保持只读；业务员可新增本订单后续产生的应收或应付费用。</p></div>
            <div className="consignment-cost-actions">
              {showQuotationChargeTable && <strong className="consignment-total-amount">{data.order.quotation_currency && data.order.quotation_total_amount != null ? `${data.order.quotation_currency} ${Number(data.order.quotation_total_amount).toLocaleString()}` : "—"}</strong>}
              {manage&&<Modal title="新增订单费用" triggerLabel="新增费用" triggerClassName="primary" size="wide" closeSignal={moduleActionData?.success}>
                {moduleActionData?.formError&&<div className="alert error" role="alert">{moduleActionData.formError}</div>}
                <div className="alert">新增费用会进入订单费用台账，后续在“对账结算”节点统一确认、审核和锁定。</div>
                <ExpenseCreateForm fields={data.quotationCostWorkflowFields} busy={busy} entryContext="consignment_costs"/>
              </Modal>}
            </div>
          </header>
          {showQuotationCosts?<>
            <WorkflowInformationGroup
              title="报价时效"
              fields={data.quotationCostWorkflowFields}
              items={[{ fieldKey: "quotation_valid_until", label: "报价有效期", value: data.order.quotation_valid_until || "" }]}
            />
            {showQuotationChargeTable && <div className="table-wrap consignment-charge-table" data-workflow-field={quotationChargePolicy.visible ? "quotation_charge_items" : "pre_receivable_expenses"}>
              <table>
                <thead><tr><th>{quotationChargePolicy.label || inheritedReceivablePolicy.label || "费用名称"}{quotationChargePolicy.required || inheritedReceivablePolicy.required ? " *" : ""}</th><th>费用代码</th><th>币种</th><th>汇率</th><th>数量</th><th>单价</th><th>金额</th></tr></thead>
                <tbody>
                  {data.quotationCharges.map((charge) => <tr key={charge.id}><td><strong>{charge.description}</strong></td><td>{charge.charge_code}</td><td>{data.order.quotation_currency || ""}</td><td>{Number(charge.exchange_rate).toLocaleString()}</td><td>{Number(charge.quantity).toLocaleString()}</td><td>{Number(charge.unit_price).toLocaleString()}</td><td><strong>{Number(charge.amount).toLocaleString()}</strong></td></tr>)}
                  {!data.quotationCharges.length && <tr><td colSpan={7} className="empty-state">关联报价尚无费用明细</td></tr>}
                </tbody>
              </table>
            </div>}
          </>:<div className="alert workflow-hidden-data-note">当前工作流已隐藏询价报价费用与有效期；历史金额仍保留用于结算和审计。</div>}
          <section className="consignment-form-group consignment-supplemental-expenses">
            <h4>新增订单费用 <span>{supplementalExpenses.length} 项</span></h4>
            <div className="table-wrap">
              <table>
                <thead><tr><th>方向</th><th>费用名称</th><th>往来单位</th><th>币种</th><th>汇率</th><th>数量</th><th>单价</th><th>金额</th><th>状态</th><th>备注</th></tr></thead>
                <tbody>
                  {supplementalExpenses.map((expense)=><tr key={expense.id}><td><span className={`status-pill ${expense.direction==="payable"?"warning":"success"}`}>{expense.direction==="receivable"?"应收":"应付"}</span></td><td><strong>{expense.charge_name}</strong><small>{expense.charge_code}</small></td><td>{expense.counterparty_name||"—"}</td><td>{expense.currency}</td><td>{expense.exchange_rate}</td><td>{expense.quantity}</td><td>{expense.unit_price.toLocaleString()}</td><td><strong>{expense.amount.toLocaleString()}</strong></td><td>{expenseStageLabel(expense.stage)}</td><td>{expense.notes||"—"}</td></tr>)}
                  {!supplementalExpenses.length&&<tr><td colSpan={10} className="empty-state">暂无新增费用；如报价之外产生其他费用，请点击右上角“新增费用”。</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </section>}

        {showConsignmentActionBar && <ConsignmentReviewActionBar data={data} busy={busy} />}
      </div>
    );
  }
  if (code === "warehouse") {
    const actualByCargo = new Map(
      (data.warehouseFlow?.cargoActuals ?? []).map((item) => [item.cargo_item_id, item]),
    );
    const packageLabels = data.warehouseFlow?.packageLabels ?? [];
    const receipts = data.warehouseFlow?.receipts ?? [];
    const packageStatuses = data.warehouseFlow?.packageStatuses ?? [];
    const packageCount = (status: string) =>
      packageStatuses.find((item) => item.status === status)?.package_count ?? 0;
    const hasReceipt = Boolean(data.warehouseFlow?.receiptCount);
    return (
      <div className="module-business-stack dense-module-stack warehouse-comparison-workbench">
        <p className="readonly-note">本节点由国内仓操作员在仓库端完成。管理端按货物行对照订单创建数据与仓库实际清点数据，不重复修改仓库实收。</p>

        {data.warehouseFlow?.inboundReady ? (
          <div className="alert success"><strong>国内仓入库完成：</strong>仓库已经确认货齐，实收数据已同步至订单，主流程会自动开放出口准备与装车出库。</div>
        ) : data.warehouseFlow?.received ? (
          <div className="alert warning"><strong>国内仓已部分入库：</strong>实收数据已经同步，等待仓库确认整票货齐后自动推进下一节点。</div>
        ) : null}

        <BusinessSubsection title="国内仓入库核实记录" hint="逐张显示仓库提交的入仓时间、实收数量、库位、核实结果和操作人员。">
          <div className="table-wrap module-record-table operation-sheet-table warehouse-receipt-detail-table">
            <table>
              <thead><tr><th>收货单</th><th>入仓时间</th><th>仓库 / 库位</th><th>仓库核实结果</th><th>实收</th><th>操作人员</th><th>备注 / 凭证</th></tr></thead>
              <tbody>
                {receipts.map((receipt) => <tr key={receipt.id}>
                  <td><strong>{receipt.receipt_number}</strong></td>
                  <td>{new Date(receipt.received_at).toLocaleString("zh-CN",{hour12:false})}</td>
                  <td>{receipt.warehouse_name}<small>{receipt.zone_name} / {receipt.location_name}（{receipt.location_code}）</small></td>
                  <td><span className={`status-pill ${receipt.cargo_complete ? "success" : receipt.has_exception ? "danger" : ""}`}>{receipt.cargo_complete ? "已核实货齐" : receipt.has_exception ? "异常入库" : "分批入库"}</span>{receipt.exception_notes && <small className="danger-text">{receipt.exception_notes}</small>}</td>
                  <td><strong>{receipt.total_packages} 包 / {receipt.total_pieces} 件</strong><small>{Number(receipt.total_weight_kg).toFixed(2)} KG · {Number(receipt.total_volume_cbm).toFixed(3)} CBM</small></td>
                  <td>{receipt.operator_name || "仓库操作员"}</td>
                  <td>{receipt.notes || "—"}<small>{receipt.evidence_note || "无补充凭证说明"}</small></td>
                </tr>)}
                {!receipts.length && <tr><td colSpan={7} className="empty-state">尚未收到国内仓入库核实记录。</td></tr>}
              </tbody>
            </table>
          </div>
        </BusinessSubsection>

        <BusinessSubsection title="订单创建数据与仓库实际清点对比" hint="每条货物固定显示订单创建行和仓库实点行；入库前实点值为空，验收入库后自动同步。">
          <div className="table-wrap module-record-table operation-sheet-table warehouse-cargo-comparison-table">
            <table>
              <thead><tr><th>货物</th><th>数据来源</th><th>包装类型</th><th>包装数</th><th>件数</th><th>重量 KG</th><th>长×宽×高 CM</th><th>体积 CBM</th><th>收货单 / 标签</th></tr></thead>
              <tbody>
                {data.cargo.flatMap((cargo) => {
                  const actual = actualByCargo.get(cargo.id);
                  const hasActual = Boolean(actual?.actual_record_count);
                  const labels = packageLabels.filter((item) => item.cargo_item_id === cargo.id);
                  return [
                    <tr key={`${cargo.id}-planned`} className="comparison-planned-row">
                      <td rowSpan={2}><strong>{cargo.cargo_name_cn}</strong><small>{cargo.cargo_name_en || "—"} · HS {cargo.hs_code || "—"}</small></td>
                      <td><span className="data-source-label planned">订单创建</span></td>
                      <td>{warehousePackageTypeLabel(cargo.package_type)}</td>
                      <td>{cargo.package_count}</td>
                      <td>{cargo.package_count * cargo.pieces_per_package}</td>
                      <td>{(cargo.package_count * cargo.gross_weight_per_package_kg).toFixed(2)}</td>
                      <td>{cargo.length_cm} × {cargo.width_cm} × {cargo.height_cm}</td>
                      <td>{(cargo.package_count * cargo.volume_per_package_cbm).toFixed(3)}</td>
                      <td>订单货物明细</td>
                    </tr>,
                    <tr key={`${cargo.id}-actual`} className={hasActual ? "comparison-actual-row ready" : "comparison-actual-row pending"}>
                      <td><span className={`data-source-label ${hasActual ? "actual" : "pending"}`}>仓库实点</span></td>
                      <td>{hasActual ? warehousePackageTypesLabel(actual?.actual_package_types ?? null) : "—"}</td>
                      <td>{hasActual ? actual?.actual_packages : "—"}</td>
                      <td>{hasActual ? actual?.actual_pieces : "—"}</td>
                      <td>{hasActual ? Number(actual?.actual_weight_kg).toFixed(2) : "—"}</td>
                      <td>{hasActual ? actual?.actual_dimensions || "—" : "—"}</td>
                      <td>{hasActual ? Number(actual?.actual_volume_cbm).toFixed(3) : "—"}</td>
                      <td>{hasActual ? <><strong>{actual?.receipt_numbers || "收货单待同步"}</strong><small>{labels.length} 张仓库标签</small></> : "—"}</td>
                    </tr>,
                  ];
                })}
                {!data.cargo.length && <tr><td colSpan={9} className="empty-state">订单尚无货物创建数据。</td></tr>}
              </tbody>
            </table>
          </div>
          {Boolean(data.warehouseFlow?.pendingDifferenceCount) && <div className="alert warning"><strong>实收差异待确认：</strong>共 {data.warehouseFlow?.pendingDifferenceCount} 条，最大差异 {data.warehouseFlow?.maxDifferencePercent?.toFixed(1)}%。仓库可继续作业，但结算前必须确认费用影响。<Form method="post"><input type="hidden" name="intent" value="warehouse_difference_confirm"/><button className="secondary">确认差异及费用影响</button></Form></div>}
        </BusinessSubsection>

        <BusinessSubsection title="仓库标签明细" hint="标签号和条码来自仓库验收生成的实际包装；出库后仍保留历史记录。">
          <div className="table-wrap module-record-table operation-sheet-table warehouse-label-table">
            <table>
              <thead><tr><th>标签号</th><th>条码</th><th>货物</th><th>实点件数</th><th>重量 / 体积</th><th>长×宽×高 CM</th><th>仓库 / 库位</th><th>状态</th><th>生成时间</th></tr></thead>
              <tbody>
                {packageLabels.map((label) => <tr key={label.id}>
                  <td><strong>{label.package_number}</strong></td>
                  <td><code>{label.barcode}</code></td>
                  <td>{label.line_no ? `${label.line_no}. ` : ""}{label.cargo_name_cn || "未关联货物行"}</td>
                  <td>{label.pieces}</td>
                  <td>{label.weight_kg == null ? "—" : `${Number(label.weight_kg).toFixed(2)} KG`}<small>{label.volume_cbm == null ? "—" : `${Number(label.volume_cbm).toFixed(3)} CBM`}</small></td>
                  <td>{label.length_cm == null || label.width_cm == null || label.height_cm == null ? "—" : `${label.length_cm} × ${label.width_cm} × ${label.height_cm}`}</td>
                  <td>{label.warehouse_name || "—"}<small>{[label.zone_name,label.location_name,label.location_code && `(${label.location_code})`].filter(Boolean).join(" / ") || "—"}</small></td>
                  <td><span className={`status-pill ${["in_stock","allocated","dispatched","picked_up"].includes(label.status) ? "success" : label.status === "exception" ? "danger" : ""}`}>{warehousePackageStatusText(label.status)}</span></td>
                  <td>{new Date(label.created_at).toLocaleString("zh-CN",{hour12:false})}</td>
                </tr>)}
                {!packageLabels.length && <tr><td colSpan={9} className="empty-state">尚未验收入库，暂无仓库标签号。</td></tr>}
              </tbody>
            </table>
          </div>
        </BusinessSubsection>

        <BusinessSubsection title="入库记录与库存状态" hint="入库、分配、出库和移库状态均由仓库包装记录实时汇总。">
          <div className="table-wrap module-record-table operation-sheet-table warehouse-status-table">
            <table>
              <thead><tr><th>首次入库</th><th>最后入库</th><th>收货单</th><th>在库</th><th>已分配</th><th>已出库</th><th>异常</th><th>移库记录</th></tr></thead>
              <tbody><tr>
                <td>{hasReceipt && data.warehouseFlow?.firstInboundAt ? new Date(data.warehouseFlow.firstInboundAt).toLocaleString("zh-CN",{hour12:false}) : "—"}</td>
                <td>{hasReceipt && data.warehouseFlow?.lastInboundAt ? new Date(data.warehouseFlow.lastInboundAt).toLocaleString("zh-CN",{hour12:false}) : "—"}</td>
                <td>{hasReceipt ? `${data.warehouseFlow?.receiptCount} 张` : "—"}</td>
                <td>{hasReceipt ? `${packageCount("in_stock")} 个` : "—"}</td>
                <td>{hasReceipt ? `${packageCount("allocated")} 个` : "—"}</td>
                <td>{hasReceipt ? `${packageCount("dispatched")} 个` : "—"}</td>
                <td>{hasReceipt ? `${packageCount("exception")} 个` : "—"}</td>
                <td>{hasReceipt ? `${packageStatuses.reduce((sum,item)=>sum+item.move_count,0)} 次` : "—"}</td>
              </tr></tbody>
            </table>
          </div>
        </BusinessSubsection>

        <BusinessSubsection title="仓库办理" hint="实际收货操作继续在仓库端完成；管理端仅提供入口和同步状态。">
          <div className="table-wrap module-record-table operation-sheet-table warehouse-operation-table">
            <table>
              <thead><tr><th>办理事项</th><th>当前状态</th><th>同步结果</th><th>操作</th></tr></thead>
              <tbody><tr>
                <td>到仓收货、实点登记与货齐确认</td>
                <td><span className={`status-pill ${data.warehouseFlow?.inboundReady ? "success" : ""}`}>{data.warehouseFlow?.inboundReady ? "已入库并确认货齐" : data.warehouseFlow?.received ? "已收货，待确认货齐" : "待仓库收货"}</span></td>
                <td>{data.warehouseFlow?.inboundReady ? "已同步至订单，允许进入装车与出库" : "仓库实点值和标签将在入库后自动显示"}</td>
                <td><div className="row-actions"><WarehouseSiteButton orderId={data.order.id} targetPath="/warehouse/acceptance" className="primary">{data.warehouseFlow?.inboundReady ? "查看收货记录" : "去仓库收货"}</WarehouseSiteButton>{data.warehouseFlow?.inboundReady && <Link className="secondary" to={`/admin/orders/${data.order.id}/modules/loading#module-business-data`}>进入装车与出库</Link>}</div></td>
              </tr></tbody>
            </table>
          </div>
        </BusinessSubsection>
      </div>
    );
  }
  if (code === "review" && data.orderReview) {
    const review = data.orderReview;
    const canGenerate = manage;
    const timings = [
      ["下单", review.timing.orderAt],
      ["提货", review.timing.pickupAt],
      ["入仓", review.timing.inboundAt],
      ["装车", review.timing.loadingAt],
      ["出境", review.timing.outboundAt],
      ["到仓", review.timing.overseasArrivalAt],
      ["自提完成", review.timing.pickupCompletedAt],
    ] as const;
    return (
      <div className="module-business-stack dense-module-stack order-review-workbench">
        <BusinessSubsection
          title="复盘结论与完成判定"
          hint="完成复盘前必须完成应收、应付的收付款与核销，并确保所有币种未结余额为零。"
        >
          <div className="order-review-status-row">
            <span className={`status-pill review-status-${review.completionStatus}`}>
              {review.completionLabel}
            </span>
            <span>
              {review.snapshotId
                ? `第 ${review.revision} 版 · ${review.generatedBy || "系统"} · ${review.generatedAt ? new Date(review.generatedAt).toLocaleString("zh-CN") : "—"}`
                : "尚未生成订单复盘"}
            </span>
          </div>
          {review.blockers.length ? (
            <div className="review-blocker-list">
              <strong>异常通知</strong>
              {review.blockers.map((blocker) => (
                <Link key={blocker.code} to={blocker.href}>
                  {blocker.message} <span>查看并处理 →</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="alert success">业务条件、收付款与核销均已闭环；生成复盘后可完成订单。</p>
          )}
        </BusinessSubsection>

        <BusinessSubsection title="时效复盘" hint="所有时间均来自对应业务模块的实际记录，不要求重复填写。">
          <div className="table-wrap module-record-table review-timing-table">
            <table>
              <thead><tr>{timings.map(([label]) => <th key={label}>{label}</th>)}</tr></thead>
              <tbody><tr>{timings.map(([label, value]) => <td className={value ? "completed-cell" : "pending-cell"} key={label}><strong>{reviewDate(value)}</strong></td>)}</tr></tbody>
            </table>
          </div>
        </BusinessSubsection>

        <BusinessSubsection title="货量复盘" hint="按计划、仓库实收和实际装车三种口径并列展示。">
          <div className="table-wrap module-record-table">
            <table>
              <thead><tr><th>口径</th><th>件数</th><th>重量 KG</th><th>体积 CBM</th></tr></thead>
              <tbody>
                <ReviewCargoRow label="订单预录" pieces={review.cargo.plannedPieces} weight={review.cargo.plannedWeightKg} volume={review.cargo.plannedVolumeCbm} />
                <ReviewCargoRow label="仓库实收" pieces={review.cargo.actualPieces} weight={review.cargo.actualWeightKg} volume={review.cargo.actualVolumeCbm} />
                <ReviewCargoRow label="实际装车" pieces={review.cargo.loadedPieces} weight={review.cargo.loadedWeightKg} volume={review.cargo.loadedVolumeCbm} />
              </tbody>
            </table>
          </div>
        </BusinessSubsection>

        <BusinessSubsection title="费用与利润" hint="不同币种分别统计，不做跨币种毛利合并。">
          <div className="table-wrap module-record-table">
            <table>
              <thead><tr><th>币种</th><th>应收</th><th>应付</th><th>实收</th><th>实付</th><th>毛利</th><th>毛利率</th><th>未结余额</th></tr></thead>
              <tbody>
                {review.finance.map((line) => (
                  <tr key={line.currency}>
                    <td><strong>{line.currency}</strong></td>
                    <td>{line.receivable.toLocaleString()}</td>
                    <td>{line.payable.toLocaleString()}</td>
                    <td>{line.received.toLocaleString()}</td>
                    <td>{line.paid.toLocaleString()}</td>
                    <td>{line.margin.toLocaleString()}</td>
                    <td>{line.marginRate === null ? "—" : `${line.marginRate}%`}</td>
                    <td>{line.receivableBalance.toLocaleString()} / {line.payableBalance.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!review.finance.length && <p className="empty-state">暂无可复盘费用。</p>}
        </BusinessSubsection>

        <BusinessSubsection title="异常与人员" hint="自动汇总系统记录，客户异议与复盘结论由复盘人补充。">
          <ModuleSummaryTable className="review-summary-table" items={[
            { label: "货差", value: review.exceptions.cargoDifferenceCount, detail: `最大 ${review.exceptions.maxCargoDifferencePercent.toFixed(1)}%` },
            { label: "未关闭异常", value: review.exceptions.openWarehouseExceptionCount, detail: "仓库异常" },
            { label: "延误", value: review.exceptions.delayDays, detail: "天" },
            { label: "费用调整", value: review.exceptions.costAdjustmentCount, detail: "条" },
          ]} />
          <div className="table-wrap module-record-table review-people-table">
            <table>
              <thead><tr><th>业务员</th><th>主操作</th><th>仓库经办</th><th>财务经办</th></tr></thead>
              <tbody><tr><td>{review.people.salesperson || "—"}</td><td>{review.people.mainOperator || "—"}</td><td>{review.people.warehouseHandler || "—"}</td><td>{review.people.financeHandler || "—"}</td></tr></tbody>
            </table>
          </div>
        </BusinessSubsection>

        {canGenerate && (
          <BusinessSubsection title="生成订单复盘" hint="可以重复生成新版本；每次均重新读取业务模块实际数据。">
            <Form method="post" className="review-generation-form">
              <input type="hidden" name="intent" value="generate_order_review" />
              <ModuleField fields={data.workflowFields} fieldKey="customer_dispute_summary" label="客户异议摘要">
                {(required) => <textarea name="customerDisputeSummary" required={required} defaultValue={review.customerDisputeSummary || ""} placeholder="没有异议可留空" />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="review_result" label="复盘结论" fallbackRequired>
                {(required) => <textarea name="reviewConclusion" required={required} defaultValue={review.reviewConclusion || ""} placeholder="本票业务结论、主要偏差与原因" />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="review_improvements" label="改进建议">
                {(required) => <textarea name="improvementNotes" required={required} defaultValue={review.improvementNotes || ""} placeholder="后续可复用的改进动作" />}
              </ModuleField>
              <button className="primary" disabled={busy}>生成并判定订单完成状态</button>
            </Form>
          </BusinessSubsection>
        )}
        <Link className="secondary module-external-link" to="/admin/billing">进入费用结算与核销</Link>
      </div>
    );
  }
  if (code === "exceptions")
    return (
      <div className="module-business-stack dense-module-stack">
        <div className="table-wrap module-record-table exception-capability-table">
          <table>
            <thead><tr><th>处理环节</th><th>业务范围</th><th>办理位置</th></tr></thead>
            <tbody>
              <tr><td><strong>异常登记</strong></td><td>资料、货损、短少、多货、错标、报关、配载、运输和费用异常</td><td rowSpan={4}>仓库异常工作台</td></tr>
              <tr><td><strong>证据与责任</strong></td><td>上传现场图片、记录严重等级、责任人和处理期限</td></tr>
              <tr><td><strong>冻结与解除</strong></td><td>异常期间冻结相关业务动作，结案后解除</td></tr>
              <tr><td><strong>客户沟通</strong></td><td>区分内部说明与客户可见的处理进展</td></tr>
            </tbody>
          </table>
        </div>
        <Form method="post" action="/switch-site" className="module-external-form">
          <input type="hidden" name="target" value="warehouse" />
          <input
            type="hidden"
            name="warehouseTo"
            value={`/warehouse/exceptions?orderId=${data.order.id}&returnTo=${encodeURIComponent(`/admin/orders/${data.order.id}/modules/exceptions`)}`}
          />
          <button className="secondary module-external-link">查看仓库异常工作台</button>
        </Form>
      </div>
    );
  return (
    <p className="empty-state">
      当前模块已建立独立流程框架，后续业务表单将在这里逐项接入。
    </p>
  );
}
function CustomsDeclarationFlags({ declaration }: { declaration: CustomsDeclaration }) {
  const flags = [
    declaration.is_deleted ? "删单" : "",
    declaration.is_redeclared ? "删单重报" : "",
    declaration.is_amended ? "改单" : "",
    declaration.is_inspected ? "查验" : "",
  ].filter(Boolean);
  return <div className="customs-declaration-flags">{flags.length ? flags.map((flag) => <span key={flag}>{flag}</span>) : <span className="muted">无</span>}</div>;
}

function CustomsDeclarationAction({ declaration, manage, busy, fields }: { declaration: CustomsDeclaration; manage: boolean; busy: boolean; fields: WorkflowFieldState[] }) {
  const canRelease = declaration.status !== "released" && declaration.status !== "cancelled" && declaration.is_deleted !== 1;
  return <div className="row-actions customs-row-actions">
    <Modal title={`查看报关单 · ${declaration.declaration_number}`} triggerLabel="查看" triggerClassName="text-button" size="wide">
      <CustomsDeclarationView declaration={declaration} />
    </Modal>
    {manage ? <Modal title={`编辑报关单 · ${declaration.declaration_number}`} triggerLabel="编辑" triggerClassName="text-button" size="wide">
      <CustomsDeclarationForm declaration={declaration} busy={busy} fields={fields} lockStatus submitLabel="保存修改" />
    </Modal> : <button type="button" className="text-button" disabled title="当前账号只读">编辑</button>}
    {manage && canRelease
      ? <CustomsDeclarationInlineRelease declaration={declaration} busy={busy} />
      : <button type="button" className="text-button" disabled title={declaration.status === "released" ? "该报关单已放行" : declaration.is_deleted ? "已删单的报关单不能放行" : "当前账号只读"}>放行</button>}
  </div>;
}

function CustomsDeclarationView({ declaration }: { declaration: CustomsDeclaration }) {
  return <dl className="quote-detail-grid customs-declaration-view">
    <div><dt>作业阶段</dt><dd>{customsStageLabel(declaration.clearance_stage)}</dd></div>
    <div><dt>报关单号</dt><dd>{declaration.declaration_number || "—"}</dd></div>
    <div><dt>报关单类型</dt><dd>{declaration.declaration_type || "—"}</dd></div>
    <div><dt>状态</dt><dd>{customsDeclarationStatusLabel(declaration)}</dd></div>
    <div><dt>申报抬头</dt><dd>{declaration.declaration_title || "—"}</dd></div>
    <div><dt>申报公司</dt><dd>{declaration.declaring_company || "—"}</dd></div>
    <div><dt>申报金额</dt><dd>{declaration.currency} {Number(declaration.declared_amount).toLocaleString()}</dd></div>
    <div><dt>申报毛重</dt><dd>{Number(declaration.gross_weight_kg).toLocaleString()} KG</dd></div>
    <div><dt>申报时间</dt><dd>{formatDateTime(declaration.declared_at)}</dd></div>
    <div><dt>放行时间</dt><dd>{formatDateTime(declaration.released_at)}</dd></div>
    <div><dt>业务标记</dt><dd><CustomsDeclarationFlags declaration={declaration} /></dd></div>
    <div><dt>变更原因</dt><dd>{declaration.change_reason || "—"}</dd></div>
  </dl>;
}

function CustomsDeclarationInlineRelease({ declaration, busy }: { declaration: CustomsDeclaration; busy: boolean }) {
  return <Form method="post" className="customs-inline-release-form">
    <CustomsDeclarationReleaseFields declaration={declaration} releasedAt={new Date().toISOString()} />
    <button className="primary" disabled={busy}>确认放行</button>
  </Form>;
}

function CustomsDeclarationReleaseFields({ declaration, releasedAt }: { declaration: CustomsDeclaration; releasedAt?: string }) {
  return <>
    <input type="hidden" name="intent" value="customs_declaration_save" />
    <input type="hidden" name="declarationId" value={declaration.id} />
    <input type="hidden" name="customsRecordId" value={declaration.customs_record_id} />
    <input type="hidden" name="clearanceStage" value={declaration.clearance_stage} />
    <input type="hidden" name="status" value="released" />
    <input type="hidden" name="declarationNumber" value={declaration.declaration_number} />
    <input type="hidden" name="declarationType" value={declaration.declaration_type} />
    <input type="hidden" name="declarationTitle" value={declaration.declaration_title} />
    <input type="hidden" name="declaringCompany" value={declaration.declaring_company} />
    <input type="hidden" name="declaredAt" value={toDateTimeInput(declaration.declared_at)} />
    <input type="hidden" name="declaredAmount" value={declaration.declared_amount} />
    <input type="hidden" name="currency" value={declaration.currency} />
    <input type="hidden" name="grossWeightKg" value={declaration.gross_weight_kg} />
    <input type="hidden" name="changeReason" value={declaration.change_reason || ""} />
    {releasedAt && <input type="hidden" name="releasedAt" value={toDateTimeInput(releasedAt)} />}
    {declaration.is_redeclared === 1 && <input type="hidden" name="isRedeclared" value="on" />}
    {declaration.is_amended === 1 && <input type="hidden" name="isAmended" value="on" />}
    {declaration.is_inspected === 1 && <input type="hidden" name="isInspected" value="on" />}
  </>;
}

function customsValueMissing(value: unknown) {
  const normalized = String(value ?? "").trim();
  return !normalized || normalized === "未配置" || normalized === "—";
}

function customsDisplayValue(value: unknown) {
  return customsValueMissing(value) ? "未填写" : String(value);
}

function CustomsMissingValue({ label }: { label?: string }) {
  return <span className="customs-missing-value">{label ? `${label}未填写` : "未填写"}</span>;
}

function CustomsDeclarationForm({ busy, declaration, fields, lockStatus = false, submitLabel }: { busy: boolean; declaration?: CustomsDeclaration; fields: WorkflowFieldState[]; lockStatus?: boolean; submitLabel?: string }) {
  const [status, setStatus] = useState(declaration?.status === "released" ? "released" : "declared");
  const [isDeleted, setIsDeleted] = useState(declaration?.is_deleted === 1);
  return <Form method="post" className="form-grid compact customs-declaration-form">
    <input type="hidden" name="intent" value="customs_declaration_save" />
    {declaration?.id && <input type="hidden" name="declarationId" value={declaration.id} />}
    {!workflowFieldPolicy(fields, "declaration_stage").visible && <input type="hidden" name="clearanceStage" value={declaration?.clearance_stage ?? "origin"} />}
    {!workflowFieldPolicy(fields, "declaration_status").visible && <input type="hidden" name="status" value={declaration?.status ?? "declared"} />}
    {!workflowFieldPolicy(fields, "declaration_number").visible && <input type="hidden" name="declarationNumber" value={declaration?.declaration_number ?? ""} />}
    {!workflowFieldPolicy(fields, "declaration_type").visible && <input type="hidden" name="declarationType" value={declaration?.declaration_type ?? ""} />}
    {!workflowFieldPolicy(fields, "declaration_title").visible && <input type="hidden" name="declarationTitle" value={declaration?.declaration_title ?? ""} />}
    {!workflowFieldPolicy(fields, "declaring_company").visible && <input type="hidden" name="declaringCompany" value={declaration?.declaring_company ?? ""} />}
    {!workflowFieldPolicy(fields, "declared_at").visible && <input type="hidden" name="declaredAt" value={toDateTimeInput(declaration?.declared_at) || ""} />}
    {!workflowFieldPolicy(fields, "declared_amount").visible && <input type="hidden" name="declaredAmount" value={declaration?.declared_amount ?? 0} />}
    {!workflowFieldPolicy(fields, "declaration_currency").visible && <input type="hidden" name="currency" value={declaration?.currency ?? "USD"} />}
    {!workflowFieldPolicy(fields, "declaration_gross_weight").visible && <input type="hidden" name="grossWeightKg" value={declaration?.gross_weight_kg ?? 0} />}
    {(!workflowFieldPolicy(fields, "customs_release").visible || lockStatus) && declaration?.released_at && <input type="hidden" name="releasedAt" value={toDateTimeInput(declaration.released_at)} />}
    {!workflowFieldPolicy(fields, "declaration_change_reason").visible && <input type="hidden" name="changeReason" value={declaration?.change_reason ?? ""} />}
    {!workflowFieldPolicy(fields, "declaration_change_flags").visible && <>
      {declaration?.is_deleted === 1 && <input type="hidden" name="isDeleted" value="on" />}
      {declaration?.is_redeclared === 1 && <input type="hidden" name="isRedeclared" value="on" />}
      {declaration?.is_amended === 1 && <input type="hidden" name="isAmended" value="on" />}
      {declaration?.is_inspected === 1 && <input type="hidden" name="isInspected" value="on" />}
    </>}
    <ModuleField fields={fields} fieldKey="declaration_stage" label="报关作业阶段" fallbackRequired>
      {(required) => <select name="clearanceStage" defaultValue={declaration?.clearance_stage ?? "origin"} required={required}><option value="origin">起运地报关</option><option value="transit">过境地报关/清关</option><option value="destination">目的地清关</option></select>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="declaration_status" label="申报单状态" fallbackRequired>
      {(required) => lockStatus
        ? <><input type="hidden" name="status" value={isDeleted ? "cancelled" : status} /><span className={`status-pill ${status === "released" ? "success" : ""}`}>{isDeleted ? "已删单" : status === "released" ? "已放行" : "已申报，待放行"}</span></>
        : <><select name="status" value={status} onChange={(event) => setStatus(event.target.value)} disabled={isDeleted} required={required}><option value="declared">已申报，待放行</option><option value="released">已放行</option></select>{isDeleted && <input type="hidden" name="status" value="cancelled" />}</>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="declaration_number" label="报关单号" fallbackRequired>
      {(required) => <input name="declarationNumber" defaultValue={declaration?.declaration_number ?? ""} required={required} />}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="declaration_type" label="报关单类型" fallbackRequired>
      {(required) => <input name="declarationType" defaultValue={declaration?.declaration_type ?? ""} placeholder="例如一般贸易、转关" required={required} />}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="declaration_title" label="申报抬头" fallbackRequired>
      {(required) => <input name="declarationTitle" defaultValue={declaration?.declaration_title ?? ""} required={required} />}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="declaring_company" label="申报公司" fallbackRequired>
      {(required) => <input name="declaringCompany" defaultValue={declaration?.declaring_company ?? ""} required={required} />}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="declared_at" label="申报日期" fallbackRequired>
      {(required) => <input name="declaredAt" type="datetime-local" defaultValue={toDateTimeInput(declaration?.declared_at) || toDateTimeInput(new Date().toISOString())} required={required} />}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="declared_amount" label="申报金额" fallbackRequired>
      {(required) => <input name="declaredAmount" type="number" min="0" step="0.01" defaultValue={declaration?.declared_amount ?? 0} required={required} />}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="declaration_currency" label="申报币种" fallbackRequired>
      {(required) => <select name="currency" defaultValue={declaration?.currency ?? "USD"} required={required}>{["USD","CNY","RUB","KZT","UZS","EUR"].map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="declaration_gross_weight" label="申报毛重（KG）" fallbackRequired>
      {(required) => <input name="grossWeightKg" type="number" min="0" step="0.001" defaultValue={declaration?.gross_weight_kg ?? 0} required={required} />}
    </ModuleField>
    {status === "released" && !isDeleted && !lockStatus && <ModuleField fields={fields} fieldKey="customs_release" label="放行日期" fallbackRequired>
      {(required) => <input name="releasedAt" type="datetime-local" defaultValue={toDateTimeInput(declaration?.released_at) || toDateTimeInput(new Date().toISOString())} required={required} />}
    </ModuleField>}
    {workflowFieldPolicy(fields, "declaration_change_flags").visible && <div className="field span-2" data-workflow-field="declaration_change_flags"><span>删单/重报/改单/查验标记</span><div className="check-row"><label><input name="isDeleted" type="checkbox" checked={isDeleted} onChange={(event) => setIsDeleted(event.target.checked)} />删单</label><label><input name="isRedeclared" type="checkbox" defaultChecked={declaration?.is_redeclared === 1} />删单重报</label><label><input name="isAmended" type="checkbox" defaultChecked={declaration?.is_amended === 1} />改单</label><label><input name="isInspected" type="checkbox" defaultChecked={declaration?.is_inspected === 1} />查验</label></div></div>}
    <ModuleField fields={fields} fieldKey="declaration_change_reason" label="申报变更原因" className="field span-2">
      {(required) => <textarea name="changeReason" rows={3} defaultValue={declaration?.change_reason ?? ""} required={required || isDeleted} placeholder={isDeleted ? "删单时必须说明原因；重报后请另建新报关单" : "发生删单、重报、改单或查验时填写"} />}
    </ModuleField>
    <button className="primary span-2" disabled={busy}>{submitLabel || (isDeleted ? "保存删单状态" : status === "released" ? "保存并确认放行" : "保存申报单")}</button>
  </Form>;
}

function customsStageLabel(stage: string) {
  return stage === "origin" ? "起运地报关" : stage === "transit" ? "过境地报关/清关" : "目的地清关";
}

function customsDeclarationStatusLabel(declaration: CustomsDeclaration) {
  if (declaration.is_deleted || declaration.status === "cancelled") return "已删单";
  return declaration.status === "released" ? "已放行" : "已申报";
}

function CustomsQuickAction({
  record,
  manage,
  busy,
  orderNumber,
}: {
  record: CustomsRecord | null;
  manage: boolean;
  busy: boolean;
  orderNumber: string;
}) {
  const released = record?.status === "released";
  const canRelease = Boolean(record?.declaration_number && !released);
  const declared = record && ["declared", "inspecting"].includes(record.status);
  return (
    <section className={`customs-action-panel ${released ? "done" : ""}`}>
      <div className="customs-action-copy">
        <span>当前办理</span>
        <h3>
          {released
            ? "报关已放行"
            : canRelease
              ? "等待海关审核，下一步确认放行"
              : "先录入申报信息，完成申报"}
        </h3>
        <p>
          {released
            ? "起运地报关已经放行，出境门禁可继续校验。"
            : canRelease
              ? "这条起运地报关已有单号，拿到放行信息后在这里填写放行时间并确认。"
              : "填写报关单号、方式、代理和申报时间后提交，系统会自动把模块推进到海关审核。"}
        </p>
      </div>
      {released ? (
        <div className="customs-action-state">
          <strong>{record?.declaration_number || "单号待定"}</strong>
          <span>放行 {formatDateTime(record?.released_at)}</span>
        </div>
      ) : manage ? (
        <CustomsRecordForm
          busy={busy}
          record={record}
          forcedStatus={canRelease || declared ? "released" : "declared"}
          submitLabel={canRelease || declared ? "确认海关放行" : "完成申报"}
        />
      ) : (
        <div className="customs-action-state">
          <strong>当前账号只读</strong>
          <span>需要有订单管理权限才能办理报关节点。</span>
        </div>
      )}
      <Link
        className="secondary"
        to={`/admin/workbenches/customs?q=${encodeURIComponent(orderNumber)}`}
      >
        查看跨订单列表
      </Link>
    </section>
  );
}
function CustomsNextStepStrip({
  record,
  manage,
  busy,
}: {
  record: CustomsRecord | null;
  manage: boolean;
  busy: boolean;
}) {
  if (!record)
    return (
      <div className="customs-next-strip">
        <div>
          <strong>下一步：先完成申报</strong>
          <span>填写报关单号和申报信息后，系统推进到海关审核。</span>
        </div>
      </div>
    );
  if (record.status === "released")
    return (
      <div className="customs-next-strip done">
        <div>
          <strong>已放行，可以继续出境门禁</strong>
          <span>{record.declaration_number || "单号待定"} · 放行 {formatDateTime(record.released_at)}</span>
        </div>
      </div>
    );
  if (!record.declaration_number)
    return (
      <div className="customs-next-strip">
        <div>
          <strong>下一步：完成申报</strong>
          <span>当前起运地报关还没有报关单号，请先补齐申报信息。</span>
        </div>
      </div>
    );
  return (
    <div className="customs-next-strip urgent">
      <div>
        <strong>下一步：确认海关放行</strong>
        <span>已申报。收到海关/代理放行结果后，填写放行时间并确认。</span>
      </div>
      {manage ? (
        <Form method="post" className="customs-release-inline">
          <input type="hidden" name="intent" value="customs_save" />
          <input type="hidden" name="recordId" value={record.id} />
          <input type="hidden" name="clearanceStage" value={record.clearance_stage} />
          <input type="hidden" name="status" value="released" />
          <input type="hidden" name="declarationNumber" value={record.declaration_number || ""} />
          <input type="hidden" name="declarationType" value={record.declaration_type || ""} />
          <input type="hidden" name="declarationMode" value={record.declaration_mode || ""} />
          <input type="hidden" name="documentProvider" value={record.document_provider || ""} />
          <input type="hidden" name="brokerName" value={record.broker_name || ""} />
          <input type="hidden" name="brokerContact" value={record.broker_contact || ""} />
          <input type="hidden" name="cutoffAt" value={record.cutoff_at || ""} />
          <input type="hidden" name="declaredAt" value={record.declared_at || ""} />
          {record.transit_customs === 1 && <input type="hidden" name="transitCustoms" value="on" />}
          {record.inspection_required === 1 && <input type="hidden" name="inspectionRequired" value="on" />}
          {record.quarantine_required === 1 && <input type="hidden" name="quarantineRequired" value="on" />}
          <label className="field">
            <span>放行时间</span>
            <input name="releasedAt" type="datetime-local" defaultValue={toDateTimeInput(new Date().toISOString())} required />
          </label>
          <button className="primary" disabled={busy}>确认海关放行</button>
        </Form>
      ) : (
        <span className="status-pill">只读</span>
      )}
    </div>
  );
}
function CustomsRowAction({
  record,
  manage,
  busy,
}: {
  record: CustomsRecord;
  manage: boolean;
  busy: boolean;
}) {
  if (record.status === "released")
    return <span className="status-pill success">已放行</span>;
  if (!manage) return <span className="status-pill">只读</span>;
  if (!record.declaration_number)
    return <span className="muted">先补报关单号</span>;
  return (
    <Form method="post" className="inline-action-form">
      <input type="hidden" name="intent" value="customs_save" />
      <input type="hidden" name="recordId" value={record.id} />
      <input type="hidden" name="clearanceStage" value={record.clearance_stage} />
      <input type="hidden" name="status" value="released" />
      <input type="hidden" name="declarationNumber" value={record.declaration_number || ""} />
      <input type="hidden" name="declarationType" value={record.declaration_type || ""} />
      <input type="hidden" name="declarationMode" value={record.declaration_mode || ""} />
      <input type="hidden" name="documentProvider" value={record.document_provider || ""} />
      <input type="hidden" name="brokerName" value={record.broker_name || ""} />
      <input type="hidden" name="brokerContact" value={record.broker_contact || ""} />
      <input type="hidden" name="cutoffAt" value={record.cutoff_at || ""} />
      <input type="hidden" name="declaredAt" value={record.declared_at || ""} />
      <input type="hidden" name="releasedAt" value={toDateTimeInput(new Date().toISOString())} />
      {record.transit_customs === 1 && <input type="hidden" name="transitCustoms" value="on" />}
      {record.inspection_required === 1 && <input type="hidden" name="inspectionRequired" value="on" />}
      {record.quarantine_required === 1 && <input type="hidden" name="quarantineRequired" value="on" />}
      <button className="text-button" disabled={busy}>确认放行</button>
    </Form>
  );
}
function CustomsRecordForm({
  busy,
  record,
  forcedStatus,
  submitLabel = "保存报关记录",
}: {
  busy: boolean;
  record?: CustomsRecord | null;
  forcedStatus?: string;
  submitLabel?: string;
}) {
  const status = forcedStatus ?? record?.status ?? "draft";
  return (
    <Form method="post" className="form-grid compact customs-inline-form">
      <input type="hidden" name="intent" value="customs_save" />
      {record?.id && <input type="hidden" name="recordId" value={record.id} />}
      <label className="field">
        <span>作业阶段</span>
        <select name="clearanceStage" defaultValue={record?.clearance_stage ?? "origin"}>
          <option value="origin">起运地报关</option>
          <option value="transit">过境地报关/清关</option>
          <option value="destination">目的地清关</option>
        </select>
      </label>
      <label className="field">
        <span>状态</span>
        {forcedStatus ? (
          <>
            <input type="hidden" name="status" value={forcedStatus} />
            <input value={customsStatusLabel(forcedStatus)} readOnly />
          </>
        ) : (
          <select name="status" defaultValue={status}>
            <option value="draft">草稿</option>
            <option value="documents_pending">资料待齐</option>
            <option value="declared">已申报</option>
            <option value="inspecting">查验中</option>
            <option value="released">已放行</option>
          </select>
        )}
      </label>
      <label className="field">
        <span>报关单号</span>
        <input name="declarationNumber" defaultValue={record?.declaration_number ?? ""} required={["declared", "released"].includes(status)} />
      </label>
      <label className="field">
        <span>报关方式</span>
        <input name="declarationMode" placeholder="一般贸易、转关等" defaultValue={record?.declaration_mode ?? ""} />
      </label>
      <label className="field">
        <span>报关/清关行</span>
        <input name="brokerName" defaultValue={record?.broker_name ?? ""} />
      </label>
      <label className="field">
        <span>联系方式</span>
        <input name="brokerContact" defaultValue={record?.broker_contact ?? ""} />
      </label>
      <label className="field">
        <span>截关日期</span>
        <input name="cutoffAt" type="datetime-local" defaultValue={toDateTimeInput(record?.cutoff_at)} />
      </label>
      <label className="field">
        <span>申报日期</span>
        <input name="declaredAt" type="datetime-local" defaultValue={toDateTimeInput(record?.declared_at)} />
      </label>
      {status === "released" && (
        <label className="field">
          <span>放行日期</span>
          <input name="releasedAt" type="datetime-local" defaultValue={toDateTimeInput(record?.released_at) || toDateTimeInput(new Date().toISOString())} />
        </label>
      )}
      <label className="field">
        <span>报关单类型</span>
        <input name="declarationType" defaultValue={record?.declaration_type ?? ""} />
      </label>
      <label className="field">
        <span>单证提供方</span>
        <input name="documentProvider" defaultValue={record?.document_provider ?? ""} />
      </label>
      <div className="field">
        <span>特殊流程</span>
        <div className="check-row">
          <label>
            <input name="transitCustoms" type="checkbox" defaultChecked={record?.transit_customs === 1} />
            转关
          </label>
          <label>
            <input name="inspectionRequired" type="checkbox" defaultChecked={record?.inspection_required === 1} />
            查验
          </label>
          <label>
            <input name="quarantineRequired" type="checkbox" defaultChecked={record?.quarantine_required === 1} />
            报检
          </label>
        </div>
      </div>
      <label className="field">
        <span>查验说明</span>
        <textarea name="inspectionNotes" rows={3} defaultValue={record?.inspection_notes ?? ""} />
      </label>
      <label className="field">
        <span>报检说明</span>
        <textarea name="quarantineNotes" rows={3} defaultValue={record?.quarantine_notes ?? ""} />
      </label>
      <button className="primary span-2" disabled={busy}>
        {submitLabel}
      </button>
    </Form>
  );
}
function ReviewCargoRow({label,pieces,weight,volume}:{label:string;pieces:number;weight:number;volume:number}) {
  return <tr><td><strong>{label}</strong></td><td>{pieces.toLocaleString()}</td><td>{weight.toFixed(3)}</td><td>{volume.toFixed(4)}</td></tr>;
}
function reviewDate(value:string|null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "待记录";
}
function OrderApprovalReview({
  data,
  manage,
  canApproveConsignment,
  busy,
}: {
  data: Route.ComponentProps["loaderData"];
  manage: boolean;
  canApproveConsignment: boolean;
  busy: boolean;
}) {
  const { order, cargo } = data;
  const cargoTotals = cargo.reduce((total, item) => ({
    pieces: total.pieces + item.package_count * item.pieces_per_package,
    grossWeight: total.grossWeight + item.package_count * item.gross_weight_per_package_kg,
    volume: total.volume + item.package_count * item.volume_per_package_cbm,
  }), { pieces: 0, grossWeight: 0, volume: 0 });
  const pickupAddress = [order.origin_country, order.origin_state, order.origin_city, order.origin_address]
    .filter(Boolean)
    .join(" ");
  return <div className="approval-sheet">
    <section className="approval-section">
      <header><strong>审批资料一览</strong><span>详细委托资料可在右侧“订单关键资料”查看</span></header>
      <div className="approval-facts">
        <Info label="客户" value={order.customer_name} className="span-2" />
        <Info label="关联报价" value={order.quote_number || "历史订单"} />
        <Info label="订单类型" value={`${order.business_type === "ltl" ? "拼车" : "整车"} · 报价锁定`} />
        <Info label="提货地址" value={pickupAddress} className="span-2" />
        <Info label="预约提货" value={order.requested_pickup_date || "—"} />
        <Info label="清关方式" value={order.customs_clearance_mode === "customer" ? "客户自理清关" : "公司代办清关"} />
        <Info label="货物" value={`${cargo.map((item) => item.cargo_name_cn).filter(Boolean).join("、") || "—"} · ${cargoTotals.pieces} 件`} className="span-2" />
        <Info label="预录数据" value={`${cargoTotals.grossWeight.toFixed(3)} KG · ${cargoTotals.volume.toFixed(4)} CBM`} />
        <Info label="境外目的仓" value={order.overseas_warehouse_name || "—"} />
      </div>
    </section>
    <ModuleSourceDocuments
      code="consignment"
      data={data}
      manage={manage}
      canApproveConsignment={canApproveConsignment}
      busy={busy}
    />
    <section className="approval-section approval-decision">
      <header><strong>审批意见</strong><span>审批通过后进入任务分配</span></header>
      <div className="approval-decision-fields">
        <label><span>审批结果 <b>*</b></span><select className="control filled" aria-label="审批结果" defaultValue="approved"><option value="approved">通过</option></select></label>
        <label><span>审批意见</span><input className="control editing" form="consignment-approval-form" name="notes" defaultValue="资料完整，同意进入任务分配" /></label>
      </div>
    </section>
    <Form method="post" id="consignment-approval-form" className="approval-footer">
      <input type="hidden" name="intent" value="workflow_action" />
      <input type="hidden" name="actionCode" value="approve" />
      <div><strong>审批通过并进入任务分配</strong><span>系统校验委托书和订单资料后自动推进，不返回订单列表。</span></div>
      <button className="primary" disabled={busy || !cargo.length || !canApproveConsignment}>审批通过并进入任务分配 →</button>
    </Form>
  </div>;
}
function Info({
  label,
  value,
  className,
  state,
}: {
  label: string;
  value: string;
  className?: string;
  state?: "filled" | "optional-empty" | "required-missing";
}) {
  return (
    <div className={className}>
      <span>{label}</span>
      <strong>{value || "\u00a0"}</strong>
      {state && <em className={`field-state ${state}`}>{state === "filled" ? "已填" : state === "required-missing" ? "必填但未填" : "未填"}</em>}
    </div>
  );
}
function BusinessSubsection({
  title,
  hint,
  tag,
  className,
  children,
}: {
  title: string;
  hint?: string;
  tag?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`module-business-section${className ? ` ${className}` : ""}`}>
      <header>
        <div>
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
        {tag && <span className="module-business-tag">{tag}</span>}
      </header>
      {children}
    </section>
  );
}

function ModuleSummaryTable({
  items,
  className,
}: {
  items: Array<{ label: string; value: ReactNode; detail?: ReactNode }>;
  className?: string;
}) {
  return <div className={["table-wrap", "module-record-table", "module-summary-table", className].filter(Boolean).join(" ")}>
    <table>
      <thead><tr>{items.map((item) => <th key={item.label}>{item.label}</th>)}</tr></thead>
      <tbody><tr>{items.map((item) => <td key={item.label}><strong>{item.value}</strong>{item.detail !== undefined && <small>{item.detail}</small>}</td>)}</tr></tbody>
    </table>
  </div>;
}

function WorkflowInformationGroup({
  title,
  hint,
  items,
  fields,
}: {
  title: string;
  hint?: string;
  items: Array<{ label: string; value: ReactNode; fieldKey: string }>;
  fields: WorkflowFieldState[];
}) {
  const hasVisibleItems = items.some((item) =>
    workflowFieldPolicy(fields, item.fieldKey).visible,
  );
  if (!hasVisibleItems) return null;
  return <section className="consignment-form-group workflow-information-group">
    <h4>{title}</h4>
    {hint && <p>{hint}</p>}
    <InformationTable fields={fields} items={items} />
  </section>;
}

function workflowDisplayValuePresent(value: ReactNode) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function InformationTable({
  items,
  fields,
  className,
}: {
  items: Array<{ label: string; value: ReactNode; fieldKey?: string }>;
  fields?: WorkflowFieldState[];
  className?: string;
}) {
  const visibleItems = items.filter((item) => !item.fieldKey || !fields || workflowFieldPolicy(fields, item.fieldKey).visible);
  if (!visibleItems.length) return null;
  return <div className={["table-wrap", "module-record-table", "information-table", className].filter(Boolean).join(" ")}>
    <table>
      <thead><tr>{visibleItems.map((item) => {
        const policy = item.fieldKey && fields ? workflowFieldPolicy(fields, item.fieldKey) : null;
        return <th key={item.fieldKey || item.label}>{policy?.label || item.label}{policy?.required ? " *" : ""}</th>;
      })}</tr></thead>
      <tbody><tr>{visibleItems.map((item) => {
        const policy = item.fieldKey && fields ? workflowFieldPolicy(fields, item.fieldKey) : null;
        const present = workflowDisplayValuePresent(item.value);
        return <td
          className={policy?.required && !present ? "required-missing" : present ? "filled" : "optional-empty"}
          data-workflow-field={item.fieldKey}
          key={item.fieldKey || item.label}
        >{present ? item.value : "—"}</td>;
      })}</tr></tbody>
    </table>
  </div>;
}

function ExpenseCreateForm({
  fields,
  busy,
  entryContext,
}: {
  fields: WorkflowFieldState[];
  busy: boolean;
  entryContext?: "consignment_costs";
}) {
  const [currency,setCurrency]=useState("CNY");
  const [exchangeRate,setExchangeRate]=useState("1");
  const [quantity,setQuantity]=useState("1");
  const [unitPrice,setUnitPrice]=useState("");
  const [taxRate,setTaxRate]=useState("0");
  const amount=Math.max(0,Number(quantity)||0)*Math.max(0,Number(unitPrice)||0);
  const taxAmount=amount*Math.max(0,Number(taxRate)||0)/100;
  return <Form method="post" className="form-grid compact expense-create-form">
    <input type="hidden" name="intent" value="expense_add" />
    {entryContext&&<input type="hidden" name="expenseEntryContext" value={entryContext}/>}
    {!workflowFieldPolicy(fields,"expense_direction").visible&&<input type="hidden" name="direction" value="receivable"/>}
    {!workflowFieldPolicy(fields,"expense_charge_code").visible&&<input type="hidden" name="chargeCode" value="OTHER"/>}
    {!workflowFieldPolicy(fields,"expense_charge_name").visible&&<input type="hidden" name="chargeName" value="其他费用"/>}
    {!workflowFieldPolicy(fields,"expense_currency").visible&&<input type="hidden" name="currency" value={currency}/>}
    {!workflowFieldPolicy(fields,"expense_exchange_rate").visible&&<input type="hidden" name="exchangeRate" value={exchangeRate}/>}
    {!workflowFieldPolicy(fields,"expense_quantity").visible&&<input type="hidden" name="quantity" value={quantity}/>}
    {!workflowFieldPolicy(fields,"expense_unit_price").visible&&<input type="hidden" name="unitPrice" value={unitPrice||"0"}/>}
    {!workflowFieldPolicy(fields,"expense_tax_rate").visible&&<input type="hidden" name="taxRate" value={taxRate}/>}
    {!workflowFieldPolicy(fields,"expense_is_internal").visible&&<input type="hidden" name="isInternal" value="0"/>}
    <ModuleField fields={fields} fieldKey="expense_direction" label="费用方向" fallbackRequired>
      {(required)=><select name="direction" defaultValue="receivable" required={required}><option value="receivable">应收</option><option value="payable">应付</option></select>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_charge_code" label="费用代码">
      {(required)=><input name="chargeCode" placeholder="例如 OTHER" required={required}/>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_charge_name" label="费用名称" fallbackRequired>
      {(required)=><><input name="chargeName" list="expense-charge-name-options" placeholder="请选择或输入费用名称" autoComplete="off" required={required}/><datalist id="expense-charge-name-options">{transportChargeNameOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</datalist></>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_counterparty" label="往来单位/联系人" fallbackRequired>
      {(required)=><input name="counterpartyName" placeholder="应收客户或应付供应商" required={required}/>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_currency" label="币种" fallbackRequired>
      {(required)=><select name="currency" value={currency} onChange={(event)=>setCurrency(event.target.value)} required={required}><option value="CNY">CNY 人民币</option><option value="USD">USD 美元</option><option value="KZT">KZT 坚戈</option><option value="UZS">UZS 苏姆</option><option value="EUR">EUR 欧元</option><option value="RUB">RUB 卢布</option></select>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_exchange_rate" label="汇率" fallbackRequired>
      {(required)=><input name="exchangeRate" type="number" min="0.000001" step="0.000001" value={exchangeRate} onChange={(event)=>setExchangeRate(event.target.value)} required={required}/>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_quantity" label="数量" fallbackRequired>
      {(required)=><input name="quantity" type="number" min="0.0001" step="0.0001" value={quantity} onChange={(event)=>setQuantity(event.target.value)} required={required}/>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_unit_price" label="单价" fallbackRequired>
      {(required)=><input name="unitPrice" type="number" min="0" step="0.01" value={unitPrice} onChange={(event)=>setUnitPrice(event.target.value)} placeholder="0.00" required={required}/>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_tax_rate" label="税率 %">
      {(required)=><input name="taxRate" type="number" min="0" step="0.01" value={taxRate} onChange={(event)=>setTaxRate(event.target.value)} required={required}/>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_occurred_on" label="发生日期">
      {(required)=><input name="occurredOn" type="date" required={required}/>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_foreign_account_no" label="国外账单号">
      {(required)=><input name="foreignAccountNo" required={required}/>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_is_internal" label="内部费用">
      {(required)=><select name="isInternal" defaultValue="0" required={required}><option value="0">否</option><option value="1">是</option></select>}
    </ModuleField>
    <ModuleField fields={fields} fieldKey="expense_notes" label="费用备注" className="field span-2">
      {(required)=><textarea name="notes" rows={2} placeholder="费用产生原因或计价说明" required={required}/>}
    </ModuleField>
    <div className="expense-create-summary span-2" aria-live="polite">
      <span>金额由数量 × 单价自动计算</span>
      <strong>{currency} {amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>
      {taxAmount>0&&<small>税额 {currency} {taxAmount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</small>}
    </div>
    <button className="primary span-2" disabled={busy}>{busy?"正在保存…":"保存费用"}</button>
  </Form>;
}

function ExpenseEditForm({
  expense,
  fields,
  busy,
}: {
  expense: Expense;
  fields: WorkflowFieldState[];
  busy: boolean;
}) {
  return (
    <Form method="post" className="form-grid compact expense-edit-form">
      <input type="hidden" name="intent" value="expense_update" />
      <input type="hidden" name="expenseId" value={expense.id} />
      <input type="hidden" name="direction" value={expense.direction} />
      {!workflowFieldPolicy(fields, "expense_charge_code").visible && <input type="hidden" name="chargeCode" value={expense.charge_code} />}
      {!workflowFieldPolicy(fields, "expense_charge_name").visible && <input type="hidden" name="chargeName" value={expense.charge_name} />}
      {!workflowFieldPolicy(fields, "expense_counterparty").visible && <input type="hidden" name="counterpartyName" value={expense.counterparty_name || ""} />}
      {!workflowFieldPolicy(fields, "expense_currency").visible && <input type="hidden" name="currency" value={expense.currency} />}
      {!workflowFieldPolicy(fields, "expense_exchange_rate").visible && <input type="hidden" name="exchangeRate" value={expense.exchange_rate} />}
      {!workflowFieldPolicy(fields, "expense_quantity").visible && <input type="hidden" name="quantity" value={expense.quantity} />}
      {!workflowFieldPolicy(fields, "expense_unit_price").visible && <input type="hidden" name="unitPrice" value={expense.unit_price} />}
      {!workflowFieldPolicy(fields, "expense_tax_rate").visible && <input type="hidden" name="taxRate" value={expense.tax_rate} />}
      {!workflowFieldPolicy(fields, "expense_occurred_on").visible && <input type="hidden" name="occurredOn" value={expense.occurred_on || ""} />}
      {!workflowFieldPolicy(fields, "expense_foreign_account_no").visible && <input type="hidden" name="foreignAccountNo" value={expense.foreign_account_no || ""} />}
      {!workflowFieldPolicy(fields, "expense_is_internal").visible && <input type="hidden" name="isInternal" value={expense.is_internal ? "1" : "0"} />}
      {!workflowFieldPolicy(fields, "expense_notes").visible && <input type="hidden" name="notes" value={expense.notes || ""} />}
      <div className="expense-edit-direction span-2">
        <span>费用方向</span>
        <strong>{expense.direction === "receivable" ? "应收" : "应付"}</strong>
      </div>
      <ModuleField fields={fields} fieldKey="expense_charge_code" label="费用代码">
        {(required) => <input name="chargeCode" defaultValue={expense.charge_code} required={required} />}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_charge_name" label="费用名称" fallbackRequired>
        {(required) => <input name="chargeName" defaultValue={expense.charge_name} required={required} />}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_counterparty" label="往来单位/联系人" fallbackRequired>
        {(required) => <input name="counterpartyName" defaultValue={expense.counterparty_name || ""} required={required} />}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_currency" label="币种" fallbackRequired>
        {(required) => <select name="currency" defaultValue={expense.currency} required={required}>
          <option value="CNY">CNY 人民币</option>
          <option value="USD">USD 美元</option>
          <option value="KZT">KZT 坚戈</option>
          <option value="UZS">UZS 苏姆</option>
          <option value="EUR">EUR 欧元</option>
          <option value="RUB">RUB 卢布</option>
        </select>}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_exchange_rate" label="汇率" fallbackRequired>
        {(required) => <input name="exchangeRate" type="number" min="0.000001" step="0.000001" defaultValue={expense.exchange_rate} required={required} />}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_quantity" label="数量" fallbackRequired>
        {(required) => <input name="quantity" type="number" min="0.0001" step="0.0001" defaultValue={expense.quantity} required={required} />}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_unit_price" label="单价" fallbackRequired>
        {(required) => <input name="unitPrice" type="number" min="0" step="0.01" defaultValue={expense.unit_price} required={required} />}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_tax_rate" label="税率 %">
        {(required) => <input name="taxRate" type="number" min="0" step="0.01" defaultValue={expense.tax_rate} required={required} />}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_occurred_on" label="发生日期">
        {(required) => <input name="occurredOn" type="date" defaultValue={expense.occurred_on || ""} required={required} />}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_foreign_account_no" label="国外账单号">
        {(required) => <input name="foreignAccountNo" defaultValue={expense.foreign_account_no || ""} required={required} />}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_is_internal" label="内部费用">
        {(required) => <select name="isInternal" defaultValue={expense.is_internal ? "1" : "0"} required={required}><option value="0">否</option><option value="1">是</option></select>}
      </ModuleField>
      <ModuleField fields={fields} fieldKey="expense_notes" label="费用摘要" className="field span-2">
        {(required) => <textarea name="notes" rows={3} defaultValue={expense.notes || ""} required={required} />}
      </ModuleField>
      <button className="primary span-2" disabled={busy}>保存修改</button>
    </Form>
  );
}

function ExpenseDirectionWorkflow({
  direction,
  control,
  hasExpenses,
  manage,
  busy,
}: {
  direction: "receivable" | "payable";
  control: ExpenseDirectionControl;
  hasExpenses: boolean;
  manage: boolean;
  busy: boolean;
}) {
  const progress = expenseDirectionProgress(control);
  const nextAction = expenseDirectionNextAction(control);
  const action = !control.confirmed
    ? "confirm"
    : !control.business_reviewed
      ? "business_review"
      : !control.finance_reviewed
        ? "finance_review"
        : !control.business_locked
          ? "business_lock"
          : !control.finance_locked
            ? "finance_lock"
            : null;
  const steps = [
    ["费用确认", control.confirmed],
    ["业务审核", control.business_reviewed],
    ["财务审核", control.finance_reviewed],
    ["业务锁定", control.business_locked],
    ["财务锁定", control.finance_locked],
  ] as const;
  return (
    <div className="expense-direction-flow">
      <div className="table-wrap module-record-table expense-direction-table">
        <table>
          <thead><tr><th>完成进度</th>{steps.map(([label]) => <th key={label}>{label}</th>)}<th>下一步</th></tr></thead>
          <tbody><tr><td><strong>{progress}%</strong></td>{steps.map(([label, complete]) => <td className={complete ? "completed-cell" : "pending-cell"} key={label}><span className={`status-pill ${complete ? "success" : "off"}`}>{complete ? "已完成" : "待办理"}</span></td>)}<td>{hasExpenses ? nextAction : "先录入费用"}</td></tr></tbody>
        </table>
      </div>
      {manage && hasExpenses && action && (
        <Form method="post" className="expense-direction-action">
          <input type="hidden" name="intent" value="expense_direction_control" />
          <input type="hidden" name="direction" value={direction} />
          <input type="hidden" name="controlAction" value={action} />
          <input name="notes" placeholder={`${nextAction}说明（可选）`} />
          <button className="secondary" disabled={busy}>{nextAction}</button>
        </Form>
      )}
      {!hasExpenses && <p className="alert warning">尚未预录该方向费用，不能进入确认和审核。</p>}
      {control.finance_locked === 1 && (
        <p className="alert success">该方向已财务锁定；原费用不可直接修改，只能走调整或补充费用。</p>
      )}
    </div>
  );
}
function warehouseAdminReturn(orderId: string, moduleCode = "warehouse") {
  return `/admin/orders/${orderId}/modules/${moduleCode}`;
}
function warehouseTarget(orderId: string, targetPath: string, returnModuleCode = "warehouse") {
  const separator = targetPath.includes("?") ? "&" : "?";
  return `${targetPath}${separator}orderId=${orderId}&returnTo=${encodeURIComponent(warehouseAdminReturn(orderId, returnModuleCode))}`;
}
function WarehouseSiteButton({
  orderId,
  targetPath,
  returnModuleCode = "warehouse",
  className = "secondary",
  children,
}: {
  orderId: string;
  targetPath: string;
  returnModuleCode?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Form method="post" action="/switch-site">
      <input type="hidden" name="target" value="warehouse" />
      <input type="hidden" name="warehouseTo" value={warehouseTarget(orderId, targetPath, returnModuleCode)} />
      <button className={className}>{children}</button>
    </Form>
  );
}
function WarehouseSiteCard({
  orderId,
  targetPath,
  marker,
  title,
  text,
  className,
}: {
  orderId: string;
  targetPath: string;
  marker: string;
  title: string;
  text: string;
  className?: string;
}) {
  return (
    <Form method="post" action="/switch-site" className={`warehouse-module-step-form ${className ?? ""}`}>
      <input type="hidden" name="target" value="warehouse" />
      <input type="hidden" name="warehouseTo" value={warehouseTarget(orderId, targetPath)} />
      <button type="submit" title={`进入${title}`}>
        <b>{marker}</b>
        <strong>{title}</strong>
        <span>{text}</span>
      </button>
    </Form>
  );
}
function Capability({ title, text, href }: { title: string; text: string; href?: string }) {
  const content = (
    <>
      <strong>{title}</strong>
      <p>{text}</p>
      {href && <small>点击进入</small>}
    </>
  );
  if (href?.startsWith("/warehouse"))
    return (
      <Form method="post" action="/switch-site" className="capability-switch-form">
        <input type="hidden" name="target" value="warehouse" />
        <input type="hidden" name="warehouseTo" value={href} />
        <button type="submit">{content}</button>
      </Form>
    );
  return href ? (
    <Link to={href}>{content}</Link>
  ) : (
    <article>{content}</article>
  );
}

function FtlOutboundResourceForm({
  data,
  batch,
  busy,
}: {
  data: Route.ComponentProps["loaderData"];
  batch: Batch;
  busy: boolean;
}) {
  const overseasCarriers = data.carriers.filter((item) => item.carrier_scope === "overseas");
  const initialCarrierId = batch.carrier_id
    || overseasCarriers.find((item) => item.name === batch.overseas_carrier_name)?.id
    || "";
  const [carrierId, setCarrierId] = useState(initialCarrierId);
  const [vehicleId, setVehicleId] = useState(
    data.carrierVehicles.find((item) => item.carrier_id === initialCarrierId && item.plate_number === batch.overseas_vehicle_plate)?.id || "",
  );
  const [driverId, setDriverId] = useState(
    data.carrierDrivers.find((item) => item.carrier_id === initialCarrierId && item.name === batch.overseas_driver_name)?.id || "",
  );
  const vehicles = data.carrierVehicles.filter((item) => item.carrier_id === carrierId);
  const drivers = data.carrierDrivers.filter((item) => item.carrier_id === carrierId);
  const vehicle = vehicles.find((item) => item.id === vehicleId);
  const driver = drivers.find((item) => item.id === driverId);

  return <Form method="post" className="consignment-form-grid compact loading-resource-form">
    <input type="hidden" name="intent" value="outbound_transport_resource_save" />
    <input type="hidden" name="batchId" value={batch.id} />
    <input type="hidden" name="overseasVehicleCount" value="1" />
    <label className="field">
      <span>境外承运商 <b>*</b></span>
      <select name="carrierId" value={carrierId} required onChange={(event) => {
        setCarrierId(event.currentTarget.value);
        setVehicleId("");
        setDriverId("");
      }}>
        <option value="">请选择境外承运商</option>
        {overseasCarriers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <label className="field">
      <span>境外车辆 <b>*</b></span>
      <select name="vehicleMasterId" value={vehicleId} required disabled={!carrierId} onChange={(event) => setVehicleId(event.currentTarget.value)}>
        <option value="">{carrierId ? "请选择车辆" : "请先选择境外承运商"}</option>
        {vehicles.map((item) => <option key={item.id} value={item.id}>{item.plate_number}{item.vehicle_type ? ` · ${item.vehicle_type}` : ""}</option>)}
      </select>
    </label>
    <label className="field">
      <span>境外司机 <b>*</b></span>
      <select name="driverMasterId" value={driverId} required disabled={!carrierId} onChange={(event) => setDriverId(event.currentTarget.value)}>
        <option value="">{carrierId ? "请选择司机" : "请先选择境外承运商"}</option>
        {drivers.map((item) => <option key={item.id} value={item.id}>{item.name}{item.phone ? ` · ${item.phone}` : ""}</option>)}
      </select>
    </label>
    <label className="field"><span>车型</span><input value={vehicle?.vehicle_type || "选择车辆后自动带出"} readOnly /></label>
    <label className="field"><span>车牌号</span><input value={vehicle?.plate_number || "选择车辆后自动带出"} readOnly /></label>
    <label className="field"><span>司机电话</span><input value={driver?.phone || "选择司机后自动带出"} readOnly /></label>
    <button className="primary" disabled={busy || !carrierId || !vehicleId || !driverId}>保存整车运输单</button>
  </Form>;
}

function InlineLoadingWorkbench({
  data,
  busy,
  context = "loading",
}: {
  data: Route.ComponentProps["loaderData"];
  busy: boolean;
  context?: "loading" | "warehouse";
}) {
  const activeBatch = data.batches.find((item) => item.status !== "cancelled");
  const warehouseTo = `/warehouse/consolidation?orderId=${encodeURIComponent(data.order.id)}&returnTo=${encodeURIComponent(`/admin/orders/${data.order.id}/modules/loading`)}`;
  return <section className="inline-loading-workbench">
    <div className="panel-header">
      <div>
        <h3>{activeBatch ? "已生成配载单" : "等待仓库配载"}</h3>
        <p>{activeBatch
          ? "配载关系由仓库端维护；管理后台可打开配载单继续办理报关、车辆和境外运输。"
          : "管理后台不再创建配载单。国内仓验收货齐后，由仓库操作员在“货物配载”中选择同批订单。"}</p>
      </div>
      <span className="status-pill">{context === "warehouse" ? "仓库创建" : "只读监控"}</span>
    </div>
    {activeBatch ? <div className="inline-loading-actions">
      <small><BatchNumberLink id={activeBatch.id} number={activeBatch.batch_number}/> · 已挂载 {activeBatch.order_count} 票订单</small>
      <Link className="primary" to={`/admin/loading/${activeBatch.id}`}>打开配载单</Link>
    </div> : <Form method="post" action="/switch-site" className="inline-loading-actions">
      <input type="hidden" name="target" value="warehouse" />
      <input type="hidden" name="warehouseTo" value={warehouseTo} />
      <small>仓库端会按当前账号绑定仓库显示可配载货物。</small>
      <button className="primary" disabled={busy}>去仓库端货物配载</button>
    </Form>}
  </section>;
}

function LegacyInlineLoadingWorkbench({
  data,
  busy,
  context = "loading",
}: {
  data: Route.ComponentProps["loaderData"];
  busy: boolean;
  context?: "loading" | "warehouse";
}) {
  const fetcher = useFetcher<{
    success?: string;
    formError?: string;
    batchId?: string;
  }>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const currentTotals = useMemo(
    () =>
      data.cargo.reduce(
        (sum, item) => ({
          pieces: sum.pieces + item.package_count * item.pieces_per_package,
          weight:
            sum.weight +
            item.package_count * item.gross_weight_per_package_kg,
          volume:
            sum.volume + item.package_count * item.volume_per_package_cbm,
        }),
        { pieces: 0, weight: 0, volume: 0 },
      ),
    [data.cargo],
  );
  const totals = useMemo(
    () => summarizeLoadingSelection(
      {
        pieces: currentTotals.pieces,
        gross_weight_kg: currentTotals.weight,
        volume_cbm: currentTotals.volume,
      },
      data.loadingCandidates,
      selectedIds,
    ),
    [currentTotals, data.loadingCandidates, selectedIds],
  );
  const toggle = (id: string, checked: boolean) =>
    setSelectedIds((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((item) => item !== id),
    );
  const validationError = !selectedIds.length
    ? "请至少再勾选一票可配载订单"
    : null;
  const actionError = fetcher.data?.formError;
  const submitting = fetcher.state !== "idle";

  return (
    <section className="inline-loading-workbench">
      <div className="panel-header">
        <div>
          <h3>{context === "warehouse" ? "本订单快捷配载" : "可配载订单"}</h3>
          <p>
            {context === "warehouse"
              ? "当前订单固定选中；只列出同装车仓、同口岸、同清关地和同境外目的仓的订单。"
              : "当前订单固定选中；系统已按装车仓、口岸、清关地和境外目的仓精确匹配。"}
          </p>
        </div>
        <span className="status-pill">{data.loadingCandidates.length} 票可选</span>
      </div>
      <fetcher.Form method="post" action="/admin/loading">
        <input type="hidden" name="intent" value="create_batch" />
        <input type="hidden" name="orderIds" value={data.order.id} />
        <div className="loading-batch-fields compact-loading-fields">
          <label className="field">
            <span>批次名称（可选）</span>
            <input name="batchName" placeholder="默认使用当前线路" />
          </label>
          <label className="field span-2">
            <span>组批说明</span>
            <input name="notes" placeholder="先确定共同运输的订单，组批后再安排承运商和车辆" />
          </label>
        </div>
        <div className="loading-selection-summary inline-loading-summary" aria-live="polite">
          <span>已选 <strong>{totals.orderCount}</strong> 票（含当前订单）</span>
          <span>{totals.pieces} 件</span>
          <span>{totals.weight.toFixed(2)} KG</span>
          <span>{totals.volume.toFixed(3)} CBM</span>
        </div>
        <div className="table-wrap module-record-table inline-loading-table">
          <table>
            <thead>
              <tr>
                <th>选择</th><th>订单</th><th>客户</th><th>接单日期</th><th>配载条件</th><th>货物汇总</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr className="selected-row">
                <td><span className="status-pill">当前</span></td>
                <td><strong><OrderNumberLink id={data.order.id} number={data.order.order_number}/></strong></td>
                <td>{data.order.customer_name}</td>
                <td>—</td>
                <td><strong>{data.order.route_notes}</strong><small>{data.order.exit_port} · {data.order.customs_location} · {data.order.overseas_warehouse_name}</small></td>
                <td>
                  {currentTotals.pieces} 件
                  <small>{currentTotals.weight.toFixed(2)} KG · {currentTotals.volume.toFixed(3)} CBM</small>
                </td>
                <td>固定选中</td>
              </tr>
              {data.loadingCandidates.map((item) => (
                <tr key={item.id} className={selectedIds.includes(item.id) ? "selected-row" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      name="orderIds"
                      value={item.id}
                      checked={selectedIds.includes(item.id)}
                      onChange={(event) => toggle(item.id, event.target.checked)}
                    />
                  </td>
                  <td><OrderNumberLink id={item.id} number={item.order_number}/></td>
                  <td>{item.customer_name}</td>
                  <td>{item.order_date || "—"}</td>
                  <td><strong>{item.route_code}</strong><small>{item.exit_port} · {item.customs_location}</small><small>{item.domestic_warehouse_name} → {item.overseas_warehouse_name}</small></td>
                  <td>
                    {item.pieces} 件
                    <small>{item.gross_weight_kg.toFixed(2)} KG · {item.volume_cbm.toFixed(3)} CBM</small>
                  </td>
                  <td>{item.status === "confirmed" ? "待派单" : "执行中"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.loadingCandidates.length && (
          <p className="empty-state">当前没有满足装车条件且未进入其他有效批次的订单。</p>
        )}
        {(actionError || validationError) && (
          <div className="inline-validation-result error" role="alert">
            <strong>无法生成配载批次</strong>
            <span>{actionError || validationError}</span>
          </div>
        )}
        {fetcher.data?.success && (
          <div className="inline-validation-result success" role="status">
            <strong>配载成功</strong>
            <span>{fetcher.data.success}</span>
          </div>
        )}
        <div className="inline-loading-actions">
          <small>提交时会再次逐票校验；成功后生成配载批次并回写当前订单，不需要跳出本页重新筛选。</small>
          <button className="primary" disabled={busy || submitting || Boolean(validationError)}>
            {submitting ? "正在校验并配载…" : "一键生成配载批次"}
          </button>
        </div>
      </fetcher.Form>
    </section>
  );
}
const trackingManualMilestoneOptions: [string, string][] = [
  ["border_arrived", "到达出境口岸"],
  ["exported", "出境"],
  ["transloaded", "换装"],
  ["transit_customs", "转关"],
  ["foreign_entered", "国外入境"],
  ["customs_cleared", "目的地清关完成"],
  ["station_arrived", "到达境外目的仓"],
];
const trackingOptionalMilestones = new Set(["transloaded", "transit_customs"]);
function formatDateTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}
function transportAssignmentStatusLabel(status: string) {
  return ({
    planned: "已计划",
    dispatched: "已派车",
    in_transit: "运输中",
    arrived: "已到仓",
    completed: "已完成",
    cancelled: "已取消",
  } as Record<string, string>)[status] ?? status;
}
function toDateTimeInput(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function currentOriginCustomsRecord(records: CustomsRecord[]) {
  const originRecords = records.filter((record) => record.clearance_stage === "origin");
  if (originRecords.length) return prioritizedCustomsRecord(originRecords);
  return prioritizedCustomsRecord(records);
}
function prioritizedCustomsRecord(records: CustomsRecord[]) {
  return (
    [...records].sort(
      (a, b) =>
        customsStatusRank(b.status) - customsStatusRank(a.status) ||
        new Date(b.updated_at || b.created_at).getTime() -
          new Date(a.updated_at || a.created_at).getTime(),
    )[0] ?? null
  );
}
function customsStatusRank(status: string) {
  return (
    { released: 5, inspecting: 4, declared: 3, documents_pending: 2, draft: 1 }[
      status
    ] ?? 0
  );
}
function legTypeLabel(value: string) {
  return value === "first_mile"
    ? "国内运输"
    : "出境 / 境外";
}
function customsStatusLabel(value: string) {
  return (
    (
      {
        draft: "草稿",
        documents_pending: "资料待齐",
        declared: "已申报",
        inspecting: "查验中",
        released: "已放行",
        cancelled: "已取消",
      } as Record<string, string>
    )[value] ?? value
  );
}
function documentCategoryLabel(value: string | null) {
  return orderDocumentTypeLabel(value);
}
function documentReviewLabel(value: string | null) {
  return (
    (
      {
        pending: "待审核",
        approved: "已通过",
        rejected: "已退回",
        archived: "已归档",
      } as Record<string, string>
    )[value || "pending"] ?? "待审核"
  );
}
function moneyTotal(expenses: Expense[], direction: string) {
  return expenses
    .filter(
      (item) => item.direction === direction && item.stage !== "cancelled",
    )
    .reduce((sum, item) => sum + item.amount * item.exchange_rate, 0);
}
function expenseStageLabel(value: string) {
  return (
    {
      estimated: "预估",
      confirmed: "已确认",
      reconciled: "已对账",
      invoiced: "已开票/收票",
      settled: "已结算",
      cancelled: "已取消",
    }[value] || value
  );
}
async function toDataUrl(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return `data:${file.type};base64,${btoa(binary)}`;
}
export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: `${loaderData?.definition.name ?? "订单模块"} | International TMS`,
    },
  ];
}
