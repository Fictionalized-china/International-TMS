import { env } from "cloudflare:workers";
import { syncOrderWorkflowSnapshot } from "./order-modules.server";
import { portalOrderListLink } from "./portal-notification-links";
import { loadOverseasInboundCustomsGates } from "./overseas-inbound-policy.server";

type ArrivalInput = {
  organizationId: string;
  batchId?: string | null;
  orderId?: string | null;
  actualArrivalAt: string;
  actorUserId: string;
  notes?: string;
};

type AdvanceInput = {
  organizationId: string;
  orderId: string;
  actorUserId: string;
  action: "notify" | "pickup";
  occurredAt: string;
  pickupContact?: string;
  pickupProofReference?: string;
  notes?: string;
};

type AutomaticNoticeInput = {
  organizationId: string;
  orderId: string;
  actorUserId: string;
  occurredAt?: string;
};

type BatchOrder = {
  order_id: string;
  order_number: string;
  overseas_warehouse_id: string | null;
  warehouse_name: string | null;
  warehouse_address: string | null;
  customs_clearance_mode: "company" | "customer";
};

export async function confirmOverseasBatchArrival(input: ArrivalInput) {
  if (!input.batchId) {
    if (!input.orderId) throw new Error("未找到配载批次或整车订单");
    return confirmStandaloneOrderArrival(input as ArrivalInput & { orderId: string });
  }
  const batch = await env.DB.prepare(
    "SELECT id,batch_number,road_status FROM transport_batches WHERE id=? AND organization_id=?",
  )
    .bind(input.batchId, input.organizationId)
    .first<{ id: string; batch_number: string; road_status: string }>();
  if (!batch) throw new Error("配载批次不存在");
  if (![
    "outbound_in_transit",
    "overseas_arrived",
    "waiting_pickup",
  ].includes(batch.road_status))
    throw new Error("批次尚未确认出境，不能登记境外到仓");

  const orders = await env.DB.prepare(
    `SELECT DISTINCT bo.order_id,o.order_number,o.overseas_warehouse_id,w.name warehouse_name,w.address warehouse_address,o.customs_clearance_mode
     FROM transport_batch_orders bo
     JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     LEFT JOIN warehouses w ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
     WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'`,
  )
    .bind(input.batchId, input.organizationId)
    .all<BatchOrder>();
  if (!orders.results.length) throw new Error("批次内没有有效订单");
  const missingWarehouse = orders.results.find(
    (item) => !item.overseas_warehouse_id,
  );
  if (missingWarehouse) throw new Error("批次内存在未指定境外目的仓的订单");
  const customsGates = await loadOverseasInboundCustomsGates(
    input.organizationId,
    orders.results.map((item) => ({
      orderId: item.order_id,
      orderNumber: item.order_number,
      customsClearanceMode: item.customs_clearance_mode,
    })),
  );
  const customsBlocker = customsGates.find((gate) => gate.blocked);
  if (customsBlocker) throw new Error(customsBlocker.message || "批次清关门禁尚未通过");

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      "UPDATE transport_batches SET status='arrived',road_status=CASE WHEN road_status='outbound_in_transit' THEN 'overseas_arrived' ELSE road_status END,actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE id=? AND organization_id=?",
    ).bind(input.actualArrivalAt, now, input.batchId, input.organizationId),
    env.DB.prepare(
      "UPDATE transport_batch_orders SET status='arrived',updated_at=? WHERE batch_id=? AND organization_id=? AND status!='removed'",
    ).bind(now, input.batchId, input.organizationId),
    env.DB.prepare(
      `INSERT INTO overseas_warehouse_operations(
         id,organization_id,batch_id,order_id,warehouse_id,status,actual_arrival_at,
         notes,updated_by_user_id,created_at,updated_at
       )
       SELECT lower(hex(randomblob(16))),bo.organization_id,bo.batch_id,bo.order_id,
              o.overseas_warehouse_id,'arrived',?,?,?,?,?
       FROM transport_batch_orders bo
       JOIN transport_orders o
         ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
       ON CONFLICT(batch_id,order_id) DO UPDATE SET
         warehouse_id=COALESCE(overseas_warehouse_operations.warehouse_id,excluded.warehouse_id),
         status=CASE WHEN overseas_warehouse_operations.status='waiting_arrival' THEN 'arrived' ELSE overseas_warehouse_operations.status END,
         actual_arrival_at=COALESCE(overseas_warehouse_operations.actual_arrival_at,excluded.actual_arrival_at),
         notes=COALESCE(excluded.notes,overseas_warehouse_operations.notes),
         updated_by_user_id=excluded.updated_by_user_id,
         updated_at=excluded.updated_at`,
    ).bind(
      input.actualArrivalAt,
      input.notes || null,
      input.actorUserId,
      now,
      now,
      input.batchId,
      input.organizationId,
    ),
    env.DB.prepare(
      `UPDATE shipments
       SET status='in_transit',
           current_location=COALESCE((
             SELECT NULLIF(TRIM(
               COALESCE(w.name,'') ||
               CASE WHEN COALESCE(w.name,'')!='' AND COALESCE(w.address,'')!='' THEN ' · ' ELSE '' END ||
               COALESCE(w.address,'')
             ),'')
             FROM transport_orders o
             LEFT JOIN warehouses w
               ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
             WHERE o.id=shipments.order_id AND o.organization_id=shipments.organization_id
           ),'境外目的仓'),
           updated_at=?
       WHERE organization_id=? AND status!='cancelled'
         AND EXISTS(
           SELECT 1 FROM transport_batch_orders bo
           WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
             AND bo.order_id=shipments.order_id
         )`,
    ).bind(now, input.organizationId, input.batchId, input.organizationId),
    env.DB.prepare(
      `INSERT INTO shipment_events(
         id,shipment_id,status,location,description,event_at,
         visible_to_customer,created_by_user_id,created_at
       )
       SELECT lower(hex(randomblob(16))),s.id,'in_transit',
              COALESCE(NULLIF(TRIM(
                COALESCE(w.name,'') ||
                CASE WHEN COALESCE(w.name,'')!='' AND COALESCE(w.address,'')!='' THEN ' · ' ELSE '' END ||
                COALESCE(w.address,'')
              ),''),'境外目的仓'),
              '货物已到达境外目的仓',?,1,?,?
       FROM transport_batch_orders bo
       JOIN transport_orders o
         ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       JOIN shipments s
         ON s.order_id=o.id AND s.organization_id=o.organization_id
       LEFT JOIN warehouses w
         ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
       WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
         AND NOT EXISTS(
           SELECT 1 FROM shipment_events existing
           WHERE existing.shipment_id=s.id
             AND existing.status='in_transit'
             AND existing.description='货物已到达境外目的仓'
         )`,
    ).bind(
      input.actualArrivalAt,
      input.actorUserId,
      now,
      input.batchId,
      input.organizationId,
    ),
    env.DB.prepare(
      `INSERT INTO order_tracking_milestones(
         id,organization_id,order_id,milestone_code,milestone_name,event_at,
         location,notes,visible_to_customer,created_by_user_id,created_at
       )
       SELECT lower(hex(randomblob(16))),bo.organization_id,bo.order_id,
              'station_arrived','到达境外目的仓',?,
              COALESCE(NULLIF(TRIM(
                COALESCE(w.name,'') ||
                CASE WHEN COALESCE(w.name,'')!='' AND COALESCE(w.address,'')!='' THEN ' · ' ELSE '' END ||
                COALESCE(w.address,'')
              ),''),'境外目的仓'),
              ?,1,?,?
       FROM transport_batch_orders bo
       JOIN transport_orders o
         ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       LEFT JOIN warehouses w
         ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
       WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
         AND NOT EXISTS(
           SELECT 1 FROM order_tracking_milestones existing
           WHERE existing.organization_id=bo.organization_id
             AND existing.order_id=bo.order_id
             AND existing.milestone_code='station_arrived'
         )`,
    ).bind(
      input.actualArrivalAt,
      input.notes || null,
      input.actorUserId,
      now,
      input.batchId,
      input.organizationId,
    ),
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status='in_progress',current_step_code='arrived',current_step_name='等待系统自动通知',
           progress_percent=MAX(progress_percent,25),started_at=COALESCE(started_at,?),
           blocking_reason=NULL,updated_at=?
       WHERE organization_id=? AND module_code='overseas_warehouse' AND enabled=1 AND status!='completed'
         AND order_id IN (
           SELECT bo.order_id FROM transport_batch_orders bo
           WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
         )`,
    ).bind(now, now, input.organizationId, input.batchId, input.organizationId),
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status='completed',current_step_code='arrived',current_step_name='到达境外仓',
           progress_percent=100,started_at=COALESCE(started_at,?),
           completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=?
       WHERE organization_id=? AND module_code='tracking' AND enabled=1
         AND order_id IN (
           SELECT bo.order_id FROM transport_batch_orders bo
           WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
         )`,
    ).bind(now, now, now, input.organizationId, input.batchId, input.organizationId),
  ];
  await env.DB.batch(statements);
  const warning = await finishOverseasArrivalPostCommit({
    organizationId: input.organizationId,
    orderIds: orders.results.map((item) => item.order_id),
    actorUserId: input.actorUserId,
    occurredAt: input.actualArrivalAt,
  });
  return {
    batchNumber: batch.batch_number,
    orderCount: orders.results.length,
    warning,
  };
}

