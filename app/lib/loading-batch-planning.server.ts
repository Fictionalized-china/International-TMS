import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { chunkD1Rows, chunkD1Values, d1Placeholders } from "./d1-bindings";
import { ensureOrderModules, syncOrderWorkflowSnapshot } from "./order-modules.server";
import { orderVisibilitySql } from "./order-access.server";
import { pzNumber, randomPzSuffix } from "./package-identity";
import { refreshLoadingManifest } from "./loading-manifest.server";
import { synchronizeBatchTransport } from "./batch-transport-sync.server";
import {
  loadingBatchRequiredValueError,
  resolveLoadingBatchFieldPolicies,
} from "./loading-batch-field-policy";
import { loadLoadingBatchWorkflowOrders } from "./loading-batch-field-policy.server";
import { loadingConsolidationCandidateBlockers } from "./loading-consolidation-stage-gate";
import {
  loadLoadingConsolidationWorkflowAccesses,
  loadingConsolidationWorkflowAccessSql,
} from "./loading-consolidation-stage-gate.server";
import { pendingBatchApprovalNotificationStatement } from "./internal-notifications.server";

export type LoadingPlanningCandidate = {
  order_id: string;
  order_number: string;
  customer_name: string;
  business_type: string;
  warehouse_id: string;
  warehouse_name: string;
  warehouse_serial_code: string | null;
  packing_job_id: string;
  packing_status: string;
  package_count: number;
  pieces: number;
  weight_kg: number;
  volume_cbm: number;
  cargo_ready: number;
  has_exception: number;
  active_dispatch: number;
  active_batch_id: string | null;
  active_batch_number: string | null;
  overseas_warehouse_id: string | null;
  overseas_warehouse_name: string | null;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  operation_supervisor_user_id: string | null;
  exit_port: string | null;
  customs_location: string | null;
};

export type LoadingPlanningResourceOption = {
  id: string;
  carrier_id: string;
  name?: string;
  phone?: string | null;
  plate_number?: string;
  vehicle_type?: string | null;
};

const planningCandidateSelect = `SELECT o.id order_id,o.order_number,c.name customer_name,o.business_type,
    w.id warehouse_id,w.name warehouse_name,w.serial_code warehouse_serial_code,
    job.id packing_job_id,job.status packing_status,
    (SELECT COUNT(*) FROM warehouse_packages p WHERE p.organization_id=job.organization_id
      AND p.packing_job_id=job.id AND p.status='in_stock' AND p.label_kind='oul' AND p.lifecycle_status='active') package_count,
    COALESCE((SELECT SUM(p.pieces) FROM warehouse_packages p WHERE p.organization_id=job.organization_id
      AND p.packing_job_id=job.id AND p.status='in_stock' AND p.label_kind='oul' AND p.lifecycle_status='active'),0) pieces,
    job.total_weight_kg weight_kg,job.total_volume_cbm volume_cbm,
    1 cargo_ready,0 has_exception,0 active_dispatch,NULL active_batch_id,NULL active_batch_number,
    o.overseas_warehouse_id,ow.name overseas_warehouse_name,
    o.destination_country,o.destination_state,o.destination_city,o.operation_supervisor_user_id,
    o.exit_port,o.customs_location
  FROM transport_orders o
  JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
  JOIN warehouse_packing_jobs job ON job.organization_id=o.organization_id AND job.order_id=o.id
    AND job.status='labelled' AND job.transport_batch_id IS NULL
  JOIN warehouses w ON w.id=job.warehouse_id AND w.organization_id=job.organization_id
    AND w.status='active' AND w.warehouse_role!='overseas_destination'
  LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
  WHERE o.organization_id=? AND o.business_type='ltl'
    AND o.overseas_warehouse_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM warehouse_packages p WHERE p.organization_id=job.organization_id
      AND p.packing_job_id=job.id AND p.status='in_stock' AND p.label_kind='oul' AND p.lifecycle_status='active')
    AND EXISTS(SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id AND s.organization_id=r.organization_id
      WHERE r.organization_id=o.organization_id AND s.order_id=o.id AND r.warehouse_id=job.warehouse_id
        AND r.status='completed' AND r.cargo_complete=1)
    AND NOT EXISTS(SELECT 1 FROM warehouse_exceptions e JOIN shipments s ON s.id=e.shipment_id AND s.organization_id=e.organization_id
      WHERE e.organization_id=o.organization_id AND s.order_id=o.id AND e.status IN ('open','processing'))
    AND NOT EXISTS(SELECT 1 FROM warehouse_dispatches d
      JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
      JOIN warehouse_packages dp ON dp.id=di.package_id AND dp.organization_id=di.organization_id
      JOIN shipments ds ON ds.id=dp.shipment_id AND ds.organization_id=dp.organization_id
      WHERE d.organization_id=o.organization_id AND ds.order_id=o.id AND d.status!='cancelled')
    AND NOT EXISTS(SELECT 1 FROM transport_batch_orders bo
      JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
      WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.status!='cancelled')
    AND ${loadingConsolidationWorkflowAccessSql("o")}`;

