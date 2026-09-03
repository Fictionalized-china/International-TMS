import { env } from "cloudflare:workers";
import { syncOrderWorkflowSnapshot } from "./order-modules.server";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";
import {
  type BatchTrackingMilestone,
  BATCH_TRACKING_MILESTONES,
  BATCH_TRACKING_MAIN_CODES,
  BATCH_TRACKING_OPTIONAL_CODES,
  BATCH_TRACKING_REQUIRED_PREVIOUS,
} from "./batch-tracking.shared";
export const BATCH_SYNCED_TRACKING_MILESTONES = new Set([
  "departed",
  "border_arrived",
  "exported",
  "transloaded",
  "transit_customs",
  "foreign_entered",
  "customs_cleared",
  "station_arrived",
]);

const MILESTONE_MODULE_MAPPING: Record<
  string,
  { step: string; name: string; progress: number; complete?: boolean }
> = {
  departed: { step: "departed", name: "离港确认", progress: 15 },
  border_arrived: { step: "transit", name: "口岸到达", progress: 28 },
  exported: { step: "transit", name: "出境", progress: 40 },
  transloaded: { step: "transit", name: "换装", progress: 46 },
  transit_customs: { step: "transit", name: "转关", progress: 52 },
  foreign_entered: { step: "transit", name: "海外入境", progress: 64 },
  customs_cleared: {
    step: "customs_cleared",
    name: "目的地清关",
    progress: 82,
  },
  station_arrived: {
    step: "arrived",
    name: "目的仓到达",
    progress: 100,
    complete: true,
  },
};

const MILESTONE_PROGRESS_WEIGHTS: Record<string, number> = {
  departed: 15,
  border_arrived: 28,
  exported: 40,
  transloaded: 46,
  transit_customs: 52,
  foreign_entered: 64,
  customs_cleared: 82,
  station_arrived: 100,
};

export async function getBatchOrderIds(
  organizationId: string,
  batchId: string,
): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT order_id FROM transport_batch_orders
     WHERE organization_id=? AND batch_id=? AND status!='removed'
     ORDER BY sequence_no, order_id`,
  )
    .bind(organizationId, batchId)
    .all<{ order_id: string }>();
  return result.results.map((item) => item.order_id);
}

export async function getBatchMainVehiclePlate(
  organizationId: string,
  batchId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT plate_number FROM transport_batch_vehicles
     WHERE organization_id=? AND batch_id=? AND status!='cancelled'
       AND NULLIF(TRIM(plate_number),'') IS NOT NULL
     ORDER BY created_at LIMIT 1`,
  )
    .bind(organizationId, batchId)
    .first<{ plate_number: string }>();
  return row?.plate_number || null;
}

export async function validateBatchTrackingRequiredPrevious(
  organizationId: string,
  orderIds: string[],
  milestoneCode: string,
  eventAt?: string,
): Promise<{ missingOrders: number; sampleOrderNumber: string | null } | null> {
  const required = BATCH_TRACKING_REQUIRED_PREVIOUS[milestoneCode];
  if (!required || required.length === 0 || !orderIds.length) return null;
  const requiredPlaceholders = d1Placeholders(required.length);

  let missingOrders = 0;
  let sampleOrderNumber: string | null = null;

  for (const chunk of chunkD1Values(
    orderIds,
    1 + required.length + (eventAt ? 1 : 0),
  )) {
    const placeholders = d1Placeholders(chunk.length);
    const missingRows = await env.DB.prepare(
      `SELECT o.order_number
       FROM transport_orders o
       WHERE o.organization_id=? AND o.id IN (${placeholders})
         AND NOT EXISTS(
           SELECT 1 FROM order_tracking_milestones m
           WHERE m.organization_id=o.organization_id AND m.order_id=o.id
             AND m.milestone_code IN (${requiredPlaceholders})
             ${eventAt ? "AND m.event_at<=?" : ""}
         )`,
    )
      .bind(organizationId, ...chunk, ...required, ...(eventAt ? [eventAt] : []))
      .all<{ order_number: string }>();

    if (missingRows.results.length) {
      missingOrders += missingRows.results.length;
      sampleOrderNumber ??= missingRows.results[0].order_number;
    }
  }

  if (missingOrders === 0) return null;
  return { missingOrders, sampleOrderNumber };
}

