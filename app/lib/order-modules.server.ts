import { env } from "cloudflare:workers";
import {
  loadOrderModuleWorkflowFields,
  missingRequiredModuleFields,
} from "./workflow-fields.server";
import {
  enabledOrderModules,
  isRuntimeMandatoryOrderModule,
  orderModuleDefinition,
  type OrderModuleCode,
} from "./order-modules";
import { orderBusinessStages } from "./order-stage-flow";
import { syncOrderBusinessWorkflow } from "./business-workflow.server";
import { checkOrderLoadPlan } from "./order-readiness.server";
import {
  orderDocumentPlacements,
  orderDocumentTypeLabel,
} from "./order-documents";

export type OrderModuleInstance = {
  id: string;
  module_code: OrderModuleCode;
  module_name: string;
  enabled: number;
  is_required: number;
  status: string;
  current_step_code: string | null;
  current_step_name: string | null;
  progress_percent: number;
  blocking_reason: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  assignee_position_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type WorkflowSnapshotModule = {
  id: string;
  module_code: OrderModuleCode;
  module_name: string;
  current_step_code: string | null;
  current_step_name: string | null;
  assignee_user_id: string | null;
  status: string;
  progress_percent: number;
};

type OrderSeed = {
  id: string;
  business_type: string;
  status: string;
  current_assignee_user_id: string | null;
  workflow_id: string | null;
};

export async function ensureOrderModules(
  organizationId: string,
  orderId: string,
) {
  const order = await env.DB.prepare(
    `SELECT o.id,o.business_type,o.status,o.current_assignee_user_id,
      COALESCE(wi.workflow_id,(SELECT workflow_id FROM workflow_instances x WHERE x.order_id=o.id LIMIT 1)) workflow_id
     FROM transport_orders o LEFT JOIN workflow_instances wi ON wi.id=o.workflow_instance_id
     WHERE o.id=? AND o.organization_id=?`,
  )
    .bind(orderId, organizationId)
    .first<OrderSeed>();
  if (!order) throw new Error("订单不存在");
  const [services, metrics] = await Promise.all([
    env.DB.prepare("SELECT service_code FROM order_services WHERE order_id=?")
      .bind(orderId)
      .all<{ service_code: string }>(),
    orderModuleMetrics(organizationId, orderId),
  ]);
  const now = new Date().toISOString();
  const definitions = enabledOrderModules(
    order.business_type,
    services.results.map((item) => item.service_code),
  );
  const statements = definitions.map((definition) => {
    const initial = initialModuleState(
      definition.code,
      definition.steps,
      definition.enabled,
      order,
      metrics,
    );
    return env.DB.prepare(
      `INSERT INTO order_module_instances(id,organization_id,order_id,module_code,module_name,enabled,is_required,status,current_step_code,current_step_name,progress_percent,assignee_user_id,started_at,completed_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(order_id,module_code) DO UPDATE SET
         module_name=excluded.module_name,
         enabled=CASE
           WHEN order_module_instances.module_code='loading' AND excluded.enabled=0 THEN 0
           WHEN excluded.enabled=1 THEN 1
           ELSE order_module_instances.enabled END,
         is_required=excluded.is_required,
         status=CASE
           WHEN order_module_instances.module_code='loading' AND excluded.enabled=0 THEN 'not_applicable'
           WHEN order_module_instances.status='not_applicable' AND excluded.enabled=1 THEN excluded.status
           ELSE order_module_instances.status END,
         current_step_code=CASE
           WHEN order_module_instances.module_code='loading' AND excluded.enabled=0 THEN NULL
           WHEN order_module_instances.status='not_applicable' AND excluded.enabled=1 THEN excluded.current_step_code
           ELSE order_module_instances.current_step_code END,
         current_step_name=CASE
           WHEN order_module_instances.module_code='loading' AND excluded.enabled=0 THEN '本单无需拼车配载'
           WHEN order_module_instances.status='not_applicable' AND excluded.enabled=1 THEN excluded.current_step_name
           ELSE order_module_instances.current_step_name END,
         assignee_user_id=COALESCE(order_module_instances.assignee_user_id,excluded.assignee_user_id),
         updated_at=excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      organizationId,
      orderId,
      definition.code,
      definition.name,
      definition.enabled ? 1 : 0,
      definition.required ? 1 : 0,
      initial.status,
      initial.stepCode,
      initial.stepName,
      initial.progress,
      order.current_assignee_user_id,
      initial.status === "in_progress" ? now : null,
      initial.status === "completed" ? now : null,
      now,
      now,
    );
  });
  if (statements.length) await env.DB.batch(statements);
  await applyWorkflowModuleConfiguration(
    organizationId,
    orderId,
    order.workflow_id,
    order.business_type,
    now,
  );
  await synchronizeGovernanceModules(organizationId, orderId, order, now);
  await synchronizeDataDrivenModules(organizationId, orderId, metrics, now);
  await syncOrderBusinessWorkflow({
    organizationId,
    orderId,
    source: "system",
  });
}

async function applyWorkflowModuleConfiguration(
  organizationId:string,
  orderId:string,
  workflowId:string|null,
  businessType:string,
  now:string,
) {
  if (!workflowId) return;
  const configured = await env.DB.prepare(
    `SELECT m.module_code,MAX(m.is_required) is_required,
      MAX(CASE WHEN m.is_active=1 AND s.is_active=1 THEN 1 ELSE 0 END) enabled,
      MIN(CASE WHEN m.is_active=1 AND s.is_active=1 THEN m.display_name END) display_name
     FROM workflow_step_modules m JOIN workflow_steps s ON s.id=m.step_id AND s.workflow_id=m.workflow_id
     WHERE m.workflow_id=? GROUP BY m.module_code`,
  ).bind(workflowId).all<{module_code:string;is_required:number;enabled:number;display_name:string|null}>();
  if (!configured.results.length) return;
  const byCode = new Map(configured.results.map((item)=>[item.module_code,item]));
  const rows = await env.DB.prepare(
    "SELECT id,module_code,status FROM order_module_instances WHERE organization_id=? AND order_id=?",
  ).bind(organizationId,orderId).all<{id:string;module_code:string;status:string}>();
  const updates = rows.results.map((row) => {
    const rule = byCode.get(row.module_code);
    const mandatory = isRuntimeMandatoryOrderModule(businessType, row.module_code);
    const fileIndexOnly = row.module_code === "documents";
    const enabled = fileIndexOnly ? 0 : mandatory || rule?.enabled ? 1 : 0;
    const required = fileIndexOnly ? 0 : mandatory || rule?.is_required ? 1 : 0;
    return env.DB.prepare(
      `UPDATE order_module_instances SET module_name=COALESCE(?,module_name),enabled=?,is_required=?,
        status=CASE WHEN ?=0 THEN 'not_applicable' WHEN status='not_applicable' THEN 'not_started' ELSE status END,
        current_step_code=CASE WHEN ?=0 THEN NULL ELSE current_step_code END,
        current_step_name=CASE WHEN ?=0 THEN ? ELSE current_step_name END,
        progress_percent=CASE WHEN ?=0 THEN 0 ELSE progress_percent END,updated_at=? WHERE id=?`,
    ).bind(
      rule?.display_name||null,enabled,required,enabled,enabled,enabled,
      fileIndexOnly ? "文件由所属业务节点收集，文件中心仅供查询" : "当前工作流未启用本模组",
      enabled,now,row.id,
    );
  });
  if (updates.length) await env.DB.batch(updates);
}

async function synchronizeDataDrivenModules(
  organizationId: string,
  orderId: string,
  metrics: Awaited<ReturnType<typeof orderModuleMetrics>>,
  now: string,
) {
  const statements = [];
  const warehouseCounting = await env.DB.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM warehouse_sorting_batches b
       JOIN shipments s ON s.id=b.shipment_id
       WHERE b.organization_id=? AND s.order_id=? AND b.status='verified'
     ) ready,
     EXISTS(
       SELECT 1 FROM warehouse_receipts r
       JOIN shipments s ON s.id=r.shipment_id
       WHERE r.organization_id=? AND s.order_id=? AND r.status='completed'
     ) received,
     EXISTS(
       SELECT 1 FROM warehouse_dispatches d
       JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
       JOIN warehouse_packages p ON p.id=di.package_id
       JOIN shipments s ON s.id=p.shipment_id
       WHERE d.organization_id=? AND s.order_id=? AND d.status='dispatched'
     ) dispatched`,
  )
    .bind(organizationId, orderId, organizationId, orderId, organizationId, orderId)
    .first<{ ready: number; received: number; dispatched: number }>();
  if (warehouseCounting?.ready) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status='completed',current_step_code='ready',current_step_name='收货清点完成',
             progress_percent=100,blocking_reason=NULL,started_at=COALESCE(started_at,?),
             completed_at=COALESCE(completed_at,?),updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='warehouse' AND enabled=1`,
      ).bind(now, now, now, organizationId, orderId),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
             completed_at=NULL,blocking_reason=NULL,updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='warehouse' AND enabled=1
           AND (status='completed' OR current_step_code='ready')`,
      ).bind(
        warehouseCounting?.received ? "in_progress" : "not_started",
        warehouseCounting?.received ? "receiving" : "waiting",
        warehouseCounting?.received ? "到仓收货" : "等待到货",
        warehouseCounting?.received ? 50 : 0,
        now,
        organizationId,
        orderId,
      ),
    );
  }
  if (!warehouseCounting?.dispatched) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status='not_started',current_step_code='waiting',
             current_step_name='等待生成运输方案',progress_percent=0,
             completed_at=NULL,blocking_reason=NULL,updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='loading' AND enabled=1 AND status='completed'`,
      ).bind(
        now,
        organizationId,
        orderId,
      ),
    );
  }
  if (metrics.cargo > 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status='completed',current_step_code='confirmed',current_step_name='货物确认',
           progress_percent=100,blocking_reason=NULL,started_at=COALESCE(started_at,?),
           completed_at=COALESCE(completed_at,?),updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='cargo' AND enabled=1 AND status!='completed'`,
      ).bind(now, now, now, organizationId, orderId),
    );
  }
  if (metrics.attachments > 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status='in_progress',current_step_code='checking',current_step_name='资料检查',
           progress_percent=MAX(progress_percent,25),blocking_reason=NULL,started_at=COALESCE(started_at,?),updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='documents' AND enabled=1
           AND status NOT IN ('completed','not_applicable')`,
      ).bind(now, now, organizationId, orderId),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  await synchronizeLoadingModuleFromBatch(organizationId, orderId, now);
}

async function synchronizeLoadingModuleFromBatch(
  organizationId: string,
  orderId: string,
  now: string,
) {
  const plan = await env.DB.prepare(
      `SELECT b.id,
        MAX(o.business_type) business_type,
        COUNT(DISTINCT v.id) vehicle_count,
        COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.plate_number),'') IS NOT NULL AND NULLIF(TRIM(v.driver_name),'') IS NOT NULL THEN v.id END) staffed_vehicle_count,
         MAX(CASE WHEN EXISTS(
           SELECT 1 FROM warehouse_dispatches d
           JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
           JOIN warehouse_packages wp ON wp.id=di.package_id
           JOIN shipments sx ON sx.id=wp.shipment_id
           WHERE d.organization_id=bo.organization_id AND sx.order_id=bo.order_id AND d.status='dispatched'
         ) THEN 1 ELSE 0 END) warehouse_dispatched,
         MAX(CASE
           WHEN o.business_type='ftl'
            AND NULLIF(TRIM(b.overseas_carrier_name),'') IS NOT NULL
            AND NULLIF(TRIM(b.overseas_vehicle_type),'') IS NOT NULL
            AND COALESCE(b.overseas_vehicle_count,0)>0
            AND NULLIF(TRIM(b.overseas_vehicle_plate),'') IS NOT NULL
            AND NULLIF(TRIM(b.overseas_driver_name),'') IS NOT NULL
            AND NULLIF(TRIM(b.overseas_driver_phone),'') IS NOT NULL THEN 1
           WHEN COALESCE(o.business_type,'ltl')!='ftl'
            AND b.carrier_id IS NOT NULL
            AND b.warehouse_id IS NOT NULL
            AND b.border_port IS NOT NULL
            AND b.planned_departure_at IS NOT NULL
            AND b.planned_arrival_at IS NOT NULL THEN 1
           ELSE 0
         END) plan_complete
       FROM transport_batch_orders bo
       JOIN transport_batches b ON b.id=bo.batch_id AND b.status!='cancelled'
       JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       LEFT JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled'
       WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
       GROUP BY b.id
       ORDER BY b.created_at DESC LIMIT 1`,
  )
    .bind(organizationId, orderId)
    .first<{
      id: string;
      business_type: string | null;
      vehicle_count: number;
      staffed_vehicle_count: number;
      warehouse_dispatched: number;
      plan_complete: number;
    }>();
  if (!plan) return;
  const isFtl = plan.business_type === "ftl";
  if (plan.warehouse_dispatched) {
    await env.DB.prepare(
      `UPDATE order_module_instances
       SET status='completed',current_step_code='confirmed',current_step_name='装车出库交接完成',
           progress_percent=100,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),
           blocking_reason=NULL,updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='loading' AND enabled=1`,
    ).bind(now, now, now, organizationId, orderId).run();
    return;
  }
  const batchBaseReady = Boolean(
    plan.plan_complete &&
      plan.vehicle_count &&
      plan.staffed_vehicle_count === plan.vehicle_count,
  );
  const orderReady = batchBaseReady;
  const blockers = [
    !plan.plan_complete
      ? isFtl
        ? "整车运输单车辆信息未完整"
        : "配载运输单基础信息未完整"
      : null,
    !plan.vehicle_count
      ? isFtl
        ? "整车运输单尚未生成车辆"
        : "配载运输单尚未添加车辆"
      : null,
    plan.vehicle_count && plan.staffed_vehicle_count !== plan.vehicle_count
      ? "车辆车牌/司机未完整"
      : null,
  ].filter(Boolean);
  const currentStepName = orderReady
    ? isFtl
      ? "整车运输单已安排，待装车出库"
      : "配载运输单已安排，待装车出库"
    : isFtl
      ? "整车运输单待完善车辆信息"
      : "配载成单，待完善整批车辆信息";
  const progress = orderReady ? 60 : 25;
  await env.DB.prepare(
    `UPDATE order_module_instances
       SET status='in_progress',current_step_code='planned',current_step_name=?,progress_percent=?,
            started_at=COALESCE(started_at,?),completed_at=NULL,
            blocking_reason=?,updated_at=?
     WHERE organization_id=? AND order_id=? AND module_code='loading' AND enabled=1`,
  )
    .bind(
      currentStepName,
      progress,
      now,
      blockers.join("；") || null,
      now,
      organizationId,
      orderId,
    )
    .run();
}

async function synchronizeGovernanceModules(
  organizationId: string,
  orderId: string,
  order: OrderSeed,
  now: string,
) {
  const consignment =
    order.status === "draft"
      ? { status: "not_started", code: "draft", name: "资料录入", progress: 0 }
      : order.status === "submitted"
        ? {
            status: "in_progress",
            code: "submitted",
            name: "提请审批",
            progress: 67,
          }
        : {
            status: "completed",
            code: "approved",
            name: "审核通过",
            progress: 100,
        };
  const consignmentDraftGuard =
    order.status === "draft"
      ? " AND (status IN ('not_started','not_applicable') OR current_step_code IS NULL OR current_step_code='draft')"
      : "";
  const statements = [
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
           started_at=CASE WHEN ?='in_progress' THEN COALESCE(started_at,?) ELSE started_at END,
           completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE completed_at END,
           updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='consignment' AND enabled=1${consignmentDraftGuard}`,
    ).bind(
      consignment.status,
      consignment.code,
      consignment.name,
      consignment.progress,
      consignment.status,
      now,
      consignment.status,
      now,
      now,
      organizationId,
      orderId,
    ),
    env.DB.prepare(
      `UPDATE order_module_instances
       SET current_step_name=CASE current_step_code
         WHEN 'waiting' THEN '等待到货'
         WHEN 'receiving' THEN '到仓收货'
         WHEN 'ready' THEN '已齐套，待配载/出库'
         WHEN 'loading' THEN '按配载批次拣货装车'
         WHEN 'outbound' THEN '装车出库交接'
         ELSE current_step_name END,
         updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='warehouse'`,
    ).bind(now, organizationId, orderId),
  ];
  // 任务分配节点必须由操作员在任务分配页手动分配各模块负责人并"确认派单"后完成，
  // 系统不得因订单已有负责人而自动代完成（业务规则，见 2026-08-18 需求）。
  statements.push(
    env.DB.prepare(
      `UPDATE order_module_instances
       SET status='completed',
           current_step_code='completed',
           current_step_name='安排完成',
           progress_percent=100,
           started_at=COALESCE(started_at,?),
           completed_at=COALESCE(completed_at,?),
           blocking_reason=NULL,
           updated_at=?
       WHERE organization_id=? AND order_id=? AND module_code='transport' AND enabled=1
         AND EXISTS (
           SELECT 1 FROM order_transport_assignments a
           WHERE a.organization_id=? AND a.order_id=? AND a.status!='cancelled'
         )`,
    ).bind(now, now, now, organizationId, orderId, organizationId, orderId),
  );
  await env.DB.batch(statements);
}

