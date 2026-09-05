import { env } from "cloudflare:workers";
import { orderBusinessStages } from "./order-stage-flow";
import {
  pickNextRequiredWorkflowModule,
  type OrderModuleCode,
} from "./order-modules";
import { snapshotWorkflowFieldsForInstance } from "./workflow-fields.server";
import { workflowFieldCatalog } from "./workflow-field-catalog";
import { resolveConfiguredOrderBusinessTarget } from "./order-business-workflow-target";
import {
  ensureWorkflowExecutionSnapshot,
  synchronizeWorkflowExecution,
} from "./workflow-execution.server";
import {
  standardRoadWorkflowModules,
  standardRoadWorkflowType,
  type StandardRoadWorkflowCode,
} from "./standard-road-workflow";

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
type WorkflowDefinitionIdentity = Definition & {
  lifecycle_status: string;
  validation_status: string;
  template_family_id: string | null;
};
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
  ["quotation", "询价报价", "quote", "quote.created", 10, "admin"],
  ["order_creation", "委托资料补充", "order", "order.created", 20, "admin"],
  ["consignment_approval", "委托审核", "order", "manual.consignment_approval", 30, "admin"],
  ["task_assignment", "任务分配", "order", "manual.task_assignment", 40, "admin"],
  ["domestic_execution", "国内运输", "order", "manual.domestic_execution", 50, "admin"],
  ["warehouse_receiving", "国内仓入库", "order", "manual.warehouse_receiving", 60, "admin"],
  ["port_loading", "出口准备与装车出库", "order", "manual.port_loading", 70, "admin"],
  ["outbound_transport", "出境运输", "order", "manual.outbound_transport", 80, "admin"],
  ["overseas_pickup", "客户扫码自提签收", "order", "manual.overseas_pickup", 90, "admin"],
  ["reconciliation", "对账结算", "order", "manual.reconciliation", 100, "admin"],
  ["completion_review", "完成复盘", "order", "manual.completion_review", 110, "admin"],
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
} as const satisfies Record<
  string,
  { code: StandardRoadWorkflowCode; name: string; steps: typeof defaultWorkflowSteps }
>;

export async function ensureDefaultWorkflow(organizationId: string): Promise<string> {
  const existingId = await findPublishedWorkflowId(
    organizationId,
    workflowDefinitions.ltl.code,
  );
  if (existingId) return existingId;
  const templates = await ensureRoadWorkflowTemplates(organizationId);
  return (await findPublishedWorkflowId(organizationId, workflowDefinitions.ltl.code)) ??
    templates.get(workflowDefinitions.ltl.code) ??
    failMissingWorkflowTemplate(workflowDefinitions.ltl.code);
}

export async function ensureWorkflowForBusinessType(
  organizationId: string,
  businessType?: string | null,
): Promise<string> {
  const code = businessType === "ftl"
    ? workflowDefinitions.ftl.code
    : businessType === "ltl"
      ? workflowDefinitions.ltl.code
      : workflowDefinitions.pending.code;
  const existingId = await findPublishedWorkflowId(organizationId, code);
  if (existingId) return existingId;
  await ensureRoadWorkflowTemplates(organizationId);
  const publishedId = await findPublishedWorkflowId(organizationId, code);
  if (publishedId) return publishedId;
  const typeLabel = code === workflowDefinitions.ftl.code
    ? "整车"
    : code === workflowDefinitions.ltl.code
      ? "拼车"
      : "待分流";
  throw new Error(
    `当前组织尚未发布且校验通过${typeLabel}工作流。请老板或开发者前往“系统 → 工作流配置”，补齐岗位负责人和必填规则，校验通过后发布再继续业务。`,
  );
}

async function findPublishedWorkflowId(
  organizationId: string,
  code: StandardRoadWorkflowCode,
) {
  const base = await findWorkflowDefinitionByCode(organizationId, code);
  const familyId = base?.template_family_id || base?.id || `${organizationId}:${code}`;
  const existing = await env.DB.prepare(
    `SELECT id FROM workflow_definitions
     WHERE organization_id=? AND lifecycle_status='published' AND status='active'
       AND validation_status='valid'
       AND (code=? OR template_family_id=?)
     ORDER BY version_number DESC,updated_at DESC LIMIT 1`,
  ).bind(organizationId,code,familyId).first<Definition>();
  return existing?.id ?? null;
}

