export type WarehouseInboundScanOutcome =
  | "accepted"
  | "duplicate"
  | "not_found"
  | "wrong_warehouse"
  | "unavailable";

export type WarehouseInboundScanResult = {
  outcome: WarehouseInboundScanOutcome;
  scanSessionId: string;
  eventId: string;
  orderId: string | null;
  orderNumber: string | null;
  inboundMarkId: string | null;
  orderReceivingSessionId: string | null;
  duplicateOfEventId: string | null;
  message: string | null;
};

type ResolvedInboundMark = {
  inbound_mark_id: string;
  order_id: string;
  order_number: string;
  shipment_id: string | null;
  eligible_warehouse_id: string | null;
  mark_status: string;
};

type LiveMarkReceipt = {
  id: string;
  first_scan_event_id: string;
  order_receiving_session_id: string;
  status: "scanned" | "confirmed";
};

const normalizeCode = (value: string) => value.trim().toUpperCase();

async function activeScanSession(db: D1Database, input: {
  organizationId: string; warehouseId: string; userId: string; now: string;
}) {
  const found = await db.prepare(
    `SELECT id FROM warehouse_inbound_scan_sessions
      WHERE organization_id=? AND warehouse_id=? AND status='active' LIMIT 1`,
  ).bind(input.organizationId, input.warehouseId).first<{ id: string }>();
  if (found) return found.id;
  const id = crypto.randomUUID();
  try {
    await db.prepare(
      `INSERT INTO warehouse_inbound_scan_sessions(
         id,organization_id,warehouse_id,status,opened_by_user_id,opened_at,created_at,updated_at
       ) VALUES(?,?,?,'active',?,?,?,?)`,
    ).bind(id, input.organizationId, input.warehouseId, input.userId, input.now, input.now, input.now).run();
    return id;
  } catch {
    const concurrent = await db.prepare(
      `SELECT id FROM warehouse_inbound_scan_sessions
        WHERE organization_id=? AND warehouse_id=? AND status='active' LIMIT 1`,
    ).bind(input.organizationId, input.warehouseId).first<{ id: string }>();
    if (!concurrent) throw new Error("无法建立仓库扫码会话");
    return concurrent.id;
  }
}

async function recordEvent(db: D1Database, input: {
  organizationId: string; warehouseId: string; scanSessionId: string; normalizedCode: string;
  requestKey?: string | null; outcome: WarehouseInboundScanOutcome; inboundMarkId?: string | null;
  orderId?: string | null; orderReceivingSessionId?: string | null; duplicateOfEventId?: string | null;
  userId: string; now: string;
}) {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO warehouse_inbound_scan_events(
       id,organization_id,warehouse_id,scan_session_id,normalized_code,request_key,outcome,
       inbound_mark_id,order_id,order_receiving_session_id,duplicate_of_event_id,
       scanned_by_user_id,scanned_at,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, input.organizationId, input.warehouseId, input.scanSessionId, input.normalizedCode,
    input.requestKey ?? null, input.outcome, input.inboundMarkId ?? null, input.orderId ?? null,
    input.orderReceivingSessionId ?? null, input.duplicateOfEventId ?? null, input.userId,
    input.now, input.now, input.now,
  ).run();
  return id;
}

/**
 * Scans an IN mark through the warehouse-wide scanner.  It deliberately does
 * not create a warehouse_receipt: confirmation remains the order session's
 * explicit mutation.  The live-mark unique index is the cross-order and
 * cross-retry duplicate boundary.
 */
