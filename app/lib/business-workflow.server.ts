import { env } from "cloudflare:workers";
import { orderBusinessStages } from "./order-stage-flow";
import type { OrderModuleCode } from "./order-modules";
import {
  ensureWorkflowCatalogFields,
  snapshotWorkflowFieldsForInstance,
} from "./workflow-fields.server";

export type WorkflowEvent =
  | "customer.ready"
  | "quote.created"
  | "quote.accepted"
  | "order.created"
  | "shipment.created"
  | "shipment.picked_up"
  | "shipment.in_transit"
  | "shipment.delivered"
  | "invoice.created";

type WorkflowRefs = {
  customerId: string;
  quotationId?: string | null;
  orderId?: string | null;
  shipmentId?: string | null;
  invoiceId?: string | null;
};

type RecordEventInput = WorkflowRefs & {
  organizationId: string;
  workflowId?: string | null;
  event: WorkflowEvent;
  actorUserId?: string | null;
  source: "admin" | "portal" | "system";
  metadata?: Record<string, unknown>;
};

type Definition = { id: string };
type Step = { step_key: string; name: string; sort_order: number };
type Instance = { id: string; workflow_id: string; current_step_key: string };

type AdvanceInput = {
  organizationId: string;
  instanceId: string;
  actorUserId: string;
};

type OrderBusinessWorkflowSyncInput = {
  organizationId: string;
  orderId: string;
  actorUserId?: string | null;
  source?: "admin" | "portal" | "system";
};

type OrderWorkflowSnapshot = {
  id: string;
  status: string;
  business_type: string;
  customer_id: string;
  quotation_id: string | null;
};

type ModuleSnapshot = {
  module_code: OrderModuleCode;
  enabled: number;
  is_required: number;
  status: string;
  current_step_code: string | null;
};

export const defaultWorkflowSteps = [
  ["order_creation", "订单创建", "order", "order.created", 10, "admin"],
  ["review_assignment", "审核分配", "order", "manual.review_assignment", 20, "admin"],
  ["domestic_execution", "国内运输", "order", "manual.domestic_execution", 30, "admin"],
  ["port_loading", "装车与出库", "order", "manual.port_loading", 40, "admin"],
  ["outbound_transport", "出境运输", "order", "manual.outbound_transport", 50, "admin"],
  ["overseas_pickup", "境外仓自提", "order", "manual.overseas_pickup", 60, "admin"],
  ["reconciliation", "对账结算", "order", "manual.reconciliation", 70, "admin"],
  ["completion_review", "完成复盘", "order", "manual.completion_review", 80, "admin"],
] as const;

const workflowDefinitions = {
  pending: {
    code: "tms-road-pending",
    name: "汽运订单待分流流程",
    steps: defaultWorkflowSteps,
  },
  ltl: {
    code: "tms-default",
    name: "拼车型汽运订单标准流程",
    steps: defaultWorkflowSteps,
  },
  ftl: {
    code: "tms-ftl-standard",
    name: "整车型汽运订单标准流程",
    steps: defaultWorkflowSteps,
  },
} as const;

export async function ensureDefaultWorkflow(organizationId: string): Promise<string> {
  await ensureRoadWorkflowTemplates(organizationId);
  const existing = await env.DB.prepare(
    "SELECT id FROM workflow_definitions WHERE organization_id = ? AND code = 'tms-default'",
  ).bind(organizationId).first<Definition>();
  return existing?.id ?? `${organizationId}:tms-default`;
}

export async function ensureWorkflowForBusinessType(
  organizationId: string,
  businessType?: string | null,
): Promise<string> {
  await ensureRoadWorkflowTemplates(organizationId);
  const code = businessType === "ftl"
    ? workflowDefinitions.ftl.code
    : businessType === "ltl"
      ? workflowDefinitions.ltl.code
      : workflowDefinitions.pending.code;
  const existing = await env.DB.prepare(
    "SELECT id FROM workflow_definitions WHERE organization_id = ? AND code = ? AND status = 'active'",
  ).bind(organizationId, code).first<Definition>();
  return existing?.id ?? ensureDefaultWorkflow(organizationId);
}

