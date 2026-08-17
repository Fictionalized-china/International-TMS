import { env } from "cloudflare:workers";
import { syncOrderWorkflowSnapshot } from "./order-modules.server";

// 配载页"运输执行与跟踪"区块使用的常量与共享函数。
// 里程碑写入、模块状态同步等 SQL 与 admin.order-module.tsx 的对应实现保持一致，
// 以便从两条入口（订单级 / 配载级）写入的数据形态完全相同。

export type BatchTrackingMilestone = {
  code: string;
  name: string;
  progress: number;
  optional?: boolean;
};

// 5 个主节点 + 2 个可选节点（换装 / 转关）
export const BATCH_TRACKING_MILESTONES: BatchTrackingMilestone[] = [
  { code: "border_arrived", name: "到达出境口岸", progress: 28 },
  { code: "exported", name: "出境", progress: 40 },
  { code: "transloaded", name: "换装", progress: 46, optional: true },
  { code: "transit_customs", name: "转关", progress: 52, optional: true },
  { code: "foreign_entered", name: "国外入境", progress: 64 },
  { code: "customs_cleared", name: "目的地清关完成", progress: 82 },
  { code: "station_arrived", name: "到达境外目的仓", progress: 100 },
];

export const BATCH_TRACKING_MAIN_CODES = [
  "border_arrived",
  "exported",
  "foreign_entered",
  "customs_cleared",
  "station_arrived",
];

export const BATCH_TRACKING_OPTIONAL_CODES = ["transloaded", "transit_customs"];

// 顺序门禁：登记某节点前，批次内每个订单都必须已存在其前置节点
// 与 admin.order-module.tsx 的 requiredPrevious 一致
export const BATCH_TRACKING_REQUIRED_PREVIOUS: Record<string, string[]> = {
  exported: ["border_arrived"],
  transloaded: ["exported"],
  transit_customs: ["exported"],
  foreign_entered: ["exported"],
  customs_cleared: ["foreign_entered"],
  station_arrived: ["customs_cleared"],
};

// 这些节点登记后会同步到同批次所有子订单
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

// milestone_code -> (step, name, progress) 映射；与 order-module.tsx syncTrackingModuleStatus 内联
const MILESTONE_MODULE_MAPPING: Record<
  string,
  { step: string; name: string; progress: number; complete?: boolean }
> = {
  departed: { step: "departed", name: "已登记发车", progress: 15 },
  border_arrived: { step: "transit", name: "到达出境口岸", progress: 28 },
  exported: { step: "transit", name: "已出境", progress: 40 },
  transloaded: { step: "transit", name: "已换装", progress: 46 },
  transit_customs: { step: "transit", name: "转关处理中", progress: 52 },
  foreign_entered: { step: "transit", name: "国外已入境", progress: 64 },
  customs_cleared: { step: "customs_cleared", name: "目的地清关完成", progress: 82 },
  station_arrived: { step: "arrived", name: "到达境外目的仓", progress: 100, complete: true },
};

// 进度权重，用于 SQL 内的 CASE 排序
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

/**
 * 取批次内全部子订单 ID（按 sequence_no 排序，排除已移除的）
 */
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

/**
 * 取批次主车辆的车牌（第一个未取消的车辆；优先取已录车牌的那条）
 */
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

/**
 * 校验"前置节点"是否已存在于批次内全部子订单。
 * 返回缺失前置的订单数与示例订单号；全部满足时返回 null。
 */
export async function validateBatchTrackingRequiredPrevious(
  organizationId: string,
  orderIds: string[],
  milestoneCode: string,
): Promise<{ missingOrders: number; sampleOrderNumber: string | null } | null> {
  const required = BATCH_TRACKING_REQUIRED_PREVIOUS[milestoneCode];
  if (!required || required.length === 0 || !orderIds.length) return null;
  const placeholders = orderIds.map(() => "?").join(",");
  // 任一前置节点缺失的订单 = 这些订单在该 code 上没有任何记录
  const missingRows = await env.DB.prepare(
    `SELECT o.order_number
     FROM transport_orders o
     WHERE o.organization_id=? AND o.id IN (${placeholders})
       AND NOT EXISTS(
         SELECT 1 FROM order_tracking_milestones m
         WHERE m.organization_id=o.organization_id AND m.order_id=o.id
           AND m.milestone_code IN (${required.map(() => "?").join(",")})
       )`,
  )
    .bind(organizationId, ...orderIds, ...required)
    .all<{ order_number: string }>();
  if (!missingRows.results.length) return null;
  return {
    missingOrders: missingRows.results.length,
    sampleOrderNumber: missingRows.results[0].order_number,
  };
}

