import { env } from "cloudflare:workers";
import { syncOrderWorkflowSnapshot } from "./order-modules.server";

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
  action: "notify" | "appointment" | "pickup";
  occurredAt: string;
  pickupContact?: string;
  pickupProofReference?: string;
  notes?: string;
};

type BatchOrder = {
  order_id: string;
  shipment_id: string | null;
  overseas_warehouse_id: string | null;
  warehouse_name: string | null;
  warehouse_address: string | null;
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
    `SELECT bo.order_id,s.id shipment_id,o.overseas_warehouse_id,w.name warehouse_name,w.address warehouse_address
     FROM transport_batch_orders bo
     JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     LEFT JOIN shipments s ON s.order_id=o.id AND s.organization_id=o.organization_id
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
  const orderPlaceholders = orders.results.map(() => "?").join(",");
  const clearedOrders = await env.DB.prepare(
    `SELECT COUNT(DISTINCT order_id) total
     FROM order_tracking_milestones
     WHERE organization_id=? AND order_id IN (${orderPlaceholders})
       AND milestone_code='customs_cleared'`,
  )
    .bind(input.organizationId, ...orders.results.map((item) => item.order_id))
    .first<{ total: number }>();
  if ((clearedOrders?.total ?? 0) !== orders.results.length)
    throw new Error("批次内仍有订单未完成目的地清关，不能确认境外目的仓到仓");

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      "UPDATE transport_batches SET status='arrived',road_status=CASE WHEN road_status='outbound_in_transit' THEN 'overseas_arrived' ELSE road_status END,actual_arrival_at=COALESCE(actual_arrival_at,?),updated_at=? WHERE id=? AND organization_id=?",
    ).bind(input.actualArrivalAt, now, input.batchId, input.organizationId),
    env.DB.prepare(
      "UPDATE transport_batch_orders SET status='arrived',updated_at=? WHERE batch_id=? AND organization_id=? AND status!='removed'",
    ).bind(now, input.batchId, input.organizationId),
  ];
  for (const item of orders.results) {
    const location = [item.warehouse_name, item.warehouse_address]
      .filter(Boolean)
      .join(" · ");
    statements.push(
      env.DB.prepare(
        `INSERT INTO overseas_warehouse_operations(id,organization_id,batch_id,order_id,warehouse_id,status,actual_arrival_at,notes,updated_by_user_id,created_at,updated_at)
         VALUES(?,?,?,?,?,'arrived',?,?,?,?,?)
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
        item.order_id,
        item.overseas_warehouse_id,
        input.actualArrivalAt,
        input.notes || null,
        input.actorUserId,
        now,
        now,
      ),
      env.DB.prepare(
        "UPDATE shipments SET status='in_transit',current_location=?,updated_at=? WHERE order_id=? AND organization_id=? AND status!='cancelled'",
      ).bind(location || "境外目的仓", now, item.order_id, input.organizationId),
      env.DB.prepare(
        `INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at)
         SELECT ?,s.id,'in_transit',?,'货物已到达境外目的仓',?,1,?,?
         FROM shipments s WHERE s.order_id=? AND s.organization_id=?`,
      ).bind(
        crypto.randomUUID(),
        location || "境外目的仓",
        input.actualArrivalAt,
        input.actorUserId,
        now,
        item.order_id,
        input.organizationId,
      ),
      env.DB.prepare(
        `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,visible_to_customer,created_by_user_id,created_at)
         VALUES(?,?,?,'station_arrived','到达境外目的仓',?,?,?,1,?,?)`,
      ).bind(
        crypto.randomUUID(),
        input.organizationId,
        item.order_id,
        input.actualArrivalAt,
        location || "境外目的仓",
        input.notes || null,
        input.actorUserId,
        now,
      ),
      env.DB.prepare(
        `UPDATE order_module_instances SET status='in_progress',current_step_code='notified',current_step_name='客户已通知',progress_percent=MAX(progress_percent,25),started_at=COALESCE(started_at,?),blocking_reason=NULL,updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1 AND status!='completed'`,
      ).bind(now, now, input.organizationId, item.order_id),
      env.DB.prepare(
        `UPDATE order_module_instances SET status='completed',current_step_code='arrived',current_step_name='到达境外仓',progress_percent=100,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='tracking' AND enabled=1`,
      ).bind(now, now, now, input.organizationId, item.order_id),
    );
  }
  await env.DB.batch(statements);
  await Promise.all(
    orders.results.map((item) =>
      syncOrderWorkflowSnapshot(input.organizationId, item.order_id),
    ),
  );
  return { batchNumber: batch.batch_number, orderCount: orders.results.length };
}