export async function loadLoadingPlanningCandidates(current: SessionUser) {
  const visibility = orderVisibilitySql(current, "o");
  const result = await env.DB.prepare(
    `${planningCandidateSelect} AND ${visibility.sql}
     ORDER BY w.name,ow.name,o.destination_country,o.destination_state,o.destination_city,o.order_number
     LIMIT 300`,
  ).bind(current.organizationId, ...visibility.values).all<LoadingPlanningCandidate>();
  return result.results;
}

export async function loadLoadingPlanningOptions(organizationId: string) {
  const [carriers, vehicles, drivers, references] = await Promise.all([
    env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND status='active' AND carrier_scope='overseas' ORDER BY name")
      .bind(organizationId).all<{ id: string; name: string }>(),
    env.DB.prepare(`SELECT v.id,v.carrier_id,v.plate_number,v.vehicle_type
      FROM carrier_vehicles v JOIN carriers c ON c.id=v.carrier_id AND c.organization_id=v.organization_id
      WHERE v.organization_id=? AND v.status='active' AND c.status='active' AND c.carrier_scope='overseas'
      ORDER BY c.name,v.plate_number`).bind(organizationId).all<LoadingPlanningResourceOption>(),
    env.DB.prepare(`SELECT d.id,d.carrier_id,d.name,d.phone
      FROM carrier_drivers d JOIN carriers c ON c.id=d.carrier_id AND c.organization_id=d.organization_id
      WHERE d.organization_id=? AND d.status='active' AND c.status='active' AND c.carrier_scope='overseas'
      ORDER BY c.name,d.name`).bind(organizationId).all<LoadingPlanningResourceOption>(),
    env.DB.prepare("SELECT category,code,name FROM reference_data WHERE organization_id=? AND status='active' AND category IN ('border_port','customs_place') ORDER BY category,sort_order,name")
      .bind(organizationId).all<{ category: string; code: string; name: string }>(),
  ]);
  return {
    carriers: carriers.results,
    vehicles: vehicles.results,
    drivers: drivers.results,
    borderPorts: references.results.filter((item) => item.category === "border_port"),
    customsPlaces: references.results.filter((item) => item.category === "customs_place"),
  };
}