async function confirmStandaloneOrderArrival(input: ArrivalInput & { orderId: string }) {
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.business_type,o.overseas_warehouse_id,o.customs_clearance_mode,w.name warehouse_name,w.address warehouse_address
     FROM transport_orders o
     LEFT JOIN warehouses w ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
     WHERE o.organization_id=? AND o.id=?`,
  )
    .bind(input.organizationId, input.orderId)
    .first<{
      id: string;
      order_number: string;
      business_type: string;
      overseas_warehouse_id: string | null;
      customs_clearance_mode: "company" | "customer";
      warehouse_name: string | null;
      warehouse_address: string | null;
    }>();
  if (!order) throw new Error("订单不存在");
  if (order.business_type === "ltl") throw new Error("拼车订单必须通过配载单确认境外到仓");
  if (!order.overseas_warehouse_id) throw new Error("订单尚未指定境外目的仓");
  const [customsGate] = await loadOverseasInboundCustomsGates(
    input.organizationId,
    [{
      orderId: order.id,
      orderNumber: order.order_number,
      customsClearanceMode: order.customs_clearance_mode,
    }],
  );
  if (!customsGate || customsGate.blocked)
    throw new Error(customsGate?.message || "整车订单清关门禁解析失败");

  const now = new Date().toISOString();
  const batch = await ensureStandaloneBatch(input.organizationId, input.orderId, input.actorUserId, now);
  const location = [order.warehouse_name, order.warehouse_address].filter(Boolean).join(" · ");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE transport_batches SET status='arrived',road_status='overseas_arrived',actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE id=? AND organization_id=?",
    ).bind(input.actualArrivalAt, now, batch.id, input.organizationId),
    env.DB.prepare(
      "UPDATE transport_batch_orders SET status='arrived',updated_at=? WHERE batch_id=? AND organization_id=? AND status!='removed'",
    ).bind(now, batch.id, input.organizationId),
    env.DB.prepare(
      `INSERT INTO overseas_warehouse_operations(id,organization_id,batch_id,order_id,warehouse_id,status,actual_arrival_at,notes,updated_by_user_id,created_at,updated_at)
       VALUES(?,?,?,?,?,'arrived',?,?,?,?,?)
       ON CONFLICT(batch_id,order_id) DO UPDATE SET
         warehouse_id=COALESCE(overseas_warehouse_operations.warehouse_id,excluded.warehouse_id),
         status=CASE WHEN overseas_warehouse_operations.status='waiting_arrival' THEN 'arrived' ELSE overseas_warehouse_operations.status END,
         actual_arrival_at=COALESCE(overseas_warehouse_operations.actual_arrival_at,excluded.actual_arrival_at),
         notes=COALESCE(excluded.notes,overseas_warehouse_operations.notes),
         updated_by_user_id=excluded.updated_by_user_id,
         updated_at=excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      batch.id,
      input.orderId,
      order.overseas_warehouse_id,
      input.actualArrivalAt,
      input.notes || null,
      input.actorUserId,
      now,
      now,
    ),
    env.DB.prepare(
      "UPDATE shipments SET status='in_transit',current_location=?,updated_at=? WHERE order_id=? AND organization_id=? AND status!='cancelled'",
    ).bind(location || "境外目的仓", now, input.orderId, input.organizationId),
    env.DB.prepare(
      `INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at)
       SELECT ?,s.id,'in_transit',?,'货物已到达境外目的仓',?,1,?,?
       FROM shipments s
       WHERE s.order_id=? AND s.organization_id=?
         AND NOT EXISTS(
           SELECT 1 FROM shipment_events existing
           WHERE existing.shipment_id=s.id
             AND existing.status='in_transit'
             AND existing.description='货物已到达境外目的仓'
         )`,
    ).bind(
      crypto.randomUUID(),
      location || "境外目的仓",
      input.actualArrivalAt,
      input.actorUserId,
      now,
      input.orderId,
      input.organizationId,
    ),
    env.DB.prepare(
      `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,visible_to_customer,created_by_user_id,created_at)
       SELECT ?,?,?,'station_arrived','到达境外目的仓',?,?,?,1,?,?
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
      `UPDATE order_module_instances SET status='in_progress',current_step_code='arrived',current_step_name='等待系统自动通知',progress_percent=MAX(progress_percent,25),started_at=COALESCE(started_at,?),blocking_reason=NULL,updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1 AND status!='completed'`,
    ).bind(now, now, input.organizationId, input.orderId),
    env.DB.prepare(
      `UPDATE order_module_instances SET status='completed',current_step_code='arrived',current_step_name='到达境外仓',progress_percent=100,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='tracking' AND enabled=1`,
    ).bind(now, now, now, input.organizationId, input.orderId),
  ]);
  const warning = await finishOverseasArrivalPostCommit({
    organizationId: input.organizationId,
    orderIds: [input.orderId],
    actorUserId: input.actorUserId,
    occurredAt: input.actualArrivalAt,
  });
  return { batchNumber: order.order_number, orderCount: 1, warning };
}

async function finishOverseasArrivalPostCommit(input: {
  organizationId: string;
  orderIds: string[];
  actorUserId: string;
  occurredAt: string;
}) {
  const notificationFailures: string[] = [];
  const snapshotFailures: string[] = [];

  for (const orderId of [...new Set(input.orderIds)]) {
    try {
      await automaticallyNotifyOverseasArrival({
        organizationId: input.organizationId,
        orderId,
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
      });
    } catch (error) {
      notificationFailures.push(orderId);
      console.error("Failed to notify an overseas warehouse arrival", {
        orderId,
        error,
      });
    }

    try {
      await syncOrderWorkflowSnapshot(input.organizationId, orderId);
    } catch (error) {
      snapshotFailures.push(orderId);
      console.error("Failed to synchronize an overseas arrival workflow snapshot", {
        orderId,
        error,
      });
    }
  }

  const warningParts: string[] = [];
  if (notificationFailures.length)
    warningParts.push(`${notificationFailures.length} 票客户通知待重试`);
  if (snapshotFailures.length)
    warningParts.push(`${snapshotFailures.length} 票流程快照待同步`);
  return warningParts.length
    ? `到仓数据已安全保存，但${warningParts.join("，")}；可稍后刷新订单重试`
    : null;
}

async function ensureStandaloneBatch(
  organizationId: string,
  orderId: string,
  actorUserId: string,
  now: string,
) {
  const existing = await env.DB.prepare(
    `SELECT b.id,b.batch_number
     FROM transport_batch_orders bo
     JOIN transport_batches b ON b.id=bo.batch_id
     WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND b.status!='cancelled'
     ORDER BY b.created_at DESC LIMIT 1`,
  ).bind(organizationId, orderId).first<{ id: string; batch_number: string }>();
  if (existing) return existing;

  const order = await env.DB.prepare(
    `SELECT order_number,origin_country,origin_state,origin_city,destination_country,destination_state,destination_city,
            exit_port,transit_locations,current_assignee_user_id
     FROM transport_orders WHERE organization_id=? AND id=?`,
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
  if (!order) throw new Error("订单不存在");
  const seq = await env.DB.prepare(
    "SELECT COUNT(*)+1 next FROM transport_batches WHERE organization_id=? AND batch_number LIKE 'FTL-%'",
  ).bind(organizationId).first<{ next: number }>();
  const batchId = crypto.randomUUID();
  const batchNumber = `FTL-${now.slice(0, 10).replaceAll("-", "")}-${String(seq?.next ?? 1).padStart(3, "0")}`;
  const origin = [order.origin_country, order.origin_state, order.origin_city].filter(Boolean).join(" ");
  const destination = [order.destination_country, order.destination_state, order.destination_city].filter(Boolean).join(" ");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,status,notes,route_key,created_by_user_id,created_at,updated_at,border_port,transit_location,road_status)
       VALUES(?,?,?,?,?,?,?,'departed',?,?,?,?,?,?,?,'outbound_in_transit')`,
    ).bind(
      batchId,
      organizationId,
      orderId,
      batchNumber,
      `${order.order_number} 整车直装`,
      origin,
      destination,
      "整车订单自动生成的直装批次，用于出境后批量状态同步",
      [order.origin_country, order.origin_state, order.origin_city, ">", order.destination_country, order.destination_state, order.destination_city]
        .filter(Boolean)
        .join("|")
        .toLowerCase(),
      actorUserId || order.current_assignee_user_id || null,
      now,
      now,
      order.exit_port || null,
      order.transit_locations || null,
    ),
    env.DB.prepare(
      "INSERT INTO transport_batch_orders(id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at) VALUES(?,?,?,?,1,'departed',?,?,?)",
    ).bind(crypto.randomUUID(), organizationId, batchId, orderId, actorUserId, now, now),
  ]);
  return { id: batchId, batch_number: batchNumber };
}