export async function syncOrderWorkflowSnapshot(
  organizationId: string,
  orderId: string,
) {
  await ensureOrderModules(organizationId, orderId);
  await syncModuleStateFromTransportBatch(organizationId, orderId);
  const order = await env.DB.prepare(
    "SELECT status,business_type,current_assignee_user_id FROM transport_orders WHERE organization_id=? AND id=?",
  )
    .bind(organizationId, orderId)
    .first<{
      status: string;
      business_type: string;
      current_assignee_user_id: string | null;
    }>();
  if (!order || order.status !== "in_execution") return;
  const modules = (
    await env.DB.prepare(
      `SELECT id,module_code,module_name,current_step_code,current_step_name,assignee_user_id,status,progress_percent
     FROM order_module_instances
     WHERE organization_id=? AND order_id=? AND enabled=1
       AND (is_required=1 OR status NOT IN ('not_started','not_applicable'))
     ORDER BY module_code`,
    )
      .bind(organizationId, orderId)
      .all<WorkflowSnapshotModule>()
  ).results;
  const next = pickNextWorkflowModule(modules, order.business_type);
  const now = new Date().toISOString();
  if (next?.status === "not_started") {
    await env.DB.prepare(
      "UPDATE order_module_instances SET status='in_progress',started_at=COALESCE(started_at,?),progress_percent=CASE WHEN progress_percent>0 THEN progress_percent ELSE 1 END,updated_at=? WHERE id=?",
    )
      .bind(now, now, next.id)
      .run();
  }
  await env.DB.prepare(
    "UPDATE transport_orders SET current_step_code=?,current_step_name=?,current_assignee_user_id=?,workflow_updated_at=?,updated_at=? WHERE organization_id=? AND id=? AND status='in_execution'",
  )
    .bind(
      next ? `module:${next.module_code}` : "ready_to_complete",
      next
        ? `${next.module_name} · ${next.current_step_name || "待处理"}`
        : "已启用模块全部完成",
      next?.assignee_user_id ?? order.current_assignee_user_id ?? null,
      now,
      now,
      organizationId,
      orderId,
    )
    .run();
  await syncOrderBusinessWorkflow({
    organizationId,
    orderId,
    source: "system",
  });
}