async function ensureRoadWorkflowTemplates(organizationId: string) {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const config of Object.values(workflowDefinitions)) {
    const workflowId = `${organizationId}:${config.code}`;
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO workflow_definitions (id, organization_id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(workflowId, organizationId, config.code, config.name, now, now),
      env.DB.prepare(
        "UPDATE workflow_definitions SET name=?,updated_at=? WHERE organization_id=? AND code=? AND name IN ('汽运订单标准流程','国际零担标准流程')",
      ).bind(config.name, now, organizationId, config.code),
      ...config.steps.map(([key, name, entity, event, order, scope]) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          `${organizationId}:wf:${config.code}:${key}`,
          workflowId,
          key,
          name,
          entity,
          event,
          order,
          scope,
          now,
          now,
        ),
      ),
      ...config.steps.map(([key, name, entity, event, order, scope]) =>
        env.DB.prepare(
          `UPDATE workflow_steps
           SET name=?,entity_type=?,trigger_event=?,sort_order=?,actor_scope=?,is_active=1,updated_at=?
           WHERE workflow_id=? AND step_key=?`,
        ).bind(name, entity, event, order, scope, now, workflowId, key),
      ),
    );
  }
  await env.DB.batch(statements);

  const ltlWorkflowId = `${organizationId}:${workflowDefinitions.ltl.code}`;
  const ftlWorkflowId = `${organizationId}:${workflowDefinitions.ftl.code}`;
  const ltlFields = await env.DB.prepare(
    `SELECT f.field_key,f.label,f.field_type,f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,s.step_key
     FROM workflow_step_fields f
     JOIN workflow_steps s ON s.id=f.step_id
     WHERE f.workflow_id=? AND s.step_key<>'port_loading'`,
  )
    .bind(ltlWorkflowId)
    .all<{
      field_key: string;
      label: string;
      field_type: string;
      is_required: number;
      is_active: number;
      sort_order: number;
      options_text: string | null;
      help_text: string | null;
      step_key: string;
    }>();
  if (ltlFields.results.length) {
    const copyStatements = ltlFields.results.map((field) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO workflow_step_fields(
          id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,sort_order,options_text,help_text,created_at,updated_at
        )
        SELECT ?,?,?,?, ?,?,?,?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM workflow_steps WHERE id=? AND workflow_id=?)`,
      ).bind(
        `${organizationId}:wf-field:${workflowDefinitions.ftl.code}:${field.step_key}:${field.field_key}`,
        ftlWorkflowId,
        `${organizationId}:wf:${workflowDefinitions.ftl.code}:${field.step_key}`,
        field.field_key,
        field.label,
        field.field_type,
        field.is_required,
        field.is_active,
        field.sort_order,
        field.options_text,
        field.help_text,
        now,
        now,
        `${organizationId}:wf:${workflowDefinitions.ftl.code}:${field.step_key}`,
        ftlWorkflowId,
      ),
    );
    await env.DB.batch(copyStatements);
  }
  await ensureWorkflowCatalogFields(organizationId);
}

export async function recordWorkflowEvent(input: RecordEventInput): Promise<string | null> {
  await ensureDefaultWorkflow(input.organizationId);
  let instance = await findInstance(input.organizationId, input);
  const definition =
    (instance ? { id: instance.workflow_id } : null) ??
    (input.workflowId
      ? await env.DB.prepare(
          "SELECT id FROM workflow_definitions WHERE id = ? AND organization_id = ? AND status = 'active'",
        ).bind(input.workflowId, input.organizationId).first<Definition>()
      : null) ??
    (await env.DB.prepare(
      "SELECT id FROM workflow_definitions WHERE organization_id = ? AND code = 'tms-default' AND status = 'active' LIMIT 1",
    ).bind(input.organizationId).first<Definition>()) ??
    (await env.DB.prepare(
      "SELECT id FROM workflow_definitions WHERE organization_id = ? AND status = 'active' ORDER BY created_at LIMIT 1",
    ).bind(input.organizationId).first<Definition>());
  if (!definition) return null;

  let step = await env.DB.prepare(
    "SELECT step_key, name, sort_order FROM workflow_steps WHERE workflow_id = ? AND trigger_event = ? AND is_active = 1",
  ).bind(definition.id, input.event).first<Step>();
  if (!step) return null;

  const now = new Date().toISOString();
  if (!instance) {
    const instanceId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO workflow_instances
      (id, organization_id, workflow_id, customer_id, quotation_id, order_id, shipment_id, invoice_id, current_step_key, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(instanceId, input.organizationId, definition.id, input.customerId, input.quotationId ?? null, input.orderId ?? null, input.shipmentId ?? null, input.invoiceId ?? null, step.step_key, now, now).run();
    instance = { id: instanceId, workflow_id: definition.id, current_step_key: step.step_key };
    await snapshotWorkflowFieldsForInstance({
      organizationId: input.organizationId,
      instanceId,
      workflowId: definition.id,
    });
  } else {
    const current = await env.DB.prepare(
      "SELECT sort_order,trigger_event FROM workflow_steps WHERE workflow_id = ? AND step_key = ?",
    ).bind(definition.id, instance.current_step_key).first<{ sort_order: number; trigger_event:string }>();
    if (current && step.sort_order < current.sort_order) return instance.id;
    if (current?.trigger_event.startsWith("manual.")) return instance.id;
    if (current) {
      const manualStep = await env.DB.prepare(`SELECT step_key,name,sort_order FROM workflow_steps
        WHERE workflow_id=? AND is_active=1 AND trigger_event LIKE 'manual.%' AND sort_order>? AND sort_order<?
        ORDER BY sort_order,step_key LIMIT 1`).bind(definition.id,current.sort_order,step.sort_order).first<Step>();
      if (manualStep) step=manualStep;
    }
    const completed = await env.DB.prepare(
      "SELECT NOT EXISTS (SELECT 1 FROM workflow_steps WHERE workflow_id = ? AND is_active = 1 AND sort_order > ?) AS done",
    ).bind(definition.id, step.sort_order).first<{ done: number }>();
    await env.DB.prepare(`UPDATE workflow_instances SET
      customer_id = ?, quotation_id = COALESCE(?, quotation_id), order_id = COALESCE(?, order_id),
      shipment_id = COALESCE(?, shipment_id), invoice_id = COALESCE(?, invoice_id), current_step_key = ?,
      status = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END, updated_at = ?
      WHERE id = ? AND organization_id = ?`)
      .bind(input.customerId, input.quotationId ?? null, input.orderId ?? null, input.shipmentId ?? null, input.invoiceId ?? null,
        step.step_key, completed?.done ? "completed" : "active", completed?.done ? "completed" : "active", now, now, instance.id, input.organizationId).run();
  }

  await env.DB.prepare(`INSERT INTO workflow_history
    (id, instance_id, step_key, step_name, actor_user_id, source, metadata, occurred_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS
      (SELECT 1 FROM workflow_history WHERE instance_id = ? AND step_key = ?)`)
    .bind(crypto.randomUUID(), instance.id, step.step_key, step.name, input.actorUserId ?? null, input.source,
      input.metadata ? JSON.stringify(input.metadata) : null, now, instance.id, step.step_key).run();
  return instance.id;
}

export async function advanceWorkflowInstance(input: AdvanceInput): Promise<{ stepName: string; completed: boolean }> {
  const instance = await env.DB.prepare(`SELECT wi.id,wi.workflow_id,wi.current_step_key,ws.sort_order
    FROM workflow_instances wi JOIN workflow_steps ws ON ws.workflow_id=wi.workflow_id AND ws.step_key=wi.current_step_key
    WHERE wi.id=? AND wi.organization_id=? AND wi.status='active'`)
    .bind(input.instanceId,input.organizationId).first<{id:string;workflow_id:string;current_step_key:string;sort_order:number}>();
  if (!instance) throw new Error("流程实例不存在或已经结束");
  const next = await env.DB.prepare(`SELECT step_key,name,sort_order FROM workflow_steps
    WHERE workflow_id=? AND is_active=1 AND sort_order>? ORDER BY sort_order,step_key LIMIT 1`)
    .bind(instance.workflow_id,instance.sort_order).first<Step>();
  if (!next) throw new Error("当前已经是最后一个启用节点");
  const final = await env.DB.prepare(`SELECT NOT EXISTS(
    SELECT 1 FROM workflow_steps WHERE workflow_id=? AND is_active=1 AND sort_order>?
  ) AS done`).bind(instance.workflow_id,next.sort_order).first<{done:number}>();
  const now=new Date().toISOString(), status=final?.done?"completed":"active";
  await env.DB.batch([
    env.DB.prepare(`UPDATE workflow_instances SET current_step_key=?,status=?,completed_at=CASE WHEN ?='completed' THEN ? ELSE NULL END,updated_at=?
      WHERE id=? AND organization_id=?`).bind(next.step_key,status,status,now,now,input.instanceId,input.organizationId),
    env.DB.prepare(`INSERT INTO workflow_history(id,instance_id,step_key,step_name,actor_user_id,source,metadata,occurred_at)
      SELECT ?,?,?,?,?, 'admin', ?, ? WHERE NOT EXISTS(SELECT 1 FROM workflow_history WHERE instance_id=? AND step_key=?)`)
      .bind(crypto.randomUUID(),input.instanceId,next.step_key,next.name,input.actorUserId,JSON.stringify({manual:true}),now,input.instanceId,next.step_key),
  ]);
  return {stepName:next.name,completed:Boolean(final?.done)};
}

export async function syncOrderBusinessWorkflow(input: OrderBusinessWorkflowSyncInput) {
  const order = await env.DB.prepare(
    "SELECT id,status,business_type,customer_id,quotation_id FROM transport_orders WHERE organization_id=? AND id=?",
  )
    .bind(input.organizationId, input.orderId)
    .first<OrderWorkflowSnapshot>();
  if (!order) return null;
  const workflowId = await ensureWorkflowForBusinessType(input.organizationId, order.business_type);
  let instance = await env.DB.prepare(
    `SELECT id,workflow_id,current_step_key
     FROM workflow_instances
     WHERE organization_id=? AND order_id=?
     LIMIT 1`,
  )
    .bind(input.organizationId, input.orderId)
    .first<Instance>();
  const modules = (
    await env.DB.prepare(
      `SELECT module_code,enabled,is_required,status,current_step_code
       FROM order_module_instances
       WHERE organization_id=? AND order_id=?`,
    )
      .bind(input.organizationId, input.orderId)
      .all<ModuleSnapshot>()
  ).results;
  const targetStepKey = resolveOrderBusinessStep(
    order.status,
    modules,
  );
  if (!targetStepKey) return null;
  const targetStep = await env.DB.prepare(
    "SELECT step_key,name,sort_order FROM workflow_steps WHERE workflow_id=? AND step_key=? AND is_active=1",
  )
    .bind(workflowId, targetStepKey)
    .first<Step>();
  if (!targetStep) return null;
  const now = new Date().toISOString();
  const completed = order.status === "completed";
  if (!instance) {
    const instanceId = crypto.randomUUID();
    const refs = await env.DB.prepare(
      `SELECT
         (SELECT s.id FROM shipments s WHERE s.order_id=? ORDER BY s.created_at DESC LIMIT 1) shipment_id,
         (SELECT i.id FROM invoices i JOIN shipments s ON s.id=i.shipment_id WHERE s.order_id=? ORDER BY i.created_at DESC LIMIT 1) invoice_id`,
    )
      .bind(order.id, order.id)
      .first<{ shipment_id: string | null; invoice_id: string | null }>();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workflow_instances(
          id,organization_id,workflow_id,customer_id,quotation_id,order_id,shipment_id,invoice_id,
          current_step_key,status,started_at,completed_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        instanceId,
        input.organizationId,
        workflowId,
        order.customer_id,
        order.quotation_id,
        order.id,
        refs?.shipment_id ?? null,
        refs?.invoice_id ?? null,
        targetStep.step_key,
        completed ? "completed" : "active",
        now,
        completed ? now : null,
        now,
      ),
      env.DB.prepare(
        "UPDATE transport_orders SET workflow_instance_id=?,updated_at=? WHERE organization_id=? AND id=?",
      ).bind(instanceId, now, input.organizationId, order.id),
      env.DB.prepare(
        `INSERT INTO workflow_history(id,instance_id,step_key,step_name,actor_user_id,source,metadata,occurred_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),
        instanceId,
        targetStep.step_key,
        targetStep.name,
        input.actorUserId ?? null,
        input.source ?? "system",
        JSON.stringify({ syncedFromOrderModules: true, orderStatus: order.status, createdMissingInstance: true }),
        now,
      ),
    ]);
    await snapshotWorkflowFieldsForInstance({
      organizationId: input.organizationId,
      instanceId,
      workflowId,
    });
    return targetStep.step_key;
  }
  if (targetStepKey === instance.current_step_key) {
    if (instance.workflow_id !== workflowId) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_instances SET workflow_id=?,updated_at=? WHERE id=? AND organization_id=?",
        ).bind(workflowId, now, instance.id, input.organizationId),
        env.DB.prepare(
          `INSERT INTO workflow_history(id,instance_id,step_key,step_name,actor_user_id,source,metadata,occurred_at)
           SELECT ?,?,?,?,?,?,?,?
           WHERE NOT EXISTS(
             SELECT 1 FROM workflow_history
             WHERE instance_id=? AND step_key=? AND metadata LIKE '%templateSynced%'
           )`,
        ).bind(
          crypto.randomUUID(),
          instance.id,
          targetStep.step_key,
          targetStep.name,
          input.actorUserId ?? null,
          input.source ?? "system",
          JSON.stringify({
            templateSynced: true,
            businessType: order.business_type,
            syncedFromOrderModules: true,
          }),
          now,
          instance.id,
          targetStep.step_key,
        ),
      ]);
      await env.DB.prepare("DELETE FROM workflow_instance_fields WHERE instance_id=?")
        .bind(instance.id)
        .run();
      await snapshotWorkflowFieldsForInstance({
        organizationId: input.organizationId,
        instanceId: instance.id,
        workflowId,
      });
    }
    return targetStepKey;
  }
  const targetOnInstanceWorkflow = await env.DB.prepare(
    "SELECT step_key,name,sort_order FROM workflow_steps WHERE workflow_id=? AND step_key=? AND is_active=1",
  )
    .bind(workflowId, targetStepKey)
    .first<Step>();
  if (!targetOnInstanceWorkflow) return null;
  const targetStepResolved = targetOnInstanceWorkflow;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workflow_instances
       SET current_step_key=?,status=?,completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE completed_at END,updated_at=?
       WHERE id=? AND organization_id=?`,
    ).bind(
      targetStepResolved.step_key,
      completed ? "completed" : "active",
      completed ? "completed" : "active",
      now,
      now,
      instance.id,
      input.organizationId,
    ),
    env.DB.prepare(
      "UPDATE workflow_instances SET workflow_id=?,updated_at=? WHERE id=? AND organization_id=? AND workflow_id<>?",
    ).bind(workflowId, now, instance.id, input.organizationId, workflowId),
    env.DB.prepare(
      `INSERT INTO workflow_history(id,instance_id,step_key,step_name,actor_user_id,source,metadata,occurred_at)
       SELECT ?,?,?,?,?,?,?,?
       WHERE NOT EXISTS(SELECT 1 FROM workflow_history WHERE instance_id=? AND step_key=?)`,
    ).bind(
      crypto.randomUUID(),
      instance.id,
      targetStep.step_key,
      targetStepResolved.name,
      input.actorUserId ?? null,
      input.source ?? "system",
      JSON.stringify({ syncedFromOrderModules: true, orderStatus: order.status, businessType: order.business_type }),
      now,
      instance.id,
      targetStepResolved.step_key,
    ),
  ]);
  if (instance.workflow_id !== workflowId) {
    await env.DB.prepare("DELETE FROM workflow_instance_fields WHERE instance_id=?")
      .bind(instance.id)
      .run();
    await snapshotWorkflowFieldsForInstance({
      organizationId: input.organizationId,
      instanceId: instance.id,
      workflowId,
    });
  }
  return targetStepResolved.step_key;
}

function resolveOrderBusinessStep(
  status: string,
  modules: ModuleSnapshot[],
) {
  if (status === "cancelled") return null;
  if (status === "draft") return "order_creation";
  if (status === "submitted" || status === "confirmed") return "review_assignment";
  if (status === "completed") return "completion_review";
  if (status !== "in_execution") return "order_creation";
  const activeModules = modules.filter(
    (module) =>
      module.enabled === 1 &&
      (module.is_required === 1 ||
        !["not_started", "not_applicable"].includes(module.status)),
  );
  for (const stage of orderBusinessStages.slice(2)) {
    const stageModules = activeModules.filter((module) =>
      stage.modules.includes(module.module_code),
    );
    if (!stageModules.length) continue;
    if (stageModules.some((module) => !isStageModuleComplete(stage.code, module)))
      return stage.code;
  }
  return "completion_review";
}

function isStageModuleComplete(stageCode: string, module: ModuleSnapshot) {
  return module.status === "completed";
}

async function findInstance(organizationId: string, refs: WorkflowRefs): Promise<Instance | null> {
  const candidates: [string, string | null | undefined][] = [
    ["invoice_id", refs.invoiceId], ["shipment_id", refs.shipmentId], ["order_id", refs.orderId], ["quotation_id", refs.quotationId],
  ];
  for (const [column, value] of candidates) {
    if (!value) continue;
    const row = await env.DB.prepare(
      `SELECT id, workflow_id, current_step_key FROM workflow_instances WHERE organization_id = ? AND ${column} = ? LIMIT 1`,
    ).bind(organizationId, value).first<Instance>();
    if (row) return row;
  }
  return null;
}