export async function createOperationPlannedBatch(input: {
  current: SessionUser;
  orderIds: readonly string[];
  batchName: string;
  carrierId: string;
  vehicleId: string;
  driverId: string;
  borderPort: string;
  customsLocation: string;
  plannedLoadingAt: string;
  plannedDepartureAt: string;
  plannedArrivalAt: string;
  routeNotes: string;
  notes: string;
}) {
  const orderIds = [...new Set(input.orderIds.filter(Boolean))];
  if (orderIds.length < 2) throw new Error("拼车配载至少选择 2 票订单");
  if (orderIds.length > 50) throw new Error("单张配载单最多选择 50 票订单");
  if (!input.carrierId || !input.vehicleId || !input.driverId) {
    throw new Error("请先选择商务已录入的境外承运商、车辆和司机，再生成配载单");
  }
  const visibility = orderVisibilitySql(input.current, "o");
  const rows = await env.DB.prepare(
    `${planningCandidateSelect} AND ${visibility.sql} AND o.id IN (${d1Placeholders(orderIds.length)})`,
  ).bind(input.current.organizationId, ...visibility.values, ...orderIds).all<LoadingPlanningCandidate>();
  if (rows.results.length !== orderIds.length) {
    throw new Error("部分订单已不满足配载条件、已被其他配载单占用或不在当前权限范围，请刷新后重选");
  }
  const byId = new Map(rows.results.map((row) => [row.order_id, row]));
  const candidates = orderIds.map((id) => byId.get(id)).filter((row): row is LoadingPlanningCandidate => Boolean(row));
  const accesses = await loadLoadingConsolidationWorkflowAccesses(env.DB, input.current.organizationId, orderIds);
  const accessByOrder = new Map(accesses.map((access) => [access.orderId, access]));
  const blockers = candidates.flatMap((row) => loadingConsolidationCandidateBlockers(row, accessByOrder.get(row.order_id))
    .map((reason) => `${row.order_number}：${reason}`));
  if (blockers.length) throw new Error(`暂不能配载：${[...new Set(blockers)].join("；")}`);
  const first = candidates[0];
  const same = (pick: (row: LoadingPlanningCandidate) => string | null) =>
    candidates.every((row) => (pick(row) || "").trim() === (pick(first) || "").trim());
  if (!same((row) => row.warehouse_id)) throw new Error("所选订单不在同一国内仓，请按仓库拆分配载");
  if (!same((row) => row.overseas_warehouse_id) ||
      !same((row) => row.destination_country) ||
      !same((row) => row.destination_state) ||
      !same((row) => row.destination_city)) {
    throw new Error("所选订单的境外目的仓或目的地区不一致，不能生成同一配载单");
  }
  if (!same((row) => row.operation_supervisor_user_id) || !first.operation_supervisor_user_id) {
    throw new Error("所选订单必须已指派同一操作主管，请按负责人拆分配载");
  }
  const workflowOrders = await loadLoadingBatchWorkflowOrders(input.current.organizationId, orderIds);
  const policies = resolveLoadingBatchFieldPolicies(workflowOrders);
  const requiredError = loadingBatchRequiredValueError(policies, {
    exit_port: input.borderPort,
    customs_location: input.customsLocation,
    planned_exit_at: input.plannedDepartureAt,
    planned_arrival_at: input.plannedArrivalAt,
    planned_loading_at: input.plannedLoadingAt,
    route_code: input.routeNotes,
    loading_notes: input.notes,
  });
  if (requiredError) throw new Error(requiredError);
  const [carrier, vehicle, driver] = await Promise.all([
    env.DB.prepare("SELECT id,name FROM carriers WHERE id=? AND organization_id=? AND status='active' AND carrier_scope='overseas'")
      .bind(input.carrierId, input.current.organizationId).first<{ id: string; name: string }>(),
    env.DB.prepare("SELECT id,carrier_id,plate_number,vehicle_type,capacity_weight_kg,capacity_volume_cbm FROM carrier_vehicles WHERE id=? AND organization_id=? AND status='active'")
      .bind(input.vehicleId, input.current.organizationId).first<{ id: string; carrier_id: string; plate_number: string; vehicle_type: string | null; capacity_weight_kg: number | null; capacity_volume_cbm: number | null }>(),
    env.DB.prepare("SELECT id,carrier_id,name,phone FROM carrier_drivers WHERE id=? AND organization_id=? AND status='active'")
      .bind(input.driverId, input.current.organizationId).first<{ id: string; carrier_id: string; name: string; phone: string | null }>(),
  ]);
  if (!carrier) throw new Error("所选境外承运商已停用或不存在");
  if (!vehicle || vehicle.carrier_id !== carrier.id) throw new Error("所选车辆不属于该境外承运商或已停用");
  if (!driver || driver.carrier_id !== carrier.id) throw new Error("所选司机不属于该境外承运商或已停用");
  if (!vehicle.vehicle_type?.trim()) throw new Error("所选车辆缺少车型，请先由商务在承运商管理中补充");
  if (!driver.phone?.trim()) throw new Error("所选司机缺少联系电话，请先由商务在承运商管理中补充");
  if (input.borderPort || input.customsLocation) {
    const references = await env.DB.prepare(`SELECT category,code FROM reference_data
      WHERE organization_id=? AND status='active' AND ((category='border_port' AND code=?) OR (category='customs_place' AND code=?))`)
      .bind(input.current.organizationId, input.borderPort, input.customsLocation).all<{ category: string; code: string }>();
    if (input.borderPort && !references.results.some((item) => item.category === "border_port" && item.code === input.borderPort)) {
      throw new Error("请选择基础数据中启用的出境口岸");
    }
    if (input.customsLocation && !references.results.some((item) => item.category === "customs_place" && item.code === input.customsLocation)) {
      throw new Error("请选择基础数据中启用的清关地");
    }
  }
  if (!first.warehouse_serial_code) throw new Error("装车仓尚未配置两位编号，不能生成配载单");
  const now = new Date().toISOString();
  const batchNumber = await nextBatchNumber(input.current.organizationId, first.warehouse_serial_code, new Date(now));
  const batchId = crypto.randomUUID();
  const destination = [first.overseas_warehouse_name,
    [first.destination_country, first.destination_state, first.destination_city].filter(Boolean).join(" ")]
    .filter(Boolean).join(" · ");
  const routeKey = [first.warehouse_id, first.overseas_warehouse_id, first.destination_country, first.destination_state, first.destination_city]
    .map((value) => (value || "").trim().toLowerCase()).join("|");
  const batchName = input.batchName || `${first.warehouse_name} → ${first.overseas_warehouse_name || first.destination_city}`;
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO transport_batches(
      id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,
      planned_departure_at,planned_arrival_at,status,notes,route_key,warehouse_id,carrier_id,
      created_by_user_id,created_at,updated_at,border_port,customs_location,transit_location,route_notes,
      planned_loading_at,overseas_carrier_name,overseas_vehicle_type,overseas_vehicle_count,
      overseas_vehicle_plate,overseas_driver_name,overseas_driver_phone,approval_status,
      operation_supervisor_user_id,submitted_by_user_id,submitted_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      batchId,input.current.organizationId,first.order_id,batchNumber,batchName,first.warehouse_name,destination,
      input.plannedDepartureAt || null,input.plannedArrivalAt || null,"planning",input.notes || null,routeKey,
      first.warehouse_id,carrier.id,input.current.userId,now,now,input.borderPort || null,input.customsLocation || null,
      null,input.routeNotes || null,input.plannedLoadingAt || null,carrier.name,vehicle.vehicle_type,1,
      vehicle.plate_number.trim().toUpperCase(),driver.name.trim(),driver.phone.trim(),"submitted",
      first.operation_supervisor_user_id,input.current.userId,now,
    ), env.DB.prepare(`INSERT INTO transport_batch_vehicles(
      id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,carrier_id,driver_name,driver_phone,
      capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at,vehicle_master_id,driver_master_id
    ) VALUES(?,?,?,'MAIN-1',?,?,?,?,?,?,?,'planned',?,?,?,?)`).bind(
      crypto.randomUUID(),input.current.organizationId,batchId,vehicle.vehicle_type,vehicle.plate_number.trim().toUpperCase(),
      carrier.id,driver.name.trim(),driver.phone.trim(),vehicle.capacity_weight_kg || 0,vehicle.capacity_volume_cbm || 0,
      now,now,vehicle.id,driver.id,
    )];
  for (const rowChunk of chunkD1Values(candidates, 5)) {
    statements.push(env.DB.prepare(`UPDATE warehouse_packing_jobs SET status='allocated',transport_batch_id=?,updated_at=?
      WHERE organization_id=? AND warehouse_id=? AND status='labelled' AND transport_batch_id IS NULL
        AND id IN (${d1Placeholders(rowChunk.length)})`)
      .bind(batchId,now,input.current.organizationId,first.warehouse_id,...rowChunk.map((row) => row.packing_job_id)));
  }
  let sequenceOffset = 0;
  for (const rowChunk of chunkD1Rows(candidates, 8)) {
    const start = sequenceOffset;
    statements.push(env.DB.prepare(`INSERT INTO transport_batch_orders(
      id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at
    ) VALUES ${rowChunk.map(() => "(?,?,?,?,?,'planned',?,?,?)").join(",")}`)
      .bind(...rowChunk.flatMap((row, index) => [crypto.randomUUID(),input.current.organizationId,batchId,row.order_id,start + index + 1,input.current.userId,now,now])));
    sequenceOffset += rowChunk.length;
  }
  statements.push(pendingBatchApprovalNotificationStatement(env.DB, {
    organizationId: input.current.organizationId,
    batchId,
    batchNumber,
    supervisorUserId: first.operation_supervisor_user_id,
    actorUserId: input.current.userId,
    now,
  }));
  for (const orderChunk of chunkD1Values(orderIds, 6)) {
    statements.push(env.DB.prepare(`UPDATE transport_orders SET
      exit_port=CASE WHEN ?<>'' THEN ? ELSE exit_port END,
      customs_location=CASE WHEN ?<>'' THEN ? ELSE customs_location END,updated_at=?
      WHERE organization_id=? AND id IN (${d1Placeholders(orderChunk.length)})`)
      .bind(input.borderPort,input.borderPort,input.customsLocation,input.customsLocation,now,input.current.organizationId,...orderChunk));
  }
  await env.DB.batch(statements);
  await activateLoadingModules(input.current.organizationId, orderIds, batchNumber, input.current.userId, now);
  await synchronizeBatchTransport(input.current.organizationId, batchId, now);
  await refreshLoadingManifest(input.current.organizationId, batchId, input.current.userId, now);
  return {
    batchId,
    batchNumber,
    orderIds,
    operationSupervisorUserId: first.operation_supervisor_user_id,
    totalWeight: candidates.reduce((sum, row) => sum + Number(row.weight_kg || 0), 0),
    totalVolume: candidates.reduce((sum, row) => sum + Number(row.volume_cbm || 0), 0),
  };
}