export async function advanceOverseasOrder(input: AdvanceInput) {
  const operation = await env.DB.prepare(
    `SELECT op.id,op.batch_id,op.status,COALESCE(w.name,'境外目的仓') warehouse_name
     FROM overseas_warehouse_operations op
     LEFT JOIN warehouses w ON w.id=op.warehouse_id AND w.organization_id=op.organization_id
     WHERE op.organization_id=? AND op.order_id=? AND op.status!='cancelled'
     ORDER BY op.created_at DESC LIMIT 1`,
  )
    .bind(input.organizationId, input.orderId)
    .first<{ id: string; batch_id: string; status: string; warehouse_name: string }>();
  if (!operation) throw new Error("请先由批次确认货物已到达境外目的仓");

  const canAdvance = input.action === "notify"
    ? operation.status === "arrived"
    : ["notified", "appointment"].includes(operation.status);
  if (!canAdvance)
    throw new Error(`当前状态不能执行该操作，请按“到仓并由系统自动通知—客户扫码核对并确认收货”顺序办理`);

  const nextStatus = input.action === "notify" ? "notified" : "picked_up";
  const stepName = input.action === "notify" ? "客户已通知" : "扫码自提签收";
  const progress = input.action === "notify" ? 60 : 100;
  const moduleStepCode = input.action === "notify" ? "notified" : "signed";
  const moduleStepName = input.action === "notify"
    ? "等待客户预约或扫码自提"
    : "扫码自提签收完成";
  const moduleStatus=input.action === "pickup" ? "completed" : "in_progress";
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      `UPDATE overseas_warehouse_operations SET status=?,
         notified_at=CASE WHEN ?='notify' THEN ? ELSE notified_at END,
         pickup_at=CASE WHEN ?='pickup' THEN ? ELSE pickup_at END,
         pickup_contact=CASE WHEN ?='pickup' THEN ? ELSE pickup_contact END,
         pickup_proof_reference=CASE WHEN ?='pickup' THEN ? ELSE pickup_proof_reference END,
         notes=COALESCE(?,notes),updated_by_user_id=?,updated_at=? WHERE id=?`,
    ).bind(
      nextStatus,
      input.action,
      input.occurredAt,
      input.action,
      input.occurredAt,
      input.action,
      input.pickupContact || null,
      input.action,
      input.pickupProofReference || null,
      input.notes || null,
      input.actorUserId,
      now,
      operation.id,
    ),
    env.DB.prepare(
      `UPDATE order_module_instances SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,started_at=COALESCE(started_at,?),completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,blocking_reason=NULL,updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1`,
    ).bind(
      moduleStatus,
      moduleStepCode,
      moduleStepName,
      progress,
      now,
      moduleStatus,
      now,
      now,
      input.organizationId,
      input.orderId,
    ),
  ];
  if (input.action === "notify") {
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,visible_to_customer,created_by_user_id,created_at)
         VALUES(?,?,?,?,?,?,?,?,1,?,?)`,
      ).bind(
        crypto.randomUUID(),
        input.organizationId,
        input.orderId,
        "customer_notified",
        "通知客户",
        input.occurredAt,
        operation.warehouse_name,
        input.notes || null,
        input.actorUserId,
        now,
      ),
    );
  }
  if (input.action === "pickup") {
    statements.push(
      env.DB.prepare(
        "UPDATE shipments SET status='delivered',current_location=?,actual_delivery_at=COALESCE(actual_delivery_at,?),updated_at=? WHERE order_id=? AND organization_id=? AND status!='cancelled'",
      ).bind(
        operation.warehouse_name,
        input.occurredAt,
        now,
        input.orderId,
        input.organizationId,
      ),
      env.DB.prepare(
        "UPDATE order_cargo_packages SET status='delivered' WHERE order_id=? AND organization_id=? AND status!='cancelled'",
      ).bind(input.orderId, input.organizationId),
      env.DB.prepare(
        `INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at)
          SELECT ?,s.id,'delivered',?,'客户已在境外目的仓扫码核对并完成自提签收，订单进入结算',?,1,?,?
         FROM shipments s WHERE s.order_id=? AND s.organization_id=?`,
      ).bind(
        crypto.randomUUID(),
        operation.warehouse_name,
        input.occurredAt,
        input.actorUserId,
        now,
        input.orderId,
        input.organizationId,
      ),
      env.DB.prepare(
        `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,visible_to_customer,created_by_user_id,created_at)
         VALUES(?,?,?,'picked_up','客户自提',?,?,?,1,?,?)`,
      ).bind(
        crypto.randomUUID(),
        input.organizationId,
        input.orderId,
        input.occurredAt,
        operation.warehouse_name,
        input.notes || null,
        input.actorUserId,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,visible_to_customer,created_by_user_id,created_at)
         SELECT ?,?,?,'signed','扫码确认签收',?,?,?,1,?,?
         WHERE NOT EXISTS(SELECT 1 FROM order_tracking_milestones WHERE organization_id=? AND order_id=? AND milestone_code='signed')`,
      ).bind(crypto.randomUUID(),input.organizationId,input.orderId,input.occurredAt,operation.warehouse_name,"境外仓复核整票货物后确认客户自提",input.actorUserId,now,input.organizationId,input.orderId),
      env.DB.prepare(
        `INSERT INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,priority,status,assignee_user_id,assigned_by_user_id,created_at,updated_at)
         SELECT ?,?,?,'costs','start_receivable_reconciliation','发起客户应收对账','normal','pending',NULL,?,?,?
         WHERE NOT EXISTS(SELECT 1 FROM order_tasks WHERE organization_id=? AND order_id=? AND task_type='start_receivable_reconciliation' AND status IN ('pending','in_progress'))`,
      ).bind(crypto.randomUUID(),input.organizationId,input.orderId,input.actorUserId,now,now,input.organizationId,input.orderId),
    );
  }
  await env.DB.batch(statements);

  if (input.action === "pickup") {
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) total FROM overseas_warehouse_operations WHERE batch_id=? AND organization_id=? AND status NOT IN ('picked_up','cancelled')",
    )
      .bind(operation.batch_id, input.organizationId)
      .first<{ total: number }>();
    if ((remaining?.total ?? 0) === 0)
      await env.DB.prepare(
        "UPDATE transport_batches SET status='arrived',road_status='pickup_completed',updated_at=? WHERE id=? AND organization_id=?",
      )
        .bind(now, operation.batch_id, input.organizationId)
        .run();
  }
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
  return { nextStatus, stepName };
}

