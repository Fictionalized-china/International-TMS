import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { chunkD1Rows, chunkD1Values, d1Placeholders } from "./d1-bindings";
import { ensureOrderModules, syncOrderWorkflowSnapshot } from "./order-modules.server";
import { orderVisibilitySql } from "./order-access.server";
import { pzNumber, randomPzSuffix } from "./package-identity";
import { ensureBatchSystemDocuments } from "./loading-manifest.server";
import { sha256 } from "./crypto.server";
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
import {
  assignedBatchNotificationStatement,
  warehouseBatchReadyNotificationStatement,
} from "./internal-notifications.server";
import { listActiveOrganizationAssignees, isActiveOrganizationAssigneeForPositions } from "./organization-assignee.server";
import {
  BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS,
  buildConfiguredBatchResponsibilityTargets,
  eligibleBatchInitialResponsibilityCandidates,
  buildBatchInitialResponsibilityRestrictions,
  type BatchResponsibilityTransferTarget,
} from "./batch-responsibility";
import { loadOrderAssignmentManifest } from "./order-assignment-manifest.server";
import { allocateCost, allocationDensity, recommendAllocationMethod, type AllocationMethod } from "./cost-allocation";

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
  receivable_base_amount: number;
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
    o.exit_port,o.customs_location,
    COALESCE((SELECT SUM(e.base_amount) FROM business_expenses e
      WHERE e.organization_id=o.organization_id AND e.order_id=o.id
        AND e.direction='receivable' AND e.stage!='cancelled'),0) receivable_base_amount
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
  const [carriers, vehicles, drivers, references, members] = await Promise.all([
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
    listActiveOrganizationAssignees(organizationId),
  ]);
  const emptyRestrictions = buildBatchInitialResponsibilityRestrictions([]);
  return {
    carriers: carriers.results,
    vehicles: vehicles.results,
    drivers: drivers.results,
    borderPorts: references.results.filter((item) => item.category === "border_port"),
    customsPlaces: references.results.filter((item) => item.category === "customs_place"),
    operationMembers: eligibleBatchInitialResponsibilityCandidates(members, emptyRestrictions, "operation"),
    documentMembers: eligibleBatchInitialResponsibilityCandidates(members, emptyRestrictions, "document"),
  };
}

async function loadBatchResponsibilityTransferTargets(input: {
  organizationId: string;
  orderIds: readonly string[];
  operationAssigneeUserId: string;
  documentAssigneeUserId: string;
}) {
  const targets: BatchResponsibilityTransferTarget[] = [];
  for (const orderId of input.orderIds) {
    const manifest = await loadOrderAssignmentManifest(input.organizationId, orderId);
    targets.push(...buildConfiguredBatchResponsibilityTargets({
      orderId,
      manifest,
      operationAssigneeUserId: input.operationAssigneeUserId,
      documentAssigneeUserId: input.documentAssigneeUserId,
    }));
  }
  for (const positionCode of ["OPERATION", "DOC"] as const) {
    if (!targets.some((target) => target.positionCode === positionCode)) {
      throw new Error(`挂载订单冻结工作流中没有未完成的${positionCode === "OPERATION" ? "操作" : "单证"}职责`);
    }
  }
  return targets;
}

type PlannedBatchResult = {
  batchId: string; batchNumber: string; orderIds: string[];
  operationSupervisorUserId: string | null; totalWeight: number; totalVolume: number;
  receivableBaseAmount: number; costBaseAmount: number; costAllocationId: string;
};
type PlanningSubmission = {
  payload_hash: string; batch_id: string; result_json: string | PlannedBatchResult;
  sync_status: "pending" | "complete";
};
type PlanningInput = {
  current: SessionUser;
  requestId: string;
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
  operationAssigneeUserId: string;
  documentAssigneeUserId: string;
  costAmount: number;
  costCurrency: string;
  costExchangeRate: number;
  costAllocationMethod: "auto" | AllocationMethod;
};