export async function insertTrackingMilestoneForBatchOrders(params: {
  organizationId: string;
  orderIds: string[];
  milestoneCode: string;
  milestoneName: string;
  eventAt: string;
  location: string | null;
  vehicleReference: string | null;
  notes: string | null;
  visibleToCustomer: boolean;
  actorUserId: string;
  createdAt: string;
}): Promise<number> {
  const {
    organizationId,
    orderIds,
    milestoneCode,
    milestoneName,
    eventAt,
    location,
    vehicleReference,
    notes,
    visibleToCustomer,
    actorUserId,
    createdAt,
  } = params;
  if (!orderIds.length) return 0;

  const statements = orderIds.map((orderId) =>
    env.DB.prepare(
      `INSERT INTO order_tracking_milestones(
        id,organization_id,order_id,milestone_code,milestone_name,event_at,
        location,vehicle_reference,notes,visible_to_customer,created_by_user_id,created_at
      )
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?
       WHERE NOT EXISTS(
         SELECT 1 FROM order_tracking_milestones
         WHERE organization_id=? AND order_id=? AND milestone_code=? AND event_at=?
       )`,
    ).bind(
      crypto.randomUUID(),
      organizationId,
      orderId,
      milestoneCode,
      milestoneName,
      eventAt,
      location,
      vehicleReference,
      notes,
      visibleToCustomer ? 1 : 0,
      actorUserId,
      createdAt,
      organizationId,
      orderId,
      milestoneCode,
      eventAt,
    ),
  );
  await env.DB.batch(statements);
  return orderIds.length;
}

export async function syncTrackingModuleStatusForOrder(
  organizationId: string,
  orderId: string,
  milestoneCode: string,
  actorUserId: string,
  now: string,
): Promise<void> {
  const next = MILESTONE_MODULE_MAPPING[milestoneCode];
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
  const effectiveStep =
    effectiveProgress >= 100
      ? "arrived"
      : effectiveProgress >= 82
        ? "customs_cleared"
        : effectiveProgress >= 28
          ? "transit"
          : next.step;

  const effectiveName =
    effectiveProgress >= 100
      ? "目的仓到达"
      : effectiveProgress >= 82
        ? "目的地清关"
        : effectiveProgress >= 40
          ? "出境"
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
  if ((module.progress_percent ?? 0) > effectiveProgress && module.current_step_code === effectiveStep)
    return;

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
      "tracking status sync",
      module.current_step_code,
      effectiveStep,
      effectiveName,
      actorUserId,
      `tracking milestone: ${milestoneCode}`,
      now,
    ),
  ]);

  await syncOrderWorkflowSnapshot(organizationId, orderId);
}

export async function syncBatchRoadStatusFromTracking(
  organizationId: string,
  batchId: string,
  orderIds: string[],
  now: string,
): Promise<void> {
  if (!orderIds.length) return;

  const latestByChunk: Array<{ milestone_code: string; event_at: string; location: string | null }> = [];
  for (const chunk of chunkD1Values(orderIds)) {
    const placeholders = d1Placeholders(chunk.length);
    const latest = await env.DB.prepare(
      `SELECT milestone_code,event_at,location
       FROM order_tracking_milestones
       WHERE organization_id=? AND order_id IN (${placeholders})
         AND milestone_code IN ('departed','border_arrived','exported','transloaded','transit_customs','foreign_entered','customs_cleared','station_arrived')
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
         event_at DESC, created_at DESC
       LIMIT 1`,
    )
      .bind(organizationId, ...chunk)
      .first<{ milestone_code: string; event_at: string; location: string | null }>();
    if (latest) {
      latestByChunk.push(latest);
    }
  }

  if (!latestByChunk.length) return;
  const latestMilestone = latestByChunk.reduce((prev, curr) => {
    const prevWeight = MILESTONE_PROGRESS_WEIGHTS[prev.milestone_code] ?? 0;
    const currWeight = MILESTONE_PROGRESS_WEIGHTS[curr.milestone_code] ?? 0;
    if (currWeight > prevWeight) return curr;
    if (currWeight < prevWeight) return prev;
    return curr.event_at > prev.event_at ? curr : prev;
  });

  const batch = await env.DB.prepare(
    "SELECT id,status,road_status FROM transport_batches WHERE id=? AND organization_id=? AND status!='cancelled'",
  )
    .bind(batchId, organizationId)
    .first<{ id: string; status: string; road_status: string }>();
  if (!batch) return;
  if (["overseas_arrived", "waiting_pickup", "pickup_completed"].includes(batch.road_status))
    return;

  const progress = MILESTONE_PROGRESS_WEIGHTS[latestMilestone.milestone_code] ?? 0;
  let exportedAt: string | null = null;
  let borderLocation: string | null = null;
  for (const chunk of chunkD1Values(orderIds)) {
    const placeholders = d1Placeholders(chunk.length);
    const transition = await env.DB.prepare(
      `SELECT
         MAX(CASE WHEN milestone_code='exported' THEN event_at END) exported_at,
         MAX(CASE WHEN milestone_code IN ('border_arrived','exported') THEN location END) border_location
       FROM order_tracking_milestones
       WHERE organization_id=? AND order_id IN (${placeholders})`,
    )
      .bind(organizationId, ...chunk)
      .first<{ exported_at: string | null; border_location: string | null }>();
    if (transition?.exported_at && (!exportedAt || transition.exported_at > exportedAt)) {
      exportedAt = transition.exported_at;
    }
    borderLocation ??= transition?.border_location || null;
  }
  const targetRoadStatus =
    progress >= 100
      ? "overseas_arrived"
      : progress >= 40
        ? "outbound_in_transit"
        : batch.road_status;
  const targetBatchStatus = progress >= 100 ? "arrived" : progress >= 40 ? "departed" : batch.status;

  const statements = [
    env.DB.prepare(
      `UPDATE transport_batches
       SET status=?, road_status=?, actual_departure_at=COALESCE(actual_departure_at,?),
            border_port=COALESCE(NULLIF(?,''), border_port), updated_at=?
       WHERE id=? AND organization_id=? AND road_status NOT IN ('overseas_arrived','waiting_pickup','pickup_completed')`,
    ).bind(
      targetBatchStatus,
      targetRoadStatus,
      exportedAt,
      borderLocation || "",
      now,
      batchId,
      organizationId,
    ),
  ];
  if (progress >= 40) {
    statements.push(
      env.DB.prepare(
        `UPDATE transport_batch_orders
         SET status=?, updated_at=?
         WHERE batch_id=? AND organization_id=? AND status NOT IN ('removed','picked_up')`,
      ).bind(progress >= 100 ? "arrived" : "departed", now, batchId, organizationId),
    );
  }
  await env.DB.batch(statements);
}