function pickNextWorkflowModule(
  modules: WorkflowSnapshotModule[],
  _businessType: string,
) {
  const pendingByStage = new Map(
    orderBusinessStages.map((stage) => [
      stage.code,
      modules
        .filter((module) => stage.modules.includes(module.module_code))
        .sort(
          (left, right) =>
            stage.modules.indexOf(left.module_code) -
            stage.modules.indexOf(right.module_code),
        ),
    ]),
  );
  for (const stage of orderBusinessStages) {
    const stageModules = pendingByStage.get(stage.code) ?? [];
    const pending = stageModules.find(
      (module) => !isWorkflowModuleCompleteForStage(stage.code, module),
    );
    if (pending) return pending;
  }
  return null;
}

function isWorkflowModuleCompleteForStage(
  _stageCode: string,
  module: WorkflowSnapshotModule,
) {
  return module.status === "completed";
}

async function syncModuleStateFromTransportBatch(organizationId: string, orderId: string) {
  const batch = await env.DB.prepare(
    `SELECT b.id,b.road_status,b.status,bo.status order_batch_status,
            EXISTS(SELECT 1 FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages wp ON wp.id=di.package_id JOIN shipments s ON s.id=wp.shipment_id WHERE d.organization_id=? AND s.order_id=? AND d.status='dispatched') warehouse_dispatched,
            EXISTS(SELECT 1 FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id WHERE l.organization_id=? AND p.order_id=? AND l.loaded_at IS NOT NULL) packages_loaded,
            EXISTS(SELECT 1 FROM overseas_warehouse_operations op WHERE op.organization_id=? AND op.order_id=? AND op.status!='cancelled') overseas_operation_exists,
            (SELECT COUNT(*) FROM order_cargo_packages p WHERE p.organization_id=? AND p.order_id=? AND p.status!='cancelled') package_count,
            (SELECT COUNT(DISTINCT l.package_id)
             FROM transport_vehicle_loads l
             JOIN order_cargo_packages p ON p.id=l.package_id
             WHERE l.organization_id=? AND l.batch_id=bo.batch_id AND p.order_id=? AND l.loaded_at IS NOT NULL) loaded_package_count
     FROM transport_batch_orders bo
     JOIN transport_batches b ON b.id=bo.batch_id AND b.status!='cancelled'
     WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
     ORDER BY b.updated_at DESC LIMIT 1`,
  ).bind(
    organizationId,
    orderId,
    organizationId,
    orderId,
    organizationId,
    orderId,
    organizationId,
    orderId,
    organizationId,
    orderId,
    organizationId,
    orderId,
  ).first<{
    id: string;
    road_status: string | null;
    status: string | null;
    order_batch_status: string | null;
    warehouse_dispatched: number;
    packages_loaded: number;
    overseas_operation_exists: number;
    package_count: number;
    loaded_package_count: number;
  }>();
  if (!batch) return;

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (
    batch.warehouse_dispatched ||
    ["loaded_waiting_exit", "outbound_in_transit", "overseas_arrived", "waiting_pickup", "pickup_completed"].includes(
      batch.road_status || "",
    )
  ) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status='completed',current_step_code='confirmed',current_step_name='装车出库交接完成',progress_percent=100,
             started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='loading' AND enabled=1 AND status!='completed'`,
      ).bind(now, now, now, organizationId, orderId),
    );
  }
  if (batch.road_status === "outbound_in_transit") {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
       SET status='in_progress',current_step_code='transit',current_step_name='出境运输中',progress_percent=50,started_at=COALESCE(started_at,?),blocking_reason=NULL,updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='tracking' AND enabled=1
           AND status!='completed' AND COALESCE(progress_percent,0)<50`,
      ).bind(now, now, organizationId, orderId),
    );
  }
  if (["overseas_arrived", "waiting_pickup", "pickup_completed"].includes(batch.road_status || "")) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status='completed',current_step_code='arrived',current_step_name='到达境外仓',progress_percent=100,started_at=COALESCE(started_at,?),completed_at=COALESCE(completed_at,?),blocking_reason=NULL,updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='tracking' AND enabled=1`,
      ).bind(now, now, now, organizationId, orderId),
    );
  }
  if (batch.overseas_operation_exists || ["overseas_arrived", "waiting_pickup", "pickup_completed"].includes(batch.road_status || "")) {
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status=CASE WHEN current_step_code='picked_up' THEN 'completed' ELSE 'in_progress' END,
             current_step_code=CASE WHEN current_step_code IN ('notified','appointment','picked_up') THEN current_step_code ELSE 'notified' END,
             current_step_name=CASE WHEN current_step_code IN ('notified','appointment','picked_up') THEN current_step_name ELSE '客户已通知' END,
             progress_percent=MAX(progress_percent,25),
             started_at=COALESCE(started_at,?),blocking_reason=NULL,updated_at=?
         WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1 AND status!='completed'`,
      ).bind(now, now, organizationId, orderId),
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function syncCostsModuleStatus(
  organizationId: string,
  orderId: string,
  now = new Date().toISOString(),
) {
  await ensureOrderModules(organizationId, orderId);
  const [expenses, controls] = await Promise.all([
    env.DB.prepare(
      `SELECT direction,COUNT(*) total
       FROM business_expenses
       WHERE organization_id=? AND order_id=? AND stage!='cancelled'
       GROUP BY direction`,
    )
      .bind(organizationId, orderId)
      .all<{ direction: "receivable" | "payable"; total: number }>(),
    env.DB.prepare(
      `SELECT direction,confirmed,business_reviewed,finance_reviewed,business_locked,finance_locked
       FROM order_expense_direction_controls
       WHERE organization_id=? AND order_id=?`,
    )
      .bind(organizationId, orderId)
      .all<{
        direction: "receivable" | "payable";
        confirmed: number;
        business_reviewed: number;
        finance_reviewed: number;
        business_locked: number;
        finance_locked: number;
      }>(),
  ]);
  const expenseDirections = new Set(
    expenses.results
      .filter((item) => item.total > 0)
      .map((item) => item.direction),
  );
  const presentDirections = [...expenseDirections];
  const controlByDirection = new Map(
    controls.results.map((item) => [item.direction, item]),
  );
  const allPresent = (
    field:
      | "confirmed"
      | "business_reviewed"
      | "finance_reviewed"
      | "finance_locked",
  ) =>
    presentDirections.length > 0 &&
    presentDirections.every(
      (direction) => (controlByDirection.get(direction)?.[field] ?? 0) === 1,
    );

  const definition = orderModuleDefinition("costs");
  if (!definition) return;
  let stepIndex = 0;
  let status = presentDirections.length ? "in_progress" : "not_started";
  let progress = presentDirections.length ? 20 : 0;
  if (
    expenseDirections.has("receivable") &&
    expenseDirections.has("payable") &&
    allPresent("finance_locked")
  ) {
    stepIndex = 4;
    status = "completed";
    progress = 100;
  } else if (allPresent("finance_reviewed")) {
    stepIndex = 3;
    progress = 80;
  } else if (allPresent("business_reviewed")) {
    stepIndex = 2;
    progress = 60;
  } else if (allPresent("confirmed")) {
    stepIndex = 1;
    progress = 40;
  }
  const step = definition.steps[Math.min(stepIndex, definition.steps.length - 1)];
  await env.DB.prepare(
    `UPDATE order_module_instances
     SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
         started_at=CASE WHEN ?!='not_started' THEN COALESCE(started_at,?) ELSE started_at END,
         completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,
         blocking_reason=NULL,updated_at=?
     WHERE organization_id=? AND order_id=? AND module_code='costs' AND enabled=1`,
  )
    .bind(
      status,
      step.code,
      step.name,
      progress,
      status,
      now,
      status,
      now,
      now,
      organizationId,
      orderId,
    )
    .run();
}

