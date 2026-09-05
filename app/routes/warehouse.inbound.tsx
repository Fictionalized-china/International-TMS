import { env } from "cloudflare:workers";
import { Form, Link, redirect, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/warehouse.inbound";
import {
  WarehouseReceiptResultSelector,
  WarehouseReceivingOrderStrip,
  WarehouseReceivingScanPanel,
} from "../components/WarehouseReceivingFlow";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { recordWorkflowEvent } from "../lib/business-workflow.server";
import { isValidCustomerIdentityCode } from "../lib/customer-identity";
import { nextDocumentNumber } from "../lib/documents.server";
import { recordWarehouseProgress } from "../lib/warehouse-progress.server";
import { calculateWarehouseDifference } from "../lib/warehouse-actual";
import { workflowFieldPolicy } from "../lib/workflow-field-catalog";
import { loadOrderModuleWorkflowFields } from "../lib/workflow-fields.server";
import { syncOrderWorkflowSnapshot } from "../lib/order-modules.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { canOperateWarehouseUi } from "../lib/warehouse-ui-access";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import {
  automaticallyNotifyOverseasArrival,
  confirmOverseasBatchArrival,
} from "../lib/overseas-warehouse.server";
import {
  acceptanceRequiredMarker,
  resolveWarehouseAcceptancePolicies,
} from "../lib/warehouse-acceptance-policy";
import {
  calculateWarehouseVolumeCbm,
  formatWarehouseVolumeCbm,
  synchronizeWarehouseVolumeRow,
} from "../lib/warehouse-volume";
import {
  loadWarehousePhysicalWorkflowAccess,
  warehousePhysicalWorkflowAccessSql,
} from "../lib/warehouse-workflow-access.server";
import { overseasInboundRequiresCustomsClearance } from "../lib/overseas-inbound-policy";