async function loadSubmission(input: Pick<PlanningInput, "current" | "requestId">) {
  return env.DB.prepare(`SELECT payload_hash,batch_id,result_json,sync_status FROM loading_planning_submissions
    WHERE organization_id=? AND actor_user_id=? AND request_id=?`)
    .bind(input.current.organizationId,input.current.userId,input.requestId).first<PlanningSubmission>();
}

export async function createOperationPlannedBatch(input: PlanningInput) {
  if (!/^[a-zA-Z0-9-]{16,128}$/.test(input.requestId)) throw new Error("提交标识无效，请刷新页面后重试");
  const orderIds = [...new Set(input.orderIds.filter(Boolean))].sort();
  const { current: _current, requestId: _requestId, ...payload } = input;
  const payloadHash = await sha256(JSON.stringify({ ...payload, orderIds }));
  const previous = await loadSubmission(input);
  if (previous) {
    if (previous.payload_hash !== payloadHash) throw new Error("这次提交已保存过不同的规划，请刷新页面后发起新规划");
    return resumeOperationPlannedBatch(input.current,previous.batch_id);
  }
  if (orderIds.length < 2) throw new Error("拼车配载至少选择 2 票订单");
  if (orderIds.length > 50) throw new Error("单张配载单最多选择 50 票订单");
  if (!input.carrierId || !input.vehicleId || !input.driverId) {
    throw new Error("请先选择商务已录入的境外承运商、车辆和司机，再生成配载单");
  }
  if (!input.operationAssigneeUserId || !input.documentAssigneeUserId) {
    throw new Error("请选择整批操作负责人和单证负责人");
  }
  if (!Number.isFinite(input.costAmount) || input.costAmount <= 0) {
    throw new Error("请填写大于 0 的境外运输成本");
  }
  if (!Number.isFinite(input.costExchangeRate) || input.costExchangeRate <= 0) {
    throw new Error("费用汇率必须大于 0");
  }
  if (!["CNY","USD","RUB","KZT","UZS"].includes(input.costCurrency)) throw new Error("成本币种无效");
  if (input.costCurrency === "CNY" && input.costExchangeRate !== 1) throw new Error("人民币成本折算汇率必须为 1");
  const [operationAssigneeValid, documentAssigneeValid] = await Promise.all([
    isActiveOrganizationAssigneeForPositions(
      input.current.organizationId,
      input.operationAssigneeUserId,
      ["OPERATION"],
      BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS.operation,
    ),
    isActiveOrganizationAssigneeForPositions(
      input.current.organizationId,
      input.documentAssigneeUserId,
      ["DOC"],
      BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS.document,
    ),
  ]);
  if (!operationAssigneeValid) throw new Error("所选操作负责人岗位或权限已变化，请刷新后重选");
  if (!documentAssigneeValid) throw new Error("所选单证负责人岗位或权限已变化，请刷新后重选");
  const visibility = orderVisibilitySql(input.current, "o");
  const rows = await env.DB.prepare(
    `${planningCandidateSelect} AND ${visibility.sql} AND o.id IN (${d1Placeholders(orderIds.length)})`,
  ).bind(input.current.organizationId, ...visibility.values, ...orderIds).all<LoadingPlanningCandidate>();
  if (rows.results.length !== orderIds.length) {
    const winner = await loadSubmission(input);
    if (winner?.payload_hash === payloadHash) return resumeOperationPlannedBatch(input.current,winner.batch_id);
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
  const privileged = ["BOSS","DEVELOPER"].includes(input.current.positionCode || "") ||
    input.current.roleCodes.some((code) => ["owner","boss","developer"].includes(code));
  if (!privileged && first.operation_supervisor_user_id !== input.current.userId) {
    throw new Error("仅订单已指派的操作主管可以生成本批配载单");
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
  const responsibilityTargets = await loadBatchResponsibilityTransferTargets({
    organizationId: input.current.organizationId,
    orderIds,
    operationAssigneeUserId: input.operationAssigneeUserId,
    documentAssigneeUserId: input.documentAssigneeUserId,
  });
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
  const responsibilityRevision = crypto.randomUUID();
  const totalWeight = candidates.reduce((sum, row) => sum + Number(row.weight_kg || 0), 0);
  const totalVolume = candidates.reduce((sum, row) => sum + Number(row.volume_cbm || 0), 0);
  const allocationMethod = input.costAllocationMethod === "auto"
    ? recommendAllocationMethod("OVERSEAS_TRANSPORT", totalWeight, totalVolume, 300)
    : input.costAllocationMethod;
  if (!["weight", "volume", "equal"].includes(allocationMethod)) {
    throw new Error("成本分摊方式无效，请刷新后重试");
  }
  const costSuggestions = allocateCost(candidates.map((row) => ({
    orderId: row.order_id,
    actualWeightKg: Number(row.weight_kg || 0),
    actualVolumeCbm: Number(row.volume_cbm || 0),
  })), input.costAmount, allocationMethod);
  const costAllocationId = crypto.randomUUID();
  const density = allocationDensity(totalWeight, totalVolume);
  const result: PlannedBatchResult = {
    batchId,batchNumber,orderIds,operationSupervisorUserId:first.operation_supervisor_user_id,
    totalWeight,totalVolume,
    receivableBaseAmount:candidates.reduce((sum,row) => sum + Number(row.receivable_base_amount || 0),0),
    costBaseAmount:input.costAmount * input.costExchangeRate,costAllocationId,
  };
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO transport_batches(
      id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,
      planned_departure_at,planned_arrival_at,status,notes,route_key,warehouse_id,carrier_id,
      created_by_user_id,created_at,updated_at,border_port,customs_location,transit_location,route_notes,
      planned_loading_at,overseas_carrier_name,overseas_vehicle_type,overseas_vehicle_count,
      overseas_vehicle_plate,overseas_driver_name,overseas_driver_phone,approval_status,
      operation_supervisor_user_id,operation_assignee_user_id,document_assignee_user_id,
      responsibility_revision,submitted_by_user_id,submitted_at,approved_by_user_id,approved_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      batchId,input.current.organizationId,first.order_id,batchNumber,batchName,first.warehouse_name,destination,
      input.plannedDepartureAt || null,input.plannedArrivalAt || null,"planning",input.notes || null,routeKey,
      first.warehouse_id,carrier.id,input.current.userId,now,now,input.borderPort || null,input.customsLocation || null,
      null,input.routeNotes || null,input.plannedLoadingAt || null,carrier.name,vehicle.vehicle_type,1,
      vehicle.plate_number.trim().toUpperCase(),driver.name.trim(),driver.phone.trim(),"draft",
      first.operation_supervisor_user_id,input.operationAssigneeUserId,input.documentAssigneeUserId,
      responsibilityRevision,input.current.userId,now,input.current.userId,now,
    ), env.DB.prepare(`INSERT INTO loading_planning_submissions(
      organization_id,actor_user_id,request_id,payload_hash,batch_id,result_json,sync_status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'pending',?,?)`).bind(
      input.current.organizationId,input.current.userId,input.requestId,payloadHash,batchId,JSON.stringify(result),now,now,
    ), env.DB.prepare(`INSERT INTO transport_batch_vehicles(
      id,organization_id,batch_id,vehicle_no,vehicle_type,plate_number,carrier_id,driver_name,driver_phone,
      capacity_weight_kg,capacity_volume_cbm,status,created_at,updated_at,vehicle_master_id,driver_master_id
    ) VALUES(?,?,?,'MAIN-1',?,?,?,?,?,?,?,'planned',?,?,?,?)`).bind(
      crypto.randomUUID(),input.current.organizationId,batchId,vehicle.vehicle_type,vehicle.plate_number.trim().toUpperCase(),
      carrier.id,driver.name.trim(),driver.phone.trim(),vehicle.capacity_weight_kg || 0,vehicle.capacity_volume_cbm || 0,
      now,now,vehicle.id,driver.id,
    ), env.DB.prepare(`INSERT INTO transport_cost_allocations(
      id,organization_id,batch_id,charge_code,charge_name,counterparty_name,currency,exchange_rate,
      total_amount,allocation_method,total_actual_weight_kg,total_actual_volume_cbm,density_kg_per_cbm,
      density_result,status,notes,created_by_user_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`).bind(
      costAllocationId,input.current.organizationId,batchId,"OVERSEAS_TRANSPORT","境外运输费",carrier.name,
      input.costCurrency.trim().toUpperCase() || "CNY",input.costExchangeRate,input.costAmount,allocationMethod,
      totalWeight,totalVolume,density,density < 300 ? "轻货：按 1:300 抛重比建议按体积分摊" : "重货：按实收重量分摊",
      `配载单生成前成本预览；${input.notes || "无备注"}`,input.current.userId,now,now,
    ), ...costSuggestions.map((line) => env.DB.prepare(`INSERT INTO transport_cost_allocation_lines(
      id,organization_id,allocation_id,order_id,actual_weight_kg,actual_volume_cbm,suggested_ratio,
      suggested_amount,final_amount,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(
      crypto.randomUUID(),input.current.organizationId,costAllocationId,line.orderId,line.actualWeightKg,
      line.actualVolumeCbm,line.ratio,line.amount,line.amount,now,now,
    ))];
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
  for (const orderId of orderIds) {
    const orderTargets = responsibilityTargets.filter((target) => target.orderId === orderId);
    const moduleCodes = [...new Set(orderTargets.flatMap((target) => target.moduleCodes))];
    for (const moduleCodeChunk of chunkD1Values(moduleCodes, 8)) {
      statements.push(env.DB.prepare(`UPDATE order_tasks SET status='cancelled',updated_at=?
        WHERE organization_id=? AND order_id=? AND task_type='module_owner'
          AND status IN ('pending','in_progress')
          AND module_code IN (${d1Placeholders(moduleCodeChunk.length)})`)
        .bind(now,input.current.organizationId,orderId,...moduleCodeChunk));
    }
    for (const target of orderTargets) {
      for (const taskStateIds of chunkD1Values(target.taskStateIds, 10)) {
        statements.push(env.DB.prepare(`UPDATE workflow_instance_task_states
          SET assignee_user_id=?,updated_at=?
          WHERE id IN (${d1Placeholders(taskStateIds.length)})
            AND status NOT IN ('completed','not_applicable')
            AND instance_module_state_id IN (
              SELECT module_state.id FROM workflow_instance_module_states module_state
              JOIN workflow_instance_step_states step_state ON step_state.id=module_state.instance_step_state_id
              JOIN workflow_instances instance ON instance.id=step_state.instance_id
              WHERE instance.id=? AND instance.organization_id=? AND instance.order_id=?
            )`)
          .bind(target.assigneeUserId,now,...taskStateIds,target.workflowInstanceId,input.current.organizationId,orderId));
      }
      for (const primaryModuleCodes of chunkD1Values(target.primaryModuleCodes, 12)) {
        statements.push(env.DB.prepare(`UPDATE order_module_instances
          SET assignee_user_id=?,blocking_reason=NULL,updated_at=?
          WHERE organization_id=? AND order_id=?
            AND module_code IN (${d1Placeholders(primaryModuleCodes.length)})
            AND status NOT IN ('completed','not_applicable')`)
          .bind(target.assigneeUserId,now,input.current.organizationId,orderId,...primaryModuleCodes));
      }
      for (const targetModuleCodes of chunkD1Values(target.moduleCodes, 12)) {
        statements.push(env.DB.prepare(`INSERT INTO order_tasks(
            id,organization_id,order_id,module_code,task_type,title,status,assignee_user_id,
            assigned_by_user_id,due_at,created_at,updated_at
          )
          SELECT lower(hex(randomblob(16))),module.organization_id,module.order_id,module.module_code,'module_owner',
            module.module_name||?,'pending',?,?,NULL,?,?
          FROM order_module_instances module
          WHERE module.organization_id=? AND module.order_id=?
            AND module.module_code IN (${d1Placeholders(targetModuleCodes.length)})
            AND module.status NOT IN ('completed','not_applicable')`)
          .bind(`处理任务（${target.positionCode}）`,target.assigneeUserId,input.current.userId,now,now,
            input.current.organizationId,orderId,...targetModuleCodes));
        statements.push(env.DB.prepare(`INSERT INTO order_module_history(
            id,organization_id,order_id,module_instance_id,action_code,action_name,
            from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
          )
          SELECT lower(hex(randomblob(16))),module.organization_id,module.order_id,module.id,'assign',
            '配载单统一分配',module.current_step_code,module.current_step_code,module.current_step_name,?,?,?
          FROM order_module_instances module
          WHERE module.organization_id=? AND module.order_id=?
            AND module.module_code IN (${d1Placeholders(targetModuleCodes.length)})
            AND module.status NOT IN ('completed','not_applicable')`)
          .bind(input.current.userId,`${batchNumber}：操作与单证职责按冻结工作流配置统一交接`,now,
            input.current.organizationId,orderId,...targetModuleCodes));
      }
    }
  }
  for (const orderChunk of chunkD1Values(orderIds, 6)) {
    statements.push(env.DB.prepare(`UPDATE transport_orders SET
      exit_port=CASE WHEN ?<>'' THEN ? ELSE exit_port END,
      customs_location=CASE WHEN ?<>'' THEN ? ELSE customs_location END,updated_at=?
      WHERE organization_id=? AND id IN (${d1Placeholders(orderChunk.length)})`)
      .bind(input.borderPort,input.borderPort,input.customsLocation,input.customsLocation,now,input.current.organizationId,...orderChunk));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    // The database rolls back the complete batch if the request key or active
    // order claim loses a race. A repeated identical request reuses its winner.
    const winner = await loadSubmission(input);
    if (winner && winner.payload_hash === payloadHash) return resumeOperationPlannedBatch(input.current,winner.batch_id);
    if (String(error).includes("transport_batch_order_claims")) {
      throw new Error("所选订单已被其他配载单占用，本次规划未保存，请刷新后重选");
    }
    throw error;
  }
  return resumeOperationPlannedBatch(input.current,batchId).catch((error) => {
    console.error("LOADING_PLAN_SYNC_PENDING",{batchId,error:String(error)});
    return { ...result, syncPending:true };
  });
}

export async function resumeOperationPlannedBatch(current: SessionUser, batchId: string) {
  const saved = await env.DB.prepare(`SELECT s.result_json,s.sync_status,b.batch_number,b.status,
      b.operation_assignee_user_id,b.document_assignee_user_id,b.warehouse_id,b.created_by_user_id
    FROM loading_planning_submissions s JOIN transport_batches b ON b.id=s.batch_id AND b.organization_id=s.organization_id
    WHERE s.organization_id=? AND s.actor_user_id=? AND s.batch_id=?`)
    .bind(current.organizationId,current.userId,batchId).first<PlanningSubmission & {
      status:string; operation_assignee_user_id:string; document_assignee_user_id:string;
      warehouse_id:string; created_by_user_id:string;
    }>();
  if (!saved) throw new Error("当前账号没有这次配载规划的同步记录");
  const result = typeof saved.result_json === "string" ? JSON.parse(saved.result_json) as PlannedBatchResult : saved.result_json;
  if (saved.status === "cancelled") throw new Error("配载单已取消，不能继续同步");
  if (saved.sync_status === "complete") return { ...result, syncPending:false };
  const token = crypto.randomUUID(), now = new Date().toISOString();
  const expires = new Date(Date.now() - 10 * 60_000).toISOString();
  const claim = await env.DB.prepare(`UPDATE loading_planning_submissions SET sync_token=?,sync_started_at=?,updated_at=?
    WHERE organization_id=? AND batch_id=? AND sync_status='pending'
      AND (sync_token IS NULL OR sync_started_at<?)`)
    .bind(token,now,now,current.organizationId,batchId,expires).run();
  if (!Number(claim.meta.changes)) return { ...result, syncPending:true };
  try {
    await activateLoadingModules(current.organizationId,result.orderIds,result.batchNumber,current.userId,now,batchId);
    await synchronizeBatchTransport(current.organizationId,batchId,now);
    if (!await ensureBatchSystemDocuments(current.organizationId,batchId,current.userId,now)) {
      throw new Error("配载系统单据尚未完整生成");
    }
    await env.DB.batch([
      env.DB.prepare(`UPDATE transport_batches SET approval_status='approved',updated_at=?
        WHERE organization_id=? AND id=? AND status!='cancelled'`).bind(now,current.organizationId,batchId),
      assignedBatchNotificationStatement(env.DB,{organizationId:current.organizationId,batchId,batchNumber:result.batchNumber,
        assigneeUserId:saved.operation_assignee_user_id,actorUserId:current.userId,responsibilityLabel:"操作职责",now}),
      assignedBatchNotificationStatement(env.DB,{organizationId:current.organizationId,batchId,batchNumber:result.batchNumber,
        assigneeUserId:saved.document_assignee_user_id,actorUserId:current.userId,responsibilityLabel:"单证与报关职责",targetTab:"documents",now}),
      warehouseBatchReadyNotificationStatement(env.DB,{organizationId:current.organizationId,batchId,batchNumber:result.batchNumber,
        warehouseId:saved.warehouse_id,actorUserId:current.userId,now}),
      env.DB.prepare(`UPDATE loading_planning_submissions SET sync_status='complete',sync_token=NULL,updated_at=?
        WHERE organization_id=? AND batch_id=? AND sync_token=?`).bind(now,current.organizationId,batchId,token),
    ]);
    return { ...result, syncPending:false };
  } catch (error) {
    console.error("LOADING_PLAN_SYNC_PENDING",{batchId,error:String(error)});
    return { ...result, syncPending:true };
  } finally {
    await env.DB.prepare(`UPDATE loading_planning_submissions SET sync_token=NULL
      WHERE organization_id=? AND batch_id=? AND sync_token=?`)
      .bind(current.organizationId,batchId,token).run().catch((error) => console.error("LOADING_SYNC_UNLOCK_FAILED",String(error)));
  }
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
  batchId: string,
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
      WHERE status NOT IN ('completed','not_applicable') AND COALESCE(current_step_code,'')!='confirmed'
        AND id IN (${d1Placeholders(moduleChunk.length)})`)
      .bind(now,now,...moduleChunk.map((module) => module.id)));
  }
  for (const moduleChunk of chunkD1Rows(modules, 12)) {
    statements.push(env.DB.prepare(`INSERT INTO order_module_history(
      id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,
      to_step_code,to_step_name,actor_user_id,notes,occurred_at
    ) VALUES ${moduleChunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")} ON CONFLICT(id) DO NOTHING`)
      .bind(...moduleChunk.flatMap((module) => [`${batchId}:${module.id}:create`,organizationId,module.order_id,module.id,
        "batch_create","操作主管配载规划",module.current_step_code,"planned","配载成单",userId,
        `加入配载单 ${batchNumber}`,now])));
  }
  if (statements.length) await env.DB.batch(statements);
  for (const orderId of orderIds) await syncOrderWorkflowSnapshot(organizationId, orderId);
}