async function nextBatchNumber(organizationId: string, warehouseSerialCode: string, at: Date) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const candidate = pzNumber({ warehouseSerialCode, at, suffix: randomPzSuffix() });
    const exists = await env.DB.prepare("SELECT 1 ok FROM transport_batches WHERE organization_id=? AND batch_number=?")
      .bind(organizationId, candidate).first();
    if (!exists) return candidate;
  }
  throw new Error("配载单随机编号连续冲突，请重试");
}

async function activateLoadingModules(
  organizationId: string,
  orderIds: readonly string[],
  batchNumber: string,
  userId: string,
  now: string,
) {
  for (const orderId of orderIds) await ensureOrderModules(organizationId, orderId);
  const modules: Array<{ id: string; order_id: string; current_step_code: string | null }> = [];
  for (const orderChunk of chunkD1Values([...orderIds], 1)) {
    const result = await env.DB.prepare(`SELECT id,order_id,current_step_code FROM order_module_instances
      WHERE organization_id=? AND module_code='loading' AND enabled=1
        AND order_id IN (${d1Placeholders(orderChunk.length)})`)
      .bind(organizationId,...orderChunk).all<{ id: string; order_id: string; current_step_code: string | null }>();
    modules.push(...result.results);
  }
  const statements: D1PreparedStatement[] = [];
  for (const moduleChunk of chunkD1Values(modules, 2)) {
    statements.push(env.DB.prepare(`UPDATE order_module_instances SET status='in_progress',
      current_step_code='planned',current_step_name='配载成单',progress_percent=75,
      started_at=COALESCE(started_at,?),completed_at=NULL,blocking_reason=NULL,updated_at=?
      WHERE id IN (${d1Placeholders(moduleChunk.length)})`)
      .bind(now,now,...moduleChunk.map((module) => module.id)));
  }
  for (const moduleChunk of chunkD1Rows(modules, 12)) {
    statements.push(env.DB.prepare(`INSERT INTO order_module_history(
      id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,
      to_step_code,to_step_name,actor_user_id,notes,occurred_at
    ) VALUES ${moduleChunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}`)
      .bind(...moduleChunk.flatMap((module) => [crypto.randomUUID(),organizationId,module.order_id,module.id,
        "batch_create","操作主管配载规划",module.current_step_code,"planned","配载成单",userId,
        `加入配载单 ${batchNumber}`,now])));
  }
  if (statements.length) await env.DB.batch(statements);
  for (const orderId of orderIds) await syncOrderWorkflowSnapshot(organizationId, orderId);
}