function failMissingWorkflowTemplate(code: StandardRoadWorkflowCode): never {
  throw new Error(`标准工作流模板 ${code} 初始化失败，请刷新工作流配置页重试。`);
}

async function findWorkflowDefinitionByCode(
  organizationId: string,
  code: StandardRoadWorkflowCode,
) {
  return env.DB.prepare(
    `SELECT id,lifecycle_status,validation_status,template_family_id
       FROM workflow_definitions
      WHERE organization_id=? AND code=?
      LIMIT 1`,
  ).bind(organizationId, code).first<WorkflowDefinitionIdentity>();
}

const ftlLoadingTypeLockedFields = new Set([
  "business_type",
  "loading_batch",
  "consolidation_warehouse",
  "cost_allocation",
  "vehicle_capacity_weight",
  "vehicle_capacity_volume",
]);

async function ensureDraftWorkflowCatalogFields(input: {
  workflowId: string;
  code: StandardRoadWorkflowCode;
  now: string;
}) {
  const statements: D1PreparedStatement[] = [];
  for (const [index, item] of workflowFieldCatalog.entries()) {
    if (
      input.code === workflowDefinitions.ftl.code &&
      item.moduleCode === "loading" &&
      ftlLoadingTypeLockedFields.has(item.fieldKey)
    ) continue;
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO workflow_step_fields(
           id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
           sort_order,options_text,help_text,module_code,created_at,updated_at
         )
         SELECT ?,?,s.id,?,?,?,?,?,?,?,?,?,?,?
           FROM workflow_steps s
          WHERE s.workflow_id=? AND s.step_key=?`,
      ).bind(
        `${input.workflowId}:catalog:${item.moduleCode}:${item.fieldKey}`,
        input.workflowId,
        item.fieldKey,
        item.label,
        item.fieldType,
        item.defaultMode === "required" ? 1 : 0,
        item.defaultMode === "hidden" ? 0 : 1,
        index * 10 + 10,
        item.optionsText ?? null,
        item.helpText,
        item.moduleCode,
        input.now,
        input.now,
        input.workflowId,
        item.stepKey,
      ),
    );
  }
  for (let index = 0; index < statements.length; index += 80) {
    await env.DB.batch(statements.slice(index, index + 80));
  }
}

async function ensureRoadWorkflowTemplates(organizationId: string) {
  const now = new Date().toISOString();
  const templates = new Map<StandardRoadWorkflowCode, string>();
  const editableTemplates: Array<{
    code: StandardRoadWorkflowCode;
    workflowId: string;
  }> = [];
  for (const config of Object.values(workflowDefinitions)) {
    const deterministicId = `${organizationId}:${config.code}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO workflow_definitions(
         id,organization_id,code,name,status,template_family_id,version_number,
         lifecycle_status,validation_status,road_load_type,created_at,updated_at
       ) VALUES(?,?,?,?,'active',?,1,'draft','pending',?,?,?)`,
    ).bind(
      deterministicId,
      organizationId,
      config.code,
      config.name,
      deterministicId,
      standardRoadWorkflowType(config.code),
      now,
      now,
    ).run();
    const definition = await findWorkflowDefinitionByCode(organizationId, config.code);
    if (!definition) failMissingWorkflowTemplate(config.code);
    templates.set(config.code, definition.id);
    if (definition.lifecycle_status !== "draft") continue;
    editableTemplates.push({ code: config.code, workflowId: definition.id });
    await env.DB.batch([
      ...config.steps.map(([key, name, entity, event, order, scope]) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          `${definition.id}:step:${key}`,
          definition.id,
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
    ]);
    const moduleStatements = standardRoadWorkflowModules.flatMap((module) => [
      env.DB.prepare(
        `INSERT OR IGNORE INTO workflow_step_modules(
           id,workflow_id,step_id,module_code,display_name,sort_order,is_required,is_active,
           responsibility_position_code,completion_mode,created_at,updated_at
         )
         SELECT ?,s.workflow_id,s.id,?,?,?,?,1,?,?,?,?
           FROM workflow_steps s
          WHERE s.workflow_id=? AND s.step_key=? AND s.is_active=1`,
      ).bind(
        `${definition.id}:module:${module.stepKey}:${module.moduleCode}`,
        module.moduleCode,
        module.displayName,
        module.sortOrder,
        module.required ? 1 : 0,
        module.responsibilityPositionCode,
        module.completionMode,
        now,
        now,
        definition.id,
        module.stepKey,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO workflow_module_tasks(
           id,workflow_id,step_module_id,task_key,name,task_type,sort_order,is_required,is_active,
           responsibility_position_code,instructions,created_at,updated_at
         )
         SELECT ?,m.workflow_id,m.id,?,?,?,10,?,1,?,?,?,?
           FROM workflow_step_modules m
           JOIN workflow_steps s ON s.id=m.step_id AND s.workflow_id=m.workflow_id
          WHERE m.workflow_id=? AND s.step_key=? AND m.module_code=? AND m.is_active=1`,
      ).bind(
        `${definition.id}:task:${module.stepKey}:${module.moduleCode}:${module.taskKey}`,
        module.taskKey,
        module.taskName,
        module.taskType,
        module.taskRequired ? 1 : 0,
        module.responsibilityPositionCode,
        module.instructions,
        now,
        now,
        definition.id,
        module.stepKey,
        module.moduleCode,
      ),
    ]);
    await env.DB.batch(moduleStatements);
  }

  const ltlWorkflowId = templates.get(workflowDefinitions.ltl.code);
  const ftlWorkflowId = templates.get(workflowDefinitions.ftl.code);
  const ftlIsEditable = editableTemplates.some((item) => item.code === workflowDefinitions.ftl.code);
  if (ltlWorkflowId && ftlWorkflowId && ftlIsEditable) {
    const ltlFields = await env.DB.prepare(
    `SELECT f.field_key,f.label,f.field_type,f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,
            COALESCE(f.module_code,'consignment') module_code,s.step_key
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
      module_code: OrderModuleCode;
      step_key: string;
    }>();
    if (ltlFields.results.length) {
      const copyStatements = ltlFields.results.map((field) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO workflow_step_fields(
            id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,sort_order,
            options_text,help_text,module_code,created_at,updated_at
          )
          SELECT ?,?,target.id,?,?,?,?,?,?,?,?,?,?,?
          FROM workflow_steps target
          WHERE target.workflow_id=? AND target.step_key=?`,
        ).bind(
          `${ftlWorkflowId}:copied:${field.step_key}:${field.field_key}`,
          ftlWorkflowId,
          field.field_key,
          field.label,
          field.field_type,
          field.is_required,
          field.is_active,
          field.sort_order,
          field.options_text,
          field.help_text,
          field.module_code,
          now,
          now,
          ftlWorkflowId,
          field.step_key,
        ),
      );
      await env.DB.batch(copyStatements);
    }
  }
  for (const template of editableTemplates) {
    await ensureDraftWorkflowCatalogFields({
      workflowId: template.workflowId,
      code: template.code,
      now,
    });
  }
  return templates;
}