export async function listOrderModules(
  organizationId: string,
  orderId: string,
) {
  await ensureOrderModules(organizationId, orderId);
  const rows = await env.DB.prepare(
    `SELECT m.id,m.module_code,m.module_name,m.enabled,m.is_required,m.status,m.current_step_code,m.current_step_name,m.progress_percent,m.blocking_reason,m.assignee_user_id,u.display_name assignee_name,p.name assignee_position_name,m.started_at,m.completed_at,m.updated_at
     FROM order_module_instances m
     LEFT JOIN users u ON u.id=m.assignee_user_id
     LEFT JOIN memberships ms ON ms.organization_id=m.organization_id AND ms.user_id=m.assignee_user_id AND ms.status='active'
     LEFT JOIN positions p ON p.id=ms.position_id AND p.organization_id=m.organization_id
     WHERE m.organization_id=? AND m.order_id=?
     ORDER BY CASE m.module_code WHEN 'consignment' THEN 10 WHEN 'cargo' THEN 20 WHEN 'assignment' THEN 30 WHEN 'transport' THEN 40 WHEN 'warehouse' THEN 50 WHEN 'loading' THEN 60 WHEN 'documents' THEN 70 WHEN 'customs' THEN 80 WHEN 'tracking' THEN 90 WHEN 'overseas_warehouse' THEN 100 WHEN 'costs' THEN 110 WHEN 'exceptions' THEN 120 WHEN 'review' THEN 130 ELSE 999 END`,
  )
    .bind(organizationId, orderId)
    .all<OrderModuleInstance>();
  return rows.results;
}

