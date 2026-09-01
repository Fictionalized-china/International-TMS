import { env } from "cloudflare:workers";
import {
  orderDocumentPlacements,
  preDepartureDocumentTypeCodes,
  orderDocumentTypeLabel,
} from "./order-documents";
import { customsDeclarationGate } from "./customs-declarations";
import { loadOrderModuleWorkflowFields } from "./workflow-fields.server";
import type { OrderModuleCode } from "./order-modules";

export type ReadinessResult = {
  ready: boolean;
  reasons: string[];
};

const LOAD_PLAN_GATE_MODULES = [
  "consignment",
  "cargo",
  "assignment",
  "transport",
  "warehouse",
  "loading",
] as const;

type OperationalOrder = {
  business_type: string;
  customs_enabled: number;
  warehouse_enabled: number;
  exit_port: string | null;
  overseas_warehouse_id: string | null;
};

async function operationalOrder(organizationId: string, orderId: string) {
  return env.DB.prepare(
    `SELECT o.business_type,o.exit_port,o.overseas_warehouse_id,
       CASE WHEN EXISTS(
         SELECT 1 FROM order_module_instances mi
         WHERE mi.organization_id=o.organization_id AND mi.order_id=o.id
           AND mi.module_code='customs' AND mi.enabled=1
       ) THEN 1 ELSE 0 END customs_enabled,
       CASE WHEN EXISTS(
         SELECT 1 FROM order_module_instances mi
         WHERE mi.organization_id=o.organization_id AND mi.order_id=o.id
           AND mi.module_code='warehouse' AND mi.enabled=1
       ) THEN 1 ELSE 0 END warehouse_enabled
     FROM transport_orders o
     WHERE o.organization_id=? AND o.id=?`,
  ).bind(organizationId, orderId).first<OperationalOrder>();
}

async function workflowRequirements(
  organizationId: string,
  orderId: string,
  moduleCodes: OrderModuleCode[],
) {
  const groups: Awaited<ReturnType<typeof loadOrderModuleWorkflowFields>>[] = [];
  for (const moduleCode of moduleCodes) {
    groups.push(await loadOrderModuleWorkflowFields(organizationId, orderId, moduleCode));
  }
  const fields = groups.flat();
  return (fieldKey: string, fallback = false) => {
    const field = fields.find((item) => item.fieldKey === fieldKey);
    return field ? field.isActive && field.isRequired : fallback;
  };
}