export async function recordWorkflowEvent(input: RecordEventInput): Promise<string | null> {
  await ensureDefaultWorkflow(input.organizationId);
  let instance = await findInstance(input.organizationId, input);
  const definition =
    (instance ? { id: instance.workflow_id } : null) ??
    (input.workflowId
      ? await env.DB.prepare(
          `SELECT id FROM workflow_definitions
           WHERE id=? AND organization_id=? AND validation_status='valid'
             AND lifecycle_status IN ('published','retired')`,
        ).bind(input.workflowId, input.organizationId).first<Definition>()
      : null) ??
    (await env.DB.prepare(
      "SELECT id FROM workflow_definitions WHERE organization_id=? AND code='tms-default' AND status='active' AND lifecycle_status='published' AND validation_status='valid' LIMIT 1",
    ).bind(input.organizationId).first<Definition>()) ??
    (await env.DB.prepare(
      "SELECT id FROM workflow_definitions WHERE organization_id=? AND status='active' AND lifecycle_status='published' AND validation_status='valid' ORDER BY created_at LIMIT 1",
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
    await ensureWorkflowExecutionSnapshot({instanceId,workflowId:definition.id});
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
  let instance = await env.DB.prepare(
    `SELECT id,workflow_id,current_step_key
     FROM workflow_instances
     WHERE organization_id=? AND order_id=?
     LIMIT 1`,
  )
    .bind(input.organizationId, input.orderId)
    .first<Instance>();
  // Existing orders are version-frozen. A separate explicit migration action
  // is required before an order may use a newer published workflow version.
  let workflowId = instance?.workflow_id ??
    await ensureWorkflowForBusinessType(input.organizationId, order.business_type);
  const modules = (
    await env.DB.prepare(
      `SELECT module_code,enabled,is_required,status,current_step_code
       FROM order_module_instances
       WHERE organization_id=? AND order_id=?`,
    )
      .bind(input.organizationId, input.orderId)
      .all<ModuleSnapshot>()
  ).results;
  const targetStepKey = await resolveOrderBusinessStep(
    order.status,
    modules,
    {
      workflowId,
      instanceId: instance?.id ?? null,
      currentStepKey: instance?.current_step_key ?? null,
    },
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
    await ensureWorkflowExecutionSnapshot({instanceId,workflowId});
    const actualStepKey = await synchronizeWorkflowExecution({
      organizationId:input.organizationId,
      orderId:order.id,
      instanceId,
      workflowId,
      targetStepKey:targetStep.step_key,
      orderStatus:order.status,
    });
    return actualStepKey;
  }
  if (instance.workflow_id === workflowId) {
    const previousStepKey = instance.current_step_key;
    const actualStepKey = await synchronizeWorkflowExecution({
      organizationId:input.organizationId,
      orderId:order.id,
      instanceId:instance.id,
      workflowId,
      targetStepKey,
      orderStatus:order.status,
    });
    if (actualStepKey !== previousStepKey) {
      const actual = await env.DB.prepare(
        "SELECT name FROM workflow_steps WHERE workflow_id=? AND step_key=?",
      ).bind(workflowId,actualStepKey).first<{name:string}>();
      await env.DB.prepare(
        `INSERT INTO workflow_history(id,instance_id,step_key,step_name,actor_user_id,source,metadata,occurred_at)
         SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(
           SELECT 1 FROM workflow_history WHERE instance_id=? AND step_key=?
         )`,
      ).bind(
        crypto.randomUUID(),instance.id,actualStepKey,actual?.name||actualStepKey,
        input.actorUserId??null,input.source??"system",
        JSON.stringify({syncedFromExecutionSnapshot:true,orderStatus:order.status}),now,
        instance.id,actualStepKey,
      ).run();
    }
    return actualStepKey;
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

async function resolveOrderBusinessStep(
  status: string,
  modules: ModuleSnapshot[],
  workflow: {
    workflowId: string;
    instanceId: string | null;
    currentStepKey: string | null;
  },
) {
  if (status === "cancelled") return null;
  if (status === "draft") return "order_creation";
  if (status === "submitted") return "consignment_approval";
  if (status === "confirmed") return "task_assignment";
  if (status === "completed") return "completion_review";
  if (status !== "in_execution") return "order_creation";

  const placements = workflow.instanceId
    ? await env.DB.prepare(
        `SELECT ss.step_key,ss.sort_order,ms.module_code,
                ms.is_required module_required,ms.status module_state_status
           FROM workflow_instance_step_states ss
           JOIN workflow_instance_module_states ms
             ON ms.instance_step_state_id=ss.id
          WHERE ss.instance_id=?
          ORDER BY ss.sort_order,ms.sort_order,ms.id`,
      ).bind(workflow.instanceId).all<{
        step_key: string;
        sort_order: number;
        module_code: string;
        module_required: number;
        module_state_status: string;
      }>()
    : await env.DB.prepare(
        `SELECT s.step_key,s.sort_order,m.module_code,
                m.is_required module_required,NULL module_state_status
           FROM workflow_steps s
           JOIN workflow_step_modules m
             ON m.workflow_id=s.workflow_id AND m.step_id=s.id
          WHERE s.workflow_id=? AND s.is_active=1 AND m.is_active=1
          ORDER BY s.sort_order,m.sort_order,m.id`,
      ).bind(workflow.workflowId).all<{
        step_key: string;
        sort_order: number;
        module_code: string;
        module_required: number;
        module_state_status: null;
      }>();
  const configured = resolveConfiguredOrderBusinessTarget({
    modules,
    placements: placements.results,
    currentStepKey: workflow.currentStepKey,
  });
  if (configured.stepKey) return configured.stepKey;

  // Only a genuinely unbound legacy order may use the static stage map. A
  // bound instance with an unresolved frozen placement must remain blocked.
  if (workflow.instanceId) return null;
  const mainlineStages = orderBusinessStages.slice(2);
  const next = pickNextRequiredWorkflowModule(
    modules,
    mainlineStages.map((stage) => stage.modules),
  );
  if (!next) return "completion_review";
  return (
    mainlineStages.find((stage) =>
      stage.modules.includes(next.module_code),
    )?.code ?? "completion_review"
  );
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