export async function assignOrderModule(input: {
  organizationId: string;
  orderId: string;
  moduleCode: string;
  assigneeUserId: string;
  actorUserId: string;
  dueAt?: string | null;
  notes?: string;
}) {
  const module = await moduleRow(input);
  if (!module.enabled) throw new Error("该模块未启用");
  const user = await env.DB.prepare(
    "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND u.status='active'",
  )
    .bind(input.organizationId, input.assigneeUserId)
    .first();
  if (!user) throw new Error("负责人无效");
  const definition = orderModuleDefinition(input.moduleCode);
  if (!definition) throw new Error("模块不存在");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE order_module_instances SET assignee_user_id=?,blocking_reason=NULL,updated_at=? WHERE id=?",
    ).bind(
      input.assigneeUserId,
      now,
      module.id,
    ),
    env.DB.prepare(
      "UPDATE order_tasks SET status='cancelled',updated_at=? WHERE organization_id=? AND order_id=? AND module_code=? AND task_type='module_owner' AND status IN ('pending','in_progress')",
    ).bind(now, input.organizationId, input.orderId, input.moduleCode),
    env.DB.prepare(
      "INSERT INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,status,assignee_user_id,assigned_by_user_id,due_at,created_at,updated_at) VALUES(?,?,?,?,? ,?,'pending',?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.orderId,
      input.moduleCode,
      "module_owner",
      `${definition.name}处理任务`,
      input.assigneeUserId,
      input.actorUserId,
      input.dueAt || null,
      now,
      now,
    ),
    historyStatement({
      organizationId: input.organizationId,
      orderId: input.orderId,
      moduleId: module.id,
      actionCode: "assign",
      actionName: "分配负责人",
      fromStepCode: module.current_step_code,
      toStepCode: module.current_step_code || definition.steps[0].code,
      toStepName: module.current_step_name || definition.steps[0].name,
      actorUserId: input.actorUserId,
      notes: input.notes || null,
      now,
    }),
  ]);
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
}