export async function checkOrderLoadPlan(
  organizationId: string,
  orderId: string,
  vehiclePlate?: string,
  transportBatchId?: string | null,
): Promise<ReadinessResult> {
  const order = await operationalOrder(organizationId, orderId);
  if (!order) return { ready: false, reasons: ["订单不存在"] };
  const required = await workflowRequirements(organizationId, orderId, [
    "consignment",
    "warehouse",
    "loading",
    "transport",
  ]);

  const reasons: string[] = [];
  const blocker = await env.DB.prepare(
    `SELECT module_name FROM order_module_instances
     WHERE organization_id=? AND order_id=? AND enabled=1 AND status IN ('blocked','exception')
       AND module_code IN (${LOAD_PLAN_GATE_MODULES.map(() => "?").join(",")})
     LIMIT 1`,
  ).bind(organizationId, orderId, ...LOAD_PLAN_GATE_MODULES).first<{ module_name: string }>();
  if (blocker) reasons.push(`${blocker.module_name}存在当前阶段阻断或异常`);

  if (order.warehouse_enabled === 1) {
    const actual = await env.DB.prepare(
      "SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=? AND s.order_id=? AND r.status='completed' AND r.cargo_complete=1 LIMIT 1",
    ).bind(organizationId, orderId).first();
    if (!actual) reasons.push("仓库尚未登记实际收货数量、重量和体积");
  }

  if (order.business_type === "pending")
    reasons.push("已接受报价尚未确定本单是整车还是拼车");
  if (!order.exit_port && required("exit_port", true))
    reasons.push("订单尚未确定出境口岸");
  if (!order.overseas_warehouse_id && required("overseas_warehouse_id", true))
    reasons.push("订单尚未确定境外目的仓");

  if (order.business_type === "ltl") {
    const plan = await env.DB.prepare(
      `SELECT b.id,
         COUNT(DISTINCT v.id) vehicle_count,
         COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.plate_number),'') IS NOT NULL AND NULLIF(TRIM(v.driver_name),'') IS NOT NULL THEN v.id END) staffed_vehicle_count,
         COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.plate_number),'') IS NOT NULL THEN v.id END) plated_vehicle_count,
         COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.driver_name),'') IS NOT NULL THEN v.id END) driver_vehicle_count,
         MAX(CASE WHEN b.carrier_id IS NOT NULL THEN 1 ELSE 0 END) carrier_ready,
         MAX(CASE WHEN b.warehouse_id IS NOT NULL THEN 1 ELSE 0 END) warehouse_ready,
         MAX(CASE WHEN b.border_port IS NOT NULL THEN 1 ELSE 0 END) port_ready,
         MAX(CASE WHEN b.planned_departure_at IS NOT NULL THEN 1 ELSE 0 END) departure_ready,
         MAX(CASE WHEN b.planned_arrival_at IS NOT NULL THEN 1 ELSE 0 END) arrival_ready,
         MAX(CASE WHEN UPPER(v.plate_number)=UPPER(?) THEN 1 ELSE 0 END) plate_match
       FROM transport_batch_orders bo
       JOIN transport_batches b ON b.id=bo.batch_id AND b.status!='cancelled'
       LEFT JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.status!='cancelled'
       WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
         AND (?='' OR b.id=?)
       GROUP BY b.id LIMIT 1`,
    ).bind(vehiclePlate || "", organizationId, orderId, transportBatchId || "", transportBatchId || "").first<{
      id: string;
      vehicle_count: number;
      staffed_vehicle_count: number;
      plated_vehicle_count: number;
      driver_vehicle_count: number;
      carrier_ready: number;
      warehouse_ready: number;
      port_ready: number;
      departure_ready: number;
      arrival_ready: number;
      plate_match: number;
    }>();
    const loadingRequired = [
      "loading_batch",
      "consolidation_warehouse",
      "main_carrier_id",
      "main_vehicle_type",
      "main_plate_number",
      "main_driver_name",
      "main_driver_phone",
      "planned_exit_at",
      "planned_arrival_at",
      "cost_allocation",
    ].some((fieldKey) => required(fieldKey));
    if (!plan && loadingRequired) reasons.push("零担订单尚未生成配载批次");
    else {
      if (!plan) return { ready: reasons.length === 0, reasons };
      const vehicleRequired = ["main_vehicle_type", "main_plate_number", "main_driver_name", "main_driver_phone"].some((fieldKey) => required(fieldKey));
      if (!plan.vehicle_count && vehicleRequired) reasons.push("配载批次尚未添加车辆");
      if (required("main_plate_number") && plan.plated_vehicle_count !== plan.vehicle_count) reasons.push("配载车辆尚未完整登记车牌");
      if (required("main_driver_name") && plan.driver_vehicle_count !== plan.vehicle_count) reasons.push("配载车辆尚未完整登记司机");
      if (required("main_carrier_id") && !plan.carrier_ready) reasons.push("配载批次尚未确定出境承运商");
      if (required("consolidation_warehouse") && !plan.warehouse_ready) reasons.push("配载批次尚未确定集货仓库");
      if (required("exit_port", true) && !plan.port_ready) reasons.push("配载批次尚未确定出境口岸");
      if (required("planned_exit_at") && !plan.departure_ready) reasons.push("配载批次尚未确定计划出境发车时间");
      if (required("planned_arrival_at") && !plan.arrival_ready) reasons.push("配载批次尚未确定计划到达时间");
      if (vehiclePlate && !plan.plate_match) reasons.push(`车牌 ${vehiclePlate} 不在当前配载计划中`);
    }
  } else if (
    order.business_type === "ftl" &&
    [
      "domestic_carrier_id",
      "domestic_vehicle_type",
      "domestic_plate_number",
      "domestic_driver_name",
      "domestic_driver_phone",
      "domestic_planned_departure_at",
      "domestic_planned_arrival_at",
    ].some((fieldKey) => required(fieldKey))
  ) {
    const assignment = await env.DB.prepare(
      `SELECT plate_number FROM order_transport_assignments
       WHERE organization_id=? AND order_id=? AND status!='cancelled'
         AND NULLIF(TRIM(plate_number),'') IS NOT NULL
       ORDER BY CASE leg_type WHEN 'main' THEN 0 ELSE 1 END,created_at DESC LIMIT 1`,
    ).bind(organizationId, orderId).first<{ plate_number: string }>();
    if (!assignment) reasons.push("整车订单尚未完成车辆运输安排");
    else if (vehiclePlate && assignment.plate_number.toUpperCase() !== vehiclePlate.toUpperCase())
      reasons.push(`车牌与运输计划不一致（计划车牌 ${assignment.plate_number}）`);
  }

  return { ready: reasons.length === 0, reasons };
}