export async function recordShipmentEventForBatchOrders(params: {
  organizationId: string;
  orderIds: string[];
  eventAt: string;
  location: string | null;
  description: string;
  status: string;
  actorUserId: string;
  createdAt: string;
}): Promise<void> {
  const {
    organizationId,
    orderIds,
    eventAt,
    location,
    description,
    status,
    actorUserId,
    createdAt,
  } = params;
  if (!orderIds.length) return;

  const shipmentIds = new Set<string>();
  for (const chunk of chunkD1Values(orderIds)) {
    const placeholders = d1Placeholders(chunk.length);
    const shipmentRows = await env.DB.prepare(
      `SELECT s.id
       FROM shipments s
       WHERE s.organization_id=? AND s.order_id IN (${placeholders})
         AND s.id=(
           SELECT latest.id FROM shipments latest
           WHERE latest.organization_id=s.organization_id AND latest.order_id=s.order_id
           ORDER BY COALESCE(latest.updated_at,latest.created_at) DESC,latest.created_at DESC
           LIMIT 1
         )`,
    )
      .bind(organizationId, ...chunk)
      .all<{ id: string }>();
    for (const row of shipmentRows.results) {
      shipmentIds.add(row.id);
    }
  }

  const ids = [...shipmentIds];
  if (!ids.length) return;
  const statements = ids.flatMap((shipmentId) => [
    env.DB.prepare(
      "UPDATE shipments SET status=?, current_location=?, updated_at=? WHERE id=? AND organization_id=?",
    ).bind(status, location, createdAt, shipmentId, organizationId),
    env.DB.prepare(
      "INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,1,?,?)",
    ).bind(
      crypto.randomUUID(),
      shipmentId,
      status,
      location,
      description,
      eventAt,
      actorUserId,
      createdAt,
    ),
  ]);
  await env.DB.batch(statements);
}