export async function advanceOrderModule(input: {
  organizationId: string;
  orderId: string;
  moduleCode: string;
  actorUserId: string;
  notes?: string;
}) {
  const module = await moduleRow(input);
  if (!module.enabled) throw new Error("该模块未启用");
  if (module.status === "completed") throw new Error("该模块已经完成");
  const definition = orderModuleDefinition(input.moduleCode);
  if (!definition) throw new Error("模块不存在");
  const currentIndex = Math.max(
    0,
    definition.steps.findIndex(
      (step) => step.code === module.current_step_code,
    ),
  );
  await validateModuleGate(
    input.organizationId,
    input.orderId,
    input.moduleCode,
    definition.steps[currentIndex].code,
  );
  const isLast = currentIndex >= definition.steps.length - 1;
  if (isLast) {
    const missing = await missingRequiredModuleFields(
      input.organizationId,
      input.orderId,
      input.moduleCode as OrderModuleCode,
    );
    if (missing.length) {
      throw new Error(`请先补齐必填字段：${missing.map((field) => field.label).join("、")}`);
    }
  }
  const next = isLast
    ? definition.steps[currentIndex]
    : definition.steps[currentIndex + 1];
  const now = new Date().toISOString();
  const progress = isLast
    ? 100
    : Math.round(((currentIndex + 1) / definition.steps.length) * 100);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE order_module_instances SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,blocking_reason=NULL,started_at=COALESCE(started_at,?),completed_at=?,updated_at=? WHERE id=?",
    ).bind(
      isLast ? "completed" : "in_progress",
      next.code,
      next.name,
      progress,
      now,
      isLast ? now : null,
      now,
      module.id,
    ),
    historyStatement({
      organizationId: input.organizationId,
      orderId: input.orderId,
      moduleId: module.id,
      actionCode: isLast ? "complete" : "advance",
      actionName: isLast
        ? "完成模块"
        : `完成${definition.steps[currentIndex].name}`,
      fromStepCode: module.current_step_code,
      toStepCode: next.code,
      toStepName: next.name,
      actorUserId: input.actorUserId,
      notes: input.notes || null,
      now,
    }),
  ]);
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
}

async function moduleRow(input: {
  organizationId: string;
  orderId: string;
  moduleCode: string;
}) {
  await ensureOrderModules(input.organizationId, input.orderId);
  const module = await env.DB.prepare(
    "SELECT id,enabled,status,current_step_code,progress_percent FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code=?",
  )
    .bind(input.organizationId, input.orderId, input.moduleCode)
    .first<{
      id: string;
      enabled: number;
      status: string;
      current_step_code: string | null;
      current_step_name: string | null;
      progress_percent: number;
    }>();
  if (!module) throw new Error("模块不存在");
  return module;
}