export async function completeOverseasOrderDelivery(input: {
  organizationId: string;
  orderId: string;
  actorUserId: string;
  occurredAt?: string;
}) {
  const operation = await env.DB.prepare(
    `SELECT op.status,op.pickup_at,op.pickup_contact,COALESCE(w.name,'境外目的仓') warehouse_name
       FROM overseas_warehouse_operations op
       LEFT JOIN warehouses w ON w.id=op.warehouse_id AND w.organization_id=op.organization_id
      WHERE op.organization_id=? AND op.order_id=? AND op.status!='cancelled'
      ORDER BY op.created_at DESC LIMIT 1`,
  ).bind(input.organizationId, input.orderId).first<{
    status: string;
    pickup_at: string | null;
    pickup_contact: string | null;
    warehouse_name: string;
  }>();
  if (!operation || operation.status !== "picked_up")
    throw new Error("境外仓尚未完成扫码自提出库，不能确认签收");

  const signedReceipt = await env.DB.prepare(
    `SELECT a.id
       FROM order_attachments a
       JOIN order_document_metadata m ON m.attachment_id=a.id
      WHERE a.organization_id=? AND a.order_id=?
        AND m.document_category='delivery_receipt'
        AND m.review_status IN ('approved','archived')
      ORDER BY a.created_at DESC LIMIT 1`,
  ).bind(input.organizationId, input.orderId).first<{ id: string }>();
  if (!signedReceipt) throw new Error("签收单尚未上传并审核通过，不能归档签收记录");

  const now = input.occurredAt || new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE shipments SET status='delivered',current_location=?,actual_delivery_at=COALESCE(actual_delivery_at,?),signed_by=?,updated_at=? WHERE order_id=? AND organization_id=? AND status!='cancelled'",
    ).bind(
      operation.warehouse_name,
      operation.pickup_at || now,
      operation.pickup_contact || "客户自提",
      now,
      input.orderId,
      input.organizationId,
    ),
    env.DB.prepare(
      `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,visible_to_customer,created_by_user_id,created_at)
       SELECT ?,?,?,'signed','签收',?,?,?,1,?,?
       WHERE NOT EXISTS(
         SELECT 1 FROM order_tracking_milestones
          WHERE organization_id=? AND order_id=? AND milestone_code='signed'
       )`,
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.orderId,
      now,
      operation.warehouse_name,
      `签收单 ${signedReceipt.id} 已审核通过`,
      input.actorUserId,
      now,
      input.organizationId,
      input.orderId,
    ),
    env.DB.prepare(
      `UPDATE order_module_instances
          SET status='completed',current_step_code='signed',current_step_name='扫码自提签收完成',
              progress_percent=100,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),
              blocking_reason=NULL,updated_at=?
        WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1`,
    ).bind(now, now, now, input.organizationId, input.orderId),
  ]);
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
  return { completed: true };
}