export async function syncBatchTrackingMilestonesFromBatch(
  organizationId: string,
  orderIds: string[],
  actorUserId: string,
): Promise<void> {
  if (orderIds.length <= 1) return;

  const uniqueMilestones = new Map<
    string,
    {
      milestone_code: string;
      milestone_name: string;
      event_at: string;
      location: string | null;
      vehicle_reference: string | null;
      notes: string | null;
      visible_to_customer: number;
      created_at: string;
    }
  >();

  for (const chunk of chunkD1Values(orderIds)) {
    const placeholders = d1Placeholders(chunk.length);
    const milestones = await env.DB.prepare(
      `SELECT milestone_code, milestone_name, event_at, location, vehicle_reference, notes, visible_to_customer, created_at
       FROM order_tracking_milestones
       WHERE organization_id=? AND order_id IN (${placeholders})
       ORDER BY event_at, created_at`,
    )
      .bind(organizationId, ...chunk)
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

    for (const item of milestones.results) {
      if (!BATCH_SYNCED_TRACKING_MILESTONES.has(item.milestone_code)) continue;
      const key = `${item.milestone_code}|${item.event_at}|${item.location ?? ""}|${item.vehicle_reference ?? ""}|${item.notes ?? ""}|${item.visible_to_customer}`;
      if (!uniqueMilestones.has(key)) {
        uniqueMilestones.set(key, item);
      }
    }
  }

  const sharedMilestones = [...uniqueMilestones.values()];
  if (!sharedMilestones.length) return;

  const latestByCode = new Map<
    string,
    {
      milestone_code: string;
      milestone_name: string;
      event_at: string;
      location: string | null;
      vehicle_reference: string | null;
      notes: string | null;
      visible_to_customer: number;
      created_at: string;
    }
  >();
  for (const milestone of sharedMilestones) {
    const latest = latestByCode.get(milestone.milestone_code);
    if (!latest) {
      latestByCode.set(milestone.milestone_code, milestone);
      continue;
    }
    if (milestone.event_at > latest.event_at) {
      latestByCode.set(milestone.milestone_code, milestone);
      continue;
    }
    if (
      milestone.event_at === latest.event_at &&
      milestone.created_at > latest.created_at
    ) {
      latestByCode.set(milestone.milestone_code, milestone);
    }
  }

  const fallbackCreatedAt = new Date().toISOString();
  await env.DB.prepare(
    `WITH target_orders AS (
       SELECT DISTINCT CAST(value AS TEXT) AS order_id
       FROM json_each(?)
     ),
     shared_milestones AS (
       SELECT
         CAST(key AS INTEGER) AS source_order,
         CAST(json_extract(value, '$.milestone_code') AS TEXT) AS milestone_code,
         CAST(json_extract(value, '$.milestone_name') AS TEXT) AS milestone_name,
         CAST(json_extract(value, '$.event_at') AS TEXT) AS event_at,
         json_extract(value, '$.location') AS location,
         json_extract(value, '$.vehicle_reference') AS vehicle_reference,
         json_extract(value, '$.notes') AS notes,
         CAST(json_extract(value, '$.visible_to_customer') AS INTEGER) AS visible_to_customer,
         COALESCE(
           NULLIF(CAST(json_extract(value, '$.created_at') AS TEXT), ''),
           ?
         ) AS created_at
       FROM json_each(?)
     ),
     ranked_milestones AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY milestone_code, event_at
         ORDER BY source_order
       ) AS insert_rank
       FROM shared_milestones
     ),
     insertable_milestones AS (
       SELECT * FROM ranked_milestones WHERE insert_rank=1
     )
     INSERT INTO order_tracking_milestones(
       id,organization_id,order_id,milestone_code,milestone_name,event_at,
       location,vehicle_reference,notes,visible_to_customer,created_by_user_id,created_at
     )
     SELECT
       lower(hex(randomblob(16))), ?, target.order_id,
       milestone.milestone_code, milestone.milestone_name, milestone.event_at,
       milestone.location, milestone.vehicle_reference, milestone.notes,
       milestone.visible_to_customer, ?, milestone.created_at
     FROM target_orders target
     CROSS JOIN insertable_milestones milestone
     WHERE NOT EXISTS(
       SELECT 1 FROM order_tracking_milestones existing
       WHERE existing.organization_id=?
         AND existing.order_id=target.order_id
         AND existing.milestone_code=milestone.milestone_code
         AND existing.event_at=milestone.event_at
     )`,
  )
    .bind(
      JSON.stringify(orderIds),
      fallbackCreatedAt,
      JSON.stringify(sharedMilestones),
      organizationId,
      actorUserId,
      organizationId,
    )
    .run();

  const latestMilestones = [...latestByCode.values()];
  // A status projection performs several dependent reads/writes. Keep it serial so a
  // large batch cannot fan out into unbounded simultaneous D1 connections.
  for (const chunk of chunkD1Values(orderIds)) {
    for (const targetOrderId of chunk)
      for (const milestone of latestMilestones)
        await syncTrackingModuleStatusForOrder(
          organizationId,
          targetOrderId,
          milestone.milestone_code,
          actorUserId,
          new Date().toISOString(),
        );
  }
}
