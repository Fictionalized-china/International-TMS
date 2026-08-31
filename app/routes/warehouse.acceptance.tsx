import { env } from "cloudflare:workers";
import { Form, Link, redirect, useNavigation } from "react-router";
import { useState, type ReactElement } from "react";
import type { Route } from "./+types/warehouse.acceptance";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { nextDocumentNumber } from "../lib/documents.server";
import { calculateWarehouseDifference } from "../lib/warehouse-actual";
import { recordWarehouseProgress } from "../lib/warehouse-progress.server";
import { recordWorkflowEvent } from "../lib/business-workflow.server";
import { syncOrderWorkflowSnapshot } from "../lib/order-modules.server";
import { writeAudit } from "../lib/audit.server";
import { synchronizeOrderExceptionStatuses } from "../lib/order-exception-status.server";

type AcceptanceOrder = {
  id: string;
  order_number: string;
  status: string;
  business_type: string;
  customer_id: string;
  customer_name: string;
  customer_identity_code: string;
  shipper_contact: string | null;
  shipper_phone: string | null;
  origin_city: string;
  origin_address: string;
  shipment_id: string | null;
  shipment_number: string | null;
  carrier_name: string | null;
  vehicle_summary: string | null;
};

type CargoItem = {
  id: string;
  line_no: number;
  cargo_name_cn: string;
  cargo_name_en: string | null;
  hs_code: string | null;
  package_type: string;
  package_count: number;
  pieces_per_package: number;
  gross_weight_per_package_kg: number;
  net_weight_per_package_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  volume_per_package_cbm: number;
  marks: string | null;
  notes: string | null;
  received_packages: number;
  received_pieces: number;
  received_weight_kg: number;
  received_volume_cbm: number;
};

type Location = {
  id: string;
  code: string;
  name: string;
  zone_name: string;
  warehouse_name: string;
};

