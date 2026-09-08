import { env } from "cloudflare:workers";
import { requireActiveOrganizationAssignee } from "./organization-assignee.server";
import {
  loadOrderModuleWorkflowFields,
  missingRequiredModuleFields,
} from "./workflow-fields.server";
import {
  enabledOrderModules,
  orderModuleDefinition,
  pickNextRequiredWorkflowModule,
  workflowConfiguredModuleFlags,
  workflowModuleConfigurationSource,
  type OrderModuleCode,
} from "./order-modules";
import { orderBusinessStages } from "./order-stage-flow";
import { syncOrderBusinessWorkflow } from "./business-workflow.server";
import {
  resolveFrozenSettlementNotificationAssignees,
  resolveFrozenWorkflowCurrentOwner,
  type FrozenWorkflowCurrentOwnerRow,
} from "./order-workflow-current-owner";
import { assignedOrderNotificationStatement } from "./internal-notifications.server";
import {
  checkOrderLoadPlan,
  checkOrderPreDepartureDocuments,
} from "./order-readiness.server";
import {
  orderDocumentPlacements,
  preDepartureDocumentTypeCodes,
  orderDocumentTypeLabel,
} from "./order-documents";
import { evaluateCostsCompletionGate } from "./costs-completion-gate";
import { customsModuleGateRequirements } from "./customs-module-policy";
import {
  frozenWorkflowTaskAssignmentStatements,
  resolveOrderModuleAssignmentTarget,
} from "./order-assignment-manifest.server";
import { runtimeWorkflowFieldPolicy } from "./workflow-field-runtime";

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
  assignee_email: string | null;
  assignee_position_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type OrderModuleActionScope = {
  moduleCode: OrderModuleCode;
  stepKey: string | null;
  enabled: boolean;
  assigneeUserId: string | null;
  taskAssigneeUserIds: string[];
  responsibilityPositionCodes: string[];
};

/**
 * Load the frozen workflow-instance ownership used to authorize a module
 * action. This deliberately does not fall back to the mutable workflow
 * definition: an in-flight order keeps the responsibility rules it started
 * with, exactly like its field gates and UI prompts.
 */
export async function loadOrderModuleActionScope(
  organizationId: string,
  orderId: string,
  moduleCode: OrderModuleCode,
): Promise<OrderModuleActionScope | null> {
  const module = await env.DB.prepare(
    `SELECT m.enabled,m.assignee_user_id,o.workflow_instance_id,
            wi.id matched_instance_id
     FROM order_module_instances m
     JOIN transport_orders o ON o.organization_id=m.organization_id AND o.id=m.order_id
     LEFT JOIN workflow_instances wi
       ON wi.id=o.workflow_instance_id
      AND wi.organization_id=o.organization_id
      AND wi.order_id=o.id
     WHERE m.organization_id=? AND m.order_id=? AND m.module_code=?`,
  ).bind(organizationId, orderId, moduleCode).first<{
    enabled: number;
    assignee_user_id: string | null;
    workflow_instance_id: string | null;
    matched_instance_id: string | null;
  }>();
  if (!module) return null;
  if (module.workflow_instance_id && !module.matched_instance_id) {
    return {
      moduleCode,
      stepKey: null,
      enabled: false,
      assigneeUserId: null,
      taskAssigneeUserIds: [],
      responsibilityPositionCodes: [],
    };
  }
  const workflowModule = await env.DB.prepare(
    `SELECT ms.id,ss.step_key,ms.responsibility_position_code
     FROM workflow_instances wi
     JOIN workflow_instance_step_states ss ON ss.instance_id=wi.id
     LEFT JOIN workflow_instance_step_states current_ss
       ON current_ss.instance_id=wi.id AND current_ss.step_key=wi.current_step_key
     JOIN workflow_instance_module_states ms
       ON ms.instance_step_state_id=ss.id AND ms.module_code=?
     WHERE wi.id=? AND wi.organization_id=? AND wi.order_id=?
     ORDER BY
       CASE
         WHEN current_ss.sort_order IS NULL THEN 0
         WHEN ss.sort_order<=current_ss.sort_order THEN 0 ELSE 1 END,
       CASE
         WHEN current_ss.sort_order IS NULL THEN -ss.sort_order
         WHEN ss.sort_order<=current_ss.sort_order THEN -ss.sort_order ELSE ss.sort_order END,
       ms.sort_order,ms.id
     LIMIT 1`,
  ).bind(
    moduleCode,
    module.matched_instance_id,
    organizationId,
    orderId,
  ).first<{
    id: string;
    step_key: string;
    responsibility_position_code: string | null;
  }>();
  const tasks = workflowModule
    ? await env.DB.prepare(
        `SELECT assignee_user_id,responsibility_position_code
         FROM workflow_instance_task_states
         WHERE instance_module_state_id=? AND status!='completed'
         ORDER BY sort_order,id`,
      ).bind(workflowModule.id).all<{
        assignee_user_id: string | null;
        responsibility_position_code: string | null;
      }>()
    : { results: [] };
  return {
    moduleCode,
    stepKey: workflowModule?.step_key ?? null,
    enabled: module.workflow_instance_id
      ? Boolean(workflowModule)
      : module.enabled === 1,
    assigneeUserId: module.assignee_user_id,
    taskAssigneeUserIds: [...new Set(
      tasks.results
        .map((task) => task.assignee_user_id)
        .filter((userId): userId is string => Boolean(userId)),
    )],
    responsibilityPositionCodes: [...new Set(
      [
        workflowModule?.responsibility_position_code,
        ...tasks.results.map((task) => task.responsibility_position_code),
      ].filter((code): code is string => Boolean(code)),
    )],
  };
}

