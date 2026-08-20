import { useMemo, useState, type ReactNode } from "react";
import { Form, Link, useFetcher, useNavigation, redirect } from "react-router";
import { env } from "cloudflare:workers";
import type { Route } from "./+types/admin.order-module";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import {
  advanceOrderModule,
  assignOrderModule,
  ensureOrderModules,
  listOrderModules,
  syncCostsModuleStatus,
  syncOrderWorkflowSnapshot,
} from "../lib/order-modules.server";
import { runOrderWorkflowAction } from "../lib/order-workflow-action.server";
import {
  composeOrderWorkflow,
  moduleStatusLabels,
  orderModuleDefinition,
  type OrderModuleCode,
} from "../lib/order-modules";
import {
  orderModuleAccess,
  orderModuleWorkflowStageAccess,
  type WorkflowStepPosition,
} from "../lib/order-stage-flow";
import { canManageOrderModule } from "../lib/position-portal";
import { ensureFtlVehicleAndLoads } from "../lib/ftl-vehicle-loads.server";
import { summarizeLoadingSelection } from "../lib/loading-workbench";
import {
  maxInlineOrderDocumentBytes,
  orderDocumentCanBeHandledInModule,
  orderDocumentPlacement,
  orderDocumentPlacements,
  orderDocumentStages,
  orderDocumentsForModule,
  orderDocumentTypeCodes,
  orderDocumentTypeLabel,
} from "../lib/order-documents";
import { checkOrderDeparture, checkOrderLoadPlan, checkOrderPreDepartureDocuments } from "../lib/order-readiness.server";
import { roadStatusLabels } from "../lib/warehouse-actual";
import { syncBatchRoadStatusFromTracking } from "../lib/batch-tracking.server";
import {
  nextOverseasAction,
  overseasOperationProgress,
  overseasOperationStatusLabels,
} from "../lib/overseas-warehouse";
import {
  advanceOverseasOrder,
} from "../lib/overseas-warehouse.server";
import {
  emptyExpenseDirectionControl,
  expenseDirectionNextAction,
  expenseDirectionProgress,
  type ExpenseDirectionControl,
} from "../lib/expense-control";
import {
  generateOrderReview,
  loadOrderReview,
} from "../lib/order-review.server";
import { customsDeclarationGate } from "../lib/customs-declarations";
import { syncCustomsModuleFromRecords } from "../lib/customs-status.server";
import { Modal } from "../components/Modal";
import {
  loadOrderModuleWorkflowFields,
  saveOrderCustomWorkflowFieldValue,
  type WorkflowFieldState,
} from "../lib/workflow-fields.server";

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
  customer_id: string;
  customer_name: string;
  customer_reference: string | null;
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
type OrderService = {
  service_code: string;
  service_name: string;
  status: string;
};
type Member = {
  id: string;
  display_name: string;
  department_name: string | null;
};
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
  image_count: number;
};
type Attachment = {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  data_url: string;
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
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
};
type Warehouse = {
  id: string;
  name: string;
  warehouse_role: string | null;
};
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
  const positions: WorkflowStepPosition[] = steps.results.map((step) => ({
    stepKey: step.step_key,
    stepName: step.step_name,
    sortOrder: step.sort_order,
  }));
  return orderModuleWorkflowStageAccess(
    moduleCode,
    state.current_step_key,
    positions,
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
  const definition = orderModuleDefinition(moduleCode);
  if (!definition) throw new Response("订单模块不存在", { status: 404 });
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.order_date,o.quotation_id,q.quote_number,q.currency quotation_currency,q.subtotal quotation_subtotal,q.tax_amount quotation_tax_amount,q.total_amount quotation_total_amount,q.status quotation_status,o.customer_id,c.name customer_name,o.customer_reference,o.shipper_name,o.shipper_contact,o.shipper_phone,o.origin_country,o.origin_state,o.origin_city,o.origin_address,o.consignee_name,o.consignee_contact,o.consignee_phone,o.destination_country,o.destination_state,o.destination_city,o.destination_address,o.business_nature,o.business_type,o.transport_mode,o.transport_terms,o.trade_terms,o.exit_port,o.overseas_warehouse_id,ow.name overseas_warehouse_name,ow.code overseas_warehouse_code,ow.address overseas_warehouse_address,o.overseas_warehouse_address_note,o.transit_locations,o.customs_location,o.route_notes,o.requested_pickup_date,o.requested_delivery_date,o.cargo_ready_at,o.ro_agent,o.special_instructions,o.requires_transloading,o.requires_transit_customs,o.current_assignee_user_id,o.status FROM transport_orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id WHERE o.id=? AND o.organization_id=?`,
  )
    .bind(orderId, current.organizationId)
    .first<OrderSummary>();
  if (!order) throw new Response("订单不存在", { status: 404 });
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
  }
  const modules = await listOrderModules(current.organizationId, orderId);
  const module = modules.find((item) => item.module_code === moduleCode);
  if (!module) throw new Response("订单模块不存在", { status: 404 });
  const taskFilter = moduleCode === "assignment" ? "" : "AND t.module_code=?";
  const taskBindings =
    moduleCode === "assignment"
      ? [orderId, current.organizationId]
      : [orderId, current.organizationId, moduleCode];
  const [
    members,
    tasks,
    history,
    cargo,
    attachments,
    bookings,
    batches,
    shipments,
    expenses,
    quotationCharges,
    services,
    carriers,
    warehouses,
    loadingCandidates,
    customsRecords,
    customsDeclarations,
    transportAssignments,
    waybills,
    trackingMilestones,
    expenseControl,
    overseasOperation,
    expenseDirectionControls,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id,u.display_name,d.name department_name FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN departments d ON d.id=m.department_id WHERE m.organization_id=? AND m.status='active' AND u.status='active' ORDER BY d.sort_order,u.display_name`,
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
      `SELECT i.id,i.cargo_name_cn,i.cargo_name_en,i.hs_code,i.overseas_hs_code,i.package_type,i.package_count,i.pieces_per_package,i.gross_weight_per_package_kg,i.net_weight_per_package_kg,i.length_cm,i.width_cm,i.height_cm,i.volume_per_package_cbm,i.declared_value,i.currency,i.origin_country,i.brand_model,i.marks,i.special_attributes,(SELECT COUNT(*) FROM order_cargo_images img WHERE img.cargo_item_id=i.id) image_count FROM order_cargo_items i WHERE i.order_id=? AND i.organization_id=? ORDER BY i.line_no`,
    )
      .bind(orderId, current.organizationId)
      .all<Cargo>(),
    env.DB.prepare(
      `SELECT a.id,a.file_name,a.content_type,a.size_bytes,a.data_url,a.created_at,m.document_category,m.description,m.public_to_customer,m.review_status FROM order_attachments a LEFT JOIN order_document_metadata m ON m.attachment_id=a.id WHERE a.order_id=? AND a.organization_id=? ORDER BY a.created_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<Attachment>(),
    env.DB.prepare(
      `SELECT b.id,b.booking_number,b.booking_type,c.name carrier_name,b.planned_departure_at,b.status FROM booking_records b LEFT JOIN carriers c ON c.id=b.carrier_id WHERE b.order_id=? AND b.organization_id=? ORDER BY b.created_at DESC`,
    )
      .bind(orderId, current.organizationId)
      .all<Booking>(),
    env.DB.prepare(
      `SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.planned_departure_at,b.planned_arrival_at,b.border_port,b.transit_location,b.route_notes,b.status,b.road_status,c.name carrier_name,w.name warehouse_name,
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
      `SELECT id,name,contact_name,contact_phone,contact_email FROM carriers WHERE organization_id=? AND status='active' ORDER BY name`,
    )
      .bind(current.organizationId)
      .all<Carrier>(),
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
    ? await Promise.all([
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
        checkOrderLoadPlan(current.organizationId, orderId),
      ]).then(([operation, inboundTimes, packageStatuses, loadPlan]) => ({
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
      }))
    : null;
  const warehouseActuals = moduleCode === "loading"
    ? await env.DB.prepare(
        `SELECT COUNT(DISTINCT r.id) receipt_count,
                COALESCE(SUM(r.total_packages),0) actual_packages,
                COALESCE(SUM(r.total_pieces),0) actual_pieces,
                COALESCE(SUM(r.total_weight_kg),0) actual_weight_kg,
                COALESCE(SUM(r.total_volume_cbm),0) actual_volume_cbm,
                EXISTS(
                  SELECT 1 FROM warehouse_receipts rx
                  JOIN shipments sx ON sx.id=rx.shipment_id
                  WHERE sx.order_id=? AND rx.organization_id=?
                    AND rx.status='completed' AND rx.cargo_complete=1
                ) counting_completed
         FROM warehouse_receipts r
         JOIN shipments s ON s.id=r.shipment_id
         WHERE r.organization_id=? AND s.order_id=? AND r.status='completed'`,
      )
        .bind(orderId, current.organizationId, current.organizationId, orderId)
        .first<{
          receipt_count: number;
          actual_packages: number;
          actual_pieces: number;
          actual_weight_kg: number;
          actual_volume_cbm: number;
          counting_completed: number;
        }>()
    : null;
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
  const workflowStageAccess = await loadModuleWorkflowStageAccess(
    current.organizationId,
    orderId,
    definition.code,
  );
  const baseAccess = orderModuleAccess(order.status, moduleCode);
  return {
    current,
    order,
    access: {
      ...baseAccess,
      canEdit: baseAccess.canEdit && workflowStageAccess.available,
      reason: baseAccess.reason || workflowStageAccess.reason,
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
    loadingReferences,
    orderReview,
    trackingDepartureGate,
    workflowFields,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "order.view"),
    orderId = params.orderId,
    moduleCode = params.moduleCode,
    form = await request.formData(),
    intent = valueOf(form, "intent");
  if (!orderModuleDefinition(moduleCode)) return { formError: "模块不存在" };
  const isConsignmentApprovalAction =
    moduleCode === "consignment" &&
    intent === "workflow_action" &&
    valueOf(form, "actionCode") === "approve";
  const isConsignmentFileAction =
    moduleCode === "consignment" &&
    ["document_review", "document_metadata_update", "document_upload"].includes(
      intent,
    );
  const canApproveConsignment =
    (isConsignmentApprovalAction || isConsignmentFileAction) &&
    canManageOrderModule(current, "assignment");
  if (!canManageOrderModule(current, moduleCode) && !canApproveConsignment) {
    return { formError: "当前岗位可以查看本模块，但没有提交业务操作的权限" };
  }
  const order = await env.DB.prepare(
    `SELECT status,business_type,shipper_name,origin_country,origin_state,origin_city,origin_address,
            consignee_name,destination_country,destination_state,destination_city,destination_address,
            exit_port,transit_locations,customs_location,route_notes,overseas_warehouse_id,
            requires_transloading,requires_transit_customs
     FROM transport_orders WHERE id=? AND organization_id=?`,
  )
    .bind(orderId, current.organizationId)
    .first<{
      status:string;business_type:string;shipper_name:string;origin_country:string;origin_state:string|null;origin_city:string;origin_address:string;
      consignee_name:string;destination_country:string;destination_state:string|null;destination_city:string;destination_address:string;
      exit_port:string|null;transit_locations:string|null;customs_location:string|null;route_notes:string|null;overseas_warehouse_id:string|null;
      requires_transloading:number;requires_transit_customs:number;
    }>();
  if (!order) return { formError: "订单不存在" };
  const moduleWorkflowFields = await loadOrderModuleWorkflowFields(
    current.organizationId,
    orderId,
    moduleCode as Parameters<typeof loadOrderModuleWorkflowFields>[2],
  );
  const fieldPolicy = (fieldKey: string, fallbackRequired = false) =>
    workflowFieldPolicy(moduleWorkflowFields, fieldKey, fallbackRequired);
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
  const isSubmittedConsignmentApproval =
    canApproveConsignment && order.status === "submitted";
  if (!stageAccess.available && !isSubmittedConsignmentApproval)
    return { formError: stageAccess.reason || "当前业务阶段尚未开放本模块" };
  if (
    !access.canEdit &&
    !isSubmittedConsignmentApproval &&
    !(moduleCode === "review" && intent === "generate_order_review")
  )
    return { formError: access.reason || "当前订单状态不允许办理该模块" };
  if (intent === "workflow_action") {
    const actionCode = valueOf(form, "actionCode");
    const result = await runOrderWorkflowAction({
      request,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      orderId,
      actionCode,
      assigneeUserId: valueOf(form, "assigneeUserId") || null,
      notes: valueOf(form, "notes"),
    });
    if (
      !("formError" in result) &&
      moduleCode === "consignment" &&
      actionCode === "approve"
    ) {
      return redirect(
        `/admin/orders/${orderId}/modules/assignment#module-business-data`,
      );
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
      const overseasCarrierName = valueOf(form, "overseasCarrierName");
      const overseasVehicleType = valueOf(form, "overseasVehicleType");
      const overseasVehicleCount = Math.max(1, Number(valueOf(form, "overseasVehicleCount") || 1));
      const overseasVehiclePlate = valueOf(form, "overseasVehiclePlate").toUpperCase();
      const overseasDriverName = valueOf(form, "overseasDriverName");
      const overseasDriverPhone = valueOf(form, "overseasDriverPhone");
      if (!batchId || !overseasCarrierName || !overseasVehicleType || !overseasVehiclePlate || !overseasDriverName || !overseasDriverPhone)
        return { formError: "请完整填写境外承运方、车型、车辆数、车牌号、司机姓名和电话" };
      const linked = await env.DB.prepare(
        `SELECT 1 FROM transport_batch_orders
         WHERE organization_id=? AND batch_id=? AND order_id=? AND status!='removed'`,
      ).bind(current.organizationId, batchId, orderId).first();
      if (!linked) return { formError: "当前装车单与订单不匹配，请刷新页面后重试" };
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE transport_batches
         SET overseas_carrier_name=?,overseas_vehicle_type=?,overseas_vehicle_count=?,
             overseas_vehicle_plate=?,overseas_driver_name=?,overseas_driver_phone=?,updated_at=?
         WHERE id=? AND organization_id=?`,
      ).bind(
        overseasCarrierName, overseasVehicleType, overseasVehicleCount,
        overseasVehiclePlate, overseasDriverName, overseasDriverPhone,
        now, batchId, current.organizationId,
      ).run();
      if (order.business_type === "ftl") {
        await ensureFtlVehicleAndLoads({
          organizationId: current.organizationId,
          orderId,
          batchId,
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
      await Promise.all(linkedOrders.map((linkedOrderId) => syncOrderWorkflowSnapshot(current.organizationId, linkedOrderId)));
      return { success: "境外承运方和车辆信息已保存，并同步到当前装车单的全部订单" };
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
      const assigneeUserId = valueOf(form, "assigneeUserId") || current.userId;
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
      const assigneeUserId = valueOf(form, "assigneeUserId") || current.userId;
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
      const isMember = await env.DB.prepare(
        "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND u.status='active'",
      )
        .bind(current.organizationId, assigneeUserId)
        .first();
      if (!isMember) return { formError: "请选择有效的岗位人员" };
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
    if (intent === "overseas_advance" && moduleCode === "overseas_warehouse") {
      const operationAction = valueOf(form, "operationAction") as
        | "notify"
        | "appointment"
        | "pickup";
      if (!["notify", "appointment", "pickup"].includes(operationAction))
        return { formError: "境外仓操作无效" };
      if (operationAction === "pickup") {
        const missingDocuments = await missingRequiredDocumentUploads(
          "overseas_warehouse",
        );
        if (missingDocuments.length)
          return {
            formError: `确认提货完成前请先上传：${missingDocuments.join("、")}`,
          };
      }
      const occurredAt = valueOf(form, "occurredAt") || new Date().toISOString();
      const operationValues = operationAction === "notify"
        ? [
            ["customer_notified_at", valueOf(form, "occurredAt")],
            ["customer_notification_notes", valueOf(form, "notes")],
          ]
        : operationAction === "appointment"
          ? [
              ["pickup_appointment_at", valueOf(form, "occurredAt")],
              ["pickup_appointment_notes", valueOf(form, "notes")],
            ]
          : [
              ["pickup_completed_at", valueOf(form, "occurredAt")],
              ["overseas_pickup_contact", valueOf(form, "pickupContact")],
              ["pickup_proof", valueOf(form, "pickupProofReference")],
              ["pickup_completion_notes", valueOf(form, "notes")],
            ];
      const missingOperationFields = operationValues
        .filter(([fieldKey, value]) => requiredFieldMissing(fieldKey, value))
        .map(([fieldKey]) => fieldPolicy(fieldKey).label || fieldKey);
      if (missingOperationFields.length)
        return { formError: `请填写当前模板要求的字段：${missingOperationFields.join("、")}` };
      const result = await advanceOverseasOrder({
        organizationId: current.organizationId,
        orderId,
        actorUserId: current.userId,
        action: operationAction,
        occurredAt,
        pickupContact: valueOf(form, "pickupContact"),
        pickupProofReference: valueOf(form, "pickupProofReference"),
        notes: valueOf(form, "notes"),
      });
      await writeAudit({
        request,
        action: `overseas.order.${operationAction}`,
        resourceType: "transport_order",
        resourceId: orderId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: { occurredAt, nextStatus: result.nextStatus },
      });
      return { success: `${result.stepName}已登记` };
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
      return { success: isDeleted ? "申报单已标记删单，门禁已重新计算" : "申报单已保存，门禁已重新计算" };
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
      const plateNumber = valueOf(form, "plateNumber").trim().toUpperCase();
      const driverName = valueOf(form, "driverName").trim();
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
      if (carrierId) {
        const carrier = await env.DB.prepare(
          "SELECT name FROM carriers WHERE id=? AND organization_id=? AND status='active'",
        ).bind(carrierId, current.organizationId).first<{ name: string }>();
        if (!carrier) return { formError: "请选择有效的启用承运商" };
        carrierName = carrierName || carrier.name;
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
        ["domestic_vehicle_type", valueOf(form, "vehicleType"), false],
        ["domestic_vehicle_count", valueOf(form, "vehicleCount"), false],
        ["domestic_loading_mode", order.business_type, false],
        ["domestic_plate_number", plateNumber, true],
        ["domestic_driver_name", driverName, true],
        ["domestic_driver_phone", valueOf(form, "driverPhone"), false],
        ["domestic_driver_id_number", valueOf(form, "driverIdNumber"), false],
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
            carrierId, carrierName || null, valueOf(form, "vehicleType") || null, vehicleCount,
            order.business_type, plateNumber, driverName, valueOf(form, "driverPhone") || null,
            valueOf(form, "driverIdNumber") || null, freightAmount, freightCurrency,
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
            valueOf(form, "vehicleType") || null, vehicleCount, order.business_type,
            plateNumber, driverName, valueOf(form, "driverPhone") || null,
            valueOf(form, "driverIdNumber") || null, freightAmount, freightCurrency,
            originLocation, destinationLocation, destinationWarehouseId || null,
            order.exit_port || null, order.transit_locations || null,
            `${order.origin_country} → ${order.destination_country}`, plannedDepartureAt,
            plannedArrivalAt, valueOf(form, "loadingRequirements") || null,
            valueOf(form, "notes") || null, "planned", current.userId, now, now,
          )];
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
            (vehicleTotal?.total ?? 0) + offset + 1, valueOf(form, "vehicleType") || null,
            plateNumber, driverName, valueOf(form, "driverPhone") || null,
            valueOf(form, "driverIdNumber") || null, plannedDepartureAt,
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
      return { success: existingDomesticAssignment
        ? "国内运输安排已更新，并已追加提货车辆"
        : "国内运输安排已保存；等待国内提货和仓库累计收货" };
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
      if (moduleCode !== "costs") return { formError: "只能在费用模块录入" };
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
      const quantity = Math.max(0.0001, Number(valueOf(form, "quantity") || 1));
      const unitPrice = Math.max(0, Number(valueOf(form, "unitPrice") || 0));
      const amount = quantity * unitPrice;
      const exchangeRate = Math.max(
        0.000001,
        Number(valueOf(form, "exchangeRate") || 1),
      );
      const taxRate = Math.max(0, Number(valueOf(form, "taxRate") || 0));
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
            values.foreignAccountNo, existingExpense.id, current.organizationId, orderId,
          )
          .run();
      } else {
        await env.DB.prepare(
          `INSERT INTO business_expenses(id,organization_id,order_id,direction,stage,charge_code,charge_name,counterparty_name,currency,quantity,unit_price,amount,exchange_rate,base_amount,notes,created_by_user_id,created_at,updated_at,tax_rate,tax_amount,occurred_on,is_internal,foreign_account_no)
           VALUES(?,?,?,?,'estimated',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
          .bind(
            crypto.randomUUID(), current.organizationId, orderId, direction,
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
      return { success: existingExpense ? "费用已更新" : "应收/应付费用已录入" };
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
        await syncDocumentsModuleStatus(
          current.organizationId,
          orderId,
          current.userId,
          now,
        );
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
      await syncDocumentsModuleStatus(
        current.organizationId,
        orderId,
        current.userId,
        now,
      );
      return { success: `${orderDocumentTypeLabel(documentCategory)}已上传并进入审核` };
    }
    if (intent === "document_review") {
      const attachmentId = valueOf(form, "attachmentId");
      const target = await env.DB.prepare(
        "SELECT document_category FROM order_document_metadata WHERE attachment_id=? AND order_id=? AND organization_id=?",
      ).bind(attachmentId, orderId, current.organizationId).first<{ document_category: string }>();
      if (!target) return { formError: "要审核的文件不存在" };
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
      await syncDocumentsModuleStatus(
        current.organizationId,
        orderId,
        current.userId,
        now,
      );
      return {
        success: "文件审核状态已更新",
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
      await syncDocumentsModuleStatus(current.organizationId, orderId, current.userId, now);
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

async function syncDocumentsModuleStatus(
  organizationId: string,
  orderId: string,
  actorUserId: string,
  now: string,
) {
  const module = await env.DB.prepare(
    "SELECT id,status,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='documents' AND enabled=1",
  )
    .bind(organizationId, orderId)
    .first<{ id: string; status: string; current_step_code: string | null }>();
  if (!module) return;
  const documentReadiness = await env.DB.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN COALESCE(review_status,'pending') NOT IN ('approved','archived') THEN 1 ELSE 0 END) pending
     FROM order_document_metadata
     WHERE organization_id=? AND order_id=?`,
  )
    .bind(organizationId, orderId)
    .first<{ total: number; pending: number | null }>();
  const preDepartureDocuments = await checkOrderPreDepartureDocuments(organizationId, orderId);
  const completed = preDepartureDocuments.ready &&
    (documentReadiness?.total ?? 0) > 0 &&
    (documentReadiness?.pending ?? 0) === 0;
  const nextStepCode = completed ? "archived" : "checking";
  const nextStepName = completed ? "文件归档" : "资料检查";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status=?,current_step_code=?,current_step_name=?,
         progress_percent=CASE WHEN ?='completed' THEN 100 ELSE MAX(progress_percent,25) END,
         blocking_reason=NULL,started_at=COALESCE(started_at,?),
         completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,
         updated_at=?
       WHERE id=?`,
    ).bind(
      completed ? "completed" : "in_progress",
      nextStepCode,
      nextStepName,
      completed ? "completed" : "in_progress",
      now,
      completed ? "completed" : "in_progress",
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
      completed ? "documents_approved" : "document_uploaded",
      completed ? "文件审核完成后自动归档" : "上传文件后自动进入资料检查",
      module.current_step_code,
      nextStepCode,
      nextStepName,
      actorUserId,
      completed
        ? "全部文件已审核通过或归档，文件中心自动完成"
        : "文件已上传，系统自动推进到资料检查；审核通过后再完成文件中心",
      now,
    ),
  ]);
  await syncOrderWorkflowSnapshot(organizationId, orderId);
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
  const linkedOrderIds = await linkedBatchOrderIds(organizationId, orderId);
  if (linkedOrderIds.length <= 1) return;
  const placeholders = linkedOrderIds.map(() => "?").join(",");
  const milestones = await env.DB.prepare(
    `SELECT milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer,created_at
     FROM order_tracking_milestones
     WHERE organization_id=? AND order_id IN (${placeholders})
     ORDER BY event_at,created_at`,
  )
    .bind(organizationId, ...linkedOrderIds)
    .all<{
      milestone_code: string;
      milestone_name: string;
      event_at: string;
      location: string | null;
      vehicle_reference: string | null;
      notes: string | null;
      visible_to_customer: number;
      created_at: string;
    }>();
  const shared = milestones.results.filter((item) =>
    batchSynchronizedTrackingMilestones.has(item.milestone_code),
  );
  if (!shared.length) return;
  const now = new Date().toISOString();
  const statements = linkedOrderIds.flatMap((targetOrderId) =>
    shared.map((milestone) =>
      env.DB.prepare(
        `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer,created_by_user_id,created_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?
         WHERE NOT EXISTS(
           SELECT 1 FROM order_tracking_milestones
           WHERE organization_id=? AND order_id=? AND milestone_code=? AND event_at=?
         )`,
      ).bind(
        crypto.randomUUID(),
        organizationId,
        targetOrderId,
        milestone.milestone_code,
        milestone.milestone_name,
        milestone.event_at,
        milestone.location,
        milestone.vehicle_reference,
        milestone.notes,
        milestone.visible_to_customer,
        actorUserId,
        milestone.created_at || now,
        organizationId,
        targetOrderId,
        milestone.milestone_code,
        milestone.event_at,
      ),
    ),
  );
  await env.DB.batch(statements);
  const latestByCode = new Map<string, Omit<TrackingMilestone, "id">>();
  for (const milestone of shared) latestByCode.set(milestone.milestone_code, milestone);
  for (const targetOrderId of linkedOrderIds) {
    for (const milestone of latestByCode.values()) {
      await syncTrackingModuleStatus(
        organizationId,
        targetOrderId,
        actorUserId,
        milestone.milestone_code,
        now,
      );
    }
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
             current_step_code='notified',
             current_step_name='客户已通知',
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
      canManageOrderModule(loaderData.current, definition.code) &&
      loaderData.access.canEdit,
    canApproveConsignment =
      definition.code === "consignment" &&
      order.status === "submitted" &&
      canManageOrderModule(loaderData.current, "assignment");
  const actionMessage =
    actionData && "formError" in actionData
      ? actionData.formError
      : actionData && "success" in actionData
        ? actionData.success
        : null;
  const actionFailed = Boolean(actionData && "formError" in actionData);
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
            className={`status-pill ${["blocked", "exception", "not_applicable"].includes(module.status) ? "off" : ""}`}
          >
            {moduleStatusLabels[module.status] ?? module.status}
          </span>
          {definition.code === "warehouse" && (
            <Form method="post" action="/switch-site" className="module-header-warehouse-form">
              <input type="hidden" name="target" value="warehouse" />
              <input
                type="hidden"
                name="warehouseTo"
                value={`/warehouse?orderId=${order.id}&returnTo=${encodeURIComponent(`/admin/orders/${order.id}/modules/warehouse`)}`}
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
        <ModuleNextGuidance
          orderId={order.id}
          moduleStatus={module.status}
          steps={definition.steps}
          currentIndex={currentIndex}
          nextModule={nextModule}
        />
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
              <h2>1. 模块业务数据</h2>
              <p>先按页面从上到下完成业务资料和实际操作。</p>
            </div>
          </div>
          {loaderData.workflowStageAccess.available || canApproveConsignment ? (
            <>
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
              {!(["consignment", "transport"] as OrderModuleCode[]).includes(definition.code) && (
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
      ? steps.at(-1)
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

function trackingGateTarget(orderId: string, reason: string) {
  if (reason.includes("报关") || reason.includes("清关") || reason.includes("海关") || reason.includes("放行") || reason.includes("转关")) {
    return {
      key: "customs",
      title: "去报关作业处理",
      href: `/admin/orders/${orderId}/modules/customs#module-business-data`,
      hint: "在报关作业里补齐申报资料，并把起运地报关推进到海关放行。",
    };
  }
  if (reason.includes("文件") || reason.includes("单证") || reason.includes("资料")) {
    return {
      key: "documents",
      title: "去文件中心处理",
      href: `/admin/orders/${orderId}/modules/documents#module-business-data`,
      hint: "上传发运前必须文件，并完成审核或归档。",
    };
  }
  if (reason.includes("仓库") || reason.includes("装车") || reason.includes("出库") || reason.includes("交接")) {
    return {
      key: "warehouse",
      title: "去仓库作业处理",
      href: `/admin/orders/${orderId}/modules/warehouse#module-business-data`,
      hint: "完成按批次拣货装车、出库交接，仓库模块完成后再回到运踪。",
    };
  }
  if (reason.includes("配载") || reason.includes("装载") || reason.includes("包装") || reason.includes("车辆")) {
    return {
      key: "loading",
      title: "去配载单处理",
      href: `/admin/orders/${orderId}/modules/loading#module-business-data`,
      hint: "生成或打开配载批次，补齐车辆、包装装载指令和整票装载确认。",
    };
  }
  if (reason.includes("运输安排") || reason.includes("车牌") || reason.includes("司机")) {
    return {
      key: "transport",
      title: "去国内运输处理",
      href: `/admin/orders/${orderId}/modules/transport#module-business-data`,
      hint: "补齐承运方、车牌、司机、电话、计划发车和到达时间。",
    };
  }
  if (reason.includes("出境口岸") || reason.includes("目的仓")) {
    return {
      key: "order",
      title: "去订单资料补充",
      href: `/admin/orders/${orderId}/operations`,
      hint: "补齐订单的出境口岸、境外目的仓和线路资料。",
    };
  }
  return {
    key: "order-center",
    title: "返回订单中心查看",
    href: `/admin/orders/${orderId}`,
    hint: "查看当前订单工作流、模块状态和全部门禁提示。",
  };
}

function TrackingDepartureGate({
  orderId,
  reasons,
}: {
  orderId: string;
  reasons: string[];
}) {
  const targets = Array.from(
    new Map(
      reasons.map((reason) => {
        const target = trackingGateTarget(orderId, reason);
        return [target.key, target];
      }),
    ).values(),
  );
  return (
    <section className="tracking-gate-panel">
      <div className="tracking-gate-copy">
        <span>出境前置条件未完成</span>
        <h3>请先处理下方阻断，再更新运踪</h3>
        <p>
          运踪会同步给后续执行和客户可见轨迹；未完成装车出库、资料或报关放行前，不能登记出境后的运输节点。
        </p>
      </div>
      <div className="tracking-gate-reasons">
        {reasons.map((reason) => {
          const target = trackingGateTarget(orderId, reason);
          return (
            <article key={reason}>
              <strong>{reason}</strong>
              <span>{target.hint}</span>
            </article>
          );
        })}
      </div>
      <div className="tracking-gate-actions">
        {targets.map((target, index) => (
          <Link
            key={target.key}
            className={index === 0 ? "primary" : "secondary"}
            to={target.href}
          >
            {target.title}
          </Link>
        ))}
      </div>
    </section>
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
        <span className={`status-pill ${missing.length ? "off" : ""}`}>
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
  const configured = fields.find((field) => field.fieldKey === fieldKey);
  return {
    visible: configured ? configured.isActive : true,
    required: configured
      ? configured.isActive && configured.isRequired
      : fallbackRequired,
    label: configured?.label,
  };
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
  return (
    <Info
      label={`${policy.label || label}${policy.required ? " *" : ""}`}
      value={value}
      className={className}
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
      {isImage && <img src={attachment.data_url} alt={attachment.file_name} />}
      {isPdf && <object data={attachment.data_url} type="application/pdf" aria-label={attachment.file_name}>
        <p>PDF 无法在当前浏览器内预览，请使用下方按钮打开。</p>
      </object>}
      {!isImage && !isPdf && <div className="document-review-fallback">
        <strong>当前文件格式不支持页内预览</strong>
        <span>请打开或下载原文件后审核。</span>
      </div>}
    </div>
    <footer className="row-actions">
      <a className="secondary" href={attachment.data_url} target="_blank" rel="noreferrer">在新窗口打开</a>
      <a className="secondary" href={attachment.data_url} download={attachment.file_name}>下载原文件</a>
    </footer>
  </section>;
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
  if (code === "documents") return null;
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
      return ["appointment", "picked_up"].includes(operationStatus || "");
    })
    .filter((placement) => placement.policy.visible);
  if (!placements.length) return null;
  const canManageDocs = manage || canApproveConsignment;

  return (
    <section className="source-document-section" id="module-source-documents" aria-label="本节点文件">
      <header>
        <div>
          <h3>{code === "loading" ? "装车出库前文件门禁" : "本节点文件"}</h3>
          <p>{code === "loading" ? "在本页直接上传、查看、编辑和审核发票、装箱单与报关资料；全部通过后仓库才可完成出库交接。" : "文件在实际取得的业务节点上传，上传后自动汇总到文件中心查看和归档。"}</p>
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
          return (
            <article
              key={placement.documentCode}
              className={`source-document-row ${ready ? "ready" : ""}`}
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
                <span className="status-pill">
                  {latest ? documentReviewLabel(latest.review_status) : "待上传"}
                </span>
                <small title={latest?.file_name}>{latest?.file_name || "尚无文件"}</small>
              </div>
              {latest ? <div className="row-actions source-document-actions">
                <a className="text-button" href={latest.data_url} target="_blank" rel="noreferrer">查看</a>
                {canManageDocs ? <Modal title={`编辑文件 · ${placement.document.name}`} triggerLabel="编辑" triggerClassName="text-button">
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
                </Modal> : <button type="button" className="text-button" disabled>编辑</button>}
                {canManageDocs ? <Modal title={`审核文件 · ${placement.document.name}`} triggerLabel="审核" triggerClassName="text-button" size="wide" closeSignal={reviewCloseSignal}>
                  <Form method="post" className="stack">
                    <input type="hidden" name="intent" value="document_review" />
                    <input type="hidden" name="attachmentId" value={latest.id} />
                    <DocumentReviewPreview attachment={latest} />
                    <label className="field"><span>审核结果</span><select name="reviewStatus" defaultValue={latest.review_status === "rejected" ? "rejected" : "approved"}><option value="approved">审核通过</option><option value="rejected">退回修改</option></select></label>
                    <button className="primary" disabled={busy}>确认审核结果</button>
                  </Form>
                </Modal> : <button type="button" className="text-button" disabled>审核</button>}
              </div> : canManageDocs ? <Form method="post" encType="multipart/form-data" className="source-document-upload-form">
                <input type="hidden" name="intent" value="document_upload" />
                <input type="hidden" name="documentCategory" value={placement.documentCode} />
                <input type="hidden" name="documentDescription" value="" />
                <input type="hidden" name="publicToCustomer" value="0" />
                <label className="document-upload-button">
                  <input className="document-upload-input" name="attachments" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required disabled={busy} onChange={(event) => { if (event.currentTarget.files?.length) event.currentTarget.form?.requestSubmit(); }} />
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

function ModuleBusinessData({
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
  const activeBatch = data.batches.find((item) => item.status !== "cancelled");

  if (code === "cargo")
    return (
      <div className="module-business-stack">
        <div className="module-summary-cards">
          <article>
            <span>货物明细</span>
            <strong>{data.cargo.length}</strong>
            <small>最小货品记录</small>
          </article>
          <article>
            <span>包装数</span>
            <strong>
              {data.cargo.reduce((sum, x) => sum + x.package_count, 0)}
            </strong>
            <small>箱/托/件</small>
          </article>
          <article>
            <span>总毛重</span>
            <strong>
              {data.cargo
                .reduce(
                  (sum, x) =>
                    sum + x.package_count * x.gross_weight_per_package_kg,
                  0,
                )
                .toFixed(3)}
            </strong>
            <small>KG</small>
          </article>
          <article>
            <span>总体积</span>
            <strong>
              {data.cargo
                .reduce(
                  (sum, x) => sum + x.package_count * x.volume_per_package_cbm,
                  0,
                )
                .toFixed(4)}
            </strong>
            <small>CBM</small>
          </article>
        </div>
        <div className="table-wrap module-record-table">
          <table>
            <thead>
              <tr>
                <th>品名/HS</th>
                <th>包装</th>
                <th>毛重/净重</th>
                <th>尺寸/体积</th>
                <th>货值</th>
                <th>品牌/原产国</th>
                <th>属性/图片</th>
              </tr>
            </thead>
            <tbody>
              {data.cargo.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.cargo_name_cn}</strong>
                    <small>
                      {item.cargo_name_en || "—"} · HS {item.hs_code || "—"} /{" "}
                      {item.overseas_hs_code || "—"}
                    </small>
                  </td>
                  <td>
                    {item.package_type} × {item.package_count}
                    <small>每包装 {item.pieces_per_package} 件</small>
                  </td>
                  <td>
                    {item.gross_weight_per_package_kg} /{" "}
                    {item.net_weight_per_package_kg} KG<small>单包装</small>
                  </td>
                  <td>
                    {item.length_cm}×{item.width_cm}×{item.height_cm} cm
                    <small>
                      {item.volume_per_package_cbm.toFixed(4)} CBM/包装
                    </small>
                  </td>
                  <td>
                    {item.currency} {item.declared_value.toLocaleString()}
                  </td>
                  <td>
                    {item.brand_model || "—"}
                    <small>
                      {item.origin_country || "—"} · 唛头 {item.marks || "—"}
                    </small>
                  </td>
                  <td>
                    {item.special_attributes || "普通货物"}
                    <small>{item.image_count} 张图片</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.cargo.length && <p className="empty-state">暂无货物明细。</p>}
        <Link
          className="secondary module-external-link"
          to={`/admin/orders/${data.order.id}/operations#cargo`}
        >
          新增或维护货物
        </Link>
      </div>
    );
  if (code === "documents")
    return (
      <div className="module-business-stack dense-module-stack">
        <section className="order-document-stages">
          {orderDocumentStages.map((stage) => (
            <article className="order-document-stage" key={stage.code}>
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
              <div className="order-document-grid">
                {stage.documents.map((document) => {
                  const files = data.attachments.filter(
                    (attachment) => attachment.document_category === document.code,
                  );
                  const latest = files[0];
                  return (
                    <Form
                      method="post"
                      encType="multipart/form-data"
                      className={`order-document-card ${files.some((file) => ["approved", "archived"].includes(file.review_status || "")) ? "ready" : ""}`}
                      key={document.code}
                    >
                      <input type="hidden" name="intent" value="document_upload" />
                      <input type="hidden" name="documentCategory" value={document.code} />
                      <div className="order-document-card-title">
                        <strong>{document.name}</strong>
                        <span>{files.length ? `${files.length} 份` : "待上传"}</span>
                      </div>
                      <small>{document.hint}</small>
                      {latest && (
                        <p title={latest.file_name}>
                          {latest.file_name} · {documentReviewLabel(latest.review_status)}
                        </p>
                      )}
                      {!latest && (
                        <p className="muted">请到对应业务节点上传，文件中心不重复录入。</p>
                      )}
                    </Form>
                  );
                })}
              </div>
            </article>
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
                        href={item.data_url}
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
                      {manage ? <Modal title={`审核文件 · ${item.file_name}`} triggerLabel="审核" triggerClassName="text-button" size="wide" closeSignal={reviewCloseSignal}>
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
                      </Modal> : <button type="button" className="text-button" disabled>审核</button>}
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
    const originGate = customsDeclarationGate(data.customsDeclarations, "origin");
    const activeDeclarations = data.customsDeclarations.filter((item) => item.is_deleted !== 1 && item.status !== "cancelled");
    const deletedCount = data.customsDeclarations.length - activeDeclarations.length;
    return (
      <div className="module-business-stack dense-module-stack">
        <CustomsDeclarationGatePanel gate={originGate} />
        {manage && (
          <details className="expandable module-create-dialog" open={!activeDeclarations.length}>
            <summary>新增报关单</summary>
            <CustomsDeclarationForm busy={busy} fields={data.workflowFields} />
          </details>
        )}
        <div className="module-summary-cards">
          <article>
            <span>有效起运地报关单</span>
            <strong>{originGate.total}</strong>
            <small>张</small>
          </article>
          <article>
            <span>起运地已放行</span>
            <strong>{originGate.released}</strong>
            <small>张</small>
          </article>
          <article>
            <span>待放行</span>
            <strong>{originGate.pending}</strong>
            <small>张</small>
          </article>
          <article>
            <span>删单/作废</span>
            <strong>{deletedCount}</strong>
            <small>张，不计门禁</small>
          </article>
        </div>
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
              {data.customsDeclarations.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>{customsStageLabel(x.clearance_stage)}</strong>
                    <small>{x.declaration_number} · {x.declaration_type}</small>
                  </td>
                  <td>
                    {x.declaration_title}
                    <small>{x.declaring_company}</small>
                  </td>
                  <td>
                    {x.currency} {Number(x.declared_amount).toLocaleString()}
                    <small>{Number(x.gross_weight_kg).toLocaleString()} KG</small>
                  </td>
                  <td>
                    申报 {formatDateTime(x.declared_at)}
                    <small>放行 {formatDateTime(x.released_at)}</small>
                  </td>
                  <td>
                    <CustomsDeclarationFlags declaration={x} />
                  </td>
                  <td>
                    <span className={`status-pill ${x.status === "released" ? "success" : x.is_deleted ? "off" : ""}`}>
                      {customsDeclarationStatusLabel(x)}
                    </span>
                  </td>
                  <td>
                    <CustomsDeclarationAction declaration={x} manage={manage} busy={busy} fields={data.workflowFields} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.customsDeclarations.length && (
          <p className="empty-state">尚未录入报关单。新增第一张起运地报关单后，系统开始计算放行门禁。</p>
        )}
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
      <div className="module-business-stack dense-module-stack">
        {data.order.business_type === "ltl" && (
          <BusinessSubsection
            title="国内提货运输安排"
            hint="这里只安排从客户工厂到国内仓/口岸仓的提货车辆、司机、承运方和到仓时间；不做拼车配载。"
          >
            <div className="inherited-data-strip">
              <span>起点<strong>{[data.order.origin_state,data.order.origin_city,data.order.origin_address].filter(Boolean).join(" ") || "客户工厂待确认"}</strong></span>
              <span>终点<strong>{data.transportAssignments.find((item) => item.leg_type === "first_mile")?.destination_location || "请在下方选择国内段终点仓库"}</strong></span>
              <span>后续配载<strong>货物到仓复核后，在拼车配载模块按整票订单组批</strong></span>
            </div>
          </BusinessSubsection>
        )}
        <div className="module-toolbar transport-entry-forms">
          {manage && (
            <details className="expandable module-create-dialog module-inline-create transport-entry-panel" open>
              <summary>新增运输安排</summary>
              <Form method="post" className="form-grid compact transport-arrangement-form">
                <input
                  type="hidden"
                  name="intent"
                  value="transport_assignment"
                />
                <div className="transport-cost-heading span-2">
                  <strong>先安排承运商并登记预计应付</strong>
                  <span>由业务员在国内运输开始时确认；保存后同步生成国内运输应付明细。</span>
                </div>
                <label className="field">
                  <span>运输分段</span>
                  <select name="legType">
                    <option value="first_mile">国内提货段：客户工厂 → 国内仓/口岸仓</option>
                    <option value="main">出境 / 境外运输段</option>
                  </select>
                </label>
                <ModuleField
                  fields={data.workflowFields}
                  fieldKey="domestic_carrier_id"
                  label="国内承运商"
                  fallbackRequired
                >
                  {(required) => <select
                    name="carrierId"
                    required={required}
                    onChange={(event) => {
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
                    {data.carriers.map((x) => (
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
                <input type="hidden" name="carrierName" />
                <input type="hidden" name="carrierContact" />
                <input type="hidden" name="carrierPhone" />
                <fieldset className="transport-payable-fields span-2">
                  <legend>预计应付费用</legend>
                  <ModuleField fields={data.workflowFields} fieldKey="domestic_payable_charge_name" label="应付费用名称" fallbackRequired>
                    {(required) => <input name="chargeName" defaultValue="国内运输费" required={required} />}
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
                <ModuleField fields={data.workflowFields} fieldKey="domestic_vehicle_type" label="国内车型" fallbackRequired>
                  {(required) => <select name="vehicleType" defaultValue="" required={required}>
                    <option value="">请选择车型</option>
                    <option value="卡车">卡车</option>
                    <option value="尖程拼车">尖程拼车</option>
                    <option value="13米平板">13米平板</option>
                    <option value="13.5米高栏">13.5米高栏</option>
                    <option value="13.7米平板">13.7米平板</option>
                    <option value="17.5米平板">17.5米平板</option>
                    <option value="17.5米厢式车">17.5米厢式车</option>
                    <option value="13米高栏">13米高栏</option>
                    <option value="16米厢式车">16米厢式车</option>
                    <option value="13米厢式车">13米厢式车</option>
                    <option value="冷藏车">冷藏车</option>
                  </select>}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_vehicle_count" label="车辆数目">
                  {(required) => <input name="vehicleCount" type="number" min="1" step="1" defaultValue="1" required={required} />}
                </ModuleField>
                <input type="hidden" name="loadingMode" value={data.order.business_type} />
                <ModuleField fields={data.workflowFields} fieldKey="domestic_plate_number" label="国内车牌号" fallbackRequired>
                  {(required) => <input name="plateNumber" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_driver_name" label="国内司机姓名" fallbackRequired>
                  {(required) => <input name="driverName" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_driver_phone" label="国内司机手机号" fallbackRequired>
                  {(required) => <input name="driverPhone" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_driver_id_number" label="国内司机证件号">
                  {(required) => <input name="driverIdNumber" required={required} />}
                </ModuleField>
                <div className="inherited-data-strip span-2">
                  <span>起运地（继承订单）<strong>{[data.order.origin_country,data.order.origin_state,data.order.origin_city].filter(Boolean).join(" ")}</strong></span>
                  <label className="warehouse-destination-cell">
                    <span>国内段终点 <b>*</b></span>
                    <select name="destinationWarehouseId" defaultValue="" required>
                      <option value="">请选择仓库</option>
                      {data.warehouses
                        .filter((warehouse) => ["domestic_collection", "port"].includes(warehouse.warehouse_role || ""))
                        .map((warehouse) => (
                          <option key={warehouse.id} value={warehouse.id}>
                            {warehouse.name} · {warehouse.warehouse_role === "port" ? "口岸仓" : "国内集货仓"}
                          </option>
                        ))}
                    </select>
                    <small>仓库端将显示所选仓库</small>
                  </label>
                  <span>境外目的地（后续节点）<strong>{[data.order.destination_country,data.order.destination_state,data.order.destination_city].filter(Boolean).join(" ")}</strong></span>
                </div>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_planned_departure_at" label="计划提货时间" fallbackRequired>
                  {(required) => <input name="plannedDepartureAt" type="datetime-local" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_planned_arrival_at" label="计划到仓时间" fallbackRequired>
                  {(required) => <input name="plannedArrivalAt" type="datetime-local" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_loading_requirements" label="国内装载要求" className="field span-2">
                  {(required) => <textarea name="loadingRequirements" rows={2} required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="domestic_transport_notes" label="国内运输备注" className="field span-2">
                  {(required) => <textarea name="notes" rows={2} required={required} />}
                </ModuleField>
                <button className="primary" disabled={busy}>
                  保存运输安排
                </button>
              </Form>
            </details>
          )}
          {manage && (
            <details className="expandable module-create-dialog module-inline-create transport-entry-panel">
              <summary>新增运单</summary>
              <Form method="post" className="form-grid compact transport-waybill-form">
                <input type="hidden" name="intent" value="waybill_create" />
                <ModuleField fields={data.workflowFields} fieldKey="waybill_number" label="运输运单号">
                  {(required) => <input name="waybillNumber" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="waybill_accompanying_at" label="随单时间">
                  {(required) => <input name="accompanyingAt" type="datetime-local" required={required} />}
                </ModuleField>
                <div className="inherited-data-strip span-2">
                  <span>发货人（继承订单）<strong>{data.order.shipper_name}</strong><small>{data.order.origin_address}</small></span>
                  <span>收货人（继承订单）<strong>{data.order.consignee_name}</strong><small>{data.order.destination_address}</small></span>
                </div>
                <ModuleField fields={data.workflowFields} fieldKey="waybill_shipper_instructions" label="发货人指示">
                  {(required) => <textarea name="shipperInstructions" rows={2} required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="waybill_customs_notes" label="运单海关记载">
                  {(required) => <textarea name="customsNotes" rows={2} required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="waybill_accompanying_documents" label="随附单证" className="field span-2">
                  {(required) => <textarea name="accompanyingDocuments" rows={2} required={required} />}
                </ModuleField>
                {workflowFieldPolicy(data.workflowFields, "waybill_documents_verified").visible && (
                  <label className="check-field span-2" data-workflow-field="waybill_documents_verified">
                    <input
                      name="documentsVerified"
                      type="checkbox"
                      required={workflowFieldPolicy(data.workflowFields, "waybill_documents_verified").required}
                    />
                    运单和随车文件已核对
                    {workflowFieldPolicy(data.workflowFields, "waybill_documents_verified").required && (
                      <b className="required-mark" aria-label="必填">*</b>
                    )}
                  </label>
                )}
                <button className="primary" disabled={busy}>
                  建立运单
                </button>
              </Form>
            </details>
          )}
        </div>
        <BusinessSubsection
          title="运输分段与派车"
          hint="头程、干线、后程分别记录承运商、车辆、司机、时间和运费。"
        >
          <div className="table-wrap module-record-table">
            <table>
              <thead>
                <tr>
                  <th>分段</th>
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
                    <td>{legTypeLabel(x.leg_type)}</td>
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
                    <td>{x.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.transportAssignments.length && (
            <p className="empty-state">暂无运输分段安排。</p>
          )}
        </BusinessSubsection>
        <BusinessSubsection
          title="订舱记录"
          hint="订舱是业务执行节点，可按不同承运人分批建立。"
        >
          <div className="table-wrap module-record-table compact-record-table">
            <table>
              <thead><tr><th>订舱号</th><th>类型</th><th>承运商</th><th>计划发车</th><th>状态</th></tr></thead>
              <tbody>
                {data.bookings.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.booking_number}</strong></td>
                    <td>{item.booking_type}</td>
                    <td>{item.carrier_name || ""}</td>
                    <td>{item.planned_departure_at ? formatDateTime(item.planned_departure_at) : ""}</td>
                    <td>{item.status}</td>
                  </tr>
                ))}
                {!data.bookings.length && <tr><td colSpan={5} className="empty-state">暂无订舱记录，可从现有操作页建立。</td></tr>}
              </tbody>
            </table>
          </div>
        </BusinessSubsection>
        <BusinessSubsection
          title="运输运单"
          hint="集中维护发收货人、随附单证、海关记载和文件核对。"
        >
          <div className="table-wrap module-record-table compact-record-table">
            <table>
              <thead><tr><th>运单号</th><th>发货方</th><th>收货方</th><th>随单时间</th><th>文件</th><th>状态</th></tr></thead>
              <tbody>
                {data.waybills.map((x) => (
                  <tr key={x.id}>
                    <td><strong>{x.waybill_number}</strong></td>
                    <td>{x.shipper_name || ""}</td>
                    <td>{x.consignee_name || ""}</td>
                    <td>{x.accompanying_at ? formatDateTime(x.accompanying_at) : ""}</td>
                    <td>{x.documents_verified ? "已核对" : "待核对"}</td>
                    <td>{x.status}</td>
                  </tr>
                ))}
                {!data.waybills.length && <tr><td colSpan={6} className="empty-state">暂无运输运单。</td></tr>}
              </tbody>
            </table>
          </div>
        </BusinessSubsection>
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
    const referenceLabel = (items: ReferenceOption[], codeValue: string | null) =>
      items.find((item) => item.code === codeValue)?.name || codeValue || "未确定";
    const flowLabel = isFtl ? "整车运输单" : isLtl ? "配载运输单" : "运输方案";
    const resourceReady = Boolean(
      activeBatch?.overseas_carrier_name &&
      activeBatch?.overseas_vehicle_type &&
      activeBatch?.overseas_vehicle_plate &&
      activeBatch?.overseas_driver_name &&
      activeBatch?.overseas_driver_phone,
    );
    return (
      <div className="module-business-stack dense-module-stack">
        <div className="current-order-loading-context">
          <div>
            <span>当前订单</span>
            <strong>{data.order.order_number} · {data.order.customer_name}</strong>
          </div>
          <div>
            <span>订单线路</span>
            <strong>{data.order.origin_city} → {data.order.destination_city}</strong>
          </div>
          <div>
            <span>报价类型</span>
            <strong>{isFtl ? "整车：一单一车" : isLtl ? "拼车：多单一车" : "未确定"}</strong>
          </div>
          <p>国内运输完成后按报价类型自动分支；整车直接形成整车运输单，拼车才进入配载运输单。</p>
        </div>
        <BusinessSubsection
          title="仓库实收与自动分支"
          hint="仓库只确认实际收货数据；整车或拼车由报价决定，这里不再重复选择。"
        >
          <div className="loading-selection-actuals">
            <article><span>实收包装</span><strong>{data.warehouseActuals?.actual_packages ?? 0}</strong><small>个</small></article>
            <article><span>实收件数</span><strong>{data.warehouseActuals?.actual_pieces ?? 0}</strong><small>件</small></article>
            <article><span>实收重量</span><strong>{Number(data.warehouseActuals?.actual_weight_kg ?? 0).toFixed(2)}</strong><small>KG</small></article>
            <article><span>实测体积</span><strong>{Number(data.warehouseActuals?.actual_volume_cbm ?? 0).toFixed(3)}</strong><small>CBM</small></article>
          </div>
          {!hasWarehouseActuals ? (
            <div className="alert warning">
              <strong>暂不能进入装车：</strong>仓库尚未完成收货清点并确认货齐。
              <Link className="secondary" to={`/admin/orders/${data.order.id}/modules/warehouse#module-business-data`}>返回仓库作业</Link>
            </div>
          ) : (
            <div className="alert success">
              <strong>仓库实收数据已确认</strong>
              <span>下一步请确定出境口岸和起运地清关地，可补充运输线路说明。</span>
            </div>
          )}
        </BusinessSubsection>
        {hasWarehouseActuals && (
          <BusinessSubsection
            title="配载准备"
            hint="这些参数在国内仓确认货齐后确定；拼车订单只会匹配同口岸、同清关地、同装车仓和同境外目的仓的订单。"
          >
            {manage && (
              <Form method="post" className="consignment-form-grid compact loading-preparation-form">
                <input type="hidden" name="intent" value="loading_route_select" />
                <label className="field span-2">
                  <span>运输线路说明</span>
                  <textarea name="routeCode" rows={3} defaultValue={data.order.route_notes || ""} placeholder="选填，例如途经口岸、换装点或特殊行驶要求" />
                </label>
                <label className="field">
                  <span>出境口岸 <b>*</b></span>
                  <select name="exitPort" defaultValue={data.order.exit_port || ""} required>
                    <option value="">请选择出境口岸</option>
                    {data.loadingReferences.borderPorts.map((item) => <option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>起运地清关地 <b>*</b></span>
                  <select name="customsLocation" defaultValue={data.order.customs_location || ""} required>
                    <option value="">请选择清关地</option>
                    {data.loadingReferences.customsPlaces.map((item) => <option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>中转地</span>
                  <select name="transitLocations" defaultValue={data.order.transit_locations || ""}>
                    <option value="">无中转地</option>
                    {data.loadingReferences.transitPlaces.map((item) => <option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}
                  </select>
                </label>
                <label className="field span-2">
                  <span>境外目的仓</span>
                  <input value={data.order.overseas_warehouse_name || "未确定"} readOnly />
                </label>
                <button className="primary" disabled={busy}>保存配载准备参数</button>
              </Form>
            )}
            {loadingPreparationReady && (
              <div className="loading-preparation-summary">
                <span><b>线路</b>{data.order.route_notes || "未填写"}</span>
                <span><b>口岸</b>{referenceLabel(data.loadingReferences.borderPorts, data.order.exit_port)}</span>
                <span><b>清关地</b>{referenceLabel(data.loadingReferences.customsPlaces, data.order.customs_location)}</span>
                <span><b>目的仓</b>{data.order.overseas_warehouse_name}</span>
              </div>
            )}
            {!loadingPreparationReady ? (
              <div className="alert warning"><strong>出口运输准备尚未完成：</strong>选择出境口岸和清关地后才会开放后续运输分支。</div>
            ) : !isFtl && !isLtl ? (
            <div className="alert danger">
              <strong>报价未确定车型：</strong>请返回询价报价，确认本单是整车还是拼车后再继续。
            </div>
          ) : (
            <div className="alert success">
              <strong>已自动进入：{flowLabel}</strong>
              <span>{isLtl ? "请在下方选择可配载订单并生成配载运输单。" : "本单无需拼车配载，请登记出境车辆后进入仓库端装车出库。"}</span>
            </div>
          )}
          </BusinessSubsection>
        )}
        {manage && activeBatch && (
          <BusinessSubsection
            title={isFtl ? "整车运输单：车辆与承运方" : "配载运输单：境外运输资源"}
            hint={isLtl
              ? "这里登记整批出境后使用的承运方和车辆，信息会同步给同一配载单的全部订单。"
              : "整车订单在这里登记本单出境车辆；保存后系统自动生成单车装载指令。"}
          >
            <Form method="post" className="consignment-form-grid compact loading-resource-form">
              <input type="hidden" name="intent" value="outbound_transport_resource_save" />
              <input type="hidden" name="batchId" value={activeBatch.id} />
              <label className="field">
                <span>境外承运方 <b>*</b></span>
                <select name="overseasCarrierName" defaultValue={activeBatch.overseas_carrier_name || ""} required>
                  <option value="">请选择承运方</option>
                  {data.carriers.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>境外车型 <b>*</b></span>
                <select name="overseasVehicleType" defaultValue={activeBatch.overseas_vehicle_type || ""} required>
                  <option value="">请选择车型</option>
                  <option value="卡车">卡车</option>
                  <option value="头程拼车">头程拼车</option>
                  <option value="13米平板">13米平板</option>
                  <option value="13.5米高栏">13.5米高栏</option>
                  <option value="13.7米平板">13.7米平板</option>
                  <option value="17.5米平板">17.5米平板</option>
                  <option value="17.5米厢式车">17.5米厢式车</option>
                  <option value="13米高栏">13米高栏</option>
                  <option value="16米厢式车">16米厢式车</option>
                  <option value="13米厢式车">13米厢式车</option>
                  <option value="冷藏车">冷藏车</option>
                </select>
              </label>
              <label className="field"><span>车辆数目 <b>*</b></span><input name="overseasVehicleCount" type="number" min="1" defaultValue={activeBatch.overseas_vehicle_count || 1} required /></label>
              <label className="field"><span>境外车牌号 <b>*</b></span><input name="overseasVehiclePlate" defaultValue={activeBatch.overseas_vehicle_plate || ""} required /></label>
              <label className="field"><span>司机姓名 <b>*</b></span><input name="overseasDriverName" defaultValue={activeBatch.overseas_driver_name || ""} required /></label>
              <label className="field"><span>司机电话 <b>*</b></span><input name="overseasDriverPhone" defaultValue={activeBatch.overseas_driver_phone || ""} required /></label>
              <button className="primary" disabled={busy}>{isFtl ? "保存整车运输单" : "保存整批运输资源"}</button>
            </Form>
            {isFtl && resourceReady && (
              <div className="loading-next-action">
                <strong>下一步</strong>
                <span>车辆已登记，系统已把本单包装分配到整车运输单。</span>
                <WarehouseSiteButton orderId={data.order.id} targetPath="/warehouse/outbound" className="primary">去仓库端装车出库</WarehouseSiteButton>
              </div>
            )}
          </BusinessSubsection>
        )}
        {manage && isLtl && loadingPreparationReady && !data.batches.some((item) => item.status !== "cancelled") && (
          <InlineLoadingWorkbench data={data} busy={busy} />
        )}
        {manage && isLtl && activeBatch && Number(activeBatch.vehicle_count || 0) === 0 && (
          <div className="loading-batch-action-alert">
            <div>
              <strong>配载运输单尚未添加装载车辆</strong>
              <span>请先在配载运输单中添加车辆，再将每张整票订单分配到具体车辆并确认装载指令。</span>
            </div>
            <Link className="primary" to={`/admin/loading/${activeBatch.id}`}>打开配载运输单</Link>
          </div>
        )}
        <div className="module-data-list">
          {data.batches.map((item) => (
            <article key={item.id} className="loading-batch-entry">
              <Link className="loading-batch-entry-link" to={`/admin/loading/${item.id}`}>
                <div>
                  <strong>
                    {item.batch_number} · {item.batch_name}
                  </strong>
                  <small>
                    同步 {item.order_count} 票订单：{item.order_numbers || data.order.order_number}
                  </small>
                  <small>
                    {isFtl ? "装载车辆" : "配载车辆"} {item.vehicle_count} 辆 · {item.load_count} 个包装已分配
                  </small>
                </div>
                <span className="loading-batch-entry-action">
                  <small>{roadStatusLabels[item.road_status]||item.road_status}</small>
                  <b>{isFtl ? "打开整车运输单" : "打开配载运输单"}</b>
                </span>
              </Link>
              <div className="loading-batch-entry-files">
                <a className="secondary" href="#module-source-documents">处理本订单发运前文件</a>
                <Link className="primary" to={`/admin/loading/${item.id}?fromOrderId=${encodeURIComponent(data.order.id)}#batch-files`}>处理整批文件与报关门禁</Link>
              </div>
            </article>
          ))}
        </div>
        {isLtl && !data.batches.length && <p className="empty-state">尚未生成配载运输单，请从上方小工作台选择合适订单。</p>}
        {isLtl && <details className="loading-advanced-link">
          <summary>高级操作</summary>
          <Link
            className="secondary module-external-link"
            to={`/admin/loading?field=work_number&operator=equals&value=${encodeURIComponent(data.order.order_number)}`}
          >
            打开跨订单配载管理
          </Link>
        </details>}
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
        {data.trackingDepartureGate && !data.trackingDepartureGate.ready && (
          <TrackingDepartureGate
            orderId={data.order.id}
            reasons={data.trackingDepartureGate.reasons}
          />
        )}
        {manage && (
          <section className="tracking-option-controls" aria-label="可选运输节点">
            <div>
              <strong>可选运输节点</strong>
              <small>默认关闭。打开后，对应节点才会出现在运输节点下拉框中。</small>
            </div>
            <Form method="post">
              <input type="hidden" name="intent" value="tracking_option_toggle" />
              <input type="hidden" name="optionCode" value="transloaded" />
              <input
                type="hidden"
                name="enabled"
                value={data.order.requires_transloading ? "0" : "1"}
              />
              <button
                type="submit"
                className={data.order.requires_transloading ? "tracking-switch on" : "tracking-switch"}
                role="switch"
                aria-checked={Boolean(data.order.requires_transloading)}
                disabled={busy}
              >
                <span className="tracking-switch-track"><i /></span>
                换装
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="tracking_option_toggle" />
              <input type="hidden" name="optionCode" value="transit_customs" />
              <input
                type="hidden"
                name="enabled"
                value={data.order.requires_transit_customs ? "0" : "1"}
              />
              <button
                type="submit"
                className={data.order.requires_transit_customs ? "tracking-switch on" : "tracking-switch"}
                role="switch"
                aria-checked={Boolean(data.order.requires_transit_customs)}
                disabled={busy}
              >
                <span className="tracking-switch-track"><i /></span>
                转关
              </button>
            </Form>
          </section>
        )}
        {manage && (!data.trackingDepartureGate || data.trackingDepartureGate.ready) && (
          <details className="expandable module-create-dialog">
            <summary>更新运输节点</summary>
            <p className="helper-text">
              换装、转关为可选节点；没有实际业务时可直接登记国外入境。目的地清关完成后，由境外目的仓扫码入库和清点自动完成本模块。
            </p>
            <Form method="post" className="form-grid compact">
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
              <button className="primary" disabled={busy}>
                保存运输节点
              </button>
            </Form>
          </details>
        )}
        <div className="tracking-milestone-board dense-milestone-board">
          {displayedTrackingMilestones.map(([value, label]) => {
            const item = data.trackingMilestones.find(
              (x) => x.milestone_code === value,
            );
            return (
              <article className={item ? "done" : ""} key={value}>
                <b>{item ? "✓" : "·"}</b>
                <div>
                  <strong>{label}</strong>
                  <small>
                    {item
                      ? `${formatDateTime(item.event_at)} · ${item.location || "地点待补"}`
                      : trackingOptionalMilestones.has(value)
                        ? "可选，无需时可跳过"
                        : "待更新"}
                  </small>
                </div>
              </article>
            );
          })}
        </div>
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
      </div>
    );
  }
  if (code === "overseas_warehouse") {
    const operation = data.overseasOperation;
    const operationStatus = operation?.status || "waiting_arrival";
    const progress = overseasOperationProgress[operationStatus] || 0;
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
          hint="严格按“到仓—通知客户—预约提货—客户自提并签收”从左到右办理；批次到仓同步关联订单，每票自提分别确认。"
        >
          <div className="loading-selection-summary" aria-live="polite">
            <span>
              已完成至：
              <strong>
                {overseasOperationStatusLabels[operationStatus] || operationStatus}
              </strong>
            </span>
            <span>{progress}%</span>
            <span>下一步：{nextOverseasAction(operationStatus)}</span>
          </div>
          <div className="tracking-milestone-board dense-milestone-board">
            {[
              ["arrived", "目的仓到仓", 25],
              ["notified", "通知客户", 50],
              ["appointment", "预约提货", 75],
              ["picked_up", "客户自提", 100],
              ["signed", "签收", 100],
              ["completed", "运输完成", 100],
            ].map(([status, label, threshold]) => (
              <article className={progress >= Number(threshold) ? "done" : ""} key={String(status)}>
                <b>{progress >= Number(threshold) ? "✓" : "·"}</b>
                <div>
                  <strong>{label}</strong>
                  <small>{progress >= Number(threshold) ? "已完成" : "待办理"}</small>
                </div>
              </article>
            ))}
          </div>
        </BusinessSubsection>

        <BusinessSubsection
          title="批次与目的仓"
          hint="一票订单只读取创建订单时已选的境外目的仓，不在后续重复填写地址。"
        >
          <div className="consignment-form-grid overseas-summary-grid">
            <Info
              label="配载批次"
              value={operation?.batch_number || ""}
            />
            <Info
              label="批次状态"
              value={
                operation
                  ? roadStatusLabels[operation.road_status] || operation.road_status
                  : ""
              }
            />
            <Info
              label="境外目的仓"
              value={
                data.order.overseas_warehouse_name
                  ? `${data.order.overseas_warehouse_name} · ${data.order.overseas_warehouse_code || ""}`
                  : ""
              }
            />
            <Info
              label="目的仓地址"
              value={
                [
                  data.order.overseas_warehouse_address,
                  data.order.overseas_warehouse_address_note,
                ]
                  .filter(Boolean)
                  .join(" · ")
              }
            />
            <Info
              label="批次提货进度"
              value={
                operation
                  ? `${operation.picked_up_order_count}/${operation.batch_order_count} 票`
                  : ""
              }
            />
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

        {manage && operationStatus === "arrived" && (
          <BusinessSubsection title="2. 通知客户" hint="记录实际通知时间；不要求重复填写订单联系人。">
            <Form method="post" className="form-grid compact">
              <input type="hidden" name="intent" value="overseas_advance" />
              <input type="hidden" name="operationAction" value="notify" />
              <ModuleField fields={data.workflowFields} fieldKey="customer_notified_at" label="通知时间" fallbackRequired>
                {(required) => <input name="occurredAt" type="datetime-local" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="customer_notification_notes" label="通知说明" className="field span-2">
                {(required) => <input name="notes" required={required} placeholder="电话、邮件或客户门户通知结果" />}
              </ModuleField>
              <button className="primary" disabled={busy}>确认已通知客户</button>
            </Form>
          </BusinessSubsection>
        )}

        {manage && operationStatus === "notified" && (
          <BusinessSubsection title="3. 预约提货" hint="登记客户确认的预约时间，批次进入等待提货。">
            <Form method="post" className="form-grid compact">
              <input type="hidden" name="intent" value="overseas_advance" />
              <input type="hidden" name="operationAction" value="appointment" />
              <ModuleField fields={data.workflowFields} fieldKey="pickup_appointment_at" label="预约提货时间">
                {(required) => <input name="occurredAt" type="datetime-local" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="pickup_appointment_notes" label="预约说明" className="field span-2">
                {(required) => <input name="notes" required={required} placeholder="车辆、提货码或注意事项" />}
              </ModuleField>
              <button className="primary" disabled={busy}>保存提货预约</button>
            </Form>
          </BusinessSubsection>
        )}

        {manage && operationStatus === "appointment" && (
          <BusinessSubsection title="4. 确认客户自提并签收" hint="每票订单分别确认；保存后自动记录签收并完成运输，批次全部完成后自动关闭提货环节。">
            <Form method="post" className="form-grid compact">
              <input type="hidden" name="intent" value="overseas_advance" />
              <input type="hidden" name="operationAction" value="pickup" />
              <ModuleField fields={data.workflowFields} fieldKey="pickup_completed_at" label="实际提货时间" fallbackRequired>
                {(required) => <input name="occurredAt" type="datetime-local" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="overseas_pickup_contact" label="提货人/签收人" fallbackRequired>
                {(required) => <input name="pickupContact" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="pickup_proof" label="提货凭证编号">
                {(required) => <input name="pickupProofReference" required={required} />}
              </ModuleField>
              <ModuleField fields={data.workflowFields} fieldKey="pickup_completion_notes" label="交付说明" className="field span-2">
                {(required) => <input name="notes" required={required} />}
              </ModuleField>
              <button className="primary" disabled={busy}>确认客户自提并签收</button>
            </Form>
          </BusinessSubsection>
        )}

        {operationStatus === "picked_up" && (
          <BusinessSubsection title="自提与签收结果" hint="客户自提、签收和运输完成结果已同步运单轨迹与客户门户。">
            <div className="consignment-form-grid overseas-summary-grid">
              <Info label="实际到仓" value={formatDateTime(operation?.actual_arrival_at)} />
              <Info label="通知时间" value={formatDateTime(operation?.notified_at)} />
              <Info label="预约时间" value={formatDateTime(operation?.appointment_at)} />
              <Info label="提货时间" value={formatDateTime(operation?.pickup_at)} />
              <Info label="提货人" value={operation?.pickup_contact || ""} />
              <Info label="提货凭证" value={operation?.pickup_proof_reference || ""} />
            </div>
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
              <Form method="post" className="form-grid compact">
                <input type="hidden" name="intent" value="expense_add" />
                {!workflowFieldPolicy(data.workflowFields, "expense_direction").visible && <input type="hidden" name="direction" value="receivable" />}
                {!workflowFieldPolicy(data.workflowFields, "expense_charge_code").visible && <input type="hidden" name="chargeCode" value="FREIGHT" />}
                {!workflowFieldPolicy(data.workflowFields, "expense_charge_name").visible && <input type="hidden" name="chargeName" value="运费" />}
                {!workflowFieldPolicy(data.workflowFields, "expense_currency").visible && <input type="hidden" name="currency" value="CNY" />}
                {!workflowFieldPolicy(data.workflowFields, "expense_exchange_rate").visible && <input type="hidden" name="exchangeRate" value="1" />}
                {!workflowFieldPolicy(data.workflowFields, "expense_quantity").visible && <input type="hidden" name="quantity" value="1" />}
                {!workflowFieldPolicy(data.workflowFields, "expense_unit_price").visible && <input type="hidden" name="unitPrice" value="0" />}
                {!workflowFieldPolicy(data.workflowFields, "expense_tax_rate").visible && <input type="hidden" name="taxRate" value="0" />}
                {!workflowFieldPolicy(data.workflowFields, "expense_is_internal").visible && <input type="hidden" name="isInternal" value="0" />}
                <ModuleField fields={data.workflowFields} fieldKey="expense_direction" label="费用方向" fallbackRequired>
                  {(required) => <select name="direction" required={required}>
                    <option value="receivable">应收</option>
                    <option value="payable">应付</option>
                  </select>}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_charge_code" label="费用代码">
                  {(required) => <input name="chargeCode" defaultValue="FREIGHT" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_charge_name" label="费用名称" fallbackRequired>
                  {(required) => <input name="chargeName" defaultValue="运费" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_counterparty" label="往来单位/联系人" fallbackRequired>
                  {(required) => <input name="counterpartyName" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_currency" label="币种" fallbackRequired>
                  {(required) => <select name="currency" defaultValue="CNY" required={required}>
                    <option value="CNY">CNY 人民币</option>
                    <option value="USD">USD 美元</option>
                    <option value="KZT">KZT 坚戈</option>
                    <option value="UZS">UZS 苏姆</option>
                    <option value="EUR">EUR 欧元</option>
                    <option value="RUB">RUB 卢布</option>
                  </select>}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_exchange_rate" label="汇率" fallbackRequired>
                  {(required) => <input
                    name="exchangeRate"
                    type="number"
                    min="0.000001"
                    step="0.000001"
                    defaultValue="1"
                    required={required}
                  />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_quantity" label="数量" fallbackRequired>
                  {(required) => <input
                    name="quantity"
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    defaultValue="1"
                    required={required}
                  />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_unit_price" label="单价" fallbackRequired>
                  {(required) => <input
                    name="unitPrice"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue="0"
                    required={required}
                  />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_tax_rate" label="税率 %">
                  {(required) => <input
                    name="taxRate"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue="0"
                    required={required}
                  />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_occurred_on" label="发生日期">
                  {(required) => <input name="occurredOn" type="date" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_foreign_account_no" label="国外账单号">
                  {(required) => <input name="foreignAccountNo" required={required} />}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_is_internal" label="内部费用">
                  {(required) => <select name="isInternal" defaultValue="0" required={required}><option value="0">否</option><option value="1">是</option></select>}
                </ModuleField>
                <ModuleField fields={data.workflowFields} fieldKey="expense_notes" label="费用备注" className="field span-2">
                  {(required) => <textarea name="notes" rows={3} required={required} />}
                </ModuleField>
                <button className="primary" disabled={busy}>
                  保存费用
                </button>
              </Form>
            </details>
          )}
          <span className="status-pill">应收、应付分别确认和锁定</span>
        </div>
        <div className="module-summary-cards">
          <article>
            <span>应收</span>
            <strong>
              {moneyTotal(data.expenses, "receivable").toFixed(2)}
            </strong>
            <small>折算汇总</small>
          </article>
          <article>
            <span>应付</span>
            <strong>{moneyTotal(data.expenses, "payable").toFixed(2)}</strong>
            <small>折算汇总</small>
          </article>
          <article>
            <span>预计利润</span>
            <strong>
              {(
                moneyTotal(data.expenses, "receivable") -
                moneyTotal(data.expenses, "payable")
              ).toFixed(2)}
            </strong>
            <small>未含跨币种展示差异</small>
          </article>
          <article>
            <span>费用风险</span>
            <strong>
              {data.expenses.length === 0
                ? "尚未预录"
                : ["receivable", "payable"].some(
                      (direction) =>
                        !directionControl(direction as "receivable" | "payable").confirmed,
                    )
                  ? "存在未确认费用"
                  : "费用已确认"}
            </strong>
            <small>风险只提醒，正式门禁在对账环节校验</small>
          </article>
        </div>
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
    const assignableModules = data.modules.filter(
      (item) =>
        item.enabled === 1 &&
        item.module_code !== "assignment" &&
        !["completed", "not_applicable"].includes(item.status),
    );
    const assignmentModule = data.modules.find((item) => item.module_code === "assignment");
    const assignedCount = assignableModules.filter(
      (item) => item.assignee_user_id,
    ).length;
    const unassignedModules = assignableModules.filter(
      (item) => !item.assignee_user_id,
    );
    const shouldRequireConfirmDispatch = data.order.status === "confirmed";
    const canConfirmDispatch = unassignedModules.length === 0 && data.order.status === "confirmed";
    return (
      <div className="assignment-workbench">
        {data.order.status === "submitted" && (
          <div className="assignment-bulk-panel assignment-review-entry">
            <div className="assignment-bulk-head">
              <div>
                <strong>等待委托审核</strong>
                <span>审批在委托信息页完成；审批通过后，本页自动开放任务分配。</span>
              </div>
              <Link className="primary" to={`/admin/orders/${data.order.id}/modules/consignment#module-business-data`}>
                返回委托信息审批
              </Link>
            </div>
          </div>
        )}
        {data.order.status !== "submitted" && (
          <>
            <Form method="post" className="assignment-primary-panel">
              <input type="hidden" name="intent" value="assign_bulk" />
              {unassignedModules.map((item) => (
                <input key={item.id} type="hidden" name="targetModuleCode" value={item.module_code} />
              ))}
              <div>
                <strong>整单派给一位主操作员</strong>
                <span>
                  {assignedCount}/{assignableModules.length} 个模块已有负责人；系统只分配尚未分配的模块。
                </span>
              </div>
              {unassignedModules.length ? (
                <>
                  <label className="field compact-assignment-field">
                    <span>主操作员 <b className="required-mark">*</b></span>
                    <select name="assigneeUserId" required defaultValue="">
                      <option value="">请选择主操作员</option>
                      {data.members.map((user) => (
                        <option value={user.id} key={user.id}>
                          {user.display_name}
                          {user.department_name ? ` · ${user.department_name}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primary" disabled={busy}>确认整单派单</button>
                </>
              ) : (
                <div className="assignment-complete-state">
                  <strong>全部模块已分配</strong>
                  <span>模块分配已完成，请执行“确认派单”。</span>
                  <Link className="secondary" to={`/admin/orders/${data.order.id}`}>返回订单中心</Link>
                </div>
              )}
            </Form>

            {shouldRequireConfirmDispatch && assignmentModule?.status !== "completed" && (
              <Form method="post" className="assignment-confirm-panel">
                <input type="hidden" name="intent" value="confirm_dispatch" />
                <div>
                  <strong>确认派单</strong>
                  {unassignedModules.length > 0 ? (
                    <span>尚有 {unassignedModules.length} 个模块未分配，先分配后才能确认派单。</span>
                  ) : (
                    <span>审核通过后，由主管手工确认派单并推进订单执行。</span>
                  )}
                </div>
                <label className="field compact-assignment-field">
                  <span>主操作员 <b className="required-mark">*</b></span>
                  <select
                    name="assigneeUserId"
                    required
                    defaultValue={
                      assignmentModule?.assignee_user_id || data.order.current_assignee_user_id || ""
                    }
                  >
                    <option value="">请选择主操作员</option>
                    {data.members.map((user) => (
                      <option value={user.id} key={user.id}>
                        {user.display_name}
                        {user.department_name ? ` · ${user.department_name}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field compact-assignment-field">
                  <span>派单说明</span>
                  <input
                    name="notes"
                    type="text"
                    placeholder="如需特别说明可填写"
                  />
                </label>
                <button className="primary" disabled={busy || unassignedModules.length > 0}>
                  立即确认派单
                </button>
              </Form>
            )}

            {workflowFieldPolicy(data.workflowFields, "assignment_scope").visible && (
              <details className="assignment-advanced-panel">
                <summary>高级操作：按模块分别分配</summary>
                <Form method="post" className="assignment-bulk-panel">
                  <input type="hidden" name="intent" value="assign_bulk" />
                  <div className="assignment-bulk-controls">
                    {workflowFieldPolicy(data.workflowFields, "module_assignees").visible && <select name="assigneeUserId" required={workflowFieldPolicy(data.workflowFields, "module_assignees").required} defaultValue="">
                      <option value="">不选择时由当前操作人负责</option>
                      {data.members.map((user) => (
                        <option value={user.id} key={user.id}>{user.display_name}{user.department_name ? ` · ${user.department_name}` : ""}</option>
                      ))}
                    </select>}
                    {workflowFieldPolicy(data.workflowFields, "assignment_due_at").visible && <input name="dueAt" type="datetime-local" required={workflowFieldPolicy(data.workflowFields, "assignment_due_at").required} aria-label="办理期限" />}
                    {workflowFieldPolicy(data.workflowFields, "assignment_notes").visible && <input name="notes" required={workflowFieldPolicy(data.workflowFields, "assignment_notes").required} placeholder="分配说明" />}
                    <button className="secondary" disabled={busy}>分配选中模块</button>
                  </div>
                  <div className="assignment-bulk-list">
                    {assignableModules.map((item) => (
                      <label key={item.id}>
                        <input type="checkbox" name="targetModuleCode" value={item.module_code} defaultChecked={!item.assignee_user_id} />
                        <span><strong>{item.module_name}</strong><small>{item.current_step_name || "未开始"} · {item.assignee_name || "未分配"}</small></span>
                      </label>
                    ))}
                  </div>
                </Form>
                <div className="assignment-single-list">
                  {assignableModules.map((item) => (
                    <Form method="post" className="assignment-module-row" key={item.id}>
                      <input type="hidden" name="intent" value="assign_other" />
                      <input type="hidden" name="targetModuleCode" value={item.module_code} />
                      <div><strong>{item.module_name}</strong><small>{item.current_step_name || "未开始"} · {item.assignee_name || "未分配"}</small></div>
                      <select name="assigneeUserId" required defaultValue={item.assignee_user_id || ""}>
                        <option value="">请选择负责人</option>
                        {data.members.map((user) => <option value={user.id} key={user.id}>{user.display_name}</option>)}
                      </select>
                      <button className="secondary">保存</button>
                    </Form>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
        <Link
          className="secondary module-external-link"
          to="/admin/workbenches/tasks"
        >
          进入跨订单任务中心
        </Link>
      </div>
    );
  }
  if (code === "consignment") {
    const cargoTotals = data.cargo.reduce(
      (total, item) => ({
        packages: total.packages + item.package_count,
        pieces: total.pieces + item.package_count * item.pieces_per_package,
        grossWeight:
          total.grossWeight +
          item.package_count * item.gross_weight_per_package_kg,
        netWeight:
          total.netWeight + item.package_count * item.net_weight_per_package_kg,
        volume:
          total.volume + item.package_count * item.volume_per_package_cbm,
      }),
      { packages: 0, pieces: 0, grossWeight: 0, netWeight: 0, volume: 0 },
    );
    const customFields = data.workflowFields.filter(
      (field) => field.isActive && !field.isBuiltIn,
    );
    const quoteStatus = data.order.quotation_status
      ? quotationStatusLabels[data.order.quotation_status] ||
        data.order.quotation_status
      : "";
    return (
      <div className="module-business-stack consignment-business-stack">
        <section className="consignment-form-sheet" aria-label="委托信息">
          <header>
            <div>
              <h3>委托信息</h3>
              <p>已知内容集中展示；未填写的选填项保持空白。</p>
            </div>
            <span className="status-pill">{data.order.order_number}</span>
          </header>

          <div className="consignment-form-group">
            <h4>订单基础</h4>
            <div className="consignment-form-grid">
              <WorkflowInfo fields={data.workflowFields} fieldKey="customer_id" label="委托客户" value={data.order.customer_name || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="quotation_id" label="已接受报价" value={data.order.quote_number || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="order_date" label="接单日期" value={data.order.order_date || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="business_nature" label="业务性质" value={data.order.business_nature || ""} />
              <Info label="报价状态" value={quoteStatus} />
              <Info label="订单状态" value={data.order.status || ""} />
            </div>
          </div>

          <div className="consignment-form-group">
            <h4>提货信息</h4>
            <div className="consignment-form-grid">
              <WorkflowInfo fields={data.workflowFields} fieldKey="shipper_customer_id" label="发货方" value={data.order.shipper_name || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="shipper_contact" label="提货联系人" value={data.order.shipper_contact || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="shipper_phone" label="联系电话" value={data.order.shipper_phone || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="origin_country" label="起运国家/地区" value={data.order.origin_country || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="origin_state" label="起运省/州" value={data.order.origin_state || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="origin_city" label="起运城市" value={data.order.origin_city || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="origin_address" label="提货地址" value={data.order.origin_address || ""} className="span-2" />
            </div>
          </div>

          <div className="consignment-form-group">
            <h4>收货与目的地</h4>
            <div className="consignment-form-grid">
              <WorkflowInfo fields={data.workflowFields} fieldKey="consignee_contact" label="收货联系人" value={data.order.consignee_contact || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="consignee_phone" label="联系电话" value={data.order.consignee_phone || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="destination_country" label="目的国家/地区" value={data.order.destination_country || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="destination_state" label="目的省/州" value={data.order.destination_state || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="destination_city" label="目的城市" value={data.order.destination_city || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="overseas_warehouse_id" label="境外目的仓" value={data.order.overseas_warehouse_name || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="destination_address" label="送货地址" value={data.order.destination_address || ""} className="span-2" />
              <WorkflowInfo fields={data.workflowFields} fieldKey="overseas_warehouse_address_note" label="目的仓地址备注" value={data.order.overseas_warehouse_address_note || ""} className="span-2" />
            </div>
          </div>

          <div className="consignment-form-group">
            <h4>货物汇总</h4>
            <div className="consignment-form-grid">
              <Info label="品名" value={data.cargo.map((item) => item.cargo_name_cn).filter(Boolean).join("、")} className="span-2" />
              <Info label="包装数" value={data.cargo.length ? String(cargoTotals.packages) : ""} />
              <Info label="件数" value={data.cargo.length ? String(cargoTotals.pieces) : ""} />
              <Info label="毛重" value={data.cargo.length ? `${cargoTotals.grossWeight.toFixed(3)} KG` : ""} />
              <Info label="净重" value={data.cargo.length ? `${cargoTotals.netWeight.toFixed(3)} KG` : ""} />
              <Info label="体积" value={data.cargo.length ? `${cargoTotals.volume.toFixed(4)} CBM` : ""} />
              <Info label="货物明细" value={data.cargo.length ? `${data.cargo.length} 条` : ""} />
            </div>
          </div>

          <div className="consignment-form-group consignment-quote-group">
            <div className="consignment-group-heading">
              <h4>已接受报价费用</h4>
              <strong>
                {data.order.quotation_currency && data.order.quotation_total_amount != null
                  ? `${data.order.quotation_currency} ${Number(data.order.quotation_total_amount).toLocaleString()}`
                  : ""}
              </strong>
            </div>
            <div className="table-wrap consignment-charge-table">
              <table>
                <thead>
                  <tr>
                    <th>费用名称</th>
                    <th>费用代码</th>
                    <th>币种</th>
                    <th>汇率</th>
                    <th>数量</th>
                    <th>单价</th>
                    <th>金额</th>
                  </tr>
                </thead>
                <tbody>
                  {data.quotationCharges.map((charge) => (
                    <tr key={charge.id}>
                      <td><strong>{charge.description}</strong></td>
                      <td>{charge.charge_code}</td>
                      <td>{data.order.quotation_currency || ""}</td>
                      <td>{Number(charge.exchange_rate).toLocaleString()}</td>
                      <td>{Number(charge.quantity).toLocaleString()}</td>
                      <td>{Number(charge.unit_price).toLocaleString()}</td>
                      <td><strong>{Number(charge.amount).toLocaleString()}</strong></td>
                    </tr>
                  ))}
                  {!data.quotationCharges.length && (
                    <tr className="blank-row">
                      <td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="consignment-form-group">
            <h4>时间与备注</h4>
            <div className="consignment-form-grid">
              <WorkflowInfo fields={data.workflowFields} fieldKey="requested_pickup_date" label="预约提货时间" value={data.order.requested_pickup_date || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="cargo_ready_at" label="货好时间" value={data.order.cargo_ready_at ? formatDateTime(data.order.cargo_ready_at) : ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="requested_delivery_date" label="要求送达日" value={data.order.requested_delivery_date || ""} />
              <WorkflowInfo fields={data.workflowFields} fieldKey="ro_agent" label="RO 代理" value={data.order.ro_agent || ""} />
              {workflowFieldPolicy(data.workflowFields, "special_instructions").visible && (
                <WorkflowInfo fields={data.workflowFields} fieldKey="special_instructions" label="备注" value={data.order.special_instructions || ""} className="span-4 multiline" />
              )}
            </div>
          </div>

          {customFields.length > 0 && (
            <div className="consignment-form-group">
              <h4>模板补充字段</h4>
              <div className="consignment-form-grid consignment-custom-fields">
                {customFields.map((field) => (
                  <div key={field.id} className={`consignment-custom-field-cell${field.present ? " ready" : field.isRequired ? " missing" : ""}`}>
                    <div>
                      <strong>{field.label}{field.isRequired && <sup>*</sup>}</strong>
                      <small>{field.helpText || (field.isRequired ? "必须填写" : "选填")}</small>
                    </div>
                    {manage ? (
                      <CustomWorkflowFieldForm field={field} busy={busy} />
                    ) : (
                      <span>{field.displayValue || ""}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {manage && data.order.status === "draft" && (
          <Form method="post" className="consignment-submit-bar">
            <div>
              <strong>委托资料复核完成后，直接提交审批</strong>
              <span>系统按当前模板检查必填项；选填项留空不会阻断。</span>
            </div>
            <div>
              <input type="hidden" name="intent" value="workflow_action" />
              <input type="hidden" name="actionCode" value="submit" />
              <select name="assigneeUserId" required defaultValue="">
                <option value="">选择审批人</option>
                {data.members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.display_name}
                    {member.department_name ? ` · ${member.department_name}` : ""}
                  </option>
                ))}
              </select>
              <button className="primary" disabled={busy}>提交审批</button>
            </div>
          </Form>
        )}
        {canApproveConsignment && (
          <Form method="post" className="consignment-submit-bar">
            <div>
              <strong>委托资料审批</strong>
              <span>请在本页核对委托信息、报价费用、货物明细和委托文件，确认无误后审批。</span>
            </div>
            <div>
              <input type="hidden" name="intent" value="workflow_action" />
              <input type="hidden" name="actionCode" value="approve" />
              <button className="primary" disabled={busy || !data.cargo.length}>
                审批通过
              </button>
            </div>
          </Form>
        )}
      </div>
    );
  }
  if (code === "warehouse")
    return (
      <div className="module-business-stack dense-module-stack">
        <BusinessSubsection title="仓库收货与清点" hint="本模块只负责到仓收货、实收登记和确认货齐；完成后自动进入装车与出库。">
          <div className="warehouse-module-quick-panel">
            <div className="warehouse-module-steps">
              <WarehouseSiteCard
                orderId={data.order.id}
                targetPath="/warehouse/inbound"
                marker="A"
                title="到仓收货"
                text="扫码收货，登记实收包装、件数、重量、体积、库位和异常"
                className={data.warehouseFlow?.received ? "done" : undefined}
              />
            </div>
            <div className="warehouse-module-actions">
              <WarehouseSiteButton orderId={data.order.id} targetPath="/warehouse/inbound" className="primary">
                {data.warehouseFlow?.inboundReady ? "查看收货记录" : "去收货并确认货齐"}
              </WarehouseSiteButton>
              {data.warehouseFlow?.inboundReady && <Link className="secondary" to={`/admin/orders/${data.order.id}/modules/loading#module-business-data`}>进入装车与出库</Link>}
            </div>
          </div>
          {Boolean(data.warehouseFlow?.pendingDifferenceCount) && <div className="alert warning"><strong>实收差异待确认：</strong>共 {data.warehouseFlow?.pendingDifferenceCount} 条，最大差异 {data.warehouseFlow?.maxDifferencePercent?.toFixed(1)}%。仓库可继续作业，但结算前必须确认费用影响。<Form method="post"><input type="hidden" name="intent" value="warehouse_difference_confirm"/><button className="secondary">确认差异及费用影响</button></Form></div>}
        </BusinessSubsection>
        <BusinessSubsection title="入库时间与货物状态" hint="入库时间取仓库收货登记；在库、已分配、已出库和移库记录按包装实时统计。">
          {data.warehouseFlow?.receiptCount ? (
            <>
              <div className="loading-selection-actuals">
                <article><span>入库时间</span><strong>{data.warehouseFlow.firstInboundAt ? new Date(data.warehouseFlow.firstInboundAt).toLocaleString("zh-CN",{hour12:false}) : "—"}</strong><small>{data.warehouseFlow.receiptCount} 张收货单{data.warehouseFlow.lastInboundAt && data.warehouseFlow.lastInboundAt !== data.warehouseFlow.firstInboundAt ? `，最后入库 ${new Date(data.warehouseFlow.lastInboundAt).toLocaleString("zh-CN",{hour12:false})}` : ""}</small></article>
                <article><span>在库</span><strong>{data.warehouseFlow.packageStatuses?.find(item=>item.status==="in_stock")?.package_count ?? 0}</strong><small>个包装</small></article>
                <article><span>已分配待出库</span><strong>{data.warehouseFlow.packageStatuses?.find(item=>item.status==="allocated")?.package_count ?? 0}</strong><small>个包装</small></article>
                <article><span>已出库</span><strong>{data.warehouseFlow.packageStatuses?.find(item=>item.status==="dispatched")?.package_count ?? 0}</strong><small>个包装</small></article>
                <article><span>移库记录</span><strong>{(data.warehouseFlow.packageStatuses ?? []).reduce((sum,item)=>sum+item.move_count,0)}</strong><small>次</small></article>
                {(data.warehouseFlow.packageStatuses?.some(item=>item.status==="exception")) && <article className="danger-text"><span>异常</span><strong>{data.warehouseFlow.packageStatuses?.find(item=>item.status==="exception")?.package_count ?? 0}</strong><small>个包装需处理</small></article>}
              </div>
              <p className="field-hint">货物状态由仓库端实时维护：收货后在库、分配装载指令后已分配、装车出库交接后已出库；库位调整会记入移库记录。</p>
            </>
          ) : (
            <p className="empty-state">本订单还没有仓库收货记录；到仓收货后会在这里显示入库时间和货物在库状态。</p>
          )}
        </BusinessSubsection>
        <BusinessSubsection title="当前门禁" hint="完成实收登记并确认货齐后，国内运输阶段结束。">
          <div className="module-capability-grid">
            <Capability title="到仓收货与货齐确认" text="扫描标签，登记实收数量、重量、体积、库位、货齐状态与异常备注。" href={`/warehouse/inbound?orderId=${data.order.id}&returnTo=${encodeURIComponent(`/admin/orders/${data.order.id}/modules/warehouse`)}`} />
          </div>
          {!data.warehouseFlow?.inboundReady && <p className="alert warning">国内运输尚未完成：请先完成到仓收货并确认货齐。</p>}
        </BusinessSubsection>
      </div>
    );
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
          hint="业务完成不要求所有款项已收已付；未结余额继续进入财务待办。"
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
              <strong>完成阻断</strong>
              {review.blockers.map((blocker) => (
                <Link key={blocker.code} to={blocker.href}>
                  {blocker.message} <span>查看阻断并处理 →</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="alert success">业务完成条件已满足；生成复盘后系统将按余额自动判断是否结清。</p>
          )}
        </BusinessSubsection>

        <BusinessSubsection title="时效复盘" hint="所有时间均来自对应业务模块的实际记录，不要求重复填写。">
          <div className="review-timing-grid">
            {timings.map(([label, value]) => (
              <article key={label} className={value ? "done" : "pending"}>
                <span>{label}</span>
                <strong>{reviewDate(value)}</strong>
              </article>
            ))}
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
          <div className="module-summary-cards review-summary-cards">
            <article><span>货差</span><strong>{review.exceptions.cargoDifferenceCount}</strong><small>最大 {review.exceptions.maxCargoDifferencePercent.toFixed(1)}%</small></article>
            <article><span>未关闭异常</span><strong>{review.exceptions.openWarehouseExceptionCount}</strong><small>仓库异常</small></article>
            <article><span>延误</span><strong>{review.exceptions.delayDays}</strong><small>天</small></article>
            <article><span>费用调整</span><strong>{review.exceptions.costAdjustmentCount}</strong><small>条</small></article>
          </div>
          <div className="company-profile review-people-grid">
            <Info label="业务员" value={review.people.salesperson || "—"} />
            <Info label="主操作" value={review.people.mainOperator || "—"} />
            <Info label="仓库经办" value={review.people.warehouseHandler || "—"} />
            <Info label="财务经办" value={review.people.financeHandler || "—"} />
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
        <div className="module-capability-grid">
          <Capability
            title="异常登记"
            text="支持资料、货损、短少、多货、错标、报关、配载、运输和费用异常。"
          />
          <Capability
            title="证据与责任"
            text="上传现场图片、记录严重等级、责任人和处理期限。"
          />
          <Capability
            title="冻结与解除"
            text="异常期间冻结相关业务动作，结案后解除。"
          />
          <Capability
            title="客户沟通"
            text="区分内部说明与客户可见的处理进展。"
          />
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
function CustomsDeclarationGatePanel({ gate }: { gate: ReturnType<typeof customsDeclarationGate> }) {
  const tone = gate.ready ? "done" : gate.total ? "urgent" : "";
  return <section className={`customs-action-panel ${tone}`}>
    <div className="customs-action-copy">
      <span>起运地报关门禁</span>
      <h3>{gate.ready ? "全部有效报关单已放行" : gate.total ? `还有 ${gate.pending} 张报关单待放行` : "尚未录入有效起运地报关单"}</h3>
      <p>{gate.ready ? `已放行 ${gate.released}/${gate.total} 张，可以继续校验出境门禁。` : gate.total ? `当前已放行 ${gate.released}/${gate.total} 张。所有未删单的起运地报关单都放行后，门禁才会通过。` : "新增第一张起运地报关单并完成海关放行后，系统才会开放出境门禁。"}</p>
    </div>
    <div className="customs-action-state">
      <strong>{gate.released}/{gate.total}</strong>
      <span>有效报关单已放行</span>
    </div>
  </section>;
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
    {manage && canRelease ? <Modal title={`确认海关放行 · ${declaration.declaration_number}`} triggerLabel="放行" triggerClassName="text-button" size="normal">
      <CustomsDeclarationReleaseForm declaration={declaration} busy={busy} />
    </Modal> : <button type="button" className="text-button" disabled title={declaration.status === "released" ? "该报关单已放行" : declaration.is_deleted ? "已删单的报关单不能放行" : "当前账号只读"}>放行</button>}
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

function CustomsDeclarationReleaseForm({ declaration, busy }: { declaration: CustomsDeclaration; busy: boolean }) {
  return <Form method="post" className="stack">
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
    {declaration.is_redeclared === 1 && <input type="hidden" name="isRedeclared" value="on" />}
    {declaration.is_amended === 1 && <input type="hidden" name="isAmended" value="on" />}
    {declaration.is_inspected === 1 && <input type="hidden" name="isInspected" value="on" />}
    <div className="alert warning">请确认报关单 <strong>{declaration.declaration_number}</strong> 已获得海关放行。确认后将重新计算订单的报关门禁。</div>
    <label className="field">
      <span>放行时间 <b className="required-mark">*</b></span>
      <input name="releasedAt" type="datetime-local" defaultValue={toDateTimeInput(new Date().toISOString())} required />
    </label>
    <button className="primary" disabled={busy}>确认放行</button>
  </Form>;
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
    <button className="primary span-2" disabled={busy}>{submitLabel || (isDeleted ? "保存删单状态并重算门禁" : status === "released" ? "保存并确认放行" : "保存申报单")}</button>
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
function OrderApprovalReview({order,cargo,busy}:{order:OrderSummary;cargo:Cargo[];busy:boolean}) {
  const businessTypeLabel=order.business_type === "ltl" ? "零担" : order.business_type === "ftl" ? "整车" : "待同步报价（不可后改）";
  const location=(country:string,state:string|null,city:string,address:string)=>[country,state,city,address].filter(Boolean).join(" ") || "—";
  const cargoTotals=cargo.reduce((total,item)=>({
    packages:total.packages+item.package_count,
    pieces:total.pieces+item.package_count*item.pieces_per_package,
    grossWeight:total.grossWeight+item.package_count*item.gross_weight_per_package_kg,
    volume:total.volume+item.package_count*item.volume_per_package_cbm,
  }),{packages:0,pieces:0,grossWeight:0,volume:0});
  return <div className="assignment-review-dialog">
    <section>
      <h3>订单资料</h3>
      <div className="table-wrap assignment-review-table">
        <table>
          <tbody>
            <tr><th>订单号</th><td>{order.order_number}</td><th>接单日期</th><td>{order.order_date || "—"}</td></tr>
            <tr><th>委托客户</th><td>{order.customer_name}</td><th>业务性质</th><td>{order.business_nature || "—"}</td></tr>
            <tr><th>运输方案</th><td>{businessTypeLabel}</td><th>订单状态</th><td>待审核</td></tr>
            <tr><th>发货方</th><td>{order.shipper_name || "—"}</td><th>联系人/电话</th><td>{[order.shipper_contact,order.shipper_phone].filter(Boolean).join(" / ") || "—"}</td></tr>
            <tr><th>提货地址</th><td colSpan={3}>{location(order.origin_country,order.origin_state,order.origin_city,order.origin_address)}</td></tr>
            <tr><th>收货方</th><td>{order.consignee_name || "—"}</td><th>联系人/电话</th><td>{[order.consignee_contact,order.consignee_phone].filter(Boolean).join(" / ") || "—"}</td></tr>
            <tr><th>送货地址</th><td colSpan={3}>{location(order.destination_country,order.destination_state,order.destination_city,order.destination_address)}</td></tr>
            <tr><th>要求提货日</th><td>{order.requested_pickup_date || "—"}</td><th>要求送达日</th><td>{order.requested_delivery_date || "—"}</td></tr>
            <tr><th>货好时间</th><td>{order.cargo_ready_at ? formatDateTime(order.cargo_ready_at) : "—"}</td><th>RO 代理</th><td>{order.ro_agent || "—"}</td></tr>
            <tr><th>备注</th><td colSpan={3}>{order.special_instructions || "—"}</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <section>
      <div className="assignment-review-section-head">
        <h3>货物明细</h3>
        <span>{cargoTotals.packages} 包装 · {cargoTotals.pieces} 件 · {cargoTotals.grossWeight.toFixed(3)} KG · {cargoTotals.volume.toFixed(4)} CBM</span>
      </div>
      <div className="table-wrap assignment-review-cargo-table">
        <table>
          <thead><tr><th>品名 / HS Code</th><th>包装</th><th>件数</th><th>毛重</th><th>体积</th><th>申报价值</th><th>品牌/唛头</th></tr></thead>
          <tbody>
            {cargo.map(item=><tr key={item.id}>
              <td><strong>{item.cargo_name_cn}</strong><small>{item.cargo_name_en || "—"} · {item.hs_code || "无 HS Code"}</small></td>
              <td>{item.package_type} × {item.package_count}</td>
              <td>{item.package_count*item.pieces_per_package}</td>
              <td>{(item.package_count*item.gross_weight_per_package_kg).toFixed(3)} KG</td>
              <td>{(item.package_count*item.volume_per_package_cbm).toFixed(4)} CBM</td>
              <td>{item.currency} {item.declared_value.toLocaleString()}</td>
              <td>{[item.brand_model,item.marks].filter(Boolean).join(" / ") || "—"}</td>
            </tr>)}
            {!cargo.length&&<tr><td colSpan={7} className="empty-state">暂无货物明细，不能审批。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
    <Form method="post" className="assignment-review-action">
      <input type="hidden" name="intent" value="workflow_action" />
      <input type="hidden" name="actionCode" value="approve" />
      <span>确认以上订单资料真实、完整后再执行审批。审批通过后进入负责人分配。</span>
      <button className="primary" disabled={busy || !cargo.length}>审批通过</button>
    </Form>
  </div>;
}
function Info({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <span>{label}</span>
      <strong>{value || "\u00a0"}</strong>
    </div>
  );
}
function BusinessSubsection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="module-business-section">
      <header>
        <div>
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
      </header>
      {children}
    </section>
  );
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
      <div className="loading-selection-summary">
        <span><strong>{progress}%</strong> 已完成</span>
        <span>下一步：{hasExpenses ? nextAction : "先录入费用"}</span>
      </div>
      <div className="expense-direction-steps">
        {steps.map(([label, complete]) => (
          <span className={complete ? "done" : ""} key={label}>
            <b>{complete ? "✓" : "·"}</b>{label}
          </span>
        ))}
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

function InlineLoadingWorkbench({
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
                <td><strong>{data.order.order_number}</strong></td>
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
                  <td><Link to={`/admin/orders/${item.id}`}>{item.order_number}</Link></td>
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