export async function reconcileOverseasOrderDeliveryState(input: {
  organizationId: string;
  orderId: string;
  actorUserId: string;
}) {
  const operation = await env.DB.prepare(
    `SELECT op.status,m.status module_status,m.current_step_code,m.progress_percent
       FROM overseas_warehouse_operations op
       LEFT JOIN order_module_instances m
         ON m.organization_id=op.organization_id AND m.order_id=op.order_id
        AND m.module_code='overseas_warehouse' AND m.enabled=1
      WHERE op.organization_id=? AND op.order_id=? AND op.status!='cancelled'
      ORDER BY op.created_at DESC LIMIT 1`,
  ).bind(input.organizationId, input.orderId).first<{
    status: string;
    module_status: string | null;
    current_step_code: string | null;
    progress_percent: number | null;
  }>();
  if (!operation) return;

  const state = operation.status === "picked_up"
    ? ["completed", "signed", "扫码自提签收完成", 100] as const
    : ({
        waiting_arrival: ["in_progress", "waiting_arrival", "等待到仓", 0],
        arrived: ["in_progress", "arrived", "等待系统通知客户", 25],
        notified: ["in_progress", "notified", "等待客户预约或扫码自提", 60],
        appointment: ["in_progress", "appointment", "客户已预约，等待扫码自提", 75],
      } as Record<string, readonly [string, string, string, number]>)[operation.status];
  if (!state) return;
  if (
    operation.module_status === state[0] &&
    operation.current_step_code === state[1] &&
    operation.progress_percent === state[3]
  ) {
    // The delivery module can already be correct while an older macro workflow
    // snapshot is still stale. Re-run the idempotent snapshot synchronization
    // so opening the order repairs every projection, not only this module row.
    await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
    return;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE order_module_instances
        SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
            started_at=COALESCE(started_at,?),
            completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,
            blocking_reason=NULL,updated_at=?
      WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1`,
  ).bind(
    state[0],
    state[1],
    state[2],
    state[3],
    now,
    state[0],
    now,
    now,
    input.organizationId,
    input.orderId,
  ).run();
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
}

export async function automaticallyNotifyOverseasArrival(input: AutomaticNoticeInput) {
  const context = await env.DB.prepare(
    `SELECT op.status,op.warehouse_id,o.order_number,o.customer_id,
            COALESCE(w.name,'境外目的仓') warehouse_name
       FROM overseas_warehouse_operations op
       JOIN transport_orders o ON o.id=op.order_id AND o.organization_id=op.organization_id
       LEFT JOIN warehouses w ON w.id=op.warehouse_id AND w.organization_id=op.organization_id
      WHERE op.organization_id=? AND op.order_id=? AND op.status!='cancelled'
      ORDER BY op.created_at DESC LIMIT 1`,
  ).bind(input.organizationId, input.orderId).first<{
    status: string;
    warehouse_id: string;
    order_number: string;
    customer_id: string;
    warehouse_name: string;
  }>();
  if (!context || context.status === "waiting_arrival") return { notified: false };

  const occurredAt = input.occurredAt || new Date().toISOString();
  if (context.status === "arrived") {
    await advanceOverseasOrder({
      organizationId: input.organizationId,
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      action: "notify",
      occurredAt,
      notes: `${context.warehouse_name}已完成扫码入库和清点，系统自动通知客户`,
    });
  }

  const existing = await env.DB.prepare(
    `SELECT id,portal_notification_id
       FROM warehouse_customer_notifications
      WHERE organization_id=? AND order_id=?`,
  ).bind(input.organizationId, input.orderId).first<{
    id: string;
    portal_notification_id: string | null;
  }>();
  if (existing?.portal_notification_id) return { notified: true };

  const portalNotificationId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO portal_notifications(id,organization_id,customer_id,user_id,type,title,message,link,is_read,created_at)
       VALUES(?,?,?,NULL,'shipment',?,?,?,0,?)`,
    ).bind(
      portalNotificationId,
      input.organizationId,
      context.customer_id,
      `订单 ${context.order_number} 已到仓`,
      `货物已到达${context.warehouse_name}并完成入库清点，请登录客户门户查看并安排自提。`,
      portalOrderListLink(context.order_number),
      now,
    ),
    existing
      ? env.DB.prepare(
          `UPDATE warehouse_customer_notifications
              SET warehouse_id=?,portal_notification_id=?,status='notified',
                  notified_by_user_id=?,notified_at=?,updated_at=?
            WHERE id=? AND organization_id=?`,
        ).bind(
          context.warehouse_id,
          portalNotificationId,
          input.actorUserId,
          occurredAt,
          now,
          existing.id,
          input.organizationId,
        )
      : env.DB.prepare(
          `INSERT INTO warehouse_customer_notifications(
             id,organization_id,warehouse_id,order_id,portal_notification_id,status,
             notified_by_user_id,notified_at,created_at,updated_at
           ) VALUES(?,?,?,?,?,'notified',?,?,?,?)`,
        ).bind(
          crypto.randomUUID(),
          input.organizationId,
          context.warehouse_id,
          input.orderId,
          portalNotificationId,
          input.actorUserId,
          occurredAt,
          now,
          now,
        ),
  ]);
  return { notified: true };
}