type WorkflowSnapshotModule = {
  id: string;
  module_code: OrderModuleCode;
  module_name: string;
  current_step_code: string | null;
  current_step_name: string | null;
  assignee_user_id: string | null;
  status: string;
  progress_percent: number;
  enabled: number;
  is_required: number;
};

type OrderSeed = {
  id: string;
  business_type: string;
  status: string;
  current_assignee_user_id: string | null;
  workflow_instance_id: string | null;
  matched_instance_id: string | null;
  workflow_id: string | null;
};

export async function ensureOrderModules(
  organizationId: string,
  orderId: string,
  options: { syncBusinessWorkflow?: boolean } = {},
) {
  const order = await env.DB.prepare(
    `SELECT o.id,o.business_type,o.status,o.current_assignee_user_id,
            o.workflow_instance_id,wi.id matched_instance_id,
            CASE WHEN o.workflow_instance_id IS NULL THEN (
              SELECT x.workflow_id FROM workflow_instances x
              WHERE x.organization_id=o.organization_id AND x.order_id=o.id
              LIMIT 1
            ) ELSE wi.workflow_id END workflow_id
     FROM transport_orders o
     LEFT JOIN workflow_instances wi
       ON wi.id=o.workflow_instance_id
      AND wi.organization_id=o.organization_id
      AND wi.order_id=o.id
     WHERE o.id=? AND o.organization_id=?`,
  )
    .bind(orderId, organizationId)
    .first<OrderSeed>();
  if (!order) throw new Error("订单不存在");
  if (order.workflow_instance_id && !order.matched_instance_id) {
    throw new Error("订单工作流实例绑定异常，不能同步业务模块");
  }
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
          assignee_user_id=CASE
            WHEN order_module_instances.module_code='assignment'
              AND order_module_instances.status!='completed'
              AND excluded.assignee_user_id IS NOT NULL
              THEN excluded.assignee_user_id
            ELSE COALESCE(order_module_instances.assignee_user_id,excluded.assignee_user_id)
          END,
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
      initialModuleAssigneeUserId(definition.code, order),
      initial.status === "in_progress" ? now : null,
      initial.status === "completed" ? now : null,
      now,
      now,
    );
  });
  if (statements.length) await env.DB.batch(statements);
  await clearPrematureModuleAssignments(organizationId, orderId, now);
  await applyWorkflowModuleConfiguration(
    organizationId,
    orderId,
    order.workflow_instance_id,
    order.workflow_id,
    now,
  );
  await synchronizeGovernanceModules(organizationId, orderId, order, now);
  await synchronizeDataDrivenModules(organizationId, orderId, metrics, now);
  if (options.syncBusinessWorkflow !== false) {
    await syncOrderBusinessWorkflow({
      organizationId,
      orderId,
      source: "system",
    });
  }
}