type PackageLabel = {
  id: string;
  receipt_id: string;
  barcode: string;
  package_number: string;
  pieces: number;
  weight_kg: number | null;
  volume_cbm: number | null;
  created_at: string;
  cargo_name_cn: string | null;
  package_type: string | null;
  order_number: string;
  shipment_number: string;
  customer_name: string;
  customer_identity_code: string;
  warehouse_name: string;
  zone_name: string;
  location_name: string;
  location_code: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request, "warehouse.view", "warehouse");
  const warehouseContext = await loadWarehouseContext(request, user);
  const warehouse = warehouseContext.selected;
  if (warehouse.warehouse_role === "overseas_destination")
    throw new Response("境外目的仓请使用扫码入库", { status: 404 });

  const url = new URL(request.url);
  const reference = (url.searchParams.get("reference") || "").trim();
  const receiptId = (url.searchParams.get("receiptId") || "").trim();
  const acceptanceResult = url.searchParams.get("acceptanceResult") || "";
  const [locations, recentLabels] = await Promise.all([
    env.DB.prepare(
      `SELECT l.id,l.code,l.name,z.name zone_name,w.name warehouse_name
         FROM warehouse_locations l
         JOIN warehouse_zones z ON z.id=l.zone_id
         JOIN warehouses w ON w.id=l.warehouse_id
        WHERE l.organization_id=? AND l.warehouse_id=?
          AND l.status='active' AND z.status='active' AND w.status='active'
        ORDER BY z.code,l.code`,
    ).bind(user.organizationId, warehouse.id).all<Location>(),
    env.DB.prepare(
      `SELECT p.id,p.receipt_id,p.barcode,p.package_number,p.pieces,p.weight_kg,p.volume_cbm,p.created_at,
              i.cargo_name_cn,i.package_type,o.order_number,s.shipment_number,c.name customer_name,
              c.identity_code customer_identity_code,w.name warehouse_name,z.name zone_name,
              l.name location_name,l.code location_code
         FROM warehouse_packages p
         JOIN shipments s ON s.id=p.shipment_id
         JOIN transport_orders o ON o.id=s.order_id
         JOIN customers c ON c.id=s.customer_id
         JOIN warehouses w ON w.id=p.warehouse_id
         JOIN warehouse_locations l ON l.id=p.location_id
         JOIN warehouse_zones z ON z.id=l.zone_id
         LEFT JOIN order_cargo_items i ON i.id=p.cargo_item_id
        WHERE p.organization_id=? AND p.warehouse_id=? AND (?='' OR p.receipt_id=?)
        ORDER BY p.created_at DESC LIMIT 1000`,
    ).bind(user.organizationId, warehouse.id, receiptId, receiptId).all<PackageLabel>(),
  ]);

  let order: AcceptanceOrder | null = null;
  let cargoItems: CargoItem[] = [];
  let lookupError = "";
  if (reference) {
    const matches = await env.DB.prepare(
      `SELECT o.id,o.order_number,o.status,o.business_type,o.customer_id,c.name customer_name,
              c.identity_code customer_identity_code,o.shipper_contact,o.shipper_phone,
              o.origin_city,o.origin_address,s.id shipment_id,s.shipment_number,
              COALESCE(ca.name,a.carrier_name) carrier_name,
              (SELECT GROUP_CONCAT(COALESCE(NULLIF(v.plate_number,''),'未录车牌')||' / '||COALESCE(NULLIF(v.driver_name,''),'未录司机'),'；')
                 FROM domestic_waybill_vehicles v
                WHERE v.organization_id=o.organization_id AND v.assignment_id=a.id AND v.status!='cancelled') vehicle_summary
         FROM transport_orders o
         JOIN customers c ON c.id=o.customer_id
         JOIN order_transport_assignments a ON a.id=(
           SELECT ax.id FROM order_transport_assignments ax
            WHERE ax.organization_id=o.organization_id AND ax.order_id=o.id
              AND ax.leg_type='first_mile' AND ax.status!='cancelled'
            ORDER BY ax.updated_at DESC,ax.created_at DESC LIMIT 1
         )
         LEFT JOIN carriers ca ON ca.id=a.carrier_id
         LEFT JOIN shipments s ON s.id=(
           SELECT sx.id FROM shipments sx
            WHERE sx.organization_id=o.organization_id AND sx.order_id=o.id
            ORDER BY sx.updated_at DESC,sx.created_at DESC LIMIT 1
         )
        WHERE o.organization_id=? AND o.status IN ('confirmed','in_execution')
          AND a.destination_warehouse_id=?
          AND (UPPER(o.order_number)=UPPER(?) OR UPPER(COALESCE(s.shipment_number,''))=UPPER(?) OR EXISTS(
            SELECT 1 FROM order_waybills ow
             WHERE ow.organization_id=o.organization_id AND ow.order_id=o.id
               AND UPPER(ow.waybill_number)=UPPER(?)
          ))
        ORDER BY o.updated_at DESC LIMIT 2`,
    ).bind(user.organizationId, warehouse.id, reference, reference, reference).all<AcceptanceOrder>();
    if (matches.results.length > 1) lookupError = "该号码匹配多个订单，请扫描或输入唯一的系统订单号";
    else if (!matches.results.length) lookupError = `未找到计划进入“${warehouse.name}”且可验收的订单：${reference}`;
    else {
      order = matches.results[0];
      const cargo = await env.DB.prepare(
        `SELECT i.id,i.line_no,i.cargo_name_cn,i.cargo_name_en,i.hs_code,i.package_type,
                i.package_count,i.pieces_per_package,i.gross_weight_per_package_kg,
                i.net_weight_per_package_kg,i.length_cm,i.width_cm,i.height_cm,
                i.volume_per_package_cbm,i.marks,i.notes,
                COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_packages ELSE 0 END),0) received_packages,
                COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_pieces ELSE 0 END),0) received_pieces,
                COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_weight_kg ELSE 0 END),0) received_weight_kg,
                COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_volume_cbm ELSE 0 END),0) received_volume_cbm
           FROM order_cargo_items i
           LEFT JOIN warehouse_receipt_items ri ON ri.cargo_item_id=i.id AND ri.organization_id=i.organization_id
           LEFT JOIN warehouse_receipts r ON r.id=ri.receipt_id AND r.status='completed' AND r.warehouse_id=?
          WHERE i.organization_id=? AND i.order_id=?
          GROUP BY i.id
          ORDER BY i.line_no,i.id`,
      ).bind(warehouse.id, user.organizationId, order.id).all<CargoItem>();
      cargoItems = cargo.results;
      if (!cargoItems.length) lookupError = "该订单没有货物明细，不能办理逐条验收，请先在订单中补充货物";
    }
  }

  return {
    user,
    warehouse,
    reference,
    order,
    cargoItems,
    locations: locations.results,
    recentLabels: recentLabels.results,
    receiptId,
    resultMessage: acceptanceResult === "ready"
      ? `验收入库完成，订单已确认货齐，共生成 ${recentLabels.results.length} 张标签`
      : acceptanceResult === "exception"
        ? `异常货物已入库并冻结，共生成 ${recentLabels.results.length} 张标签，请到异常处理结案`
        : acceptanceResult === "partial"
          ? `本批货物已入库，共生成 ${recentLabels.results.length} 张标签；订单继续等待后续到货`
          : "",
    lookupError,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request, "warehouse.operate", "warehouse");
  const warehouseContext = await loadWarehouseContext(request, user);
  const warehouse = warehouseContext.selected;
  if (warehouse.warehouse_role === "overseas_destination") return { formError: "境外目的仓请使用扫码入库" };
  await requireWarehouseAssignment(user, warehouse.id, "operator");

  const form = await request.formData();
  const orderId = valueOf(form, "orderId");
  const locationId = valueOf(form, "locationId");
  const result = valueOf(form, "receiptResult");
  const exceptionNotes = valueOf(form, "exceptionNotes").trim();
  const notes = valueOf(form, "notes").trim();
  if (!orderId || !locationId) return { formError: "订单和入库库位不能为空" };
  if (!['partial','ready','exception'].includes(result)) return { formError: "请选择本次验收结果" };
  if (result === "exception" && !exceptionNotes) return { formError: "异常入库必须填写异常说明" };

  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.customer_id,o.origin_city,s.id shipment_id,s.shipment_number
       FROM transport_orders o
       JOIN order_transport_assignments a ON a.id=(
         SELECT ax.id FROM order_transport_assignments ax
          WHERE ax.organization_id=o.organization_id AND ax.order_id=o.id
            AND ax.leg_type='first_mile' AND ax.status!='cancelled'
          ORDER BY ax.updated_at DESC,ax.created_at DESC LIMIT 1
       )
       LEFT JOIN shipments s ON s.id=(
         SELECT sx.id FROM shipments sx WHERE sx.organization_id=o.organization_id AND sx.order_id=o.id
          ORDER BY sx.updated_at DESC,sx.created_at DESC LIMIT 1
       )
      WHERE o.id=? AND o.organization_id=? AND o.status IN ('confirmed','in_execution')
        AND a.destination_warehouse_id=?`,
  ).bind(orderId, user.organizationId, warehouse.id).first<{
    id: string; order_number: string; customer_id: string; origin_city: string;
    shipment_id: string | null; shipment_number: string | null;
  }>();
  if (!order) return { formError: "订单不存在、状态不可收货，或计划入库仓库与当前仓库不一致" };

  const location = await env.DB.prepare(
    `SELECT l.id,l.code,l.name,z.name zone_name,w.name warehouse_name
       FROM warehouse_locations l
       JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouses w ON w.id=l.warehouse_id
      WHERE l.id=? AND l.organization_id=? AND l.warehouse_id=?
        AND l.status='active' AND z.status='active' AND w.status='active'`,
  ).bind(locationId, user.organizationId, warehouse.id).first<Location>();
  if (!location) return { formError: "请选择当前仓库的有效库位" };

  const cargo = await env.DB.prepare(
    `SELECT id,line_no,cargo_name_cn,package_type,package_count,pieces_per_package,
            gross_weight_per_package_kg,volume_per_package_cbm
       FROM order_cargo_items WHERE organization_id=? AND order_id=? ORDER BY line_no,id`,
  ).bind(user.organizationId, order.id).all<{
    id: string; line_no: number; cargo_name_cn: string; package_type: string;
    package_count: number; pieces_per_package: number;
    gross_weight_per_package_kg: number; volume_per_package_cbm: number;
  }>();
  if (!cargo.results.length) return { formError: "订单没有货物明细，无法验收" };

  const actualRows = cargo.results.map((item, index) => ({
    ...item,
    actualPackages: nonNegativeInteger(form, `actualPackages_${index}`),
    actualPieces: nonNegativeInteger(form, `actualPieces_${index}`),
    actualWeight: nonNegativeNumber(form, `actualWeight_${index}`),
    actualVolume: nonNegativeNumber(form, `actualVolume_${index}`),
    actualLength: nonNegativeNumber(form, `actualLength_${index}`),
    actualWidth: nonNegativeNumber(form, `actualWidth_${index}`),
    actualHeight: nonNegativeNumber(form, `actualHeight_${index}`),
    itemNotes: valueOf(form, `itemNotes_${index}`).trim(),
  }));
  if (actualRows.some((item) => item.actualPackages === null || item.actualPieces === null || item.actualWeight === null || item.actualVolume === null || item.actualLength === null || item.actualWidth === null || item.actualHeight === null))
    return { formError: "实收包装数、件数、重量、体积和长宽高必须填写有效的非负数字" };
  const receivedRows = actualRows.filter((item) => (item.actualPackages ?? 0) > 0);
  if (!receivedRows.length && result !== "ready") return { formError: "本次至少要验收一个实际包装" };
  if (receivedRows.some((item) => !item.actualPieces || !item.actualWeight || !item.actualVolume || !item.actualLength || !item.actualWidth || !item.actualHeight))
    return { formError: "有实收包装的货物必须填写实收件数、实际重量、实际体积和实际长宽高" };

  if (result === "ready") {
    const activeException = await env.DB.prepare(
      `SELECT exception_number FROM (
         SELECT e.exception_number,e.reported_at event_at
         FROM warehouse_exceptions e JOIN shipments s ON s.id=e.shipment_id
         WHERE e.organization_id=? AND s.order_id=? AND e.status IN ('open','processing')
         UNION ALL
         SELECT e.exception_number,e.reported_at event_at
         FROM transport_batch_exceptions e
         WHERE e.organization_id=? AND e.status IN ('open','processing') AND e.blocks_progress=1
           AND (e.order_id=? OR (e.scope='batch' AND EXISTS(
             SELECT 1 FROM transport_batch_orders bo
             WHERE bo.organization_id=e.organization_id AND bo.batch_id=e.batch_id
               AND bo.order_id=? AND bo.status!='removed'
           )))
       ) ORDER BY event_at LIMIT 1`,
    ).bind(user.organizationId, order.id, user.organizationId, order.id, order.id).first<{ exception_number: string }>();
    if (activeException) return { formError: `订单仍有未结案异常 ${activeException.exception_number}，处理结案后才能确认货齐` };
  }

  const now = new Date().toISOString();
  let shipmentId = order.shipment_id;
  let shipmentNumber = order.shipment_number;
  const bootstrap: D1PreparedStatement[] = [];
  if (!shipmentId) {
    shipmentId = crypto.randomUUID();
    shipmentNumber = await nextDocumentNumber(user.organizationId, "shipment");
    bootstrap.push(
      env.DB.prepare(
        `INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,status,current_location,created_at,updated_at)
         VALUES(?,?,?,?,?,'booked',?,?,?)`,
      ).bind(shipmentId, user.organizationId, shipmentNumber, order.id, order.customer_id, order.origin_city, now, now),
      env.DB.prepare(
        `INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at)
         VALUES(?,?,'booked',?,'仓库验收收货时自动生成运单',?,1,?,?)`,
      ).bind(crypto.randomUUID(), shipmentId, order.origin_city, now, user.userId, now),
    );
  }

  const receiptId = crypto.randomUUID();
  const receiptNumber = generateCode("IN");
  const totalPackages = receivedRows.reduce((sum, item) => sum + (item.actualPackages ?? 0), 0);
  const totalPieces = receivedRows.reduce((sum, item) => sum + (item.actualPieces ?? 0), 0);
  const totalWeight = receivedRows.reduce((sum, item) => sum + (item.actualWeight ?? 0), 0);
  const totalVolume = receivedRows.reduce((sum, item) => sum + (item.actualVolume ?? 0), 0);
  const packageTypes = [...new Set(receivedRows.map((item) => item.package_type))];
  const locationText = `${location.warehouse_name} / ${location.zone_name} / ${location.name} (${location.code})`;
  const statements: D1PreparedStatement[] = [...bootstrap];
  statements.push(
    env.DB.prepare(
      `INSERT INTO warehouse_receipts(
        id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,status,
        total_packages,total_pieces,total_weight_kg,total_volume_cbm,notes,received_by_user_id,
        received_at,created_at,updated_at,package_type,evidence_note,cargo_complete,has_exception,exception_notes
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      receiptId,user.organizationId,receiptNumber,shipmentId,warehouse.id,location.id,"completed",
      totalPackages,totalPieces,totalWeight,totalVolume,notes || null,user.userId,now,now,now,
      packageTypes.length === 1 ? packageTypes[0] : "mixed",null,result === "ready" ? 1 : 0,
      result === "exception" ? 1 : 0,exceptionNotes || null,
    ),
  );

  const createdPackages: { id: string; barcode: string }[] = [];
  for (const item of receivedRows) {
    const actualPackages = item.actualPackages as number;
    const actualPieces = item.actualPieces as number;
    const actualWeight = item.actualWeight as number;
    const actualVolume = item.actualVolume as number;
    const actualLength = item.actualLength as number;
    const actualWidth = item.actualWidth as number;
    const actualHeight = item.actualHeight as number;
    statements.push(
      env.DB.prepare(
        `INSERT INTO warehouse_receipt_items(
          id,organization_id,receipt_id,order_id,cargo_item_id,
          expected_packages,expected_pieces,expected_weight_kg,expected_volume_cbm,
          actual_packages,actual_pieces,actual_weight_kg,actual_volume_cbm,
          actual_length_cm,actual_width_cm,actual_height_cm,result,notes,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),user.organizationId,receiptId,order.id,item.id,
        item.package_count,item.package_count * item.pieces_per_package,
        item.package_count * item.gross_weight_per_package_kg,item.package_count * item.volume_per_package_cbm,
        actualPackages,actualPieces,actualWeight,actualVolume,actualLength,actualWidth,actualHeight,
        result === "exception" ? "exception" : "normal",item.itemNotes || null,now,now,
      ),
    );
    for (let sequence = 1; sequence <= actualPackages; sequence += 1) {
      const packageId = crypto.randomUUID();
      const barcode = generateCode("OUL");
      const packageNumber = generatePackageNumber(order.order_number, item.line_no, sequence);
      const pieces = distributeInteger(actualPieces, actualPackages, sequence);
      const weight = distributeDecimal(actualWeight, actualPackages, sequence);
      const volume = distributeDecimal(actualVolume, actualPackages, sequence);
      const packageStatus = result === "exception" && sequence === 1 && createdPackages.length === 0 ? "exception" : "in_stock";
      createdPackages.push({ id: packageId, barcode });
      statements.push(
        env.DB.prepare(
          `INSERT INTO warehouse_packages(
            id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,
            pieces,weight_kg,volume_cbm,length_cm,width_cm,height_cm,status,notes,created_at,updated_at,cargo_item_id
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          packageId,user.organizationId,receiptId,shipmentId,warehouse.id,location.id,barcode,packageNumber,
          pieces,weight,volume,actualLength,actualWidth,actualHeight,packageStatus,item.itemNotes || notes || null,now,now,item.id,
        ),
        env.DB.prepare(
          `INSERT INTO warehouse_package_movements(
            id,organization_id,package_id,operation_type,from_location_id,to_location_id,
            operator_user_id,notes,occurred_at,created_at
          ) VALUES(?,?,?,'inbound',NULL,?,?,?,?,?)`,
        ).bind(crypto.randomUUID(),user.organizationId,packageId,location.id,user.userId,`验收收货 · ${receiptNumber}`,now,now),
      );
    }
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO warehouse_operations(
        id,organization_id,shipment_id,operation_type,location,measured_pieces,
        measured_weight_kg,measured_volume_cbm,notes,operator_user_id,occurred_at,created_at,warehouse_location_id
      ) VALUES(?,?,?,'receive',?,?,?,?,?,?,?,?,?)`,
    ).bind(crypto.randomUUID(),user.organizationId,shipmentId,locationText,totalPieces,totalWeight,totalVolume,notes || exceptionNotes || null,user.userId,now,now,location.id),
    env.DB.prepare(
      `INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at)
       VALUES(?,?,'picked_up',?,?,?,1,?,?)`,
    ).bind(crypto.randomUUID(),shipmentId,locationText,result === "ready" ? "仓库验收完成并确认货齐" : result === "exception" ? "仓库异常验收入库" : "仓库完成一批货物验收入库",now,user.userId,now),
    env.DB.prepare(
      `UPDATE shipments SET status='picked_up',current_location=?,actual_pickup_at=COALESCE(actual_pickup_at,?),updated_at=?
       WHERE id=? AND organization_id=?`,
    ).bind(locationText,now,now,shipmentId,user.organizationId),
    env.DB.prepare(
      `UPDATE transport_orders SET status='in_execution',updated_at=?
       WHERE id=? AND organization_id=? AND status='confirmed'`,
    ).bind(now,order.id,user.organizationId),
  );

  const expected = cargo.results.reduce((sum, item) => ({
    packages: sum.packages + item.package_count,
    pieces: sum.pieces + item.package_count * item.pieces_per_package,
    weightKg: sum.weightKg + item.package_count * item.gross_weight_per_package_kg,
    volumeCbm: sum.volumeCbm + item.package_count * item.volume_per_package_cbm,
  }), { packages: 0, pieces: 0, weightKg: 0, volumeCbm: 0 });
  const previous = await env.DB.prepare(
    `SELECT COALESCE(SUM(total_packages),0) packages,COALESCE(SUM(total_pieces),0) pieces,COALESCE(SUM(total_weight_kg),0) weight_kg,
            COALESCE(SUM(total_volume_cbm),0) volume_cbm
       FROM warehouse_receipts WHERE organization_id=? AND shipment_id=? AND warehouse_id=? AND status='completed'`,
  ).bind(user.organizationId, shipmentId, warehouse.id).first<{ packages: number; pieces: number; weight_kg: number; volume_cbm: number }>();
  const cumulative = {
    packages: (previous?.packages ?? 0) + totalPackages,
    pieces: (previous?.pieces ?? 0) + totalPieces,
    weightKg: (previous?.weight_kg ?? 0) + totalWeight,
    volumeCbm: (previous?.volume_cbm ?? 0) + totalVolume,
  };
  const difference = calculateWarehouseDifference(expected, cumulative);
  if (result === "ready" && (
    cumulative.packages !== expected.packages ||
    cumulative.pieces !== expected.pieces ||
    difference.requiresFeeConfirmation
  )) return {
    formError: `累计实收与预录差异较大，不能直接确认货齐：预录 ${expected.packages} 包/${expected.pieces} 件，累计实收 ${cumulative.packages} 包/${cumulative.pieces} 件，最大重量或体积差异 ${difference.maxPercent.toFixed(1)}%。请选择“异常入库”并处理差异。`,
  };
  if (result !== "partial" && difference.hasDifference) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO warehouse_receipt_differences(
          id,organization_id,receipt_id,order_id,planned_pieces,planned_weight_kg,planned_volume_cbm,
          actual_pieces,actual_weight_kg,actual_volume_cbm,max_difference_percent,status,notes,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      ).bind(
        crypto.randomUUID(),user.organizationId,receiptId,order.id,expected.pieces,expected.weightKg,
        expected.volumeCbm,cumulative.pieces,cumulative.weightKg,cumulative.volumeCbm,difference.maxPercent,
        exceptionNotes || notes || "仓库验收实收与预录存在差异",now,now,
      ),
    );
  }
  if (result === "exception") {
    const exceptionPackage = createdPackages[0];
    statements.push(
      env.DB.prepare(
        `INSERT INTO warehouse_exceptions(
          id,organization_id,exception_number,package_id,shipment_id,exception_type,severity,status,
          previous_package_status,description,reported_by_user_id,reported_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,'other','medium','open','in_stock',?,?,?,?,?)`,
      ).bind(crypto.randomUUID(),user.organizationId,generateCode("EX"),exceptionPackage.id,shipmentId,exceptionNotes,user.userId,now,now,now),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error("warehouse acceptance failed", error);
    return { formError: "验收入库失败，未写入库存，请检查数据后重试" };
  }

  if (result === "exception") {
    await synchronizeOrderExceptionStatuses(user.organizationId, [order.id], now);
  }

  if (result === "ready") {
    await ensureVerifiedReceivingBatch({ organizationId: user.organizationId, shipmentId, locationId: location.id, actorUserId: user.userId, now });
  }
  await recordWarehouseProgress({
    organizationId: user.organizationId,
    orderId: order.id,
    actorUserId: user.userId,
    stepCode: result === "ready" ? "ready" : "receiving",
    stepName: result === "ready" ? "货齐，等待装车/配载" : result === "exception" ? "验收异常处理中" : "累计收货中",
    actionCode: result === "ready" ? "acceptance_ready" : result === "exception" ? "acceptance_exception" : "acceptance_partial",
    actionName: result === "ready" ? "验收并确认货齐" : result === "exception" ? "异常验收入库" : "分批验收入库",
    notes: `入库单 ${receiptNumber}，生成 ${createdPackages.length} 张仓库标签${exceptionNotes ? `；${exceptionNotes}` : ""}`,
  });
  if (result === "ready") await completeDomesticTransport(user.organizationId, order.id, shipmentId, user.userId, receiptNumber, now);

  await recordWorkflowEvent({
    organizationId: user.organizationId,event: "shipment.picked_up",customerId: order.customer_id,
    orderId: order.id,shipmentId,actorUserId: user.userId,source: "admin",
    metadata: { warehouse: true, acceptance: true, receiptNumber, locationId, result, packages: createdPackages.length },
  });
  await writeAudit({
    request,action: "warehouse.acceptance.receive",resourceType: "warehouse_receipt",resourceId: receiptId,
    organizationId: user.organizationId,actorUserId: user.userId,
    metadata: { orderId: order.id,orderNumber: order.order_number,receiptNumber,result,totalPackages,totalPieces,totalWeight,totalVolume,locationId },
  });
  const successParams = new URLSearchParams({
    warehouseId: warehouse.id,
    receiptId,
    acceptanceResult: result,
  });
  return redirect(`/warehouse/acceptance?${successParams}`);
}

export default function WarehouseAcceptance({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const canOperate = loaderData.user.permissions.includes("warehouse.operate");
  const [receiptResult, setReceiptResult] = useState<"partial" | "ready" | "exception">("partial");
  const labels = loaderData.receiptId ? loaderData.recentLabels : [];
  return <>
    <header className="page-header acceptance-header"><div><p className="eyebrow">ACCEPTANCE RECEIVING</p><h1>验收收货</h1><p>扫描订单号，逐条核对预录与实收数据，选择库位入库后打印每个实际包装的仓库标签。</p></div>{labels.length > 0 && <button type="button" className="primary no-print" onClick={() => window.print()}>打印本次 {labels.length} 张标签</button>}</header>
    {(loaderData.resultMessage || actionData?.formError) && <div className={`alert ${actionData?.formError ? "error" : "success"}`}>{actionData?.formError ?? loaderData.resultMessage}</div>}
    {!loaderData.locations.length && <div className="alert error">当前仓库没有可用库位，请先<Link to={`/warehouse/locations?warehouseId=${loaderData.warehouse.id}`}>配置仓库与库位</Link>。</div>}
    <section className="panel acceptance-scan-panel no-print">
      <Form method="get" action="." className="acceptance-scan-form">
        <input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/>
        <label className="field scan-field"><span>扫描订单号</span><input name="reference" defaultValue={loaderData.reference} autoFocus autoComplete="off" placeholder="扫描订单号条码后回车"/></label>
        <button className="primary">调出验收信息</button>
        <small>扫描枪输入订单号并发送回车后，系统自动读取客户、货物、运输和累计收货信息。</small>
      </Form>
    </section>
    {loaderData.lookupError && <div className="alert error no-print">{loaderData.lookupError}</div>}
    {loaderData.order && loaderData.cargoItems.length > 0 && <Form method="post" className="acceptance-workbench no-print">
      <input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/><input type="hidden" name="orderId" value={loaderData.order.id}/><input type="hidden" name="reference" value={loaderData.order.order_number}/>
      <section className="panel acceptance-order-strip">
        <span><small>订单 / 类型</small><strong>{loaderData.order.order_number} · {loaderData.order.business_type === "ftl" ? "整车" : "拼车"}</strong></span>
        <span><small>客户</small><strong>[{loaderData.order.customer_identity_code}] {loaderData.order.customer_name}</strong></span>
        <span><small>发货联系人</small><strong>{loaderData.order.shipper_contact || "未填写"} · {loaderData.order.shipper_phone || "未填写"}</strong></span>
        <span><small>国内运输</small><strong>{loaderData.order.carrier_name || "承运商未填写"}</strong><em>{loaderData.order.vehicle_summary || "车辆与司机未填写"}</em></span>
        <span><small>提货地</small><strong>{loaderData.order.origin_city} · {loaderData.order.origin_address}</strong></span>
      </section>
      <section className="panel acceptance-cargo-panel"><div className="panel-header"><div><h2>预录货物与本次实收</h2><p>每条货物按本次实际到仓填写；未在本批到仓的货物全部填 0。</p></div><span className="status-pill">{loaderData.cargoItems.length} 条货物</span></div>
        <div className="table-wrap acceptance-cargo-table"><table><thead><tr><th>预录货物</th><th>计划数据</th><th>累计已收</th><th>本次包装数 *</th><th>本次件数 *</th><th>实际重量 KG *</th><th>实际长×宽×高 CM *</th><th>实际体积 CBM *</th><th>本行备注</th></tr></thead><tbody>{loaderData.cargoItems.map((item,index) => {
          const expectedPieces = item.package_count * item.pieces_per_package;
          const expectedWeight = item.package_count * item.gross_weight_per_package_kg;
          const expectedVolume = item.package_count * item.volume_per_package_cbm;
          return <tr key={item.id}><td><strong>{item.line_no}. {item.cargo_name_cn}</strong><small>{item.cargo_name_en || "—"} · HS {item.hs_code || "—"}</small><small>{packageTypeLabel(item.package_type)} · {item.length_cm}×{item.width_cm}×{item.height_cm} cm</small></td><td><strong>{item.package_count} 包 / {expectedPieces} 件</strong><small>{expectedWeight.toFixed(2)} KG · {expectedVolume.toFixed(3)} CBM</small></td><td><strong>{item.received_packages} 包 / {item.received_pieces} 件</strong><small>{item.received_weight_kg.toFixed(2)} KG · {item.received_volume_cbm.toFixed(3)} CBM</small></td><td><input name={`actualPackages_${index}`} type="number" min="0" step="1" defaultValue={Math.max(0,item.package_count-item.received_packages)} required/></td><td><input name={`actualPieces_${index}`} type="number" min="0" step="1" defaultValue={Math.max(0,expectedPieces-item.received_pieces)} required/></td><td><input name={`actualWeight_${index}`} type="number" min="0" step="0.001" defaultValue={Math.max(0,expectedWeight-item.received_weight_kg).toFixed(3)} required/></td><td><div className="acceptance-dimensions"><input name={`actualLength_${index}`} type="number" min="0" step="0.1" defaultValue={item.length_cm} aria-label="实际长度" required/><span>×</span><input name={`actualWidth_${index}`} type="number" min="0" step="0.1" defaultValue={item.width_cm} aria-label="实际宽度" required/><span>×</span><input name={`actualHeight_${index}`} type="number" min="0" step="0.1" defaultValue={item.height_cm} aria-label="实际高度" required/></div></td><td><input name={`actualVolume_${index}`} type="number" min="0" step="0.0001" defaultValue={Math.max(0,expectedVolume-item.received_volume_cbm).toFixed(4)} required/></td><td><input name={`itemNotes_${index}`} placeholder="选填"/></td></tr>;
        })}</tbody></table></div>
      </section>
      <section className="panel acceptance-confirm-panel"><label className="field"><span>入库库位 *</span><select name="locationId" required><option value="">请选择库位</option>{loaderData.locations.map((item) => <option key={item.id} value={item.id}>{item.warehouse_name} / {item.zone_name} / {item.name}（{item.code}）</option>)}</select></label><fieldset className="acceptance-result"><legend>本次验收结果 *</legend><label><input type="radio" name="receiptResult" value="partial" checked={receiptResult === "partial"} onChange={() => setReceiptResult("partial")}/><span><b>分批正常入库</b><small>本批货物无异常，订单尚未全部到齐</small></span></label><label><input type="radio" name="receiptResult" value="ready" checked={receiptResult === "ready"} onChange={() => setReceiptResult("ready")}/><span><b>订单货齐</b><small>本次入库后，订单全部货物已经到齐</small></span></label><label><input type="radio" name="receiptResult" value="exception" checked={receiptResult === "exception"} onChange={() => setReceiptResult("exception")}/><span><b>异常入库</b><small>允许入库但冻结后续装车和配载</small></span></label></fieldset>{receiptResult === "exception" && <label className="field span-2"><span>异常说明 *</span><textarea name="exceptionNotes" rows={3} required placeholder="填写短少、破损、错货、超差等具体情况"/></label>}<label className="field span-2"><span>收货备注</span><textarea name="notes" rows={2} placeholder="选填，本次到货车辆、现场情况等"/></label><button className="primary acceptance-submit" disabled={busy || !canOperate || !loaderData.locations.length}>{busy ? "正在验收入库…" : "确认验收、入库并生成标签"}</button></section>
    </Form>}
    {labels.length > 0 && <section className="acceptance-label-section"><div className="panel-header no-print"><div><h2>本次仓库货物标签</h2><p>每个实际包装一张，打印后粘贴到对应货物外包装。</p></div><span>{labels.length} 张</span></div><div className="package-labels">{labels.map((item) => <AcceptanceLabel key={item.id} item={item}/>)}</div></section>}
  </>;
}

function AcceptanceLabel({ item }: { item: PackageLabel }) {
  return <article className="package-label warehouse-package-label"><header><strong>OULING 国际物流</strong><span>货物条码标签</span></header><Code39 value={item.barcode}/><b>{item.barcode}</b><dl><div><dt>订单</dt><dd>{item.order_number}</dd></div><div><dt>货物条码</dt><dd>{item.barcode}</dd></div><div><dt>客户</dt><dd>[{item.customer_identity_code}] {item.customer_name}</dd></div><div><dt>实收</dt><dd>{item.pieces} 件 · {item.weight_kg?.toFixed(2) || "0.00"} KG · {item.volume_cbm?.toFixed(3) || "0.000"} CBM</dd></div><div><dt>库位</dt><dd>{item.zone_name} / {item.location_name}（{item.location_code}）</dd></div></dl></article>;
}

function Code39({ value }: { value: string }) {
  const patterns: Record<string,string>={"0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw","5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn","A":"wnnnnwnnw","B":"nnwnnwnnw","C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn","F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn","I":"nnwnnwwnn","J":"nnnnwwwnn","K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww","O":"wnnnwnnwn","P":"nnwnwnnwn","Q":"nnnnnnwww","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn","U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwnnwnnnw","Y":"wwnnwnnnn","Z":"nwwnwnnnn","-":"nwnnnnwnw","*":"nwnnwnwnn"};
  let x=0;const bars:ReactElement[]=[];for(const char of `*${value}*`){for(const[index,width]of[...(patterns[char]??patterns["-"])].entries()){const size=width==="w"?3:1;if(index%2===0)bars.push(<rect key={`${x}-${index}`} x={x} y="0" width={size} height="48"/>);x+=size}x+=1}return <svg className="code39" viewBox={`0 0 ${x} 48`} preserveAspectRatio="none">{bars}</svg>;
}

async function ensureVerifiedReceivingBatch(input:{organizationId:string;shipmentId:string;locationId:string;actorUserId:string;now:string}) {
  const existing=await env.DB.prepare("SELECT id FROM warehouse_sorting_batches WHERE organization_id=? AND shipment_id=? AND status!='cancelled' ORDER BY created_at DESC LIMIT 1").bind(input.organizationId,input.shipmentId).first<{id:string}>();
  const batchId=existing?.id??crypto.randomUUID();const statements:D1PreparedStatement[]=[];
  if(existing) statements.push(env.DB.prepare("UPDATE warehouse_sorting_batches SET target_location_id=?,status='verified',verified_by_user_id=?,verified_at=COALESCE(verified_at,?),updated_at=? WHERE id=? AND organization_id=?").bind(input.locationId,input.actorUserId,input.now,input.now,batchId,input.organizationId));
  else statements.push(env.DB.prepare("INSERT INTO warehouse_sorting_batches(id,organization_id,batch_number,shipment_id,target_location_id,status,notes,created_by_user_id,verified_by_user_id,created_at,updated_at,verified_at) VALUES(?,?,?,?,?,'verified',?,?,?,?,?,?)").bind(batchId,input.organizationId,generateCode("SORT"),input.shipmentId,input.locationId,"系统根据验收确认货齐自动生成",input.actorUserId,input.actorUserId,input.now,input.now,input.now));
  const packages=await env.DB.prepare("SELECT id FROM warehouse_packages WHERE organization_id=? AND shipment_id=? AND status IN ('in_stock','allocated')").bind(input.organizationId,input.shipmentId).all<{id:string}>();
  for(const item of packages.results) statements.push(env.DB.prepare("INSERT OR IGNORE INTO warehouse_sorting_items(id,organization_id,batch_id,package_id,status,sorted_by_user_id,verified_by_user_id,sorted_at,verified_at,notes) VALUES(?,?,?,?,'verified',?,?,?,?,?)").bind(crypto.randomUUID(),input.organizationId,batchId,item.id,input.actorUserId,input.actorUserId,input.now,input.now,"验收确认货齐，自动纳入装车范围"));
  await env.DB.batch(statements);
}

async function completeDomesticTransport(organizationId:string,orderId:string,shipmentId:string,actorUserId:string,receiptNumber:string,now:string) {
  const [module,assignment]=await Promise.all([
    env.DB.prepare("SELECT id,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='transport' AND enabled=1").bind(organizationId,orderId).first<{id:string;current_step_code:string|null}>(),
    env.DB.prepare("SELECT id FROM order_transport_assignments WHERE organization_id=? AND order_id=? AND leg_type='first_mile' AND status!='cancelled' ORDER BY created_at DESC LIMIT 1").bind(organizationId,orderId).first<{id:string}>(),
  ]);
  const statements:D1PreparedStatement[]=[env.DB.prepare("UPDATE order_transport_assignments SET status='arrived',actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE organization_id=? AND order_id=? AND leg_type='first_mile' AND status!='cancelled'").bind(now,now,organizationId,orderId)];
  if(assignment) statements.push(env.DB.prepare("UPDATE domestic_waybill_vehicles SET status='arrived',actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE organization_id=? AND assignment_id=?").bind(now,now,organizationId,assignment.id));
  if(module) statements.push(env.DB.prepare("UPDATE order_module_instances SET status='completed',current_step_code='warehouse_arrived',current_step_name='货物已到国内仓',progress_percent=100,completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=? WHERE id=?").bind(now,now,module.id),env.DB.prepare("INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),organizationId,orderId,module.id,"warehouse_acceptance_ready","验收确认货齐",module.current_step_code,"warehouse_arrived","货物已到国内仓",actorUserId,`入库单 ${receiptNumber} 已确认货齐`,now));
  await env.DB.batch(statements);
  await syncOrderWorkflowSnapshot(organizationId,orderId);
  void shipmentId;
}

function nonNegativeNumber(form:FormData,name:string){const raw=valueOf(form,name);if(raw==="")return null;const value=Number(raw);return Number.isFinite(value)&&value>=0?value:null}
function nonNegativeInteger(form:FormData,name:string){const value=nonNegativeNumber(form,name);return value!==null&&Number.isInteger(value)?value:null}
function distributeInteger(total:number,count:number,sequence:number){const base=Math.floor(total/count);return base+(sequence<=total%count?1:0)}
function distributeDecimal(total:number,count:number,sequence:number){const base=Math.floor(total/count*1_000_000)/1_000_000;return sequence===count?Number((total-base*(count-1)).toFixed(6)):base}
function generateCode(prefix:string){return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0,5).toUpperCase()}`}
function generatePackageNumber(orderNumber:string,lineNo:number,sequence:number){return `PK-${orderNumber.replace(/[^A-Z0-9]/gi,"").slice(-14).toUpperCase()}-${lineNo}-${sequence}-${crypto.randomUUID().slice(0,3).toUpperCase()}`}
function packageTypeLabel(value:string){return({carton:"纸箱",pallet:"托盘",wooden_case:"木箱",bag:"袋装",drum:"桶装",bundle:"捆装",other:"其他",mixed:"混合包装"}as Record<string,string>)[value]||value}
export function meta(){return[{title:"验收收货 | International TMS"}]}