function historyStatement(input: {
  organizationId: string;
  orderId: string;
  moduleId: string;
  actionCode: string;
  actionName: string;
  fromStepCode: string | null;
  toStepCode: string;
  toStepName: string;
  actorUserId: string;
  notes: string | null;
  now: string;
}) {
  return env.DB.prepare(
    "INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    crypto.randomUUID(),
    input.organizationId,
    input.orderId,
    input.moduleId,
    input.actionCode,
    input.actionName,
    input.fromStepCode,
    input.toStepCode,
    input.toStepName,
    input.actorUserId,
    input.notes,
    input.now,
  );
}

async function validateModuleGate(
  organizationId: string,
  orderId: string,
  moduleCode: string,
  currentStep: string,
) {
  const configuredFields = await loadOrderModuleWorkflowFields(
    organizationId,
    orderId,
    moduleCode as OrderModuleCode,
  );
  const required = (fieldKey: string, fallback = false) => {
    const field = configuredFields.find((item) => item.fieldKey === fieldKey);
    return field ? field.isActive && field.isRequired : fallback;
  };
  const anyRequired = (fieldKeys: string[], fallback = false) =>
    fieldKeys.some((fieldKey) => required(fieldKey, fallback));

  if (
    moduleCode === "cargo" &&
    currentStep === "entered" &&
    configuredFields.some((field) => field.isActive && field.isRequired)
  ) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) total FROM order_cargo_items WHERE organization_id=? AND order_id=?",
    )
      .bind(organizationId, orderId)
      .first<{ total: number }>();
    if (!row?.total) throw new Error("请先录入至少一条货物明细");
  }
  if (
    moduleCode === "assignment" &&
    currentStep !== "assigned" &&
    anyRequired(["primary_operator", "module_assignees"], true)
  ) {
    const row = await env.DB.prepare(
      "SELECT assignee_user_id FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='assignment'",
    )
      .bind(organizationId, orderId)
      .first<{ assignee_user_id: string | null }>();
    if (!row?.assignee_user_id) throw new Error("请先分配订单负责人");
  }
  if (
    moduleCode === "documents" &&
    currentStep === "waiting" &&
    required("predeparture_documents", true)
  ) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) total FROM order_attachments WHERE organization_id=? AND order_id=?",
    )
      .bind(organizationId, orderId)
      .first<{ total: number }>();
    if (!row?.total) throw new Error("请先上传至少一份订单文件");
  }
  if (
    moduleCode === "transport" &&
    currentStep === "planning" &&
    configuredFields.some((field) => field.isActive && field.isRequired)
  ) {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM booking_records WHERE organization_id=? AND order_id=? AND status!='cancelled') +
         (SELECT COUNT(*) FROM order_transport_assignments WHERE organization_id=? AND order_id=? AND status!='cancelled') total`,
    )
      .bind(organizationId, orderId, organizationId, orderId)
      .first<{ total: number }>();
    if (!row?.total) throw new Error("请先建立运输安排或订舱记录");
  }
  if (moduleCode === "warehouse") {
    const requiredStatus =
      currentStep === "receiving"
        ? "receipt"
        : currentStep === "ready"
          ? "sorting"
          : currentStep === "loading"
            ? "loading"
            : currentStep === "outbound"
              ? "dispatched"
              : null;
    const warehouseGateRequired =
      requiredStatus === "receipt"
        ? anyRequired(
            [
              "warehouse_receipt",
              "actual_package_count",
              "actual_pieces",
              "actual_weight_kg",
              "actual_volume_cbm",
              "warehouse_location",
            ],
            true,
          )
        : requiredStatus === "sorting"
          ? anyRequired(
              [
                "cargo_complete_set",
                "business_type",
                "exit_port",
                "customs_location",
              ],
              true,
            )
          : Boolean(requiredStatus);
    if (requiredStatus && warehouseGateRequired) {
      const row = await env.DB.prepare(
        `SELECT
          CASE ?
            WHEN 'receipt' THEN EXISTS(SELECT 1 FROM warehouse_receipts wr JOIN shipments s ON s.id=wr.shipment_id WHERE s.order_id=? AND wr.organization_id=?)
            WHEN 'sorting' THEN EXISTS(SELECT 1 FROM warehouse_sorting_batches wb JOIN shipments s ON s.id=wb.shipment_id WHERE s.order_id=? AND wb.organization_id=? AND wb.status='verified')
            WHEN 'loading' THEN EXISTS(SELECT 1 FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages wp ON wp.id=di.package_id JOIN shipments s ON s.id=wp.shipment_id WHERE s.order_id=? AND d.organization_id=? AND d.status IN ('loading','dispatched'))
            WHEN 'dispatched' THEN EXISTS(SELECT 1 FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages wp ON wp.id=di.package_id JOIN shipments s ON s.id=wp.shipment_id WHERE s.order_id=? AND d.organization_id=? AND d.status='dispatched')
            ELSE 0 END ready`,
      ).bind(requiredStatus, orderId, organizationId, orderId, organizationId, orderId, organizationId, orderId, organizationId).first<{ ready: number }>();
      if (!row?.ready)
        throw new Error(
          requiredStatus === "receipt" ? "请先完成仓库实际收货" :
          requiredStatus === "sorting" ? "请先完成货物齐套与分拣复核" :
          requiredStatus === "loading" ? "请先创建仓库扫码装车任务" :
          "请先完成仓库出库交接",
        );
    }
  }
  if (
    moduleCode === "loading" &&
    configuredFields.some((field) => field.isActive && field.isRequired)
  ) {
    const readiness = await checkOrderLoadPlan(organizationId, orderId);
    if (!readiness.ready) throw new Error(readiness.reasons.join("；"));
  }
  if (moduleCode === "customs") {
    // 报关作业强阻断：本节点文件未审核不能推进
    if (currentStep === "documents") {
      const customsDocCodes = orderDocumentPlacements
        .filter((p) => p.moduleCode === "customs")
        .filter((p) => required(p.fieldKey, p.requiredByDefault))
        .map((p) => p.documentCode);
      if (customsDocCodes.length) {
        const approved = await env.DB.prepare(
          `SELECT DISTINCT document_category FROM order_document_metadata
           WHERE organization_id=? AND order_id=? AND review_status IN ('approved','archived')`,
        ).bind(organizationId, orderId).all<{ document_category: string }>();
        const approvedSet = new Set(approved.results.map((r) => r.document_category));
        const missing = customsDocCodes.filter((c) => !approvedSet.has(c));
        if (missing.length)
          throw new Error(`报关资料尚未审核通过：${missing.map(orderDocumentTypeLabel).join("、")}`);
      }
    }
    // 推进到"海关放行"步骤前，要求至少一张报关单已放行
    if (currentStep === "review") {
      const customsGate = await env.DB.prepare(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN d.status='released' THEN 1 ELSE 0 END) released
         FROM order_customs_declarations d
         JOIN order_customs_records r ON r.id=d.customs_record_id AND r.organization_id=d.organization_id
        WHERE d.organization_id=? AND d.order_id=? AND d.is_deleted=0 AND d.status!='cancelled'`,
      ).bind(organizationId, orderId).first<{ total: number; released: number | null }>();
      const total = customsGate?.total ?? 0;
      const released = customsGate?.released ?? 0;
      if (total === 0) throw new Error("请先录入至少一张有效报关单");
      if (released !== total) throw new Error(`报关单尚未全部放行（已放行 ${released}/${total} 张）`);
    }
  }
  if (
    moduleCode === "tracking" &&
    currentStep === "waiting" &&
    required("actual_departure_at", true)
  ) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) total FROM shipments WHERE organization_id=? AND order_id=? AND status NOT IN ('booked','picked_up','cancelled')",
    )
      .bind(organizationId, orderId)
      .first<{ total: number }>();
    if (!row?.total) throw new Error("请先由仓库完成装车出库并确认发车");
  }
}