export async function checkOrderDeparture(
  organizationId: string,
  orderId: string,
  vehiclePlate?: string,
  options?: { warehouseDispatchConfirmed?: boolean },
): Promise<ReadinessResult> {
  const order = await operationalOrder(organizationId, orderId);
  if (!order) return { ready: false, reasons: ["订单不存在"] };
  const loadPlan = await checkOrderLoadPlan(organizationId, orderId, vehiclePlate);
  const reasons = [...loadPlan.reasons];
  const documentGate = await checkOrderPreDepartureDocuments(organizationId, orderId);
  reasons.push(...documentGate.reasons);

  if (order.customs_enabled === 1) {
    const declarations = await env.DB.prepare(
      `SELECT r.clearance_stage,d.status,d.is_deleted
       FROM order_customs_declarations d
       JOIN order_customs_records r ON r.id=d.customs_record_id AND r.organization_id=d.organization_id
      WHERE d.organization_id=? AND d.order_id=?`,
    ).bind(organizationId, orderId).all<{
      clearance_stage: string;
      status: string;
      is_deleted: number;
    }>();
    const gate = customsDeclarationGate(declarations.results, "origin");
    if (gate.total === 0) reasons.push("尚未录入有效起运地报关单");
    else if (!gate.ready) reasons.push(`起运地报关尚未全部放行（已放行 ${gate.released}/${gate.total} 张）`);
  }

  if (order.warehouse_enabled === 1 && !options?.warehouseDispatchConfirmed) {
    const outbound = await env.DB.prepare(
      `SELECT 1
       FROM order_module_instances mi
       WHERE mi.organization_id=? AND mi.order_id=? AND mi.module_code='warehouse'
         AND mi.enabled=1
         AND (
           mi.status='completed'
           OR EXISTS(
             SELECT 1
             FROM warehouse_dispatches d
             JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
             JOIN warehouse_packages p ON p.id=di.package_id
             JOIN shipments s ON s.id=p.shipment_id
             WHERE d.organization_id=mi.organization_id
               AND s.order_id=mi.order_id
               AND d.status='dispatched'
           )
         )
       LIMIT 1`,
    ).bind(organizationId, orderId).first();
    if (!outbound) reasons.push("仓库尚未完成实际装车与出库交接");
  }

  return { ready: reasons.length === 0, reasons };
}

export async function checkOrderPreDepartureDocuments(
  organizationId: string,
  orderId: string,
): Promise<ReadinessResult> {
  const order = await operationalOrder(organizationId, orderId);
  if (!order) return { ready: false, reasons: ["订单不存在"] };
  const required = await workflowRequirements(organizationId, orderId, [
    "documents",
    "consignment",
    "transport",
    "customs",
  ]);
  const preDepartureModules = new Set<OrderModuleCode>(["consignment", "transport", "customs"]);
  const requiredDocuments = orderDocumentPlacements
    .filter((placement) => preDepartureDocumentTypeCodes.has(placement.documentCode))
    .filter((placement) => preDepartureModules.has(placement.moduleCode))
    .filter((placement) => placement.moduleCode !== "customs" || order.customs_enabled === 1)
    .filter((placement) => required(placement.fieldKey, placement.requiredByDefault))
    .map((placement) => placement.documentCode);
  if (!requiredDocuments.length) return { ready: true, reasons: [] };
  const approved = await env.DB.prepare(
    `SELECT DISTINCT document_category FROM order_document_metadata
     WHERE organization_id=? AND order_id=? AND review_status IN ('approved','archived')`,
  ).bind(organizationId, orderId).all<{ document_category: string }>();
  const approvedSet = new Set(approved.results.map((item) => item.document_category));
  const missing = requiredDocuments.filter((code) => !approvedSet.has(code));
  const reasons = missing.length
    ? [`发运前文件尚未审核通过：${missing.map(orderDocumentTypeLabel).join("、")}`]
    : [];
  return { ready: reasons.length === 0, reasons };
}