/**
 * The order-level current assignee owns the workflow hand-off, not every future
 * business module.  Only the salesperson's opening module and the operation
 * supervisor's assignment module may inherit that value automatically.  All
 * operational module owners must come from an explicit task assignment.
 */
function initialModuleAssigneeUserId(
  code: OrderModuleCode,
  order: OrderSeed,
) {
  if (!order.current_assignee_user_id) return null;
  if (code === "consignment" && order.status === "draft")
    return order.current_assignee_user_id;
  if (code === "assignment" && order.status === "confirmed")
    return order.current_assignee_user_id;
  return null;
}

/**
 * Older orders may already contain the former blanket assignment.  Before the
 * operation supervisor confirms dispatch, clear any future-module owner that
 * has no corresponding module_owner task.  Explicit assignments are preserved.
 */
async function clearPrematureModuleAssignments(
  organizationId: string,
  orderId: string,
  now: string,
) {
  await env.DB.prepare(
    `UPDATE order_module_instances AS target
     SET assignee_user_id=NULL,updated_at=?
     WHERE target.organization_id=? AND target.order_id=?
       AND target.module_code NOT IN ('consignment','cargo','assignment')
       AND target.assignee_user_id IS NOT NULL
       AND EXISTS(
         SELECT 1 FROM order_module_instances assignment
         WHERE assignment.organization_id=target.organization_id
           AND assignment.order_id=target.order_id
           AND assignment.module_code='assignment'
           AND assignment.enabled=1
           AND assignment.status!='completed'
       )
       AND NOT EXISTS(
         SELECT 1 FROM order_tasks task
         WHERE task.organization_id=target.organization_id
           AND task.order_id=target.order_id
           AND task.module_code=target.module_code
           AND task.task_type='module_owner'
           AND task.status!='cancelled'
       )`,
  ).bind(now, organizationId, orderId).run();
}

