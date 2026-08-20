import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import { useState, type ReactElement } from "react";
import type { Route } from "./+types/warehouse.inbound";
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
};
type Location = {
  id: string;
  warehouse_id: string;
  code: string;
  name: string;
  zone_name: string;
  warehouse_name: string;
};
type Receipt = {
  id: string;
  receipt_number: string;
  shipment_number: string;
  order_number: string;
  customer_name: string;
  customer_identity_code: string;
  warehouse_name: string;
  zone_name: string;
  location_name: string;
  total_pieces: number;
  total_weight_kg: number;
  total_volume_cbm: number;
  package_type: string | null;
  max_difference_percent: number | null;
  difference_status: string | null;
  received_at: string;
  operator_name: string | null;
};
type Package = {
  id: string;
  barcode: string;
  package_number: string;
  shipment_number: string;
  order_number: string;
  customer_name: string;
  customer_identity_code: string;
  location_name: string;
  pieces: number;
  weight_kg: number | null;
  volume_cbm: number | null;
  created_at: string;
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
  const orderId = new URL(request.url).searchParams.get("orderId");
  const [shipments, locations, receipts, packages] = await Promise.all([
    env.DB.prepare(
      `SELECT s.id,s.order_id,s.shipment_number,s.status,o.order_number,c.name customer_name,c.identity_code customer_identity_code,o.origin_city,o.destination_city,
      (SELECT COALESCE(w.name,a.destination_location) FROM order_transport_assignments a
       LEFT JOIN warehouses w ON w.id=a.destination_warehouse_id
       WHERE a.organization_id=s.organization_id AND a.order_id=s.order_id
         AND a.leg_type='first_mile' AND a.status!='cancelled'
       ORDER BY a.created_at DESC LIMIT 1) expected_warehouse_name
      FROM shipments s JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id
      WHERE s.organization_id=? AND s.status IN ('booked','picked_up') ORDER BY s.updated_at DESC`,
    )
      .bind(user.organizationId)
      .all<Shipment>(),
    env.DB.prepare(
      `SELECT l.id,l.warehouse_id,l.code,l.name,z.name zone_name,w.name warehouse_name FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouses w ON w.id=l.warehouse_id WHERE l.organization_id=? AND l.status='active' AND z.status='active' AND w.status='active' ORDER BY w.code,z.code,l.code`,
    )
      .bind(user.organizationId)
      .all<Location>(),
    env.DB.prepare(
      `SELECT r.id,r.receipt_number,s.shipment_number,o.order_number,c.name customer_name,c.identity_code customer_identity_code,w.name warehouse_name,z.name zone_name,l.name location_name,r.total_pieces,r.total_weight_kg,r.total_volume_cbm,r.package_type,d.max_difference_percent,d.status difference_status,r.received_at,u.display_name operator_name FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id JOIN warehouses w ON w.id=r.warehouse_id JOIN warehouse_locations l ON l.id=r.location_id JOIN warehouse_zones z ON z.id=l.zone_id LEFT JOIN users u ON u.id=r.received_by_user_id LEFT JOIN warehouse_receipt_differences d ON d.receipt_id=r.id WHERE r.organization_id=? ORDER BY r.received_at DESC LIMIT 50`,
    )
      .bind(user.organizationId)
      .all<Receipt>(),
    env.DB.prepare(
      `SELECT p.id,p.barcode,p.package_number,s.shipment_number,o.order_number,c.name customer_name,c.identity_code customer_identity_code,l.name location_name,p.pieces,p.weight_kg,p.volume_cbm,p.created_at FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id JOIN warehouse_locations l ON l.id=p.location_id WHERE p.organization_id=? ORDER BY p.created_at DESC LIMIT 12`,
    )
      .bind(user.organizationId)
      .all<Package>(),
  ]);
  const workflowFields = orderId
    ? await loadOrderModuleWorkflowFields(
        user.organizationId,
        orderId,
        "warehouse",
      )
    : [];
  return {
    user,
    shipments: shipments.results,
    locations: locations.results,
    receipts: receipts.results,
    packages: packages.results,
    orderId,
    workflowFields,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(
      request,
      "warehouse.operate",
      "warehouse",
    ),
    form = await request.formData(),
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
  const pieces = positiveInt(form, "pieces") ?? 1,
    weight = positive(form, "weight"),
    volume = positive(form, "volume");
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
    const matches = await env.DB.prepare(
      `SELECT s.id,s.status,s.order_id,s.customer_id,s.shipment_number,o.order_number,c.identity_code customer_identity_code,
          CASE WHEN UPPER(s.shipment_number)=UPPER(?) THEN 1 WHEN UPPER(o.order_number)=UPPER(?) THEN 2 ELSE 3 END match_priority
        FROM shipments s JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id
        WHERE s.organization_id=? AND s.status IN ('booked','picked_up')
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
    if (!shipment) {
      const orders = await env.DB.prepare(
        `SELECT o.id order_id,o.customer_id,o.order_number,c.identity_code customer_identity_code,o.origin_city,
          CASE WHEN UPPER(o.order_number)=UPPER(?) THEN 1 ELSE 2 END match_priority
        FROM transport_orders o JOIN customers c ON c.id=o.customer_id
        WHERE o.organization_id=? AND o.status IN ('confirmed','in_execution')
          AND (?='' OR UPPER(c.identity_code)=UPPER(?))
          AND NOT EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=o.id)
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
    shipment = await env.DB.prepare(
      `SELECT s.id,s.status,s.order_id,s.customer_id,s.shipment_number,o.order_number,c.identity_code customer_identity_code FROM shipments s JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id WHERE s.id=? AND s.organization_id=? AND s.status IN ('booked','picked_up') AND (?='' OR UPPER(c.identity_code)=UPPER(?))`,
    )
      .bind(
        shipmentId,
        user.organizationId,
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
  const workflowFields = await loadOrderModuleWorkflowFields(
    user.organizationId,
    orderId,
    "warehouse",
  );
  const locationPolicy = workflowFieldPolicy(
    workflowFields,
    "warehouse_location",
    "required",
  );
  const packageTypePolicy = workflowFieldPolicy(
    workflowFields,
    "actual_package_type",
    "required",
  );
  const piecesPolicy = workflowFieldPolicy(
    workflowFields,
    "actual_pieces",
    "required",
  );
  const weightPolicy = workflowFieldPolicy(
    workflowFields,
    "actual_weight_kg",
    "required",
  );
  const volumePolicy = workflowFieldPolicy(
    workflowFields,
    "actual_volume_cbm",
    "required",
  );
  const evidencePolicy = workflowFieldPolicy(
    workflowFields,
    "receipt_evidence",
    "optional",
  );
  let effectiveLocationId = locationId;
  if (!locationPolicy.isActive && !effectiveLocationId) {
    const defaultLocation = await env.DB.prepare(
      `SELECT l.id FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id JOIN warehouse_zones z ON z.id=l.zone_id WHERE l.organization_id=? AND l.status='active' AND w.status='active' AND z.status='active' ORDER BY w.code,z.code,l.code LIMIT 1`,
    )
      .bind(user.organizationId)
      .first<{ id: string }>();
    effectiveLocationId = defaultLocation?.id ?? "";
  }
  const location = await env.DB.prepare(
    `SELECT l.id,l.warehouse_id,l.name,l.code,w.name warehouse_name,z.name zone_name FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id JOIN warehouse_zones z ON z.id=l.zone_id WHERE l.id=? AND l.organization_id=? AND l.status='active' AND w.status='active' AND z.status='active'`,
  )
    .bind(effectiveLocationId, user.organizationId)
    .first<{
      id: string;
      warehouse_id: string;
      name: string;
      code: string;
      warehouse_name: string;
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
  if (piecesPolicy.isActive && piecesPolicy.isRequired && !pieces)
    return { formError: "请填写实收件数" };
  if (weightPolicy.isActive && weightPolicy.isRequired && weight == null)
    return { formError: "请填写实收重量" };
  if (volumePolicy.isActive && volumePolicy.isRequired && volume == null)
    return { formError: "请填写实测体积" };
  if (
    evidencePolicy.isActive &&
    evidencePolicy.isRequired &&
    !evidenceNote.trim()
  )
    return { formError: "请填写收货凭证或现场凭证索引" };
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
      "SELECT COALESCE(SUM(total_pieces),0) pieces,COALESCE(SUM(total_weight_kg),0) weight_kg,COALESCE(SUM(total_volume_cbm),0) volume_cbm FROM warehouse_receipts WHERE shipment_id=? AND organization_id=? AND status='completed'",
    )
      .bind(shipment.id, user.organizationId)
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
  const barcode = rawBarcode || generateCode("OUL"),
    packageNumber = generateCode("PKG"),
    receiptNumber = generateCode("IN");
  if (!/^[A-Z0-9-]{4,40}$/.test(barcode))
    return { formError: "标签条码只能使用大写字母、数字和横线，长度 4-40 位" };
  const duplicate = await env.DB.prepare(
    "SELECT id FROM warehouse_packages WHERE organization_id=? AND barcode=?",
  )
    .bind(user.organizationId, barcode)
    .first();
  if (duplicate) return { formError: `条码 ${barcode} 已经入库，请勿重复扫描` };
  const receiptId = crypto.randomUUID(),
    packageId = crypto.randomUUID(),
    operationId = crypto.randomUUID(),
    eventId = crypto.randomUUID(),
    locationText = `${location.warehouse_name} / ${location.zone_name} / ${location.name} (${location.code})`;
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
      env.DB.prepare(
        `INSERT INTO warehouse_packages(id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,pieces,weight_kg,volume_cbm,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'in_stock',?,?,?)`,
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
        notes || null,
        now,
        now,
      ),
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
      env.DB.prepare(
        `INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at) VALUES(?,?,'picked_up',?,'货物已扫码收货并入库',?,1,?,?)`,
      ).bind(eventId, shipment.id, locationText, now, user.userId, now),
      env.DB.prepare(
        "UPDATE shipments SET status='picked_up',current_location=?,actual_pickup_at=COALESCE(actual_pickup_at,?),updated_at=? WHERE id=? AND organization_id=?",
      ).bind(locationText, now, now, shipment.id, user.organizationId),
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
  if (cargoComplete) {
    await ensureVerifiedReceivingBatch({
      organizationId: user.organizationId,
      shipmentId: shipment.id,
      locationId: location.id,
      actorUserId: user.userId,
      now,
    });
  }
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
  if (cargoComplete) {
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
    action: "warehouse.inbound.receive",
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
  return { success: `收货完成：${barcode}${differenceMessage}`, barcode };
}

export default function WarehouseInbound({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle",
    canOperate = loaderData.user.permissions.includes("warehouse.operate");
  const [receiptResult, setReceiptResult] = useState<"" | "ready" | "exception">(
    "",
  );
  const locationPolicy = workflowFieldPolicy(
    loaderData.workflowFields,
    "warehouse_location",
    "required",
  );
  const barcodePolicy = workflowFieldPolicy(
    loaderData.workflowFields,
    "warehouse_barcode",
    "optional",
  );
  const packageTypePolicy = workflowFieldPolicy(
    loaderData.workflowFields,
    "actual_package_type",
    "required",
  );
  const piecesPolicy = workflowFieldPolicy(
    loaderData.workflowFields,
    "actual_pieces",
    "required",
  );
  const weightPolicy = workflowFieldPolicy(
    loaderData.workflowFields,
    "actual_weight_kg",
    "required",
  );
  const volumePolicy = workflowFieldPolicy(
    loaderData.workflowFields,
    "actual_volume_cbm",
    "required",
  );
  const evidencePolicy = workflowFieldPolicy(
    loaderData.workflowFields,
    "receipt_evidence",
    "optional",
  );
  const notesPolicy = workflowFieldPolicy(
    loaderData.workflowFields,
    "warehouse_receipt_notes",
    "optional",
  );
  const selectedShipment =
    loaderData.shipments.find((item) => item.order_id === loaderData.orderId)
      ?.id ?? "";
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">SCAN & RECEIVE</p>
          <h1>扫码收货</h1>
          <p>扫描客户标签或自动生成欧凌标签，完成收货、入库和轨迹同步。</p>
        </div>
        <button
          className="secondary no-print"
          type="button"
          onClick={() => window.print()}
        >
          打印最近标签
        </button>
      </header>
      {(actionData?.success || actionData?.formError) && (
        <div className={`alert ${actionData.formError ? "error" : "success"}`}>
          {actionData.formError ?? actionData.success}
        </div>
      )}
      {canOperate && !loaderData.locations.length && (
        <div className="alert error">
          当前没有可用入库库位，收货已暂停。请先
          <Link to="/warehouse/locations">前往“仓库与库位”完成配置</Link>。
        </div>
      )}
      <div className="inbound-layout">
        <section className="panel inbound-scan">
          <div className="panel-header">
            <div>
              <h2>收货登记</h2>
              <p>
                扫描订单号、运单号或选择待收货运单，并可使用客户识别码核对货物归属。
              </p>
            </div>
            <span className="status-pill">防重复扫描</span>
          </div>
          {canOperate ? (
            <Form method="post" className="warehouse-inbound-form">
              <label className="field scan-field">
                <span>订单号 / 运单号快速收货</span>
                <input
                  name="shipmentReference"
                  autoFocus
                  autoComplete="off"
                  placeholder="扫描或输入订单号、系统运单号或业务运单号"
                />
                <small>
                  订单尚未生成系统运单时，首次按订单收货会自动生成；一个订单关联多个运单时需从列表选择。
                </small>
              </label>
              <label className="field scan-field">
                <span>客户识别码（可选核对）</span>
                <input
                  name="customerIdentityCode"
                  autoComplete="off"
                  maxLength={5}
                  placeholder="例如 A2B3C"
                />
                <small>填写后只允许该客户名下货物入库，避免串货。</small>
              </label>
              <label className="field">
                <span>待收货运单（可选）</span>
                <select name="shipmentId" defaultValue={selectedShipment}>
                  <option value="">通过订单号或运单号收货时无需选择</option>
                  {loaderData.shipments.map((item) => (
                    <option key={item.id} value={item.id}>
                      [{item.customer_identity_code}] {item.order_number} ·{" "}
                      {item.shipment_number} · {item.customer_name} · 计划入库：
                      {item.expected_warehouse_name || "待确认仓库"}
                    </option>
                  ))}
                </select>
              </label>
              {selectedShipment && (
                <div className="inherited-data-strip">
                  <span>
                    计划入库仓库
                    <strong>
                      {loaderData.shipments.find(
                        (item) => item.id === selectedShipment,
                      )?.expected_warehouse_name || "运输安排尚未选择仓库"}
                    </strong>
                    <small>请按该仓库选择对应入库库位。</small>
                  </span>
                </div>
              )}
              {barcodePolicy.isActive && (
                <label className="field scan-field">
                  <span>货物标签条码</span>
                  <input
                    name="barcode"
                    autoComplete="off"
                    placeholder="扫描现有条码；留空自动生成"
                    required={barcodePolicy.isRequired}
                  />
                </label>
              )}
              {locationPolicy.isActive && (
                <label className="field">
                  <span>入库库位</span>
                  <select
                    name="locationId"
                    required={locationPolicy.isRequired}
                  >
                    <option value="">请选择库位</option>
                    {loaderData.locations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.warehouse_name} / {item.zone_name} / {item.name}（
                        {item.code}）
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {packageTypePolicy.isActive && (
                <label className="field">
                  <span>实际包装类型</span>
                  <select
                    name="packageType"
                    required={packageTypePolicy.isRequired}
                  >
                    <option value="">请选择</option>
                    <option value="carton">纸箱</option>
                    <option value="pallet">托盘</option>
                    <option value="wooden_case">木箱</option>
                    <option value="bag">袋装</option>
                    <option value="other">其他</option>
                  </select>
                </label>
              )}
              <div className="form-grid compact">
                {piecesPolicy.isActive && (
                  <Num
                    name="pieces"
                    label="实收件数"
                    defaultValue="1"
                    step="1"
                    required={piecesPolicy.isRequired}
                  />
                )}{" "}
                {weightPolicy.isActive && (
                  <Num
                    name="weight"
                    label="实重 KG"
                    required={weightPolicy.isRequired}
                  />
                )}{" "}
                {volumePolicy.isActive && (
                  <Num
                    name="volume"
                    label="实测体积 CBM"
                    step="0.001"
                    required={volumePolicy.isRequired}
                  />
                )}
              </div>
              {evidencePolicy.isActive && (
                <label className="field">
                  <span>货物 / 单证照片说明</span>
                  <input
                    name="evidenceNote"
                    placeholder="填写文件中心名称、照片编号或现场凭证说明"
                    required={evidencePolicy.isRequired}
                  />
                  <small>
                    照片与单证在订单文件中心统一归档，仓库只记录现场凭证索引，避免重复上传。
                  </small>
                </label>
              )}
              {notesPolicy.isActive && (
                <label className="field">
                  <span>收货备注</span>
                  <textarea
                    name="notes"
                    rows={2}
                    required={notesPolicy.isRequired}
                  />
                </label>
              )}
              <fieldset className="warehouse-receipt-result">
                <legend>本次收货结果</legend>
                <label className="check-field">
                  <input
                    type="radio"
                    name="receiptResult"
                    value="ready"
                    checked={receiptResult === "ready"}
                    onChange={(event) =>
                      event.currentTarget.checked && setReceiptResult("ready")
                    }
                    required={!receiptResult}
                  />
                  <span><b>货齐</b><small>本订单全部货物已经到齐，允许进入装车或拼车。</small></span>
                </label>
                <label className="check-field">
                  <input
                    type="radio"
                    name="receiptResult"
                    value="exception"
                    checked={receiptResult === "exception"}
                    onChange={(event) =>
                      event.currentTarget.checked && setReceiptResult("exception")
                    }
                    required={!receiptResult}
                  />
                  <span><b>异常</b><small>数量、重量、包装或货况存在异常。</small></span>
                </label>
                {receiptResult === "exception" && (
                  <label className="field warehouse-exception-note">
                    <span>异常说明 <b>*</b></span>
                    <textarea name="exceptionNotes" rows={3} required placeholder="请填写短少、破损、超差等具体情况" />
                  </label>
                )}
                <p>选择“异常”时，本次作为累计收货保存，订单仍可继续后续收货核对。</p>
              </fieldset>
              <button
                className="primary warehouse-primary scan-submit"
                disabled={busy || !loaderData.locations.length}
              >
                {busy ? "正在入库…" : "确认收货并生成标签"}
              </button>
            </Form>
          ) : (
            <p className="empty-state">当前账号没有仓库操作权限。</p>
          )}
        </section>
      </div>
      <section className="panel label-section">
        <div className="panel-header no-print">
          <div>
            <h2>最近货物标签</h2>
            <p>打印后粘贴到外包装，后续分拣和出库继续扫描此标签。</p>
          </div>
          <span>{loaderData.packages.length} 张</span>
        </div>
        <div className="package-labels">
          {loaderData.packages.map((item) => (
            <PackageLabel key={item.id} item={item} />
          ))}
        </div>
        {!loaderData.packages.length && (
          <p className="empty-state">完成首次收货后将在这里生成标签。</p>
        )}
      </section>
    </>
  );
}

function PackageLabel({ item }: { item: Package }) {
  return (
    <article className="package-label">
      <header>
        <strong>OULING 国际零担</strong>
        <span>货物标签</span>
      </header>
      <Code39 value={item.barcode} />
      <b>{item.barcode}</b>
      <dl>
        <div>
          <dt>客户识别码</dt>
          <dd>
            <strong>{item.customer_identity_code}</strong>
          </dd>
        </div>
        <div>
          <dt>订单</dt>
          <dd>{item.order_number}</dd>
        </div>
        <div>
          <dt>运单</dt>
          <dd>{item.shipment_number}</dd>
        </div>
        <div>
          <dt>客户</dt>
          <dd>{item.customer_name}</dd>
        </div>
        <div>
          <dt>库位</dt>
          <dd>{item.location_name}</dd>
        </div>
        <div>
          <dt>数量</dt>
          <dd>
            {item.pieces} 件{item.weight_kg ? ` / ${item.weight_kg} KG` : ""}
          </dd>
        </div>
      </dl>
    </article>
  );
}
function Code39({ value }: { value: string }) {
  const patterns: Record<string, string> = {
    "0": "nnnwwnwnn",
    "1": "wnnwnnnnw",
    "2": "nnwwnnnnw",
    "3": "wnwwnnnnn",
    "4": "nnnwwnnnw",
    "5": "wnnwwnnnn",
    "6": "nnwwwnnnn",
    "7": "nnnwnnwnw",
    "8": "wnnwnnwnn",
    "9": "nnwwnnwnn",
    A: "wnnnnwnnw",
    B: "nnwnnwnnw",
    C: "wnwnnwnnn",
    D: "nnnnwwnnw",
    E: "wnnnwwnnn",
    F: "nnwnwwnnn",
    G: "nnnnnwwnw",
    H: "wnnnnwwnn",
    I: "nnwnnwwnn",
    J: "nnnnwwwnn",
    K: "wnnnnnnww",
    L: "nnwnnnnww",
    M: "wnwnnnnwn",
    N: "nnnnwnnww",
    O: "wnnnwnnwn",
    P: "nnwnwnnwn",
    Q: "nnnnnnwww",
    R: "wnnnnnwwn",
    S: "nnwnnnwwn",
    T: "nnnnwnwwn",
    U: "wwnnnnnnw",
    V: "nwwnnnnnw",
    W: "wwwnnnnnn",
    X: "nwnnwnnnw",
    Y: "wwnnwnnnn",
    Z: "nwwnwnnnn",
    "-": "nwnnnnwnw",
    "*": "nwnnwnwnn",
  };
  let x = 0;
  const bars: ReactElement[] = [];
  for (const char of `*${value}*`) {
    for (const [index, width] of [
      ...(patterns[char] ?? patterns["-"]),
    ].entries()) {
      const size = width === "w" ? 3 : 1;
      if (index % 2 === 0)
        bars.push(
          <rect key={`${x}-${index}`} x={x} y="0" width={size} height="42" />,
        );
      x += size;
    }
    x += 1;
  }
  return (
    <svg
      className="code39"
      viewBox={`0 0 ${x} 42`}
      preserveAspectRatio="none"
      aria-label={`条码 ${value}`}
    >
      {bars}
    </svg>
  );
}
function Num({
  name,
  label,
  step = "0.01",
  defaultValue,
  required = false,
}: {
  name: string;
  label: string;
  step?: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        type="number"
        min="0"
        step={step}
        defaultValue={defaultValue}
        required={required}
      />
    </label>
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