async function orderModuleMetrics(organizationId: string, orderId: string) {
  const [
    cargo,
    attachments,
    bookings,
    transportAssignments,
    batches,
    shipments,
    expenses,
  ] =
    await Promise.all([
      count("order_cargo_items", organizationId, orderId),
      count("order_attachments", organizationId, orderId),
      count("booking_records", organizationId, orderId),
      count("order_transport_assignments", organizationId, orderId),
      count("transport_batches", organizationId, orderId),
      count("shipments", organizationId, orderId),
      count("business_expenses", organizationId, orderId),
    ]);
  return {
    cargo,
    attachments,
    bookings,
    transportAssignments,
    batches,
    shipments,
    expenses,
  };
}

async function count(table: string, organizationId: string, orderId: string) {
  const allowed = new Set([
    "order_cargo_items",
    "order_attachments",
    "booking_records",
    "transport_batches",
    "shipments",
    "business_expenses",
  ]);
  if (!allowed.has(table)) return 0;
  if (table === "transport_batches") {
    const row = await env.DB.prepare(
      `SELECT COUNT(DISTINCT b.id) total FROM transport_batches b
       WHERE b.organization_id=? AND b.status!='cancelled'
         AND (b.order_id=? OR EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=b.id AND bo.order_id=? AND bo.status!='removed'))`,
    )
      .bind(organizationId, orderId, orderId)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }
  const row = await env.DB.prepare(
    `SELECT COUNT(*) total FROM ${table} WHERE organization_id=? AND order_id=?`,
  )
    .bind(organizationId, orderId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

function initialModuleState(
  code: OrderModuleCode,
  steps: { code: string; name: string }[],
  enabled: boolean,
  order: OrderSeed,
  metrics: Awaited<ReturnType<typeof orderModuleMetrics>>,
) {
  if (!enabled)
    return {
      status: "not_applicable",
      stepCode: null,
      stepName: "未启用",
      progress: 0,
    };
  let index = 0;
  let completed = false;
  if (code === "consignment") {
    index = order.status === "draft" ? 0 : order.status === "submitted" ? 1 : 2;
    completed = ["confirmed", "in_execution", "completed"].includes(
      order.status,
    );
  } else if (code === "cargo" && metrics.cargo > 0) {
    index = steps.length - 1;
    completed = true;
  }
  else if (code === "assignment" && order.current_assignee_user_id) index = 1;
  else if (code === "documents" && metrics.attachments > 0) index = 1;
  else if (code === "transport" && metrics.bookings + metrics.transportAssignments > 0) {
    index = steps.length - 1;
    completed = true;
  }
  else if (code === "loading" && metrics.batches > 0) index = 1;
  else if (code === "tracking" && metrics.shipments > 0) index = 1;
  else if (code === "costs" && metrics.expenses > 0) index = 1;
  const progress = completed
    ? 100
    : index === 0
      ? 0
      : Math.round((index / steps.length) * 100);
  return {
    status: completed ? "completed" : index > 0 ? "in_progress" : "not_started",
    stepCode: steps[index].code,
    stepName: steps[index].name,
    progress,
  };
}