async function applyWorkflowModuleConfiguration(
  organizationId:string,
  orderId:string,
  workflowInstanceId:string|null,
  workflowId:string|null,
  now:string,
) {
  const source = workflowModuleConfigurationSource(workflowInstanceId, workflowId);
  if (!source) return;
  const configurationSql = source.kind === "workflow_instance"
    ? `SELECT ms.module_code,MAX(ms.is_required) is_required,
         1 enabled,
         MIN(ms.display_name) display_name
       FROM workflow_instance_step_states ss
       JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
       WHERE ss.instance_id=?
       GROUP BY ms.module_code`
    : `SELECT m.module_code,MAX(m.is_required) is_required,
         MAX(CASE WHEN m.is_active=1 AND s.is_active=1 THEN 1 ELSE 0 END) enabled,
         MIN(CASE WHEN m.is_active=1 AND s.is_active=1 THEN m.display_name END) display_name
       FROM workflow_step_modules m
       JOIN workflow_steps s ON s.id=m.step_id AND s.workflow_id=m.workflow_id
       WHERE m.workflow_id=?
       GROUP BY m.module_code`;
  const configured = await env.DB.prepare(configurationSql)
    .bind(source.id)
    .all<{module_code:string;is_required:number;enabled:number;display_name:string|null}>();
  if (!configured.results.length) return;
  const byCode = new Map(configured.results.map((item)=>[item.module_code,item]));
  const rows = await env.DB.prepare(
    "SELECT id,module_code,status FROM order_module_instances WHERE organization_id=? AND order_id=?",
  ).bind(organizationId,orderId).all<{id:string;module_code:string;status:string}>();
  const updates = rows.results.map((row) => {
    const rule = byCode.get(row.module_code);
    const fileIndexOnly = row.module_code === "documents";
    const { enabled, required } = workflowConfiguredModuleFlags({
      moduleCode: row.module_code,
      rule,
    });
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
         SET status=CASE WHEN status='not_started' THEN 'in_progress' ELSE status END,
           current_step_code='checking',current_step_name='资料检查',
           progress_percent=MAX(progress_percent,25),started_at=COALESCE(started_at,?),updated_at=?
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
         MAX(CASE WHEN EXISTS(
           SELECT 1 FROM warehouse_dispatches d
           JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
           JOIN warehouse_packages wp ON wp.id=di.package_id
           JOIN shipments sx ON sx.id=wp.shipment_id
           WHERE d.organization_id=bo.organization_id AND sx.order_id=bo.order_id AND d.status='dispatched'
         ) THEN 1 ELSE 0 END) warehouse_dispatched
       FROM transport_batch_orders bo
       JOIN transport_batches b ON b.id=bo.batch_id AND b.status!='cancelled'
       JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
       GROUP BY b.id
       ORDER BY b.created_at DESC LIMIT 1`,
  )
    .bind(organizationId, orderId)
    .first<{
      id: string;
      business_type: string | null;
      warehouse_dispatched: number;
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
  // The batch record is evidence that a plan exists; completeness is derived
  // exclusively from the current order's workflow-field snapshot. This avoids
  // silently recreating carrier/vehicle/driver/time requirements that an
  // administrator made optional or hidden.
  const readiness = await checkOrderLoadPlan(organizationId, orderId);
  const orderReady = readiness.ready;
  const blockers = readiness.reasons;
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
  await ensureOrderModules(organizationId, orderId, { syncBusinessWorkflow: false });
  await syncModuleStateFromTransportBatch(organizationId, orderId);
  const order = await env.DB.prepare(
    `SELECT o.status,o.business_type,o.current_assignee_user_id,o.workflow_instance_id,
            COALESCE(q.salesperson_user_id,o.salesperson_user_id) salesperson_user_id
     FROM transport_orders o
     LEFT JOIN quotations q ON q.organization_id=o.organization_id AND q.id=o.quotation_id
     WHERE o.organization_id=? AND o.id=?`,
  )
    .bind(organizationId, orderId)
    .first<{
      status: string;
      business_type: string;
      current_assignee_user_id: string | null;
      salesperson_user_id: string | null;
      workflow_instance_id: string | null;
    }>();
  if (!order || order.status !== "in_execution") return;
  const modules = (
    await env.DB.prepare(
      `SELECT id,module_code,module_name,current_step_code,current_step_name,assignee_user_id,status,progress_percent,enabled,is_required
     FROM order_module_instances
     WHERE organization_id=? AND order_id=? AND enabled=1
     ORDER BY module_code`,
    )
      .bind(organizationId, orderId)
      .all<WorkflowSnapshotModule>()
  ).results;
  const synchronizedStepKey = await syncOrderBusinessWorkflow({
    organizationId,
    orderId,
    source: "system",
  });
  const frozenRows = await env.DB.prepare(
    `SELECT wi.current_step_key step_key,ss.step_name,
            ms.id module_state_id,ms.module_code,ms.display_name module_name,
            ms.sort_order module_sort_order,ms.is_required module_required,
            ms.status module_state_status,
            omi.id module_instance_id,omi.enabled module_instance_enabled,
            omi.status module_instance_status,
            omi.current_step_name module_current_step_name,
            omi.assignee_user_id module_assignee_user_id,
            ts.id task_state_id,ts.sort_order task_sort_order,
            ts.is_required task_required,ts.task_type,ts.status task_status,
            ts.assignee_user_id task_assignee_user_id
       FROM workflow_instances wi
       JOIN workflow_instance_step_states ss
         ON ss.instance_id=wi.id AND ss.step_key=wi.current_step_key
       LEFT JOIN workflow_instance_module_states ms
         ON ms.instance_step_state_id=ss.id
       LEFT JOIN order_module_instances omi
         ON omi.organization_id=wi.organization_id AND omi.order_id=wi.order_id
        AND omi.module_code=ms.module_code
       LEFT JOIN workflow_instance_task_states ts
         ON ts.instance_module_state_id=ms.id
      WHERE wi.id=? AND wi.organization_id=? AND wi.order_id=?
      ORDER BY ms.sort_order,ts.sort_order,ts.id`,
  ).bind(order.workflow_instance_id, organizationId, orderId).all<FrozenWorkflowCurrentOwnerRow>();
  const frozenCurrent = resolveFrozenWorkflowCurrentOwner(frozenRows.results);
  const legacyNext =
    !frozenCurrent &&
    !synchronizedStepKey &&
    !order.workflow_instance_id
    ? pickLegacyNextWorkflowModule(modules, order.business_type)
    : null;
  const now = new Date().toISOString();
  const activeModuleIds = frozenCurrent?.activeModuleInstanceIds ??
    (legacyNext?.status === "not_started" ? [legacyNext.id] : []);
  if (activeModuleIds.length) {
    await env.DB.batch(activeModuleIds.map((moduleId) => env.DB.prepare(
      `UPDATE order_module_instances
          SET status='in_progress',started_at=COALESCE(started_at,?),
              progress_percent=CASE WHEN progress_percent>0 THEN progress_percent ELSE 1 END,
              updated_at=?
        WHERE id=? AND status='not_started'`,
    ).bind(now, now, moduleId)));
  }
  const primaryModuleCode = frozenCurrent?.primaryModuleCode ?? legacyNext?.module_code ?? null;
  const primaryAssigneeUserId = frozenCurrent?.primaryAssigneeUserId ?? legacyNext?.assignee_user_id ?? null;
  const nextStepName = frozenCurrent
    ? `${frozenCurrent.stepName}${frozenCurrent.primaryModuleName ? ` · ${frozenCurrent.primaryModuleName}` : ""}`
    : legacyNext
      ? `${legacyNext.module_name} · ${legacyNext.current_step_name || "待处理"}`
      : order.workflow_instance_id
        ? "工作流实例当前节点配置异常"
        : "已启用模块全部完成";
  const notificationStatements = [];
  let notificationAssigneeUserIds =
    frozenCurrent?.notificationAssigneeUserIds ??
      (primaryAssigneeUserId ? [primaryAssigneeUserId] : []);
  if (
    primaryModuleCode === "costs" &&
    frozenCurrent &&
    order.workflow_instance_id
  ) {
    const [activeSettlementFields, frozenFinanceOwner] = await Promise.all([
      env.DB.prepare(
        `SELECT field_key
           FROM workflow_instance_fields
          WHERE instance_id=? AND step_key=? AND module_code='costs'
            AND is_active=1
            AND field_key IN (
              'customer_service_confirmation','business_review','finance_review'
            )
          ORDER BY sort_order,field_key`,
      ).bind(order.workflow_instance_id, frozenCurrent.stepKey).all<{ field_key: string }>(),
      env.DB.prepare(
        `SELECT COALESCE(ts.assignee_user_id,omi.assignee_user_id) assignee_user_id
           FROM workflow_instance_step_states ss
           JOIN workflow_instance_module_states ms
             ON ms.instance_step_state_id=ss.id AND ms.module_code='review'
           LEFT JOIN workflow_instance_task_states ts
             ON ts.instance_module_state_id=ms.id AND ts.task_type<>'system'
           LEFT JOIN order_module_instances omi
             ON omi.organization_id=? AND omi.order_id=?
            AND omi.module_code=ms.module_code AND omi.enabled=1
          WHERE ss.instance_id=?
            AND COALESCE(
              ts.responsibility_position_code,
              ms.responsibility_position_code
            )='FINANCE_ACCOUNTING'
            AND COALESCE(ts.assignee_user_id,omi.assignee_user_id) IS NOT NULL
          ORDER BY
            CASE WHEN ts.status IN ('active','pending','blocked') THEN 0 ELSE 1 END,
            CASE WHEN ts.is_required=1 THEN 0 ELSE 1 END,
            ss.sort_order,ms.sort_order,ts.sort_order,ts.id
          LIMIT 1`,
      ).bind(
        organizationId,
        orderId,
        order.workflow_instance_id,
      ).first<{ assignee_user_id: string | null }>(),
    ]);
    notificationAssigneeUserIds = resolveFrozenSettlementNotificationAssignees({
      baseAssigneeUserIds: notificationAssigneeUserIds,
      activeFieldKeys: activeSettlementFields.results.map((field) => field.field_key),
      salespersonUserId: order.salesperson_user_id,
      financeAssigneeUserId: frozenFinanceOwner?.assignee_user_id ?? null,
    });
  }
  const notificationAssignees = new Set(notificationAssigneeUserIds);
  for (const assigneeUserId of notificationAssignees) {
    if (
      notificationAssignees.size === 1 &&
      assigneeUserId === order.current_assignee_user_id
    ) continue;
    notificationStatements.push(
      assignedOrderNotificationStatement(env.DB, {
        organizationId,
        orderId,
        assigneeUserId,
        actorUserId: null,
        stepName: nextStepName,
        now,
      }),
    );
  }
  const nextStepCode = frozenCurrent
    ? primaryModuleCode
      ? `module:${primaryModuleCode}`
      : `workflow:${frozenCurrent.stepKey}`
    : legacyNext
      ? `module:${legacyNext.module_code}`
      : order.workflow_instance_id
        ? "workflow_configuration_error"
        : "ready_to_complete";
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE transport_orders SET current_step_code=?,current_step_name=?,current_assignee_user_id=?,workflow_updated_at=?,updated_at=? WHERE organization_id=? AND id=? AND status='in_execution'",
    ).bind(
      nextStepCode,
      nextStepName,
      primaryAssigneeUserId,
      now,
      now,
      organizationId,
      orderId,
    ),
    ...notificationStatements,
  ]);
}

function pickLegacyNextWorkflowModule(
  modules: WorkflowSnapshotModule[],
  _businessType: string,
) {
  return pickNextRequiredWorkflowModule(
    modules,
    orderBusinessStages.map((stage) => stage.modules),
  );
}

async function syncModuleStateFromTransportBatch(organizationId: string, orderId: string) {
  const batch = await env.DB.prepare(
    `SELECT b.id,b.road_status,b.status,bo.status order_batch_status,
            EXISTS(SELECT 1 FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages wp ON wp.id=di.package_id JOIN shipments s ON s.id=wp.shipment_id WHERE d.organization_id=? AND s.order_id=? AND d.status='dispatched') warehouse_dispatched,
            EXISTS(SELECT 1 FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id WHERE l.organization_id=? AND p.order_id=? AND l.loaded_at IS NOT NULL) packages_loaded,
            (SELECT op.status FROM overseas_warehouse_operations op
              WHERE op.organization_id=? AND op.order_id=? AND op.status!='cancelled'
              ORDER BY op.created_at DESC LIMIT 1) overseas_operation_status,
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
    overseas_operation_status: string | null;
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
  if (batch.overseas_operation_status || ["overseas_arrived", "waiting_pickup", "pickup_completed"].includes(batch.road_status || "")) {
    const operationStatus = batch.overseas_operation_status || "arrived";
    const pickupCompleted = operationStatus === "picked_up";
    const notified = ["notified", "appointment"].includes(operationStatus);
    const appointed = operationStatus === "appointment";
    const moduleStatus = pickupCompleted ? "completed" : "in_progress";
    const moduleStepCode = pickupCompleted ? "signed" : appointed ? "appointment" : notified ? "notified" : "arrived";
    const moduleStepName = pickupCompleted
      ? "扫码自提签收完成"
      : appointed
        ? "客户已预约，等待扫码自提"
        : notified
          ? "等待客户预约或扫码自提"
        : "等待系统自动通知客户";
    const progress = pickupCompleted ? 100 : appointed ? 75 : notified ? 60 : 25;
    statements.push(
      env.DB.prepare(
        `UPDATE order_module_instances
         SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
             started_at=COALESCE(started_at,?),
             completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,
             blocking_reason=NULL,updated_at=?
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
        organizationId,
        orderId,
      ),
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
  const [expenses, controls, workflowFields] = await Promise.all([
    env.DB.prepare(
      `SELECT e.direction,COUNT(*) total,
              COALESCE(SUM(MAX(
                e.amount-COALESCE((
                  SELECT SUM(a.amount)
                  FROM settlement_cash_allocations a
                  JOIN settlement_cash_transactions t
                    ON t.id=a.cash_transaction_id AND t.status!='void'
                  WHERE a.expense_id=e.id
                ),0),
                0
              )),0) outstanding_balance
       FROM business_expenses e
       WHERE e.organization_id=? AND e.order_id=? AND e.stage!='cancelled'
       GROUP BY e.direction`,
    )
      .bind(organizationId, orderId)
      .all<{
        direction: "receivable" | "payable";
        total: number;
        outstanding_balance: number;
      }>(),
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
    loadOrderModuleWorkflowFields(organizationId, orderId, "costs"),
  ]);
  const expenseByDirection = new Map(
    expenses.results.map((item) => [item.direction, item]),
  );
  const controlByDirection = new Map(
    controls.results.map((item) => [item.direction, item]),
  );
  const gate = evaluateCostsCompletionGate({
    fields: workflowFields,
    directions: (["receivable", "payable"] as const).map((direction) => {
      const control = controlByDirection.get(direction);
      const expense = expenseByDirection.get(direction);
      return {
        direction,
        hasExpenses: Number(expense?.total ?? 0) > 0,
        outstandingBalance: Number(expense?.outstanding_balance ?? 0),
        customerServiceConfirmed: Boolean(control?.confirmed),
        businessReviewed: Boolean(control?.business_reviewed),
        financeReviewed: Boolean(control?.finance_reviewed),
      };
    }),
  });

  const definition = orderModuleDefinition("costs");
  if (!definition) return;
  const step = definition.steps.find((item) => item.code === gate.currentStepCode) ??
    definition.steps[0];
  await env.DB.prepare(
    `UPDATE order_module_instances
     SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
         started_at=CASE WHEN ?!='not_started' THEN COALESCE(started_at,?) ELSE started_at END,
         completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,
         blocking_reason=?,updated_at=?
     WHERE organization_id=? AND order_id=? AND module_code='costs' AND enabled=1`,
  )
    .bind(
      gate.status,
      step.code,
      step.name,
      gate.progressPercent,
      gate.status,
      now,
      gate.status,
      now,
      gate.blockingReason,
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
    `SELECT m.id,m.module_code,m.module_name,m.enabled,m.is_required,m.status,m.current_step_code,m.current_step_name,m.progress_percent,m.blocking_reason,m.assignee_user_id,u.display_name assignee_name,u.email assignee_email,p.name assignee_position_name,m.started_at,m.completed_at,m.updated_at
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
  responsibilityPositionCode?: string | null;
}) {
  const module = await moduleRow(input);
  if (!module.enabled) throw new Error("该模块未启用");
  const definition = orderModuleDefinition(input.moduleCode);
  if (!definition) throw new Error("模块不存在");
  const workflowAssignmentTarget = await resolveOrderModuleAssignmentTarget({
    organizationId: input.organizationId,
    orderId: input.orderId,
    moduleCode: input.moduleCode,
    assigneeUserId: input.assigneeUserId,
    responsibilityPositionCode: input.responsibilityPositionCode,
  });
  if (!workflowAssignmentTarget) {
    await requireActiveOrganizationAssignee(
      input.organizationId,
      input.assigneeUserId,
    );
  }
  const now = new Date().toISOString();
  const legacyTaskTitle = `${definition.name}处理任务`;
  const taskTitle = workflowAssignmentTarget
    ? `${legacyTaskTitle}（${workflowAssignmentTarget.positionCode}）`
    : legacyTaskTitle;
  const moduleOwnerStatements = !workflowAssignmentTarget || workflowAssignmentTarget.primaryOwner
    ? [env.DB.prepare(
        "UPDATE order_module_instances SET assignee_user_id=?,blocking_reason=NULL,updated_at=? WHERE id=?",
      ).bind(input.assigneeUserId, now, module.id)]
    : [];
  const cancelTaskStatement = workflowAssignmentTarget
    ? env.DB.prepare(
        "UPDATE order_tasks SET status='cancelled',updated_at=? WHERE organization_id=? AND order_id=? AND module_code=? AND task_type='module_owner' AND status IN ('pending','in_progress') AND title IN (?,?)",
      ).bind(
        now,
        input.organizationId,
        input.orderId,
        input.moduleCode,
        legacyTaskTitle,
        taskTitle,
      )
    : env.DB.prepare(
        "UPDATE order_tasks SET status='cancelled',updated_at=? WHERE organization_id=? AND order_id=? AND module_code=? AND task_type='module_owner' AND status IN ('pending','in_progress')",
      ).bind(now, input.organizationId, input.orderId, input.moduleCode);
  await env.DB.batch([
    ...moduleOwnerStatements,
    ...(
      workflowAssignmentTarget
        ? frozenWorkflowTaskAssignmentStatements({
            organizationId: input.organizationId,
            orderId: input.orderId,
            assigneeUserId: input.assigneeUserId,
            now,
            target: workflowAssignmentTarget,
          })
        : []
    ),
    cancelTaskStatement,
    env.DB.prepare(
      "INSERT INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,status,assignee_user_id,assigned_by_user_id,due_at,created_at,updated_at) VALUES(?,?,?,?,? ,?,'pending',?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.orderId,
      input.moduleCode,
      "module_owner",
      taskTitle,
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
      actionName: workflowAssignmentTarget
        ? `分配${workflowAssignmentTarget.positionCode}负责人`
        : "分配负责人",
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
    return runtimeWorkflowFieldPolicy(
      configuredFields,
      fieldKey,
      fallback,
    ).required;
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
    const readiness = await checkOrderPreDepartureDocuments(
      organizationId,
      orderId,
    );
    if (!readiness.ready) throw new Error(readiness.reasons.join("；"));
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
          : false;
    if (requiredStatus && warehouseGateRequired) {
      const row = await env.DB.prepare(
        `SELECT
          CASE ?
            WHEN 'receipt' THEN EXISTS(SELECT 1 FROM warehouse_receipts wr JOIN shipments s ON s.id=wr.shipment_id WHERE s.order_id=? AND wr.organization_id=?)
            WHEN 'sorting' THEN EXISTS(SELECT 1 FROM warehouse_sorting_batches wb JOIN shipments s ON s.id=wb.shipment_id WHERE s.order_id=? AND wb.organization_id=? AND wb.status='verified')
            ELSE 0 END ready`,
      ).bind(requiredStatus, orderId, organizationId, orderId, organizationId).first<{ ready: number }>();
      if (!row?.ready)
        throw new Error(
          requiredStatus === "receipt" ? "请先完成仓库实际收货" :
          "请先完成货物齐套与分拣复核",
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
        .filter((p) => preDepartureDocumentTypeCodes.has(p.documentCode))
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
    // A required customs module must produce each visible core business result.
    // Hidden actions remain absent, while optional modules stay nonblocking.
    if (currentStep === "review") {
      const moduleMode = await env.DB.prepare(
        "SELECT enabled,is_required FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='customs'",
      ).bind(organizationId, orderId).first<{ enabled: number; is_required: number }>();
      const gateRequirements = customsModuleGateRequirements(configuredFields, {
        moduleRequired: moduleMode
          ? moduleMode.enabled === 1 && moduleMode.is_required === 1
          : true,
      });
      const customsGate = await env.DB.prepare(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN d.status='released' THEN 1 ELSE 0 END) released
         FROM order_customs_declarations d
         JOIN order_customs_records r ON r.id=d.customs_record_id AND r.organization_id=d.organization_id
        WHERE d.organization_id=? AND d.order_id=? AND d.is_deleted=0 AND d.status!='cancelled'`,
      ).bind(organizationId, orderId).first<{ total: number; released: number | null }>();
      const total = customsGate?.total ?? 0;
      const released = customsGate?.released ?? 0;
      if ((gateRequirements.declarationsRequired || gateRequirements.releaseRequired) && total === 0)
        throw new Error("请先录入至少一张有效报关单");
      if (gateRequirements.releaseRequired && released !== total)
        throw new Error(`报关单尚未全部放行（已放行 ${released}/${total} 张）`);
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
  const [cargo, attachments, bookings, transportAssignments] = await Promise.all([
    count("order_cargo_items", organizationId, orderId),
    count("order_attachments", organizationId, orderId),
    count("booking_records", organizationId, orderId),
    count("order_transport_assignments", organizationId, orderId),
  ]);
  const [batches, shipments, expenses] = await Promise.all([
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
  else if (code === "assignment" && order.status === "confirmed") index = 1;
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
