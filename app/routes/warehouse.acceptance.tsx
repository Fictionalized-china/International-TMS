import { env } from "cloudflare:workers";
import { Form, Link, redirect, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/warehouse.acceptance";
import {
  WarehouseReceiptResultSelector,
  WarehouseReceivingOrderStrip,
  WarehouseReceivingScanPanel,
} from "../components/WarehouseReceivingFlow";
import { ActionToast } from "../components/ActionToast";
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
import { loadOrderModuleWorkflowFields } from "../lib/workflow-fields.server";
import { canOperateWarehouseUi } from "../lib/warehouse-ui-access";
import { loadWarehousePhysicalWorkflowAccess } from "../lib/warehouse-workflow-access.server";
import {
  acceptanceRequiredMarker,
  automaticWarehouseAcceptanceResult,
  resolveWarehouseAcceptancePolicies,
  warehouseAcceptanceReadyIsBlocked,
} from "../lib/warehouse-acceptance-policy";
import {
  calculateWarehouseVolumeCbm,
  formatWarehouseVolumeCbm,
  synchronizeWarehouseVolumeRow,
} from "../lib/warehouse-volume";

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
  planned_inbound_package_count: number;
  planned_inbound_package_type: string;
};

type InboundMark = {
  id:string;
  cargo_item_id:string;
  package_code:string;
  package_sequence:number;
  status:string;
  is_supplemental:number;
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
  let workflowFields: Awaited<ReturnType<typeof loadOrderModuleWorkflowFields>> = [];
  let inboundMarks:InboundMark[]=[];
  let lookupError = "";
  if (reference) {
    const matches = await env.DB.prepare(
      `SELECT o.id,o.order_number,o.status,o.business_type,o.customer_id,c.name customer_name,
              c.identity_code customer_identity_code,o.shipper_contact,o.shipper_phone,
              o.origin_city,o.origin_address,o.planned_inbound_package_count,o.planned_inbound_package_type,
              s.id shipment_id,s.shipment_number,
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
      const workflowAccess = await loadWarehousePhysicalWorkflowAccess(
        env.DB,
        user.organizationId,
        order.id,
        "warehouse",
        { userId: user.userId, positionCode: user.positionCode },
      );
      if (!workflowAccess.available) {
        lookupError = workflowAccess.reason || "当前订单的冻结工作流尚未开放国内仓入库";
        order = null;
      } else {
        const [cargo,marks] = await Promise.all([env.DB.prepare(
          `SELECT i.id,i.line_no,i.cargo_name_cn,i.cargo_name_en,i.hs_code,i.package_type,
                  i.package_count,i.pieces_per_package,i.gross_weight_per_package_kg,
                  i.net_weight_per_package_kg,i.length_cm,i.width_cm,i.height_cm,
                  i.volume_per_package_cbm,i.marks,i.notes,
                  COALESCE((SELECT COUNT(*) FROM order_cargo_packages mark WHERE mark.cargo_item_id=i.id AND mark.is_active=1 AND mark.status='received'),0) received_packages,
                  0 received_pieces,
                  COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_weight_kg ELSE 0 END),0) received_weight_kg,
                  COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN ri.actual_volume_cbm ELSE 0 END),0) received_volume_cbm
             FROM order_cargo_items i
             LEFT JOIN warehouse_receipt_items ri ON ri.cargo_item_id=i.id AND ri.organization_id=i.organization_id
             LEFT JOIN warehouse_receipts r ON r.id=ri.receipt_id AND r.status='completed' AND r.warehouse_id=?
            WHERE i.organization_id=? AND i.order_id=?
            GROUP BY i.id
            ORDER BY i.line_no,i.id`,
        ).bind(warehouse.id, user.organizationId, order.id).all<CargoItem>(),env.DB.prepare(
          `SELECT id,cargo_item_id,package_code,package_sequence,status,is_supplemental
             FROM order_cargo_packages
            WHERE organization_id=? AND order_id=? AND is_active=1 AND status!='cancelled'
            ORDER BY package_sequence`,
        ).bind(user.organizationId,order.id).all<InboundMark>()]);
        cargoItems = cargo.results;
        inboundMarks=marks.results;
        workflowFields = await loadOrderModuleWorkflowFields(
          user.organizationId,
          order.id,
          "warehouse",
        );
        if (!cargoItems.length) lookupError = "该订单没有货物明细，不能办理逐条验收，请先在订单中补充货物";
      }
    }
  }

  return {
    user,
    warehouse,
    warehouseAccessLevel: warehouseContext.selectedAccessLevel,
    reference,
    order,
    cargoItems,
    inboundMarks,
    workflowFields,
    locations: locations.results,
    recentLabels: recentLabels.results,
    receiptId,
    resultMessage: acceptanceResult === "ready"
      ? `验收入库完成，订单已确认货齐，本次扫描 ${recentLabels.results.length} 个入仓包装`
      : acceptanceResult === "exception"
        ? `异常货物已入库并冻结，本次扫描 ${recentLabels.results.length} 个入仓包装，请到异常处理结案`
        : acceptanceResult === "partial"
          ? `本批货物已入库，本次扫描 ${recentLabels.results.length} 个入仓包装；订单继续等待后续到货`
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
  const requestedLocationId = valueOf(form, "locationId");
  const requestedResult = valueOf(form, "receiptResult");
  const scannedMarkCodes=parseScannedCodes(valueOf(form,"scannedMarkCodes"));
  let exceptionNotes = valueOf(form, "exceptionNotes").trim();
  const notes = valueOf(form, "notes").trim();
  if (!orderId) return { formError: "订单不能为空" };

  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.customer_id,o.origin_city,o.planned_inbound_package_count,
            o.planned_inbound_package_type,s.id shipment_id,s.shipment_number
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
    planned_inbound_package_count:number; planned_inbound_package_type:string;
  }>();
  if (!order) return { formError: "订单不存在、状态不可收货，或计划入库仓库与当前仓库不一致" };

  const workflowAccess = await loadWarehousePhysicalWorkflowAccess(
    env.DB,
    user.organizationId,
    order.id,
    "warehouse",
    { userId: user.userId, positionCode: user.positionCode },
  );
  if (!workflowAccess.available)
    return { formError: workflowAccess.reason || "当前订单的冻结工作流尚未开放国内仓入库" };

  const workflowFields = await loadOrderModuleWorkflowFields(
    user.organizationId,
    order.id,
    "warehouse",
  );
  const policies = resolveWarehouseAcceptancePolicies(workflowFields);
  if (policies.notes.isActive && policies.notes.isRequired && !notes)
    return { formError: "请填写收货备注" };

  let result: "partial" | "ready" | "exception" | "auto";
  if (policies.cargoComplete.isActive) {
    if (!["partial", "ready", "exception"].includes(requestedResult)) {
      if (policies.cargoComplete.isRequired)
        return { formError: "请选择本次验收结果" };
      result = "partial";
    } else {
      result = requestedResult as "partial" | "ready" | "exception";
    }
  } else {
    // Hidden means the operator no longer decides this workflow gate. The
    // server derives ready/partial/exception after comparing cumulative stock.
    result = "auto";
  }

  let locationId = requestedLocationId;
  if (!locationId && (!policies.location.isActive || !policies.location.isRequired)) {
    const defaultLocation = await env.DB.prepare(
      `SELECT l.id FROM warehouse_locations l
        JOIN warehouse_zones z ON z.id=l.zone_id JOIN warehouses w ON w.id=l.warehouse_id
       WHERE l.organization_id=? AND l.warehouse_id=?
         AND l.status='active' AND z.status='active' AND w.status='active'
       ORDER BY z.code,l.code LIMIT 1`,
    ).bind(user.organizationId, warehouse.id).first<{ id: string }>();
    locationId = defaultLocation?.id ?? "";
  }
  if (!locationId)
    return { formError: "请选择入库库位" };

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
            gross_weight_per_package_kg,volume_per_package_cbm,
            COALESCE((
              SELECT SUM(ri.actual_packages)
              FROM warehouse_receipt_items ri
              JOIN warehouse_receipts r ON r.id=ri.receipt_id
              WHERE ri.organization_id=order_cargo_items.organization_id
                AND ri.cargo_item_id=order_cargo_items.id
                AND r.warehouse_id=? AND r.status='completed'
            ),0) received_packages
       FROM order_cargo_items WHERE organization_id=? AND order_id=? ORDER BY line_no,id`,
  ).bind(warehouse.id, user.organizationId, order.id).all<{
    id: string; line_no: number; cargo_name_cn: string; package_type: string;
    package_count: number; pieces_per_package: number;
    gross_weight_per_package_kg: number; volume_per_package_cbm: number;
    received_packages: number;
  }>();
  if (!cargo.results.length) return { formError: "订单没有货物明细，无法验收" };

  if(!scannedMarkCodes.length)return{formError:"请至少扫描一张入仓唛头"};
  const existingMarks=await env.DB.prepare(
    `SELECT id,cargo_item_id,package_code,package_sequence,status,is_supplemental
       FROM order_cargo_packages
      WHERE organization_id=? AND order_id=? AND is_active=1 AND status!='cancelled'
      ORDER BY package_sequence`,
  ).bind(user.organizationId,order.id).all<InboundMark>();
  const marksByCode=new Map(existingMarks.results.map(mark=>[mark.package_code.toUpperCase(),mark]));
  const supplementalMarks:InboundMark[]=[];
  const scannedMarks:InboundMark[]=[];
  let nextSupplementalSequence=Math.max(
    order.planned_inbound_package_count,
    ...existingMarks.results.map(mark=>mark.package_sequence),
  )+1;
  for(const code of scannedMarkCodes){
    const existing=marksByCode.get(code);
    if(existing){
      if(existing.status==='received')return{formError:`入仓唛头 ${existing.package_code} 已收货，不能重复扫描`};
      scannedMarks.push(existing);
      continue;
    }
    const match=code.match(new RegExp(`^${escapeRegExp(order.order_number)}-IN-(\\d{3})$`,'i'));
    const sequence=match?Number(match[1]):0;
    if(!sequence||sequence!==nextSupplementalSequence)
      return{formError:`${code} 不是当前订单的有效入仓唛头`};
    const supplemental:InboundMark={
      id:crypto.randomUUID(),cargo_item_id:cargo.results[0].id,package_code:code,
      package_sequence:sequence,status:'planned',is_supplemental:1,
    };
    marksByCode.set(code,supplemental);
    supplementalMarks.push(supplemental);
    scannedMarks.push(supplemental);
    nextSupplementalSequence+=1;
  }
  const scannedCountByCargo=new Map<string,number>();
  for(const mark of scannedMarks)scannedCountByCargo.set(mark.cargo_item_id,(scannedCountByCargo.get(mark.cargo_item_id)||0)+1);

  const actualRows = cargo.results.map((item, index) => {
    const actualPackages = scannedCountByCargo.get(item.id)||0;
    const actualLength = nonNegativeNumber(form, `actualLength_${index}`);
    const actualWidth = nonNegativeNumber(form, `actualWidth_${index}`);
    const actualHeight = nonNegativeNumber(form, `actualHeight_${index}`);
    return {
      ...item,
      actualPackages,
      packageCountProvided: true,
      packageCountInvalid: false,
      actualPieces: null,
      actualWeight: policies.actualWeight.isActive
        ? nonNegativeNumber(form, `actualWeight_${index}`)
        : null,
      actualVolume: policies.actualVolume.isActive
        ? calculateWarehouseVolumeCbm({
            lengthCm: actualLength,
            widthCm: actualWidth,
            heightCm: actualHeight,
            packageCount: actualPackages,
          })
        : null,
      actualLength,
      actualWidth,
      actualHeight,
      itemNotes: valueOf(form, `itemNotes_${index}`).trim(),
    };
  });
  if (actualRows.some((item) => item.packageCountInvalid))
    return { formError: "实收包装数如果填写，必须是有效的非负整数" };
  const receivedRows = actualRows.filter((item) => item.actualPackages > 0);
  if (receivedRows.some((item) => !item.actualLength || !item.actualWidth || !item.actualHeight))
    return { formError: "有实收包装的货物必须填写大于 0 的实际长、宽、高" };
  if (policies.actualWeight.isRequired && receivedRows.some((item) => !item.actualWeight))
    return { formError: "有实收包装的货物必须填写大于 0 的实际重量" };
  if (policies.actualVolume.isRequired && receivedRows.some((item) => !item.actualVolume))
    return { formError: "有实收包装的货物必须填写大于 0 的实际体积" };
  const inventoryRows = receivedRows.map((item) => ({
    ...item,
    // A package row needs at least one piece for the physical inventory
    // constraint. Optional/hidden piece counts therefore use the conservative
    // one-piece-per-package minimum for package rows, while the receipt keeps
    // zero so a future optional->required change still sees the measurement as
    // missing rather than falsely treating this fallback as warehouse data.
    actualPieces: item.actualPieces ?? 0,
    packagePieces: item.actualPieces ?? (item.actualPackages as number),
    actualWeight: item.actualWeight ?? 0,
    actualVolume: item.actualVolume ?? 0,
  }));

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
  const totalPackages = inventoryRows.reduce((sum, item) => sum + (item.actualPackages ?? 0), 0);
  const totalPieces = inventoryRows.reduce((sum, item) => sum + item.actualPieces, 0);
  const totalWeight = inventoryRows.reduce((sum, item) => sum + item.actualWeight, 0);
  const totalVolume = inventoryRows.reduce((sum, item) => sum + item.actualVolume, 0);
  const packageTypes = [...new Set(inventoryRows.map((item) => item.package_type))];
  const expectedCargo = cargo.results.reduce((sum, item) => ({
    pieces: sum.pieces + item.package_count * item.pieces_per_package,
    weightKg: sum.weightKg + item.package_count * item.gross_weight_per_package_kg,
    volumeCbm: sum.volumeCbm + item.package_count * item.volume_per_package_cbm,
  }), { pieces: 0, weightKg: 0, volumeCbm: 0 });
  const expected = { packages: order.planned_inbound_package_count, ...expectedCargo };
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
  const piecesComparable = policies.actualPieces.isActive &&
    receivedRows.every((item) => item.actualPieces !== null);
  const weightComparable = policies.actualWeight.isActive &&
    receivedRows.every((item) => item.actualWeight !== null);
  const volumeComparable = policies.actualVolume.isActive &&
    receivedRows.every((item) => item.actualVolume !== null);
  const difference = calculateWarehouseDifference(
    {
      pieces: piecesComparable ? expected.pieces : cumulative.pieces,
      weightKg: weightComparable ? expected.weightKg : cumulative.weightKg,
      volumeCbm: volumeComparable ? expected.volumeCbm : cumulative.volumeCbm,
    },
    cumulative,
  );
  const packageMismatch = cumulative.packages !== expected.packages;
  const piecesMismatch = piecesComparable && cumulative.pieces !== expected.pieces;
  const acceptanceComparison = {
    actualPackages: cumulative.packages,
    expectedPackages: expected.packages,
    piecesMismatch,
    requiresFeeConfirmation: difference.requiresFeeConfirmation,
  };
  if (result === "auto") {
    result = automaticWarehouseAcceptanceResult(acceptanceComparison);
    if (result === "exception") {
      exceptionNotes ||= "系统已隐藏人工货齐选择，实收超量或差异较大，已自动转为异常入库";
    }
  }
  if(supplementalMarks.length){
    result="exception";
    exceptionNotes||=`超计划收货 ${supplementalMarks.length} 包，已生成补录唛头，等待操作岗确认差异`;
  }
  if (!inventoryRows.length && result !== "ready")
    return { formError: "本次至少要验收一个实际包装" };
  if (result === "exception" && !exceptionNotes)
    return { formError: "异常入库必须填写异常说明" };
  if (cumulative.packages > expected.packages && result !== "exception")
    return {
      formError: `累计实收 ${cumulative.packages} 包已超过计划 ${expected.packages} 包，不能按正常或货齐入库。请选择“异常入库”并填写说明。`,
    };
  if (result === "ready" && warehouseAcceptanceReadyIsBlocked(acceptanceComparison))
    return {
      formError: `累计实收与预录差异较大，不能直接确认货齐：预录 ${expected.packages} 包/${expected.pieces} 件，累计实收 ${cumulative.packages} 包/${cumulative.pieces} 件，最大可比实收差异 ${difference.maxPercent.toFixed(1)}%。请选择“异常入库”并处理差异。`,
    };

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
  const effectiveNotes = policies.notes.isActive ? notes : "";
  const locationText = `${location.warehouse_name} / ${location.zone_name} / ${location.name} (${location.code})`;
  const statements: D1PreparedStatement[] = [...bootstrap];
  for(const mark of supplementalMarks){
    statements.push(env.DB.prepare(
      `INSERT INTO order_cargo_packages(
        id,organization_id,order_id,cargo_item_id,package_code,package_sequence,status,created_at,
        label_revision,is_active,is_supplemental
      ) VALUES(?,?,?,?,?,?,'planned',?,1,1,1)`,
    ).bind(mark.id,user.organizationId,order.id,mark.cargo_item_id,mark.package_code,mark.package_sequence,now));
  }
  statements.push(env.DB.prepare(
    `UPDATE transport_orders SET inbound_package_locked_at=COALESCE(inbound_package_locked_at,?),updated_at=?
      WHERE id=? AND organization_id=?`,
  ).bind(now,now,order.id,user.organizationId));
  statements.push(
    env.DB.prepare(
      `INSERT INTO warehouse_receipts(
        id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,status,
        total_packages,total_pieces,total_weight_kg,total_volume_cbm,notes,received_by_user_id,
        received_at,created_at,updated_at,package_type,evidence_note,cargo_complete,has_exception,exception_notes
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      receiptId,user.organizationId,receiptNumber,shipmentId,warehouse.id,location.id,"completed",
      totalPackages,totalPieces,totalWeight,totalVolume,effectiveNotes || null,user.userId,now,now,now,
      packageTypes.length === 1 ? packageTypes[0] : "mixed",null,result === "ready" ? 1 : 0,
      result === "exception" ? 1 : 0,exceptionNotes || null,
    ),
  );

  const createdPackages: { id: string; barcode: string }[] = [];
  for (const item of inventoryRows) {
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
    const itemMarks=scannedMarks.filter(mark=>mark.cargo_item_id===item.id);
    for (let sequence = 1; sequence <= itemMarks.length; sequence += 1) {
      const inboundMark=itemMarks[sequence-1];
      const packageId = crypto.randomUUID();
      const barcode = inboundMark.package_code;
      const packageNumber = inboundMark.package_code;
      const pieces = 1;
      const weight = actualWeight > 0
        ? distributeDecimal(actualWeight, actualPackages, sequence)
        : null;
      const volume = actualVolume > 0
        ? distributeDecimal(actualVolume, actualPackages, sequence)
        : null;
      const packageStatus = result === "exception" && sequence === 1 && createdPackages.length === 0 ? "exception" : "in_stock";
      createdPackages.push({ id: packageId, barcode });
      statements.push(
        env.DB.prepare(
          `INSERT INTO warehouse_packages(
            id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,
            pieces,weight_kg,volume_cbm,length_cm,width_cm,height_cm,status,notes,created_at,updated_at,cargo_item_id
            ,label_kind,lifecycle_status,source_order_package_id
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'inbound_mark','active',?)`,
        ).bind(
          packageId,user.organizationId,receiptId,shipmentId,warehouse.id,location.id,barcode,packageNumber,
          pieces,weight,volume,actualLength,actualWidth,actualHeight,packageStatus,item.itemNotes || effectiveNotes || null,now,now,item.id,inboundMark.id,
        ),
        env.DB.prepare(
          `UPDATE order_cargo_packages
              SET status='received',received_at=?,received_warehouse_id=?,received_location_id=?,received_by_user_id=?
            WHERE id=? AND organization_id=? AND status='planned' AND is_active=1`,
        ).bind(now,warehouse.id,location.id,user.userId,inboundMark.id,user.organizationId),
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
    ).bind(
      crypto.randomUUID(),
      user.organizationId,
      shipmentId,
      locationText,
      totalPieces > 0 ? totalPieces : null,
      totalWeight > 0 ? totalWeight : null,
      totalVolume > 0 ? totalVolume : null,
      effectiveNotes || exceptionNotes || null,
      user.userId,
      now,
      now,
      location.id,
    ),
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

  if (result !== "partial" && (difference.hasDifference || packageMismatch || piecesMismatch)) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO warehouse_receipt_differences(
          id,organization_id,receipt_id,order_id,planned_pieces,planned_weight_kg,planned_volume_cbm,
          actual_pieces,actual_weight_kg,actual_volume_cbm,max_difference_percent,status,notes,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      ).bind(
        crypto.randomUUID(),user.organizationId,receiptId,order.id,expected.pieces,expected.weightKg,
        expected.volumeCbm,cumulative.pieces,cumulative.weightKg,cumulative.volumeCbm,difference.maxPercent,
        exceptionNotes || effectiveNotes || "仓库验收实收与预录存在差异",now,now,
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
  const actionError = actionData?.formError;
  const canOperate = canOperateWarehouseUi(
    loaderData.user,
    loaderData.warehouseAccessLevel,
  );
  const [receiptResult, setReceiptResult] = useState<"partial" | "ready" | "exception">("partial");
  const [markInput,setMarkInput]=useState("");
  const [scannedMarks,setScannedMarks]=useState<string[]>([]);
  const labels = loaderData.receiptId ? loaderData.recentLabels : [];
  const policies = resolveWarehouseAcceptancePolicies(loaderData.workflowFields);
  useEffect(() => {setReceiptResult("partial");setScannedMarks([]);setMarkInput("");}, [loaderData.order?.id]);
  const addScannedMark=()=>{
    const code=markInput.trim().toUpperCase();
    if(!code)return;
    setScannedMarks(current=>current.includes(code)?current:[...current,code]);
    setMarkInput("");
  };
  return <>
    <header className="page-header acceptance-header"><div><p className="eyebrow">ACCEPTANCE RECEIVING</p><h1>验收收货</h1><p>先调出订单，再逐一扫描客户已粘贴的入仓唛头；系统保存到仓时间、库位和操作人，不在仓库重复统计商品件数。</p></div></header>
    <ActionToast message={actionError ?? loaderData.resultMessage} tone={actionError ? "error" : "success"} data={actionData}/>
    {!loaderData.locations.length && <div className="alert error">当前仓库没有可用库位，请先<Link to={`/warehouse/locations?warehouseId=${loaderData.warehouse.id}`}>配置仓库与库位</Link>。</div>}
    {canOperate ? <WarehouseReceivingScanPanel
      warehouseId={loaderData.warehouse.id}
      reference={loaderData.reference}
      inputLabel="扫描订单号"
      placeholder="扫描订单号条码后回车"
      submitLabel="调出验收信息"
      hint="扫描枪输入订单号并发送回车后，系统自动读取客户、货物、运输和累计收货信息。"
    /> : <div className="alert info">当前账号为仓库只读视角，可查看入库结果与历史标签；验收扫描和入库提交仅向有操作权限的冻结任务负责人开放。</div>}
    {loaderData.lookupError && <div className="alert error no-print">{loaderData.lookupError}</div>}
    {canOperate && loaderData.order && loaderData.cargoItems.length > 0 && <Form method="post" className="acceptance-workbench no-print" onInput={(event) => synchronizeWarehouseVolumeRow(event.target)}>
      <input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/><input type="hidden" name="orderId" value={loaderData.order.id}/><input type="hidden" name="reference" value={loaderData.order.order_number}/>
      <input type="hidden" name="scannedMarkCodes" value={JSON.stringify(scannedMarks)}/>
      <WarehouseReceivingOrderStrip facts={[
        { label: "订单 / 类型", value: `${loaderData.order.order_number} · ${loaderData.order.business_type === "ftl" ? "整车" : "拼车"}` },
        { label: "客户", value: `[${loaderData.order.customer_identity_code}] ${loaderData.order.customer_name}` },
        { label: "发货联系人", value: `${loaderData.order.shipper_contact || "未填写"} · ${loaderData.order.shipper_phone || "未填写"}` },
        { label: "国内运输", value: loaderData.order.carrier_name || "承运商未填写", detail: loaderData.order.vehicle_summary || "车辆与司机未填写" },
        { label: "提货地", value: `${loaderData.order.origin_city} · ${loaderData.order.origin_address}` },
      ]}/>
      <section className="panel inbound-mark-scan-panel">
        <div className="panel-header"><div><h2>扫描本批入仓唛头</h2><p>每个外包装扫描一次；重复扫描只提示且不重复计数。超收时可直接扫描连续补录码，例如 {loaderData.order.order_number}-IN-{String(loaderData.order.planned_inbound_package_count+1).padStart(3,"0")}。</p></div><strong>{scannedMarks.length} 个待提交</strong></div>
        <div className="inbound-mark-scan-row"><input className="control" value={markInput} onChange={event=>setMarkInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();addScannedMark();}}} placeholder="扫描入仓唛头后回车" autoFocus/><button type="button" className="btn primary" onClick={addScannedMark}>加入本批</button></div>
        <div className="inbound-mark-progress"><span>计划 {loaderData.order.planned_inbound_package_count} 包</span><span>历史已收 {loaderData.inboundMarks.filter(mark=>mark.status==='received').length} 包</span><span>本次 {scannedMarks.length} 包</span></div>
        {scannedMarks.length>0&&<div className="inbound-mark-chip-list">{scannedMarks.map(code=><button key={code} type="button" onClick={()=>setScannedMarks(current=>current.filter(item=>item!==code))} title="点击移除">{code}<span>×</span></button>)}</div>}
      </section>
      <section className="panel acceptance-cargo-panel">
        <div className="panel-header"><div><h2>预录货物与本次实收</h2><p>每条货物按本次实际到仓填写；未在本批到仓的货物全部填 0。长宽高用于生成实物库存与标签，固定为系统必填。</p></div><span className="status-pill">{loaderData.cargoItems.length} 条货物</span></div>
        <div className="alert info">本次包装数完全按上方已扫描唛头计算；商品件数不参与仓库收货门禁。</div>
        <div className="table-wrap acceptance-cargo-table"><table><thead><tr>
          <th>预录货物</th><th>计划数据</th><th>累计已收</th>
          <th>本次扫码包装</th>
          {policies.actualWeight.isActive && <th>实际重量 KG{acceptanceRequiredMarker(policies.actualWeight)}</th>}
          <th>实际长×宽×高 CM{acceptanceRequiredMarker(policies.actualDimensions)}</th>
          {policies.actualVolume.isActive && <th>实际体积 CBM（自动计算）{acceptanceRequiredMarker(policies.actualVolume)}</th>}
          <th>本行备注</th>
        </tr></thead><tbody>{loaderData.cargoItems.map((item,index) => {
          const expectedWeight = item.package_count * item.gross_weight_per_package_kg;
          const expectedVolume = item.package_count * item.volume_per_package_cbm;
          const knownCodes=new Set(loaderData.inboundMarks.filter(mark=>mark.cargo_item_id===item.id).map(mark=>mark.package_code.toUpperCase()));
          const scannedForItem=scannedMarks.filter(code=>knownCodes.has(code)).length+
            (index===0?scannedMarks.filter(code=>!loaderData.inboundMarks.some(mark=>mark.package_code.toUpperCase()===code)).length:0);
          const calculatedVolume = calculateWarehouseVolumeCbm({
            lengthCm: item.length_cm,
            widthCm: item.width_cm,
            heightCm: item.height_cm,
            packageCount: scannedForItem,
          });
          return <tr key={item.id} data-warehouse-volume-row data-warehouse-volume-packages={scannedForItem}>
            <td><strong>{item.line_no}. {item.cargo_name_cn}</strong><small>{item.cargo_name_en || "—"} · HS {item.hs_code || "—"}</small><small>{packageTypeLabel(item.package_type)} · {item.length_cm}×{item.width_cm}×{item.height_cm} cm</small></td>
            <td><strong>{item.package_count} 个入仓包装</strong><small>{expectedWeight.toFixed(2)} KG · {expectedVolume.toFixed(3)} CBM</small></td>
            <td><strong>{item.received_packages} 个已收包装</strong><small>{item.received_weight_kg.toFixed(2)} KG · {item.received_volume_cbm.toFixed(3)} CBM</small></td>
            <td><strong>{scannedForItem}</strong><small>按唛头自动汇总</small></td>
            {policies.actualWeight.isActive && <td><input name={`actualWeight_${index}`} type="number" min="0" step="0.001" defaultValue={(item.gross_weight_per_package_kg*scannedForItem).toFixed(3)} required={policies.actualWeight.isRequired}/></td>}
            <td><div className="acceptance-dimensions"><input name={`actualLength_${index}`} type="number" min="0" step="0.1" defaultValue={item.length_cm} aria-label="实际长度" required data-warehouse-volume-length/><span>×</span><input name={`actualWidth_${index}`} type="number" min="0" step="0.1" defaultValue={item.width_cm} aria-label="实际宽度" required data-warehouse-volume-width/><span>×</span><input name={`actualHeight_${index}`} type="number" min="0" step="0.1" defaultValue={item.height_cm} aria-label="实际高度" required data-warehouse-volume-height/></div></td>
            {policies.actualVolume.isActive && <td><input name={`actualVolume_${index}`} aria-label="实际体积 CBM（自动计算）" type="number" min="0" step="0.0001" defaultValue={formatWarehouseVolumeCbm(calculatedVolume)} required={policies.actualVolume.isRequired} readOnly data-warehouse-volume-output/></td>}
            <td><input name={`itemNotes_${index}`} placeholder="选填"/></td>
          </tr>;
        })}</tbody></table></div>
      </section>
      <section className="panel acceptance-confirm-panel">
        {policies.location.isActive ? <label className="field"><span>入库库位{acceptanceRequiredMarker(policies.location)}</span><select name="locationId" required={policies.location.isRequired}><option value="">{policies.location.isRequired ? "请选择库位" : "未选则使用首个启用库位"}</option>{loaderData.locations.map((item) => <option key={item.id} value={item.id}>{item.warehouse_name} / {item.zone_name} / {item.name}（{item.code}）</option>)}</select></label> : <div className="alert info">入库库位已在当前工作流中隐藏，系统将使用当前仓库首个启用库位。</div>}
        {policies.cargoComplete.isActive ? <WarehouseReceiptResultSelector
          value={receiptResult}
          onChange={(value) => value && setReceiptResult(value)}
          showPartial
          readyLabel="订单货齐"
          readyHint="本次入库后，订单全部货物已经到齐"
          required={policies.cargoComplete.isRequired}
          exceptionHint="允许入库但冻结后续装车和配载"
          exceptionFooter="填写短少、破损、错货、超差等具体情况"
        /> : <div className="alert info">货齐选择已在当前工作流中隐藏：系统依据累计包装数和已填的实收数据自动判定分批、货齐或异常。</div>}
        {policies.notes.isActive && <label className="field span-2"><span>收货备注{acceptanceRequiredMarker(policies.notes)}</span><textarea name="notes" rows={2} required={policies.notes.isRequired} placeholder="本次到货车辆、现场情况等"/></label>}
        <button className="primary acceptance-submit" disabled={busy || !canOperate || !loaderData.locations.length || !scannedMarks.length}>{busy ? "正在验收入库…" : "确认本批扫码入库"}</button>
      </section>
    </Form>}
  </>;
}

async function ensureVerifiedReceivingBatch(input:{organizationId:string;shipmentId:string;locationId:string;actorUserId:string;now:string}) {
  const existing=await env.DB.prepare("SELECT id FROM warehouse_sorting_batches WHERE organization_id=? AND shipment_id=? AND status!='cancelled' ORDER BY created_at DESC LIMIT 1").bind(input.organizationId,input.shipmentId).first<{id:string}>();
  const batchId=existing?.id??crypto.randomUUID();const statements:D1PreparedStatement[]=[];
  if(existing) statements.push(env.DB.prepare("UPDATE warehouse_sorting_batches SET target_location_id=?,status='verified',verified_by_user_id=?,verified_at=COALESCE(verified_at,?),updated_at=? WHERE id=? AND organization_id=?").bind(input.locationId,input.actorUserId,input.now,input.now,batchId,input.organizationId));
  else statements.push(env.DB.prepare("INSERT INTO warehouse_sorting_batches(id,organization_id,batch_number,shipment_id,target_location_id,status,notes,created_by_user_id,verified_by_user_id,created_at,updated_at,verified_at) VALUES(?,?,?,?,?,'verified',?,?,?,?,?,?)").bind(batchId,input.organizationId,generateCode("SORT"),input.shipmentId,input.locationId,"系统根据验收确认货齐自动生成",input.actorUserId,input.actorUserId,input.now,input.now,input.now));
  const packages=await env.DB.prepare("SELECT id FROM warehouse_packages WHERE organization_id=? AND shipment_id=? AND label_kind='inbound_mark' AND lifecycle_status='active' AND status='in_stock'").bind(input.organizationId,input.shipmentId).all<{id:string}>();
  for(const item of packages.results) statements.push(env.DB.prepare("INSERT OR IGNORE INTO warehouse_sorting_items(id,organization_id,batch_id,package_id,status,sorted_by_user_id,verified_by_user_id,sorted_at,verified_at,notes) VALUES(?,?,?,?,'verified',?,?,?,?,?)").bind(crypto.randomUUID(),input.organizationId,batchId,item.id,input.actorUserId,input.actorUserId,input.now,input.now,"验收确认货齐，自动纳入装车范围"));
  await env.DB.batch(statements);
}

async function completeDomesticTransport(organizationId:string,orderId:string,shipmentId:string,actorUserId:string,receiptNumber:string,now:string) {
  const [module,assignment]=await Promise.all([
    env.DB.prepare("SELECT id,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='transport' AND enabled=1").bind(organizationId,orderId).first<{id:string;current_step_code:string|null}>(),
    env.DB.prepare("SELECT id FROM order_transport_assignments WHERE organization_id=? AND order_id=? AND leg_type='first_mile' AND status!='cancelled' ORDER BY created_at DESC LIMIT 1").bind(organizationId,orderId).first<{id:string}>(),
  ]);
  const statements:D1PreparedStatement[]=[
    env.DB.prepare("UPDATE order_transport_assignments SET status='arrived',actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE organization_id=? AND order_id=? AND leg_type='first_mile' AND status!='cancelled'").bind(now,now,organizationId,orderId),
    env.DB.prepare("UPDATE shipments SET actual_delivery_at=COALESCE(actual_delivery_at,?),updated_at=? WHERE id=? AND organization_id=?").bind(now,now,shipmentId,organizationId),
  ];
  if(assignment) statements.push(env.DB.prepare("UPDATE domestic_waybill_vehicles SET status='arrived',actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE organization_id=? AND assignment_id=?").bind(now,now,organizationId,assignment.id));
  if(module) statements.push(env.DB.prepare("UPDATE order_module_instances SET status='completed',current_step_code='warehouse_arrived',current_step_name='货物已到国内仓',progress_percent=100,completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=? WHERE id=?").bind(now,now,module.id),env.DB.prepare("INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),organizationId,orderId,module.id,"warehouse_acceptance_ready","验收确认货齐",module.current_step_code,"warehouse_arrived","货物已到国内仓",actorUserId,`入库单 ${receiptNumber} 已确认货齐`,now));
  await env.DB.batch(statements);
  await syncOrderWorkflowSnapshot(organizationId,orderId);
}

function nonNegativeNumber(form:FormData,name:string){const raw=valueOf(form,name);if(raw==="")return null;const value=Number(raw);return Number.isFinite(value)&&value>=0?value:null}
function distributeDecimal(total:number,count:number,sequence:number){const base=Math.floor(total/count*1_000_000)/1_000_000;return sequence===count?Number((total-base*(count-1)).toFixed(6)):base}
function generateCode(prefix:string){return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0,5).toUpperCase()}`}
function packageTypeLabel(value:string){return({carton:"纸箱",pallet:"托盘",wooden_case:"木箱",bag:"袋装",drum:"桶装",bundle:"捆装",other:"其他",mixed:"混合包装"}as Record<string,string>)[value]||value}
function parseScannedCodes(raw:string){
  if(!raw)return[];
  try{
    const value=JSON.parse(raw);
    if(!Array.isArray(value))return[];
    return [...new Set(value.map(item=>String(item).trim().toUpperCase()).filter(Boolean))];
  }catch{return[]}
}
function escapeRegExp(value:string){return value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}
export function meta(){return[{title:"验收收货 | International TMS"}]}