export async function scanInboundMarkAtWarehouse(db: D1Database, input: {
  organizationId: string; warehouseId: string; userId: string; code: string;
  now?: string; requestKey?: string | null;
}): Promise<WarehouseInboundScanResult> {
  const now = input.now ?? new Date().toISOString();
  const code = normalizeCode(input.code);
  if (!code) throw new Error("请输入入仓唛头");
  const scanSessionId = await activeScanSession(db, { ...input, now });

  if (input.requestKey) {
    const replay = await db.prepare(
      `SELECT id,outcome,order_id,inbound_mark_id,order_receiving_session_id,duplicate_of_event_id
         FROM warehouse_inbound_scan_events WHERE scan_session_id=? AND request_key=?`,
    ).bind(scanSessionId, input.requestKey).first<{
      id: string; outcome: WarehouseInboundScanOutcome; order_id: string | null; inbound_mark_id: string | null;
      order_receiving_session_id: string | null; duplicate_of_event_id: string | null;
    }>();
    if (replay) return { outcome: replay.outcome, scanSessionId, eventId: replay.id, orderId: replay.order_id,
      orderNumber: null, inboundMarkId: replay.inbound_mark_id, orderReceivingSessionId: replay.order_receiving_session_id,
      duplicateOfEventId: replay.duplicate_of_event_id, message: null };
  }

  const mark = await db.prepare(
    `SELECT mark.id inbound_mark_id,mark.order_id,ord.order_number,
            (SELECT s.id FROM shipments s WHERE s.organization_id=ord.organization_id AND s.order_id=ord.id
             ORDER BY s.updated_at DESC,s.created_at DESC LIMIT 1) shipment_id,
            assignment.destination_warehouse_id eligible_warehouse_id,mark.status mark_status
       FROM order_cargo_packages mark
       JOIN transport_orders ord ON ord.id=mark.order_id AND ord.organization_id=mark.organization_id
       LEFT JOIN order_transport_assignments assignment ON assignment.id=(
         SELECT a.id FROM order_transport_assignments a
          WHERE a.organization_id=ord.organization_id AND a.order_id=ord.id
            AND a.leg_type='first_mile' AND a.status!='cancelled'
          ORDER BY a.updated_at DESC,a.created_at DESC LIMIT 1
       )
      WHERE mark.organization_id=? AND UPPER(mark.package_code)=?
        AND mark.is_active=1 AND mark.status!='cancelled'
      ORDER BY mark.created_at DESC LIMIT 2`,
  ).bind(input.organizationId, code).all<ResolvedInboundMark>();
  if (mark.results.length !== 1) {
    const eventId = await recordEvent(db, { ...input, now, scanSessionId, normalizedCode: code, outcome: "not_found" });
    return { outcome: "not_found", scanSessionId, eventId, orderId: null, orderNumber: null,
      inboundMarkId: null, orderReceivingSessionId: null, duplicateOfEventId: null, message: "未找到唯一有效的入仓唛头" };
  }
  const resolved = mark.results[0];
  if (resolved.eligible_warehouse_id !== input.warehouseId) {
    const eventId = await recordEvent(db, { ...input, now, scanSessionId, normalizedCode: code, outcome: "wrong_warehouse",
      inboundMarkId: resolved.inbound_mark_id, orderId: resolved.order_id });
    return { outcome: "wrong_warehouse", scanSessionId, eventId, orderId: resolved.order_id, orderNumber: resolved.order_number,
      inboundMarkId: resolved.inbound_mark_id, orderReceivingSessionId: null, duplicateOfEventId: null, message: "该入仓唛头不属于当前仓库" };
  }

  const live = await db.prepare(
    `SELECT id,first_scan_event_id,order_receiving_session_id,status
       FROM warehouse_inbound_mark_receipts
      WHERE organization_id=? AND warehouse_id=? AND inbound_mark_id=? AND status IN ('scanned','confirmed') LIMIT 1`,
  ).bind(input.organizationId, input.warehouseId, resolved.inbound_mark_id).first<LiveMarkReceipt>();
  if (live) {
    const eventId = await recordEvent(db, { ...input, now, scanSessionId, normalizedCode: code, outcome: "duplicate",
      inboundMarkId: resolved.inbound_mark_id, orderId: resolved.order_id,
      orderReceivingSessionId: live.order_receiving_session_id, duplicateOfEventId: live.first_scan_event_id });
    return { outcome: "duplicate", scanSessionId, eventId, orderId: resolved.order_id, orderNumber: resolved.order_number,
      inboundMarkId: resolved.inbound_mark_id, orderReceivingSessionId: live.order_receiving_session_id,
      duplicateOfEventId: live.first_scan_event_id, message: live.status === "confirmed" ? "该入仓唛头已完成入库" : "该入仓唛头已在收货会话中" };
  }

  let receiving = await db.prepare(
    `SELECT id FROM warehouse_inbound_order_receiving_sessions
      WHERE organization_id=? AND warehouse_id=? AND order_id=? AND status='scanning' LIMIT 1`,
  ).bind(input.organizationId, input.warehouseId, resolved.order_id).first<{ id: string }>();
  if (!receiving) {
    const id = crypto.randomUUID();
    try {
      await db.prepare(
        `INSERT INTO warehouse_inbound_order_receiving_sessions(
           id,organization_id,warehouse_id,scan_session_id,order_id,shipment_id,status,
           opened_by_user_id,opened_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,?, 'scanning',?,?,?,?)`,
      ).bind(id, input.organizationId, input.warehouseId, scanSessionId, resolved.order_id, resolved.shipment_id,
        input.userId, now, now, now).run();
      receiving = { id };
    } catch {
      receiving = await db.prepare(
        `SELECT id FROM warehouse_inbound_order_receiving_sessions
          WHERE organization_id=? AND warehouse_id=? AND order_id=? AND status='scanning' LIMIT 1`,
      ).bind(input.organizationId, input.warehouseId, resolved.order_id).first<{ id: string }>();
      if (!receiving) throw new Error("无法建立订单收货会话");
    }
  }

  const eventId = crypto.randomUUID();
  const markReceiptId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO warehouse_inbound_scan_events(
           id,organization_id,warehouse_id,scan_session_id,normalized_code,request_key,outcome,inbound_mark_id,order_id,
           order_receiving_session_id,scanned_by_user_id,scanned_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,?, 'accepted',?,?,?,?,?,?,?)`,
      ).bind(eventId, input.organizationId, input.warehouseId, scanSessionId, code, input.requestKey ?? null,
        resolved.inbound_mark_id, resolved.order_id, receiving.id, input.userId, now, now, now),
      db.prepare(
        `INSERT INTO warehouse_inbound_mark_receipts(
           id,organization_id,warehouse_id,inbound_mark_id,order_id,order_receiving_session_id,first_scan_event_id,
           status,scanned_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,'scanned',?,?,?)`,
      ).bind(markReceiptId, input.organizationId, input.warehouseId, resolved.inbound_mark_id, resolved.order_id,
        receiving.id, eventId, now, now, now),
      db.prepare(
        `INSERT INTO warehouse_inbound_order_receiving_items(
           id,organization_id,order_receiving_session_id,inbound_mark_id,mark_receipt_id,created_at
         ) VALUES(?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), input.organizationId, receiving.id, resolved.inbound_mark_id, markReceiptId, now),
    ]);
  } catch {
    const duplicate = await db.prepare(
      `SELECT id,first_scan_event_id,order_receiving_session_id,status FROM warehouse_inbound_mark_receipts
        WHERE organization_id=? AND warehouse_id=? AND inbound_mark_id=? AND status IN ('scanned','confirmed') LIMIT 1`,
    ).bind(input.organizationId, input.warehouseId, resolved.inbound_mark_id).first<LiveMarkReceipt>();
    if (!duplicate) throw new Error("写入入仓扫码记录失败");
    const duplicateEventId = await recordEvent(db, { ...input, now, scanSessionId, normalizedCode: code, outcome: "duplicate",
      inboundMarkId: resolved.inbound_mark_id, orderId: resolved.order_id,
      orderReceivingSessionId: duplicate.order_receiving_session_id, duplicateOfEventId: duplicate.first_scan_event_id });
    return { outcome: "duplicate", scanSessionId, eventId: duplicateEventId, orderId: resolved.order_id,
      orderNumber: resolved.order_number, inboundMarkId: resolved.inbound_mark_id,
      orderReceivingSessionId: duplicate.order_receiving_session_id, duplicateOfEventId: duplicate.first_scan_event_id,
      message: "该入仓唛头已在收货会话中" };
  }
  return { outcome: "accepted", scanSessionId, eventId, orderId: resolved.order_id, orderNumber: resolved.order_number,
    inboundMarkId: resolved.inbound_mark_id, orderReceivingSessionId: receiving.id, duplicateOfEventId: null, message: null };
}