type Shipment = {
  id: string;
  order_id: string;
  shipment_number: string;
  status: string;
  order_number: string;
  customer_name: string;
  customer_identity_code: string;
  origin_city: string;
  destination_city: string;
  expected_warehouse_name: string | null;
  business_type: string;
  cargo_description: string | null;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
};
type ScannedPackage = {
  id: string;
  shipment_id: string;
  barcode: string;
  package_number: string;
  status: string;
  order_id: string;
  warehouse_id: string;
  source_warehouse_name: string;
  receipt_number: string | null;
  received_at: string | null;
  receipt_status: string | null;
  cargo_name: string | null;
  package_type: string | null;
  pieces: number;
  weight_kg: number | null;
  volume_cbm: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
};
type ScannedDispatch = {
  id: string;
  dispatch_number: string;
  status: string;
  package_count: number;
};
type Location = {
  id: string;
  warehouse_id: string;
  code: string;
  name: string;
  zone_name: string;
  warehouse_name: string;
  warehouse_role: string;
};
type ResolvedShipment = {
  id: string;
  status: string;
  order_id: string;
  customer_id: string;
  shipment_number: string;
  order_number: string;
  customer_identity_code: string;
  match_priority?: number;
};
type ResolvedOrder = {
  order_id: string;
  customer_id: string;
  order_number: string;
  customer_identity_code: string;
  origin_city: string;
  match_priority: number;
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const warehouseContext = await loadWarehouseContext(request, user);
  const warehouse = warehouseContext.selected;
  const isOverseasWarehouse = warehouse.warehouse_role === "overseas_destination";
  const url = new URL(request.url);
  if (!isOverseasWarehouse)
    throw redirect(`/warehouse/acceptance${url.search}`);
  const orderId = url.searchParams.get("orderId");
  const returnTo = url.searchParams.get("returnTo") || "";
  const reference = (url.searchParams.get("reference") || "").trim();
  const workflowGate = warehousePhysicalWorkflowAccessSql(
    "o",
    "overseas_warehouse",
    { userId: user.userId, positionCode: user.positionCode },
  );
  const [shipments, locations] = await Promise.all([
    env.DB.prepare(
      `SELECT s.id,s.order_id,s.shipment_number,s.status,o.order_number,c.name customer_name,c.identity_code customer_identity_code,o.origin_city,o.destination_city,
              o.business_type,o.cargo_description,o.pieces,o.gross_weight_kg,o.volume_cbm,
      ${isOverseasWarehouse
        ? `(SELECT w.name FROM warehouses w WHERE w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id)`
        : `(SELECT COALESCE(w.name,a.destination_location) FROM order_transport_assignments a
           LEFT JOIN warehouses w ON w.id=a.destination_warehouse_id
           WHERE a.organization_id=s.organization_id AND a.order_id=s.order_id
             AND a.leg_type='first_mile' AND a.status!='cancelled'
           ORDER BY a.created_at DESC LIMIT 1)`} expected_warehouse_name
      FROM shipments s JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id
      WHERE s.organization_id=?
        AND ${isOverseasWarehouse
          ? `s.status IN ('in_transit','picked_up') AND o.overseas_warehouse_id=?
             AND EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.road_status IN ('outbound_in_transit','overseas_arrived','waiting_pickup'))`
          : `s.status IN ('booked','picked_up') AND (
               EXISTS(SELECT 1 FROM order_transport_assignments a WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.leg_type='first_mile' AND a.status!='cancelled' AND a.destination_warehouse_id=?)
               OR EXISTS(SELECT 1 FROM warehouse_receipts wr WHERE wr.organization_id=o.organization_id AND wr.shipment_id=s.id AND wr.warehouse_id=?)
             )`}
        AND ${workflowGate.sql}
      ORDER BY s.updated_at DESC`,
    )
      .bind(user.organizationId, warehouse.id, ...(isOverseasWarehouse ? [] : [warehouse.id]), ...workflowGate.values)
      .all<Shipment>(),
    env.DB.prepare(
      `SELECT l.id,l.warehouse_id,l.code,l.name,z.name zone_name,w.name warehouse_name,w.warehouse_role FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouses w ON w.id=l.warehouse_id WHERE l.organization_id=? AND l.warehouse_id=? AND l.status='active' AND z.status='active' AND w.status='active' ORDER BY z.code,l.code`,
    )
      .bind(user.organizationId, warehouse.id)
      .all<Location>(),
  ]);
  const directlyScannedPackage = reference
    ? await env.DB.prepare(
        `SELECT p.id,p.shipment_id,o.id order_id,p.barcode,p.package_number,p.status,p.warehouse_id,
                w.name source_warehouse_name,
                COALESCE(NULLIF(TRIM(i.cargo_name_cn),''),NULLIF(TRIM(o.cargo_description),'')) cargo_name,
                 COALESCE(r.package_type,i.package_type) package_type,
                 r.receipt_number,r.received_at,r.status receipt_status,
                p.pieces,p.weight_kg,p.volume_cbm,p.length_cm,p.width_cm,p.height_cm
           FROM warehouse_packages p
           JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
           JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
           JOIN warehouses w ON w.id=p.warehouse_id AND w.organization_id=p.organization_id
           LEFT JOIN warehouse_receipts r ON r.id=p.receipt_id AND r.organization_id=p.organization_id
           LEFT JOIN order_cargo_items i ON i.id=p.cargo_item_id AND i.organization_id=p.organization_id
          WHERE p.organization_id=?
            AND (UPPER(p.barcode)=UPPER(?) OR UPPER(p.package_number)=UPPER(?))
          ORDER BY CASE WHEN UPPER(p.barcode)=UPPER(?) THEN 1 ELSE 2 END
          LIMIT 1`,
      )
        .bind(user.organizationId, reference, reference, reference)
        .first<ScannedPackage>()
    : null;
  const scannedDispatch = reference && !directlyScannedPackage
    ? await env.DB.prepare(
        `SELECT d.id,d.dispatch_number,d.status,COUNT(di.id) package_count
           FROM warehouse_dispatches d
           LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
          WHERE d.organization_id=? AND UPPER(d.dispatch_number)=UPPER(?)
          GROUP BY d.id
          LIMIT 1`,
      )
        .bind(user.organizationId, reference)
        .first<ScannedDispatch>()
    : null;
  const dispatchPackage = scannedDispatch?.package_count === 1
    ? await env.DB.prepare(
        `SELECT p.id,p.shipment_id,o.id order_id,p.barcode,p.package_number,p.status,p.warehouse_id,
                w.name source_warehouse_name,
                COALESCE(NULLIF(TRIM(i.cargo_name_cn),''),NULLIF(TRIM(o.cargo_description),'')) cargo_name,
                 COALESCE(r.package_type,i.package_type) package_type,
                 r.receipt_number,r.received_at,r.status receipt_status,
                p.pieces,p.weight_kg,p.volume_cbm,p.length_cm,p.width_cm,p.height_cm
           FROM warehouse_dispatch_items di
           JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
           JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
           JOIN transport_orders o ON o.id=s.order_id AND o.organization_id=s.organization_id
           JOIN warehouses w ON w.id=p.warehouse_id AND w.organization_id=p.organization_id
           LEFT JOIN warehouse_receipts r ON r.id=p.receipt_id AND r.organization_id=p.organization_id
           LEFT JOIN order_cargo_items i ON i.id=p.cargo_item_id AND i.organization_id=p.organization_id
          WHERE di.organization_id=? AND di.dispatch_id=?
          LIMIT 1`,
      )
        .bind(user.organizationId, scannedDispatch.id)
        .first<ScannedPackage>()
    : null;
  const scannedPackage = directlyScannedPackage ?? dispatchPackage;
  const packageReady = Boolean(
    scannedPackage &&
      scannedPackage.status === "dispatched" &&
      scannedPackage.warehouse_id !== warehouse.id,
  );
  const selectedShipment = packageReady
    ? shipments.results.find((item) => item.id === scannedPackage?.shipment_id)
    : undefined;
  let lookupError = "";
  const scannedPackageWorkflowAccess = reference && scannedPackage && packageReady && !selectedShipment
    ? await loadWarehousePhysicalWorkflowAccess(
        env.DB,
        user.organizationId,
        scannedPackage.order_id,
        "overseas_warehouse",
        { userId: user.userId, positionCode: user.positionCode },
      )
    : null;
  if (reference && scannedDispatch && scannedDispatch.status !== "dispatched")
    lookupError = `装车任务 ${scannedDispatch.dispatch_number} 尚未完成出库交接，暂不能办理境外目的仓收货`;
  else if (reference && scannedDispatch && scannedDispatch.package_count > 1)
    lookupError = `装车任务 ${scannedDispatch.dispatch_number} 包含 ${scannedDispatch.package_count} 个货物标签，请逐件扫描货物标签入库`;
  else if (reference && scannedPackage?.warehouse_id === warehouse.id && scannedPackage.receipt_status === "completed")
    lookupError = `货物标签 ${scannedPackage.barcode} 已于${scannedPackage.received_at ? ` ${new Date(scannedPackage.received_at).toLocaleString("zh-CN")}` : ""}通过入库单 ${scannedPackage.receipt_number || "—"} 在“${warehouse.name}”完成入库，请勿重复扫描`;
  else if (reference && scannedPackage?.warehouse_id === warehouse.id)
    lookupError = `货物标签 ${scannedPackage.barcode} 已归属“${warehouse.name}”，但未找到已完成入库单，请联系管理员检查仓库数据`;
  else if (reference && scannedPackage && scannedPackage.status !== "dispatched")
    lookupError = `货物标签 ${scannedPackage.barcode} 尚未完成上一仓库出库，暂不能办理境外目的仓收货`;
  else if (reference && scannedPackageWorkflowAccess && !scannedPackageWorkflowAccess.available)
    lookupError = scannedPackageWorkflowAccess.reason || "当前订单的冻结工作流尚未开放境外仓入库";
  else if (reference && scannedPackage && !selectedShipment)
    lookupError = `货物标签 ${scannedPackage.barcode} 不属于当前目的仓，或对应运输单尚未进入可收货阶段`;
  else if (reference && !scannedPackage)
    lookupError = `未找到国内仓生成的货物标签或装车任务：${reference}`;
  const workflowFields = selectedShipment
    ? await loadOrderModuleWorkflowFields(
        user.organizationId,
        selectedShipment.order_id,
        isOverseasWarehouse ? "overseas_warehouse" : "warehouse",
      )
    : [];
  return {
    user,
    warehouse,
    warehouseAccessLevel: warehouseContext.selectedAccessLevel,
    isOverseasWarehouse,
    locations: locations.results,
    orderId,
    returnTo,
    reference,
    selectedShipment,
    scannedPackage: selectedShipment ? scannedPackage : null,
    lookupError,
    workflowFields,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(
      request,
      "warehouse.operate",
      "warehouse",
    );
  const warehouseContext = await loadWarehouseContext(request, user);
  const selectedWarehouse = warehouseContext.selected;
  await requireWarehouseAssignment(user, selectedWarehouse.id, "operator");
  const isOverseasWarehouse = selectedWarehouse.warehouse_role === "overseas_destination";
  if (!isOverseasWarehouse)
    throw redirect(`/warehouse/acceptance${new URL(request.url).search}`);
  const form = await request.formData(),
    shipmentId = valueOf(form, "shipmentId"),
    shipmentReference = valueOf(form, "shipmentReference").trim(),
    customerIdentityCode = valueOf(form, "customerIdentityCode")
      .trim()
      .toUpperCase(),
    locationId = valueOf(form, "locationId"),
    rawBarcode = valueOf(form, "barcode").toUpperCase(),
    packageType = valueOf(form, "packageType"),
    evidenceNote = valueOf(form, "evidenceNote"),
    notes = valueOf(form, "notes"),
    receiptResult = valueOf(form, "receiptResult"),
    cargoComplete = receiptResult === "ready",
    hasException = receiptResult === "exception",
    exceptionNotes = valueOf(form, "exceptionNotes").trim(),
    now = new Date().toISOString();
  const submittedPieces = positiveInt(form, "pieces");
  const pieces = submittedPieces ?? 1,
    weight = positive(form, "weight"),
    length = positive(form, "length"),
    width = positive(form, "width"),
    height = positive(form, "height");
  if (!["ready", "exception"].includes(receiptResult))
    return { formError: "请先选择本次收货结果（货齐/异常）。" };
  if (hasException && !exceptionNotes)
    return { formError: "勾选异常后必须填写异常说明" };
  if (!shipmentId && !shipmentReference)
    return { formError: "请输入订单号、运单号或从列表选择待收货运单" };
  if (
    customerIdentityCode &&
    !isValidCustomerIdentityCode(customerIdentityCode)
  )
    return {
      formError: "客户识别码应为5位字母与数字混合，且不包含 O、0、1、L",
    };
  let shipment: ResolvedShipment | null = null;
  let pendingOrder: ResolvedOrder | null = null;
  if (shipmentReference) {
    const shipmentScope = isOverseasWarehouse
      ? `s.status IN ('in_transit','picked_up') AND o.overseas_warehouse_id=?
         AND EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.road_status IN ('outbound_in_transit','overseas_arrived','waiting_pickup'))`
      : `s.status IN ('booked','picked_up') AND (
           EXISTS(SELECT 1 FROM order_transport_assignments a WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.leg_type='first_mile' AND a.status!='cancelled' AND a.destination_warehouse_id=?)
           OR EXISTS(SELECT 1 FROM warehouse_receipts wr WHERE wr.organization_id=o.organization_id AND wr.shipment_id=s.id AND wr.warehouse_id=?)
         )`;
    const matches = await env.DB.prepare(
      `SELECT s.id,s.status,s.order_id,s.customer_id,s.shipment_number,o.order_number,c.identity_code customer_identity_code,
          CASE WHEN UPPER(s.shipment_number)=UPPER(?) THEN 1 WHEN UPPER(o.order_number)=UPPER(?) THEN 2 ELSE 3 END match_priority
        FROM shipments s JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id
        WHERE s.organization_id=? AND ${shipmentScope}
          AND (?='' OR UPPER(c.identity_code)=UPPER(?))
          AND (UPPER(s.shipment_number)=UPPER(?) OR UPPER(o.order_number)=UPPER(?) OR EXISTS(
            SELECT 1 FROM order_waybills w
            WHERE w.organization_id=s.organization_id AND w.order_id=s.order_id
              AND UPPER(w.waybill_number)=UPPER(?)
          ))
        ORDER BY match_priority,s.updated_at DESC LIMIT 2`,
    )
      .bind(
        shipmentReference,
        shipmentReference,
        user.organizationId,
        selectedWarehouse.id,
        ...(isOverseasWarehouse ? [] : [selectedWarehouse.id]),
        customerIdentityCode,
        customerIdentityCode,
        shipmentReference,
        shipmentReference,
        shipmentReference,
      )
      .all<ResolvedShipment>();
    if (
      matches.results.length > 1 &&
      matches.results[0].match_priority === matches.results[1].match_priority
    )
      return {
        formError: "订单号关联多个可收货运单，请从待收货运单列表选择具体运单",
      };
    shipment = matches.results[0] ?? null;
    if (!shipment && !isOverseasWarehouse) {
      const orders = await env.DB.prepare(
        `SELECT o.id order_id,o.customer_id,o.order_number,c.identity_code customer_identity_code,o.origin_city,
          CASE WHEN UPPER(o.order_number)=UPPER(?) THEN 1 ELSE 2 END match_priority
        FROM transport_orders o JOIN customers c ON c.id=o.customer_id
        WHERE o.organization_id=? AND o.status IN ('confirmed','in_execution')
          AND (?='' OR UPPER(c.identity_code)=UPPER(?))
          AND NOT EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=o.id)
          AND EXISTS(SELECT 1 FROM order_transport_assignments a WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.leg_type='first_mile' AND a.status!='cancelled' AND a.destination_warehouse_id=?)
          AND (UPPER(o.order_number)=UPPER(?) OR EXISTS(
            SELECT 1 FROM order_waybills w
            WHERE w.organization_id=o.organization_id AND w.order_id=o.id
              AND UPPER(w.waybill_number)=UPPER(?)
          ))
          AND (
            NOT EXISTS(SELECT 1 FROM order_module_instances mi WHERE mi.organization_id=o.organization_id AND mi.order_id=o.id)
            OR EXISTS(SELECT 1 FROM order_module_instances mi WHERE mi.organization_id=o.organization_id AND mi.order_id=o.id AND mi.module_code='warehouse' AND mi.enabled=1)
          )
        ORDER BY match_priority,o.updated_at DESC LIMIT 2`,
      )
        .bind(
          shipmentReference,
          user.organizationId,
          customerIdentityCode,
          customerIdentityCode,
          selectedWarehouse.id,
          shipmentReference,
          shipmentReference,
        )
        .all<ResolvedOrder>();
      if (
        orders.results.length > 1 &&
        orders.results[0].match_priority === orders.results[1].match_priority
      )
        return {
          formError: "该业务运单号关联多个订单，请输入系统订单号完成收货",
        };
      pendingOrder = orders.results[0] ?? null;
    }
  } else {
    const directScope = isOverseasWarehouse
      ? `s.status IN ('in_transit','picked_up') AND o.overseas_warehouse_id=?
         AND EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.road_status IN ('outbound_in_transit','overseas_arrived','waiting_pickup'))`
      : `s.status IN ('booked','picked_up') AND (
           EXISTS(SELECT 1 FROM order_transport_assignments a WHERE a.organization_id=o.organization_id AND a.order_id=o.id AND a.leg_type='first_mile' AND a.status!='cancelled' AND a.destination_warehouse_id=?)
           OR EXISTS(SELECT 1 FROM warehouse_receipts wr WHERE wr.organization_id=o.organization_id AND wr.shipment_id=s.id AND wr.warehouse_id=?)
         )`;
    shipment = await env.DB.prepare(
      `SELECT s.id,s.status,s.order_id,s.customer_id,s.shipment_number,o.order_number,c.identity_code customer_identity_code FROM shipments s JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id WHERE s.id=? AND s.organization_id=? AND ${directScope} AND (?='' OR UPPER(c.identity_code)=UPPER(?))`,
    )
      .bind(
        shipmentId,
        user.organizationId,
        selectedWarehouse.id,
        ...(isOverseasWarehouse ? [] : [selectedWarehouse.id]),
        customerIdentityCode,
        customerIdentityCode,
      )
      .first<ResolvedShipment>();
  }
  if (!shipment && !pendingOrder)
    return {
      formError: shipmentReference
        ? `未找到可收货的订单或运单：${shipmentReference}${customerIdentityCode ? `（客户 ${customerIdentityCode}）` : ""}`
        : "请选择可收货的运单，并核对客户识别码",
    };
  const orderId = shipment?.order_id ?? pendingOrder?.order_id;
  if (!orderId) return { formError: "无法识别收货订单，请重新选择订单或运单" };
  const workflowAccess = await loadWarehousePhysicalWorkflowAccess(
    env.DB,
    user.organizationId,
    orderId,
    "overseas_warehouse",
    { userId: user.userId, positionCode: user.positionCode },
  );
  if (!workflowAccess.available)
    return { formError: workflowAccess.reason || "当前订单的冻结工作流尚未开放境外仓入库" };

  if (isOverseasWarehouse) {
    const overseasGate = await env.DB.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.road_status IN ('outbound_in_transit','overseas_arrived','waiting_pickup')) exited,
         EXISTS(SELECT 1 FROM order_tracking_milestones m WHERE m.organization_id=o.organization_id AND m.order_id=o.id AND m.milestone_code='customs_cleared') customs_cleared,
         o.customs_clearance_mode
       FROM transport_orders o
       WHERE o.organization_id=? AND o.id=? AND o.overseas_warehouse_id=?`,
    ).bind(user.organizationId, orderId, selectedWarehouse.id).first<{ exited: number; customs_cleared: number; customs_clearance_mode:"company"|"customer" }>();
    if (!overseasGate)
      return { formError: `该订单的境外目的仓不是“${selectedWarehouse.name}”，请切换到正确仓库` };
    if (!overseasGate.exited)
      return { formError: "该订单尚未登记实际出境，不能办理境外目的仓入库" };
    const customsClearanceRequired = await requiresOrderCustomsClearanceForOverseasInbound(
      user.organizationId,
      orderId,
      overseasGate.customs_clearance_mode,
    );
    if (customsClearanceRequired && !overseasGate.customs_cleared)
      return { formError: "该订单由公司代办清关，尚未完成目的地清关，不能办理境外目的仓入库" };
  }
  const workflowFields = await loadOrderModuleWorkflowFields(
    user.organizationId,
    orderId,
    isOverseasWarehouse ? "overseas_warehouse" : "warehouse",
  );
  const acceptancePolicies = resolveWarehouseAcceptancePolicies(workflowFields);
  const locationPolicy = acceptancePolicies.location;
  const packageTypePolicy = workflowFieldPolicy(
    workflowFields,
    "actual_package_type",
    "required",
  );
  const piecesPolicy = acceptancePolicies.actualPieces;
  const weightPolicy = acceptancePolicies.actualWeight;
  const volumePolicy = acceptancePolicies.actualVolume;
  const evidencePolicy = acceptancePolicies.evidence;
  const notesPolicy = acceptancePolicies.notes;
  let effectiveLocationId = locationId;
  if (!effectiveLocationId && (!locationPolicy.isActive || !locationPolicy.isRequired)) {
    const defaultLocation = await env.DB.prepare(
      `SELECT l.id FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id JOIN warehouse_zones z ON z.id=l.zone_id WHERE l.organization_id=? AND l.warehouse_id=? AND l.status='active' AND w.status='active' AND z.status='active' ORDER BY z.code,l.code LIMIT 1`,
    )
      .bind(user.organizationId, selectedWarehouse.id)
      .first<{ id: string }>();
    effectiveLocationId = defaultLocation?.id ?? "";
  }
  const location = await env.DB.prepare(
    `SELECT l.id,l.warehouse_id,l.name,l.code,w.name warehouse_name,w.warehouse_role,z.name zone_name FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id JOIN warehouse_zones z ON z.id=l.zone_id WHERE l.id=? AND l.organization_id=? AND l.warehouse_id=? AND l.status='active' AND w.status='active' AND z.status='active'`,
  )
    .bind(effectiveLocationId, user.organizationId, selectedWarehouse.id)
    .first<{
      id: string;
      warehouse_id: string;
      name: string;
      code: string;
      warehouse_name: string;
      warehouse_role: string;
      zone_name: string;
    }>();
  if (!location)
    return {
      formError: locationPolicy.isActive
        ? "请选择有效的收货库位"
        : "当前没有可自动使用的收货库位，请先配置仓库与库位",
    };
  if (
    packageTypePolicy.isActive &&
    packageTypePolicy.isRequired &&
    !packageType
  )
    return { formError: "请选择实际包装类型" };
  if (piecesPolicy.isActive && piecesPolicy.isRequired && submittedPieces == null)
    return { formError: "请填写实收件数" };
  if (weightPolicy.isActive && weightPolicy.isRequired && weight == null)
    return { formError: "请填写实收重量" };
  if (length == null || width == null || height == null)
    return { formError: "请填写货物实际长、宽、高" };
  const volume = volumePolicy.isActive
    ? calculateWarehouseVolumeCbm({ lengthCm: length, widthCm: width, heightCm: height })
    : null;
  if (volumePolicy.isActive && volumePolicy.isRequired && volume == null)
    return { formError: "系统无法根据实际长、宽、高计算实测体积" };
  if (
    evidencePolicy.isActive &&
    evidencePolicy.isRequired &&
    !evidenceNote.trim()
  )
    return { formError: "请填写收货凭证或现场凭证索引" };
  if (notesPolicy.isActive && notesPolicy.isRequired && !notes.trim())
    return { formError: "请填写收货备注" };
  const shipmentBootstrap: D1PreparedStatement[] = [];
  let createdShipmentNumber: string | null = null;
  if (!shipment && pendingOrder) {
    const id = crypto.randomUUID(),
      number = await nextDocumentNumber(user.organizationId, "shipment");
    shipment = {
      id,
      status: "booked",
      order_id: pendingOrder.order_id,
      customer_id: pendingOrder.customer_id,
      shipment_number: number,
      order_number: pendingOrder.order_number,
      customer_identity_code: pendingOrder.customer_identity_code,
    };
    createdShipmentNumber = number;
    shipmentBootstrap.push(
      env.DB.prepare(
        "INSERT INTO shipments (id,organization_id,shipment_number,order_id,customer_id,current_location,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        user.organizationId,
        number,
        pendingOrder.order_id,
        pendingOrder.customer_id,
        pendingOrder.origin_city,
        now,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO shipment_events (id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at) VALUES (?,?,'booked',?,'仓库按订单收货，系统已自动生成运单',?,1,?,?)",
      ).bind(
        crypto.randomUUID(),
        id,
        pendingOrder.origin_city,
        now,
        user.userId,
        now,
      ),
      env.DB.prepare(
        "UPDATE transport_orders SET status='in_execution',updated_at=? WHERE id=? AND organization_id=? AND status='confirmed'",
      ).bind(now, pendingOrder.order_id, user.organizationId),
    );
  }
  if (!shipment) return { formError: "订单暂时无法生成收货运单，请刷新后重试" };
  const [planned, received] = await Promise.all([
    env.DB.prepare(
      "SELECT pieces,gross_weight_kg,volume_cbm FROM transport_orders WHERE id=? AND organization_id=?",
    )
      .bind(shipment.order_id, user.organizationId)
      .first<{ pieces: number; gross_weight_kg: number; volume_cbm: number }>(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(total_pieces),0) pieces,COALESCE(SUM(total_weight_kg),0) weight_kg,COALESCE(SUM(total_volume_cbm),0) volume_cbm FROM warehouse_receipts WHERE shipment_id=? AND organization_id=? AND warehouse_id=? AND status='completed'",
    )
      .bind(shipment.id, user.organizationId, selectedWarehouse.id)
      .first<{ pieces: number; weight_kg: number; volume_cbm: number }>(),
  ]);
  const actual = {
    pieces: (received?.pieces ?? 0) + pieces,
    weightKg: (received?.weight_kg ?? 0) + (weight ?? 0),
    volumeCbm: (received?.volume_cbm ?? 0) + (volume ?? 0),
  };
  const plannedActual = {
    pieces: planned?.pieces ?? 0,
    weightKg: planned?.gross_weight_kg ?? 0,
    volumeCbm: planned?.volume_cbm ?? 0,
  };
  const difference = calculateWarehouseDifference(plannedActual, actual);
  if (isOverseasWarehouse && !rawBarcode)
    return { formError: "境外目的仓必须扫描国内仓生成的货物标签，不能重新生成标签" };
  const barcode = rawBarcode || generateCode("OUL"),
    receiptNumber = generateCode("IN");
  if (!/^[A-Z0-9-]{4,40}$/.test(barcode))
    return { formError: "标签条码只能使用大写字母、数字和横线，长度 4-40 位" };
  const existingPackage = await env.DB.prepare(
    "SELECT id,shipment_id,warehouse_id,location_id,package_number,status FROM warehouse_packages WHERE organization_id=? AND barcode=?",
  )
    .bind(user.organizationId, barcode)
    .first<{
      id: string;
      shipment_id: string;
      warehouse_id: string;
      location_id: string;
      package_number: string;
      status: string;
    }>();
  if (existingPackage && !isOverseasWarehouse)
    return { formError: `条码 ${barcode} 已经入库，请勿重复扫描` };
  if (isOverseasWarehouse && !existingPackage)
    return { formError: `未找到国内仓生成的货物标签 ${barcode}，请核对标签或先完成国内仓入库与出库` };
  if (existingPackage && existingPackage.shipment_id !== shipment.id)
    return { formError: `条码 ${barcode} 不属于当前订单或运单，不能入库` };
  if (existingPackage && existingPackage.warehouse_id === selectedWarehouse.id)
    return { formError: `条码 ${barcode} 已经在 ${selectedWarehouse.name} 入库，请勿重复扫描` };
  if (existingPackage && existingPackage.status !== "dispatched")
    return { formError: `条码 ${barcode} 尚未完成上一仓库出库，不能办理境外目的仓入库` };
  const receiptId = crypto.randomUUID(),
    packageId = existingPackage?.id ?? crypto.randomUUID(),
    packageNumber = existingPackage?.package_number ?? generateCode("PKG"),
    operationId = crypto.randomUUID(),
    eventId = crypto.randomUUID(),
    locationText = `${location.warehouse_name} / ${location.zone_name} / ${location.name} (${location.code})`;
  const packageStatements = existingPackage
    ? [
        env.DB.prepare(
          `UPDATE warehouse_packages SET receipt_id=?,warehouse_id=?,location_id=?,pieces=?,weight_kg=?,volume_cbm=?,length_cm=?,width_cm=?,height_cm=?,status='in_stock',notes=?,updated_at=? WHERE id=? AND organization_id=?`,
        ).bind(
          receiptId,
          location.warehouse_id,
          location.id,
          pieces,
          weight,
          volume,
          length,
          width,
          height,
          notes || null,
          now,
          existingPackage.id,
          user.organizationId,
        ),
        env.DB.prepare(
          `INSERT INTO warehouse_package_movements(id,organization_id,package_id,operation_type,from_location_id,to_location_id,operator_user_id,notes,occurred_at,created_at) VALUES(?,?,?,'inbound',?,?,?,?,?,?)`,
        ).bind(
          crypto.randomUUID(),
          user.organizationId,
          existingPackage.id,
          existingPackage.location_id,
          location.id,
          user.userId,
          notes || "境外目的仓扫码入库",
          now,
          now,
        ),
      ]
    : [
        env.DB.prepare(
          `INSERT INTO warehouse_packages(id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,pieces,weight_kg,volume_cbm,length_cm,width_cm,height_cm,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'in_stock',?,?,?)`,
        ).bind(
          packageId,
          user.organizationId,
          receiptId,
          shipment.id,
          location.warehouse_id,
          location.id,
          barcode,
          packageNumber,
          pieces,
          weight,
          volume,
          length,
          width,
          height,
          notes || null,
          now,
          now,
        ),
      ];
  try {
    await env.DB.batch([
      ...shipmentBootstrap,
      env.DB.prepare(
        `INSERT INTO warehouse_receipts(id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,status,total_packages,total_pieces,total_weight_kg,total_volume_cbm,notes,received_by_user_id,received_at,created_at,updated_at,package_type,evidence_note,cargo_complete,has_exception,exception_notes) VALUES(?,?,?,?,?,?,'completed',1,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        receiptId,
        user.organizationId,
        receiptNumber,
        shipment.id,
        location.warehouse_id,
        location.id,
        piecesPolicy.isActive ? pieces : 1,
        weightPolicy.isActive ? (weight ?? 0) : 0,
        volumePolicy.isActive ? (volume ?? 0) : 0,
        workflowFieldPolicy(
          workflowFields,
          "warehouse_receipt_notes",
          "optional",
        ).isActive
          ? notes || null
          : null,
        user.userId,
        now,
        now,
        now,
        packageTypePolicy.isActive ? packageType || null : null,
        evidencePolicy.isActive ? evidenceNote || null : null,
        cargoComplete ? 1 : 0,
        hasException ? 1 : 0,
        exceptionNotes || null,
      ),
      ...packageStatements,
      env.DB.prepare(
        `INSERT INTO warehouse_operations(id,organization_id,shipment_id,operation_type,location,measured_pieces,measured_weight_kg,measured_volume_cbm,notes,operator_user_id,occurred_at,created_at,warehouse_location_id) VALUES(?,?,?,'receive',?,?,?,?,?,?,?,?,?)`,
      ).bind(
        operationId,
        user.organizationId,
        shipment.id,
        locationText,
        pieces,
        weight,
        volume,
        notes || null,
        user.userId,
        now,
        now,
        location.id,
      ),
      ...(isOverseasWarehouse
        ? []
        : [
            env.DB.prepare(
              `INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at) VALUES(?,?,'picked_up',?,'货物已扫码收货并入库',?,1,?,?)`,
            ).bind(eventId, shipment.id, locationText, now, user.userId, now),
            env.DB.prepare(
              "UPDATE shipments SET status='picked_up',current_location=?,actual_pickup_at=COALESCE(actual_pickup_at,?),updated_at=? WHERE id=? AND organization_id=?",
            ).bind(locationText, now, now, shipment.id, user.organizationId),
          ]),
      ...(difference.hasDifference
        ? [
            env.DB.prepare(
              `INSERT INTO warehouse_receipt_differences(id,organization_id,receipt_id,order_id,planned_pieces,planned_weight_kg,planned_volume_cbm,actual_pieces,actual_weight_kg,actual_volume_cbm,max_difference_percent,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
            ).bind(
              crypto.randomUUID(),
              user.organizationId,
              receiptId,
              shipment.order_id,
              plannedActual.pieces,
              plannedActual.weightKg,
              plannedActual.volumeCbm,
              actual.pieces,
              actual.weightKg,
              actual.volumeCbm,
              difference.maxPercent,
              notes || null,
              now,
              now,
            ),
            env.DB.prepare(
              `INSERT INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,priority,status,assignee_user_id,assigned_by_user_id,created_at,updated_at) VALUES(?,?,?,'warehouse','warehouse_difference',?,?,'pending',NULL,?,?,?)`,
            ).bind(
              crypto.randomUUID(),
              user.organizationId,
              shipment.order_id,
              `确认仓库实收差异 · ${receiptNumber}`,
              difference.requiresFeeConfirmation ? "high" : "normal",
              user.userId,
              now,
              now,
            ),
          ]
        : []),
    ]);
  } catch (error) {
    console.error("warehouse inbound failed", error);
    return {
      formError: "收货失败，未写入仓库数据，请核对订单、库位和标签后重试",
    };
  }
  if (cargoComplete && !isOverseasWarehouse) {
    await ensureVerifiedReceivingBatch({
      organizationId: user.organizationId,
      shipmentId: shipment.id,
      locationId: location.id,
      actorUserId: user.userId,
      now,
    });
  }
  if (!isOverseasWarehouse) {
    await recordWarehouseProgress({
      organizationId: user.organizationId,
      orderId: shipment.order_id,
      actorUserId: user.userId,
      stepCode: cargoComplete ? "ready" : "receiving",
      stepName: cargoComplete ? "货齐，等待装车/配载" : "累计收货中",
      actionCode: "receipt_complete",
      actionName: cargoComplete ? "确认货齐" : "仓库累计收货",
      notes: `入库单 ${receiptNumber}；货物标签 ${barcode}${hasException ? `；异常：${exceptionNotes}` : ""}`,
    });
  }
  if (cargoComplete && !isOverseasWarehouse) {
    const transportModule = await env.DB.prepare(
      "SELECT id,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='transport' AND enabled=1",
    )
      .bind(user.organizationId, shipment.order_id)
      .first<{ id: string; current_step_code: string | null }>();
    const assignment = await env.DB.prepare(
      "SELECT id FROM order_transport_assignments WHERE organization_id=? AND order_id=? AND leg_type='first_mile' AND status!='cancelled' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(user.organizationId, shipment.order_id)
      .first<{ id: string }>();
    const completionStatements: D1PreparedStatement[] = [
      env.DB.prepare(
        "UPDATE order_transport_assignments SET status='arrived',actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE organization_id=? AND order_id=? AND leg_type='first_mile' AND status!='cancelled'",
      ).bind(now, now, user.organizationId, shipment.order_id),
      env.DB.prepare(
        "UPDATE shipments SET actual_delivery_at=COALESCE(actual_delivery_at,?),updated_at=? WHERE id=? AND organization_id=?",
      ).bind(now, now, shipment.id, user.organizationId),
    ];
    if (assignment?.id)
      completionStatements.push(
        env.DB.prepare(
          "UPDATE domestic_waybill_vehicles SET status='arrived',actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE organization_id=? AND assignment_id=?",
        ).bind(now, now, user.organizationId, assignment.id),
      );
    if (transportModule?.id) {
      completionStatements.push(
        env.DB.prepare(
          "UPDATE order_module_instances SET status='completed',current_step_code='warehouse_arrived',current_step_name='货物已到国内仓',progress_percent=100,completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=? WHERE id=?",
        ).bind(now, now, transportModule.id),
        env.DB.prepare(
          "INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          user.organizationId,
          shipment.order_id,
          transportModule.id,
          "warehouse_cargo_complete",
          "仓库确认货齐",
          transportModule.current_step_code,
          "warehouse_arrived",
          "货物已到国内仓",
          user.userId,
          `入库单 ${receiptNumber} 已确认货齐`,
          now,
        ),
      );
    }
    await env.DB.batch(completionStatements);
    await syncOrderWorkflowSnapshot(user.organizationId, shipment.order_id);
  }
  let overseasArrival: OverseasReceivingResult | null = null;
  let overseasArrivalWarning: string | null = null;
  if (cargoComplete && isOverseasWarehouse) {
    try {
      overseasArrival = await finalizeOverseasReceiving({
        organizationId: user.organizationId,
        orderId: shipment.order_id,
        actorUserId: user.userId,
        actualArrivalAt: now,
        notes: notes || `境外仓入库单 ${receiptNumber} 已清点货齐`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "境外到仓状态同步失败";
      overseasArrivalWarning = `本票已在 ${selectedWarehouse.name} 入库并完成清点，但批次暂未结束：${message}`;
    }
  }
  if (createdShipmentNumber)
    await recordWorkflowEvent({
      organizationId: user.organizationId,
      event: "shipment.created",
      customerId: shipment.customer_id,
      orderId: shipment.order_id,
      shipmentId: shipment.id,
      actorUserId: user.userId,
      source: "admin",
      metadata: {
        number: createdShipmentNumber,
        createdFromOrder: true,
        warehouse: true,
      },
    });
  if (!isOverseasWarehouse)
    await recordWorkflowEvent({
      organizationId: user.organizationId,
      event: "shipment.picked_up",
      customerId: shipment.customer_id,
      orderId: shipment.order_id,
      shipmentId: shipment.id,
      actorUserId: user.userId,
      source: "admin",
      metadata: { warehouse: true, receiptNumber, barcode, locationId },
    });
  await writeAudit({
    request,
    action: isOverseasWarehouse ? "warehouse.overseas.receive" : "warehouse.inbound.receive",
    resourceType: "warehouse_package",
    resourceId: packageId,
    organizationId: user.organizationId,
    actorUserId: user.userId,
    metadata: {
      receiptNumber,
      barcode,
      shipmentId: shipment.id,
      shipmentNumber: shipment.shipment_number,
      orderNumber: shipment.order_number,
      customerIdentityCode: shipment.customer_identity_code,
      locationId,
      pieces,
      weight,
      volume,
    },
  });
  const differenceMessage = difference.hasDifference
    ? `；实收与预录最大差异 ${difference.maxPercent.toFixed(1)}%，已生成确认待办${difference.requiresFeeConfirmation ? "，结算前须确认费用影响" : ""}`
    : "；实收与预录一致";
  if (overseasArrivalWarning)
    return { success: overseasArrivalWarning, barcode };
  if (overseasArrival?.completed)
    return {
      success: `境外目的仓收货完成：${barcode}；${overseasArrival.batchNumber} 全部订单已清点，境外运输已结束${overseasArrival.warning ? `；${overseasArrival.warning}` : "并已自动通知客户"}`,
      barcode,
    };
  if (overseasArrival)
    return {
      success: `境外目的仓收货完成：${barcode}；本票已清点，${overseasArrival.batchNumber} 仍有 ${overseasArrival.remaining} 票待到仓清点`,
      barcode,
    };
  return { success: `收货完成：${barcode}${differenceMessage}`, barcode };
}

type OverseasReceivingResult = {
  completed: boolean;
  batchNumber: string;
  remaining: number;
  warning?: string | null;
};

async function finalizeOverseasReceiving(input: {
  organizationId: string;
  orderId: string;
  actorUserId: string;
  actualArrivalAt: string;
  notes: string;
}): Promise<OverseasReceivingResult> {
  const batch = await env.DB.prepare(
    `SELECT b.id,b.batch_number,b.road_status,b.actual_arrival_at
     FROM transport_batch_orders bo
     JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
     WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND b.status!='cancelled'
     ORDER BY b.updated_at DESC LIMIT 1`,
  ).bind(input.organizationId, input.orderId).first<{
    id: string;
    batch_number: string;
    road_status: string;
    actual_arrival_at: string | null;
  }>();
  if (!batch) {
    const standalone = await confirmOverseasBatchArrival({
      organizationId: input.organizationId,
      orderId: input.orderId,
      actualArrivalAt: input.actualArrivalAt,
      actorUserId: input.actorUserId,
      notes: input.notes,
    });
    return {
      completed: true,
      batchNumber: standalone.batchNumber,
      remaining: 0,
      warning: standalone.warning,
    };
  }
  if (batch.road_status === "pickup_completed")
    return { completed: true, batchNumber: batch.batch_number, remaining: 0 };
  if (!["outbound_in_transit", "overseas_arrived", "waiting_pickup"].includes(batch.road_status))
    throw new Error("运输单尚未登记实际出境");
  const singleOrderWarning = await confirmSingleOrderOverseasArrival({
    ...input,
    batchId: batch.id,
  });
  if (["overseas_arrived", "waiting_pickup"].includes(batch.road_status)) {
    const retry = await confirmOverseasBatchArrival({
      organizationId: input.organizationId,
      batchId: batch.id,
      actualArrivalAt: batch.actual_arrival_at || input.actualArrivalAt,
      actorUserId: input.actorUserId,
      notes: input.notes,
    });
    return {
      completed: true,
      batchNumber: batch.batch_number,
      remaining: 0,
      warning: [singleOrderWarning, retry.warning].filter(Boolean).join("；") || null,
    };
  }
  const readiness = await env.DB.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN EXISTS(
              SELECT 1 FROM warehouse_receipts wr
              JOIN shipments s ON s.id=wr.shipment_id AND s.organization_id=wr.organization_id
              WHERE wr.organization_id=bo.organization_id AND s.order_id=bo.order_id
                AND wr.warehouse_id=o.overseas_warehouse_id
                AND wr.status='completed' AND wr.cargo_complete=1
            ) THEN 1 ELSE 0 END) ready
     FROM transport_batch_orders bo
     JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'`,
  ).bind(input.organizationId, batch.id).first<{ total: number; ready: number | null }>();
  const total = readiness?.total ?? 0;
  const ready = readiness?.ready ?? 0;
  if (!total) throw new Error("运输单没有有效子订单");
  if (ready < total)
    return {
      completed: false,
      batchNumber: batch.batch_number,
      remaining: total - ready,
      warning: singleOrderWarning,
    };

  const arrival = await confirmOverseasBatchArrival({
    organizationId: input.organizationId,
    batchId: batch.id,
    actualArrivalAt: input.actualArrivalAt,
    actorUserId: input.actorUserId,
    notes: input.notes,
  });
  return {
    completed: true,
    batchNumber: batch.batch_number,
    remaining: 0,
    warning: [singleOrderWarning, arrival.warning].filter(Boolean).join("；") || null,
  };
}

async function confirmSingleOrderOverseasArrival(input: {
  organizationId: string;
  batchId: string;
  orderId: string;
  actorUserId: string;
  actualArrivalAt: string;
  notes: string;
}) {
  const order = await env.DB.prepare(
    `SELECT o.overseas_warehouse_id,o.customs_clearance_mode,
            COALESCE(w.name,'境外目的仓') warehouse_name,w.address warehouse_address
       FROM transport_batch_orders bo
       JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       LEFT JOIN warehouses w ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
      WHERE bo.organization_id=? AND bo.batch_id=? AND bo.order_id=? AND bo.status!='removed'`,
  ).bind(input.organizationId, input.batchId, input.orderId).first<{
    overseas_warehouse_id: string | null;
    customs_clearance_mode: string;
    warehouse_name: string;
    warehouse_address: string | null;
  }>();
  if (!order) throw new Error("当前订单不属于该运输批次");
  if (!order.overseas_warehouse_id) throw new Error("订单尚未指定境外目的仓");
  if (await requiresOrderCustomsClearanceForOverseasInbound(
    input.organizationId,
    input.orderId,
    order.customs_clearance_mode === "customer" ? "customer" : "company",
  )) {
    const customsCleared = await env.DB.prepare(
      `SELECT 1 FROM order_tracking_milestones
        WHERE organization_id=? AND order_id=? AND milestone_code='customs_cleared' LIMIT 1`,
    ).bind(input.organizationId, input.orderId).first();
    if (!customsCleared) throw new Error("订单尚未完成目的地清关，不能确认境外目的仓到仓");
  }

  const now = new Date().toISOString();
  const location = [order.warehouse_name, order.warehouse_address].filter(Boolean).join(" · ");
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE transport_batch_orders SET status='arrived',updated_at=?
        WHERE organization_id=? AND batch_id=? AND order_id=? AND status!='removed'`,
    ).bind(now, input.organizationId, input.batchId, input.orderId),
    env.DB.prepare(
      `INSERT INTO overseas_warehouse_operations(
         id,organization_id,batch_id,order_id,warehouse_id,status,actual_arrival_at,
         notes,updated_by_user_id,created_at,updated_at
       ) VALUES(?,?,?,?,?,'arrived',?,?,?,?,?)
       ON CONFLICT(batch_id,order_id) DO UPDATE SET
         warehouse_id=COALESCE(overseas_warehouse_operations.warehouse_id,excluded.warehouse_id),
         status=CASE WHEN overseas_warehouse_operations.status='waiting_arrival' THEN 'arrived' ELSE overseas_warehouse_operations.status END,
         actual_arrival_at=COALESCE(overseas_warehouse_operations.actual_arrival_at,excluded.actual_arrival_at),
         notes=COALESCE(excluded.notes,overseas_warehouse_operations.notes),
         updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.batchId,
      input.orderId,
      order.overseas_warehouse_id,
      input.actualArrivalAt,
      input.notes || null,
      input.actorUserId,
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE shipments SET status='in_transit',current_location=?,updated_at=?
        WHERE organization_id=? AND order_id=? AND status!='cancelled'`,
    ).bind(location || "境外目的仓", now, input.organizationId, input.orderId),
    env.DB.prepare(
      `INSERT INTO order_tracking_milestones(
         id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,
         visible_to_customer,created_by_user_id,created_at
       ) SELECT ?,?,?,'station_arrived','到达境外目的仓',?,?,?,1,?,?
         WHERE NOT EXISTS(
           SELECT 1 FROM order_tracking_milestones
           WHERE organization_id=? AND order_id=? AND milestone_code='station_arrived'
         )`,
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.orderId,
      input.actualArrivalAt,
      location || "境外目的仓",
      input.notes || null,
      input.actorUserId,
      now,
      input.organizationId,
      input.orderId,
    ),
    env.DB.prepare(
      `UPDATE order_module_instances
          SET status='completed',current_step_code='arrived',current_step_name='到达境外仓',
              progress_percent=100,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),
              blocking_reason=NULL,updated_at=?
        WHERE organization_id=? AND order_id=? AND module_code='tracking' AND enabled=1`,
    ).bind(now, now, now, input.organizationId, input.orderId),
    env.DB.prepare(
      `UPDATE order_module_instances
          SET status='in_progress',current_step_code='arrived',current_step_name='等待系统自动通知客户',
              progress_percent=MAX(progress_percent,25),started_at=COALESCE(started_at,?),
              blocking_reason=NULL,updated_at=?
        WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1
          AND status!='completed'`,
    ).bind(now, now, input.organizationId, input.orderId),
  ]);

  try {
    await automaticallyNotifyOverseasArrival({
      organizationId: input.organizationId,
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      occurredAt: input.actualArrivalAt,
    });
    await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
    return null;
  } catch (error) {
    await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
    const reason = error instanceof Error ? error.message : "客户通知暂未完成";
    return `本票已到仓并推进，客户通知待重试：${reason}`;
  }
}

async function requiresOrderCustomsClearanceForOverseasInbound(
  organizationId: string,
  orderId: string,
  customsClearanceMode: "company" | "customer",
) {
  const [customsModule, customsWorkflowFields] = await Promise.all([
    env.DB.prepare(
      `SELECT enabled,is_required
       FROM order_module_instances
       WHERE organization_id=? AND order_id=? AND module_code='customs'`,
    ).bind(organizationId, orderId).first<{ enabled: number; is_required: number }>(),
    loadOrderModuleWorkflowFields(organizationId, orderId, "customs"),
  ]);
  return overseasInboundRequiresCustomsClearance({
    customsClearanceMode,
    moduleEnabled: customsModule?.enabled === 1,
    moduleRequired: customsModule?.is_required === 1,
    fields: customsWorkflowFields,
  });
}

export default function WarehouseInbound({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const canOperate = canOperateWarehouseUi(
    loaderData.user,
    loaderData.warehouseAccessLevel,
  );
  const [receiptResult, setReceiptResult] = useState<"" | "ready" | "exception">(
    "",
  );
  useEffect(() => {
    setReceiptResult("");
  }, [loaderData.reference]);
  useEffect(() => {
    if (actionData?.success) {
      setReceiptResult("");
    }
  }, [actionData?.success]);
  const acceptancePolicies = resolveWarehouseAcceptancePolicies(loaderData.workflowFields);
  const locationPolicy = acceptancePolicies.location;
  const packageTypePolicy = workflowFieldPolicy(
    loaderData.workflowFields,
    "actual_package_type",
    "required",
  );
  const piecesPolicy = acceptancePolicies.actualPieces;
  const weightPolicy = acceptancePolicies.actualWeight;
  const volumePolicy = acceptancePolicies.actualVolume;
  const evidencePolicy = acceptancePolicies.evidence;
  const notesPolicy = acceptancePolicies.notes;
  const selectedShipmentRecord = loaderData.selectedShipment;
  const scannedPackageRecord = loaderData.scannedPackage;
  const showReceivingWorkbench = Boolean(
    selectedShipmentRecord && scannedPackageRecord && !actionData?.success,
  );
  return (
    <>
      <header className="page-header acceptance-header">
        <div>
          <p className="eyebrow">ACCEPTANCE RECEIVING</p>
          <h1>验收收货</h1>
          <p>当前仓库：{loaderData.warehouse.name}。扫描国内仓生成的原货物标签，核对实收并选择库位；同一运输单全部货物清点完成后自动结束境外运输。</p>
        </div>
      </header>
      {(actionData?.success || actionData?.formError) && (
        <div className={`alert ${actionData.formError ? "error" : "success"}`}>
          {actionData.formError ?? actionData.success}
        </div>
      )}
      {canOperate && !loaderData.locations.length && (
        <div className="alert error">
          当前没有可用入库库位，收货已暂停。请先
          <Link to={`/warehouse/locations?warehouseId=${loaderData.warehouse.id}`}>前往“仓库与库位”完成配置</Link>。
        </div>
      )}
      {!actionData?.success && loaderData.lookupError && <div className="alert error no-print">{loaderData.lookupError}</div>}
      {!canOperate && <div className="alert info">当前账号为仓库只读视角，可查看收货结果；货物扫描、实收录入和入库提交仅向有操作权限的冻结任务负责人开放。</div>}
      {canOperate && <WarehouseReceivingScanPanel
        key={actionData?.success ? `completed:${actionData.success}` : loaderData.reference}
        warehouseId={loaderData.warehouse.id}
        reference={actionData?.success ? "" : loaderData.reference}
        inputLabel="扫描货物标签 / 装车任务码"
        placeholder="扫描国内仓货物条码、包装号或 OUT 装车任务码后回车"
        submitLabel="调出验收信息"
        hint="单件装车任务可扫描 OUT 任务码；多件任务逐件扫描原货物标签。系统自动核对订单、客户、运单和目的仓。"
        hiddenFields={[
          { name: "orderId", value: loaderData.orderId || "" },
          { name: "returnTo", value: loaderData.returnTo },
        ]}
      />}
      {showReceivingWorkbench && selectedShipmentRecord && scannedPackageRecord && canOperate && (
        <Form
          method="post"
          className="acceptance-workbench no-print"
          onInput={(event) => synchronizeWarehouseVolumeRow(event.target)}
        >
          <input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/>
          <input type="hidden" name="shipmentId" value={selectedShipmentRecord.id}/>
          <input type="hidden" name="barcode" value={scannedPackageRecord.barcode}/>
          <WarehouseReceivingOrderStrip facts={[
            { label: "订单 / 类型", value: `${selectedShipmentRecord.order_number} · ${selectedShipmentRecord.business_type === "ftl" ? "整车" : "拼车"}` },
            { label: "客户", value: `[${selectedShipmentRecord.customer_identity_code}] ${selectedShipmentRecord.customer_name}` },
            { label: "系统运单", value: selectedShipmentRecord.shipment_number },
            { label: "发出仓库", value: scannedPackageRecord.source_warehouse_name, detail: "上一仓已出库" },
            { label: "目的仓", value: selectedShipmentRecord.expected_warehouse_name || loaderData.warehouse.name },
          ]}/>
          <section className="panel acceptance-cargo-panel">
            <div className="panel-header"><div><h2>标签货物与本次实收</h2><p>沿用国内仓原货物码；核对标签记录并填写本次实际到仓数据，不会生成重复标签。</p></div><span className="status-pill success">原标签复用</span></div>
            <div className="table-wrap acceptance-cargo-table overseas-acceptance-cargo-table"><table><thead><tr>
              <th>标签货物</th><th>订单预录</th><th>货物标签</th>
              <th>实际包装类型{packageTypePolicy.isRequired ? " *" : ""}</th>
              <th>实收件数{acceptanceRequiredMarker(piecesPolicy)}</th>
              <th>实际重量 KG{acceptanceRequiredMarker(weightPolicy)}</th>
              <th>实际体积 CBM（自动计算）{acceptanceRequiredMarker(volumePolicy)}</th>
              <th>实际长×宽×高 CM{acceptanceRequiredMarker(acceptancePolicies.actualDimensions)}</th>
            </tr></thead><tbody><tr data-warehouse-volume-row data-warehouse-volume-packages="1">
              <td><strong>{scannedPackageRecord.cargo_name || selectedShipmentRecord.cargo_description || "货物名称未填写"}</strong><small>{scannedPackageRecord.package_number}</small></td>
              <td><strong>{selectedShipmentRecord.pieces} 件 · {Number(selectedShipmentRecord.gross_weight_kg || 0).toFixed(3)} KG</strong><small>{formatVolume(selectedShipmentRecord.volume_cbm)} CBM</small></td>
              <td><strong>{scannedPackageRecord.barcode}</strong><small>上一仓已出库</small></td>
              <td>{packageTypePolicy.isActive ? <select name="packageType" aria-label="实际包装类型" defaultValue={scannedPackageRecord.package_type ?? ""} required={packageTypePolicy.isRequired}><option value="">请选择</option><option value="carton">纸箱</option><option value="pallet">托盘</option><option value="wooden_case">木箱</option><option value="bag">袋装</option><option value="drum">桶装</option><option value="bundle">捆装</option><option value="mixed">混合包装</option><option value="other">其他</option></select> : <span className="muted">工作流已隐藏</span>}</td>
              <td>{piecesPolicy.isActive ? <input name="pieces" aria-label="实收件数" type="number" min="1" step="1" defaultValue={scannedPackageRecord.pieces ?? 1} required={piecesPolicy.isRequired}/> : <span className="muted">工作流已隐藏</span>}</td>
              <td>{weightPolicy.isActive ? <input name="weight" aria-label="实际重量 KG" type="number" min="0" step="0.001" defaultValue={scannedPackageRecord.weight_kg ?? ""} required={weightPolicy.isRequired}/> : <span className="muted">工作流已隐藏</span>}</td>
              <td>{volumePolicy.isActive ? <input name="volume" aria-label="实际体积 CBM（自动计算）" type="number" min="0" step="0.0001" defaultValue={formatWarehouseVolumeCbm(calculateWarehouseVolumeCbm({ lengthCm: scannedPackageRecord.length_cm, widthCm: scannedPackageRecord.width_cm, heightCm: scannedPackageRecord.height_cm }))} required={volumePolicy.isRequired} readOnly data-warehouse-volume-output/> : <span className="muted">工作流已隐藏</span>}</td>
              <td><div className="acceptance-dimensions"><input name="length" aria-label="实际长度" type="number" min="0" step="0.1" defaultValue={scannedPackageRecord.length_cm ?? ""} required data-warehouse-volume-length/><span>×</span><input name="width" aria-label="实际宽度" type="number" min="0" step="0.1" defaultValue={scannedPackageRecord.width_cm ?? ""} required data-warehouse-volume-width/><span>×</span><input name="height" aria-label="实际高度" type="number" min="0" step="0.1" defaultValue={scannedPackageRecord.height_cm ?? ""} required data-warehouse-volume-height/></div></td>
            </tr></tbody></table></div>
          </section>
          <section className="panel acceptance-confirm-panel">
            {locationPolicy.isActive ? <label className="field"><span>入库库位{acceptanceRequiredMarker(locationPolicy)}</span><select name="locationId" required={locationPolicy.isRequired}><option value="">{locationPolicy.isRequired ? "请选择库位" : "未选则使用首个启用库位"}</option>{loaderData.locations.map((item) => <option key={item.id} value={item.id}>{item.warehouse_name} / {item.zone_name} / {item.name}（{item.code}）</option>)}</select></label> : <div className="alert info">入库库位已在当前工作流中隐藏，系统将使用当前仓库首个启用库位。</div>}
            <WarehouseReceiptResultSelector
              value={receiptResult}
              onChange={(value) => setReceiptResult(value === "partial" ? "" : value)}
              showPartial={false}
              readyLabel="清点无误"
              readyHint="本票货物已入仓；同一运输单全部订单清点后自动结束境外运输"
              exceptionHint="数量、重量、包装或货况异常；保存本次收货但不结束运输阶段"
              exceptionFooter="填写短少、破损、错货、超差等具体情况"
            />
            {evidencePolicy.isActive && <label className="field span-2"><span>收货凭证{acceptanceRequiredMarker(evidencePolicy)}</span><textarea name="evidenceNote" rows={2} required={evidencePolicy.isRequired} placeholder="照片、单证或现场凭证的索引/说明"/></label>}
            {notesPolicy.isActive && <label className="field span-2"><span>收货备注{acceptanceRequiredMarker(notesPolicy)}</span><textarea name="notes" rows={2} required={notesPolicy.isRequired} placeholder="本次到货车辆、现场情况等"/></label>}
            <button className="primary acceptance-submit" disabled={busy || !loaderData.locations.length}>{busy ? "正在验收入库…" : "确认验收并扫码入库"}</button>
          </section>
        </Form>
      )}
      {showReceivingWorkbench && !canOperate && <p className="empty-state">当前账号没有仓库操作权限。</p>}
    </>
  );
}

function positive(form: FormData, name: string) {
  const raw = valueOf(form, name);
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function positiveInt(form: FormData, name: string) {
  const value = positive(form, name);
  return value !== null && Number.isInteger(value) ? value : null;
}
function formatVolume(value: number | null | undefined) {
  return formatWarehouseVolumeCbm(Number(value ?? 0));
}
function generateCode(prefix: string) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
}

async function ensureVerifiedReceivingBatch(input: {
  organizationId: string;
  shipmentId: string;
  locationId: string;
  actorUserId: string;
  now: string;
}) {
  const existing = await env.DB.prepare(
    `SELECT id
       FROM warehouse_sorting_batches
      WHERE organization_id=? AND shipment_id=? AND status!='cancelled'
      ORDER BY created_at DESC
      LIMIT 1`,
  )
    .bind(input.organizationId, input.shipmentId)
    .first<{ id: string }>();
  const batchId = existing?.id ?? crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];

  if (existing) {
    statements.push(
      env.DB.prepare(
        `UPDATE warehouse_sorting_batches
            SET target_location_id=?,status='verified',verified_by_user_id=?,
                verified_at=COALESCE(verified_at,?),updated_at=?
          WHERE id=? AND organization_id=?`,
      ).bind(
        input.locationId,
        input.actorUserId,
        input.now,
        input.now,
        batchId,
        input.organizationId,
      ),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO warehouse_sorting_batches(
           id,organization_id,batch_number,shipment_id,target_location_id,status,notes,
           created_by_user_id,verified_by_user_id,created_at,updated_at,verified_at
         ) VALUES(?,?,?,?,?,'verified',?,?,?,?,?,?)`,
      ).bind(
        batchId,
        input.organizationId,
        generateCode("SORT"),
        input.shipmentId,
        input.locationId,
        "系统根据仓库确认货齐自动生成",
        input.actorUserId,
        input.actorUserId,
        input.now,
        input.now,
        input.now,
      ),
    );
  }

  const packages = await env.DB.prepare(
    `SELECT id
       FROM warehouse_packages
      WHERE organization_id=? AND shipment_id=? AND status!='cancelled'`,
  )
    .bind(input.organizationId, input.shipmentId)
    .all<{ id: string }>();
  for (const item of packages.results) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO warehouse_sorting_items(
           id,organization_id,batch_id,package_id,status,sorted_by_user_id,
           verified_by_user_id,sorted_at,verified_at,notes
         ) VALUES(?,?,?,?,'verified',?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),
        input.organizationId,
        batchId,
        item.id,
        input.actorUserId,
        input.actorUserId,
        input.now,
        input.now,
        "仓库确认货齐，系统自动纳入装车范围",
      ),
    );
  }
  await env.DB.batch(statements);
}
export function meta() {
  return [{ title: "扫码收货 | International TMS" }];
}