async function confirmStandaloneOrderArrival(input: ArrivalInput & { orderId: string }) {
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.business_type,o.overseas_warehouse_id,w.name warehouse_name,w.address warehouse_address
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
      warehouse_name: string | null;
      warehouse_address: string | null;
    }>();
  if (!order) throw new Error("订单不存在");
  if (order.business_type === "ltl") throw new Error("拼车订单必须通过配载单确认境外到仓");
  if (!order.overseas_warehouse_id) throw new Error("订单尚未指定境外目的仓");
  const destinationCustomsCleared = await env.DB.prepare(
    `SELECT 1 FROM order_tracking_milestones
     WHERE organization_id=? AND order_id=? AND milestone_code='customs_cleared'
     LIMIT 1`,
  ).bind(input.organizationId, input.orderId).first();
  if (!destinationCustomsCleared)
    throw new Error("整车订单尚未完成目的地清关，不能确认境外目的仓到仓");

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
       FROM shipments s WHERE s.order_id=? AND s.organization_id=?`,
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
       VALUES(?,?,?,'station_arrived','到达境外目的仓',?,?,?,1,?,?)`,
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.orderId,
      input.actualArrivalAt,
      location || "境外目的仓",
      input.notes || null,
      input.actorUserId,
      now,
    ),
    env.DB.prepare(
      `UPDATE order_module_instances SET status='in_progress',current_step_code='notified',current_step_name='客户已通知',progress_percent=MAX(progress_percent,25),started_at=COALESCE(started_at,?),blocking_reason=NULL,updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1 AND status!='completed'`,
    ).bind(now, now, input.organizationId, input.orderId),
    env.DB.prepare(
      `UPDATE order_module_instances SET status='completed',current_step_code='arrived',current_step_name='到达境外仓',progress_percent=100,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='tracking' AND enabled=1`,
    ).bind(now, now, now, input.organizationId, input.orderId),
  ]);
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
  return { batchNumber: order.order_number, orderCount: 1 };
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

  const expected =
    input.action === "notify"
      ? "arrived"
      : input.action === "appointment"
        ? "notified"
        : "appointment";
  if (operation.status !== expected)
    throw new Error(`当前状态不能执行该操作，请按“到仓—通知客户—预约提货—客户自提并签收”顺序办理`);

  const nextStatus =
    input.action === "notify"
      ? "notified"
      : input.action === "appointment"
        ? "appointment"
        : "picked_up";
  const stepName =
    input.action === "notify"
      ? "客户已通知"
      : input.action === "appointment"
        ? "预约提货"
        : "客户自提并签收";
  const progress = input.action === "notify" ? 50 : input.action === "appointment" ? 75 : 100;
  const moduleStepCode =
    input.action === "notify"
      ? "appointment"
      : input.action === "appointment"
        ? "picked_up"
        : "completed";
  const moduleStepName =
    input.action === "notify"
      ? "预约提货"
      : input.action === "appointment"
        ? "客户自提"
        : "运输完成";
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      `UPDATE overseas_warehouse_operations SET status=?,
         notified_at=CASE WHEN ?='notify' THEN ? ELSE notified_at END,
         appointment_at=CASE WHEN ?='appointment' THEN ? ELSE appointment_at END,
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
      `UPDATE order_module_instances SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,started_at=COALESCE(started_at,?),completed_at=CASE WHEN ?='picked_up' THEN ? ELSE completed_at END,blocking_reason=NULL,updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1`,
    ).bind(
      nextStatus === "picked_up" ? "completed" : "in_progress",
      moduleStepCode,
      moduleStepName,
      progress,
      now,
      nextStatus,
      now,
      now,
      input.organizationId,
      input.orderId,
    ),
  ];
  if (input.action === "appointment") {
    statements.push(
      env.DB.prepare(
        "UPDATE transport_batches SET status='arrived',road_status='waiting_pickup',updated_at=? WHERE id=? AND organization_id=? AND road_status='overseas_arrived'",
      ).bind(now, operation.batch_id, input.organizationId),
    );
  }
  if (input.action === "notify" || input.action === "appointment") {
    const milestoneCode = input.action === "notify" ? "customer_notified" : "pickup_appointment";
    const milestoneName = input.action === "notify" ? "通知客户" : "预约提货";
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,visible_to_customer,created_by_user_id,created_at)
         VALUES(?,?,?,?,?,?,?,?,1,?,?)`,
      ).bind(
        crypto.randomUUID(),
        input.organizationId,
        input.orderId,
        milestoneCode,
        milestoneName,
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
        "UPDATE shipments SET status='delivered',current_location=?,actual_delivery_at=?,signed_by=?,updated_at=? WHERE order_id=? AND organization_id=? AND status!='cancelled'",
      ).bind(
        operation.warehouse_name,
        input.occurredAt,
        input.pickupContact || "提货人",
        now,
        input.orderId,
        input.organizationId,
      ),
      env.DB.prepare(
        "UPDATE order_cargo_packages SET status='delivered' WHERE order_id=? AND organization_id=? AND status!='cancelled'",
      ).bind(input.orderId, input.organizationId),
      env.DB.prepare(
        `INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at)
         SELECT ?,s.id,'delivered',?,'客户已在境外目的仓自提并签收',?,1,?,?
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
         VALUES(?,?,?,'signed','签收',?,?,?,1,?,?)`,
      ).bind(
        crypto.randomUUID(),
        input.organizationId,
        input.orderId,
        input.occurredAt,
        operation.warehouse_name,
        input.pickupContact || null,
        input.actorUserId,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,visible_to_customer,created_by_user_id,created_at)
         VALUES(?,?,?,'completed','运输完成',?,?,?,1,?,?)`,
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
        `UPDATE order_module_instances SET status='completed',current_step_code='arrived',current_step_name='到达境外目的仓',progress_percent=100,completed_at=COALESCE(completed_at,?),updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='tracking' AND enabled=1`,
      ).bind(now, now, input.organizationId, input.orderId),
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