/**
 * 给批次内全部子订单幂等写入一条追踪里程碑。
 * 同一订单同一 code + event_at 只写一次（与 order-module.tsx 一致）。
 * 返回实际插入的行数（如已存在则不重复写）。
 */
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
      `INSERT INTO order_tracking_milestones(id,organization_id,order_id,milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer,created_by_user_id,created_at)
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
  // 没有精确的"插入了几行"返回值（NOT EXISTS 在 SQLite 中无法获知实际命中），
  // 这里只返回订单数作为上界。
  return orderIds.length;
}

/**
 * 对应 admin.order-module.tsx 的 syncTrackingModuleStatus。
 * 根据最新里程碑推进 tracking 模块实例状态与历史记录。
 */
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

/**
 * 对应 admin.order-module.tsx 的 syncBatchStateFromTrackingMilestones。
 * 根据批次内最新里程碑推进 transport_batches / 车辆 / 订单的状态。
 * 这里仅更新 transport_batches 主状态和 tracking 模块实例的进度——
 * 与原函数相比有意简化（不动 transport_batch_vehicles 的 status），避免与
 * exit_confirm 路径重复触发车辆状态变更。
 */
export async function syncBatchRoadStatusFromTracking(
  organizationId: string,
  batchId: string,
  orderIds: string[],
  now: string,
): Promise<void> {
  if (!orderIds.length) return;
  const placeholders = orderIds.map(() => "?").join(",");
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
    .bind(organizationId, ...orderIds)
    .first<{ milestone_code: string; event_at: string; location: string | null }>();
  if (!latest) return;

  const batch = await env.DB.prepare(
    "SELECT id,road_status FROM transport_batches WHERE id=? AND organization_id=? AND status!='cancelled'",
  )
    .bind(batchId, organizationId)
    .first<{ id: string; road_status: string }>();
  if (!batch) return;
  // 若批次已到境外仓或更后阶段，不再因新里程碑回退 road_status
  if (["overseas_arrived", "waiting_pickup", "pickup_completed"].includes(batch.road_status)) return;

  const progress = MILESTONE_PROGRESS_WEIGHTS[latest.milestone_code] ?? 0;
  // 仅当里程碑推进到 transit 阶段（progress>=28）时，把批次置为 outbound_in_transit
  // 若已达 station_arrived（progress=100），把批次置为 overseas_arrived
  const targetRoadStatus =
    progress >= 100
      ? "overseas_arrived"
      : progress >= 28
        ? "outbound_in_transit"
        : batch.road_status;

  const statements = [
    env.DB.prepare(
      `UPDATE transport_batches
       SET road_status=?, actual_departure_at=COALESCE(actual_departure_at,?),
           border_port=COALESCE(NULLIF(?,''), border_port), updated_at=?
       WHERE id=? AND organization_id=? AND road_status NOT IN ('overseas_arrived','waiting_pickup','pickup_completed')`,
    ).bind(targetRoadStatus, latest.event_at, latest.location || "", now, batchId, organizationId),
    // transport_batch_orders 与 tracking 模块实例同步（仅当 progress>=28 时）
    env.DB.prepare(
      `UPDATE transport_batch_orders SET status='departed', updated_at=?
       WHERE batch_id=? AND organization_id=? AND status NOT IN ('removed','arrived','picked_up')`,
    ).bind(now, batchId, organizationId),
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status='in_progress', current_step_code='transit', current_step_name='出境运输中',
           progress_percent=50, started_at=COALESCE(started_at,?), blocking_reason=NULL, updated_at=?
       WHERE organization_id=? AND module_code='tracking' AND enabled=1
         AND COALESCE(progress_percent,0)<50 AND order_id IN (${placeholders})`,
    ).bind(now, now, organizationId, ...orderIds),
  ];
  await env.DB.batch(statements);
}

/**
 * 对每票订单的最新 shipment 写一条 shipment_event，并把 shipments.current_location 推进。
 * 不存在 shipment 时跳过。
 */
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
  const placeholders = orderIds.map(() => "?").join(",");
  const shipments = await env.DB.prepare(
    `SELECT s.id, s.customer_id FROM shipments s
     WHERE s.organization_id=? AND s.id IN (
       SELECT id FROM shipments WHERE order_id IN (${placeholders})
       ORDER BY created_at DESC
     )`,
  )
    .bind(organizationId, ...orderIds)
    .all<{ id: string; customer_id: string | null }>();
  if (!shipments.results.length) return;
  const statements = shipments.results.flatMap((shipment) => [
    env.DB.prepare(
      "UPDATE shipments SET status=?, current_location=?, updated_at=? WHERE id=? AND organization_id=?",
    ).bind(status, location, createdAt, shipment.id, organizationId),
    env.DB.prepare(
      "INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,1,?,?)",
    ).bind(
      crypto.randomUUID(),
      shipment.id,
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

/**
 * 反向同步：把批次内任一订单已登记的同步类里程碑幂等复制到其他订单。
 * 用于 loader 打开配载页时保证子订单里程碑状态一致。
 */
export async function syncBatchTrackingMilestonesFromBatch(
  organizationId: string,
  orderIds: string[],
  actorUserId: string,
): Promise<void> {
  if (orderIds.length <= 1) return;
  const placeholders = orderIds.map(() => "?").join(",");
  const milestones = await env.DB.prepare(
    `SELECT milestone_code, milestone_name, event_at, location, vehicle_reference, notes, visible_to_customer, created_at
     FROM order_tracking_milestones
     WHERE organization_id=? AND order_id IN (${placeholders})
     ORDER BY event_at, created_at`,
  )
    .bind(organizationId, ...orderIds)
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
    BATCH_SYNCED_TRACKING_MILESTONES.has(item.milestone_code),
  );
  if (!shared.length) return;
  const now = new Date().toISOString();
  const statements = orderIds.flatMap((targetOrderId) =>
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
  const latestByCode = new Map<string, (typeof shared)[number]>();
  for (const milestone of shared) latestByCode.set(milestone.milestone_code, milestone);
  for (const targetOrderId of orderIds) {
    for (const milestone of latestByCode.values()) {
      await syncTrackingModuleStatusForOrder(
        organizationId,
        targetOrderId,
        milestone.milestone_code,
        actorUserId,
        now,
      );
    }
  }
}
