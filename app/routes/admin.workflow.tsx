import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.workflow";
import { canEditWorkflowDefinition, requireSessionUser } from "../lib/auth.server";
import {
  advanceWorkflowInstance,
  ensureDefaultWorkflow,
} from "../lib/business-workflow.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { Modal } from "../components/Modal";
import { orderModuleDefinitions, type OrderModuleCode } from "../lib/order-modules";
import {
  workflowFieldCatalog,
  workflowFieldCatalogByKey,
  workflowFieldModes,
  workflowFieldMode,
  workflowFieldModeFlags,
} from "../lib/workflow-field-catalog";

type Definition = {
  id: string;
  code: string;
  name: string;
  status: string;
  step_count: number;
  instance_count: number;
  updated_at: string;
};
type Step = {
  id: string;
  step_key: string;
  name: string;
  entity_type: string;
  trigger_event: string;
  sort_order: number;
  is_required: number;
  is_active: number;
  actor_scope: string;
};
type StepField = {
  id: string;
  step_id: string;
  field_key: string;
  label: string;
  field_type: string;
  is_required: number;
  is_active: number;
  sort_order: number;
  options_text: string | null;
  help_text: string | null;
  module_code: OrderModuleCode;
};
type Instance = {
  id: string;
  customer_name: string;
  quote_number: string | null;
  order_number: string | null;
  shipment_number: string | null;
  invoice_number: string | null;
  current_step_key: string;
  current_step_name: string;
  status: string;
  updated_at: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "workflow.view");
  const defaultWorkflowId = await ensureDefaultWorkflow(current.organizationId);
  const url = new URL(request.url);
  const requestedWorkflowId = url.searchParams.get("workflowId");

  const definitions = await env.DB.prepare(
    `SELECT wd.id,wd.code,wd.name,wd.status,wd.updated_at,
      COUNT(DISTINCT ws.id) step_count,
      COUNT(DISTINCT wi.id) instance_count
     FROM workflow_definitions wd
     LEFT JOIN workflow_steps ws ON ws.workflow_id=wd.id
     LEFT JOIN workflow_instances wi ON wi.workflow_id=wd.id
     WHERE wd.organization_id=?
     GROUP BY wd.id
     ORDER BY CASE wd.code WHEN 'tms-default' THEN 0 WHEN 'tms-ftl-standard' THEN 1 ELSE 2 END,wd.updated_at DESC`,
  )
    .bind(current.organizationId)
    .all<Definition>();

  const selected =
    definitions.results.find((item) => item.id === requestedWorkflowId) ??
    definitions.results.find((item) => item.id === defaultWorkflowId) ??
    definitions.results[0];
  const workflowId = selected.id;

  const [steps, fields, instances] = await Promise.all([
    env.DB.prepare(
      "SELECT id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope FROM workflow_steps WHERE workflow_id = ? ORDER BY sort_order, step_key",
    )
      .bind(workflowId)
      .all<Step>(),
    env.DB.prepare(
      "SELECT id, step_id, field_key, label, field_type, is_required, is_active, sort_order, options_text, help_text, COALESCE(module_code,'consignment') module_code FROM workflow_step_fields WHERE workflow_id=? ORDER BY sort_order, field_key",
    )
      .bind(workflowId)
      .all<StepField>(),
    env.DB.prepare(
      `SELECT wi.id,c.name AS customer_name,q.quote_number,o.order_number,s.shipment_number,i.invoice_number,
        wi.current_step_key,ws.name AS current_step_name,wi.status,wi.updated_at
       FROM workflow_instances wi JOIN customers c ON c.id=wi.customer_id
       JOIN workflow_steps ws ON ws.workflow_id=wi.workflow_id AND ws.step_key=wi.current_step_key
       LEFT JOIN quotations q ON q.id=wi.quotation_id LEFT JOIN transport_orders o ON o.id=wi.order_id
       LEFT JOIN shipments s ON s.id=wi.shipment_id LEFT JOIN invoices i ON i.id=wi.invoice_id
       WHERE wi.organization_id=? AND wi.workflow_id=? ORDER BY wi.updated_at DESC LIMIT 200`,
    )
      .bind(current.organizationId, workflowId)
      .all<Instance>(),
  ]);
  return {
    current,
    definitions: definitions.results,
    definition: selected,
    steps: steps.results,
    fields: fields.results,
    instances: instances.results,
    canEdit: canEditWorkflowDefinition(current),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "workflow.manage");
  const defaultWorkflowId = await ensureDefaultWorkflow(current.organizationId);
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  if (intent !== "advance" && !canEditWorkflowDefinition(current)) {
    throw new Response("只有老板或开发者可以修改业务工作流", { status: 403 });
  }
  const now = new Date().toISOString();
  const workflowId =
    valueOf(form, "workflowId") || new URL(request.url).searchParams.get("workflowId") || defaultWorkflowId;

  if (intent === "workflow_create") {
    const name = valueOf(form, "name").trim();
    const sourceWorkflowId = valueOf(form, "sourceWorkflowId");
    if (name.length < 2 || name.length > 60) return { formError: "工作流名称需为 2–60 个字符" };
    const id = crypto.randomUUID();
    const code = `wf-${Date.now().toString(36)}-${id.slice(0, 8)}`;
    await env.DB.prepare(
      "INSERT INTO workflow_definitions(id,organization_id,code,name,status,created_at,updated_at) VALUES(?,?,?,?, 'active', ?, ?)",
    )
      .bind(id, current.organizationId, code, name, now, now)
      .run();
    if (sourceWorkflowId) {
      const source = await env.DB.prepare(
        "SELECT id FROM workflow_definitions WHERE id=? AND organization_id=?",
      )
        .bind(sourceWorkflowId, current.organizationId)
        .first<{ id: string }>();
      if (!source) return { formError: "复制来源不存在" };
      await copyWorkflowStepsAndFields(sourceWorkflowId, id, now);
    }
    await writeAudit({
      request,
      action: "workflow.definition.create",
      resourceType: "workflow_definition",
      resourceId: id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { name, sourceWorkflowId: sourceWorkflowId || null },
    });
    return { success: `工作流“${name}”已创建` };
  }

  const definition = await env.DB.prepare(
    "SELECT id,code FROM workflow_definitions WHERE id=? AND organization_id=?",
  )
    .bind(workflowId, current.organizationId)
    .first<{ id: string; code: string }>();
  if (!definition) return { formError: "工作流不存在" };

  if (intent === "definition") {
    const name = valueOf(form, "name").trim();
    const status = valueOf(form, "status");
    if (name.length < 2 || name.length > 60 || !["active", "disabled"].includes(status))
      return { formError: "请填写有效的工作流名称和状态" };
    await env.DB.prepare(
      "UPDATE workflow_definitions SET name=?,status=?,updated_at=? WHERE id=? AND organization_id=?",
    )
      .bind(name, status, now, workflowId, current.organizationId)
      .run();
    return { success: "工作流已更新" };
  }

  if (intent === "create") {
    const name = valueOf(form, "name").trim();
    const entity = valueOf(form, "entityType");
    const scope = valueOf(form, "actorScope");
    const order = Number(valueOf(form, "sortOrder"));
    if (
      name.length < 1 ||
      name.length > 30 ||
      !Object.keys(entityLabels).includes(entity) ||
      !Object.keys(scopeLabels).includes(scope) ||
      !Number.isInteger(order) ||
      order < 1 ||
      order > 999
    )
      return { formError: "请填写有效的节点配置" };
    const id = crypto.randomUUID();
    const key = `custom_${id.replaceAll("-", "")}`;
    await env.DB.prepare(
      `INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,is_required,is_active,actor_scope,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,0,1,?,?,?)`,
    )
      .bind(id, workflowId, key, name, entity, `manual.${key}`, order, scope, now, now)
      .run();
    await writeAudit({
      request,
      action: "workflow.step.create",
      resourceType: "workflow_step",
      resourceId: id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { workflowId, key, name, entity, order, scope },
    });
    return { success: `节点“${name}”已新增` };
  }

  if (intent === "advance") {
    const instanceId = valueOf(form, "instanceId");
    try {
      const result = await advanceWorkflowInstance({
        organizationId: current.organizationId,
        instanceId,
        actorUserId: current.userId,
      });
      await writeAudit({
        request,
        action: "workflow.instance.advance",
        resourceType: "workflow_instance",
        resourceId: instanceId,
        organizationId: current.organizationId,
        actorUserId: current.userId,
        metadata: result,
      });
      return { success: `流程已推进至“${result.stepName}”` };
    } catch (error) {
      return { formError: error instanceof Error ? error.message : "流程推进失败" };
    }
  }

  if (intent === "delete") {
    const stepId = valueOf(form, "stepId");
    const step = await env.DB.prepare(
      "SELECT step_key,name FROM workflow_steps WHERE id=? AND workflow_id=?",
    )
      .bind(stepId, workflowId)
      .first<{ step_key: string; name: string }>();
    if (!step) return { formError: "流程节点不存在" };
    const used = await env.DB.prepare(
      `SELECT EXISTS(SELECT 1 FROM workflow_instances WHERE workflow_id=? AND current_step_key=?) OR EXISTS(
        SELECT 1 FROM workflow_history wh JOIN workflow_instances wi ON wi.id=wh.instance_id WHERE wi.workflow_id=? AND wh.step_key=?) AS used`,
    )
      .bind(workflowId, step.step_key, workflowId, step.step_key)
      .first<{ used: number }>();
    if (used?.used) return { formError: "该节点已有执行记录，只能停用，不能删除" };
    await env.DB.prepare("DELETE FROM workflow_steps WHERE id=? AND workflow_id=?")
      .bind(stepId, workflowId)
      .run();
    await writeAudit({
      request,
      action: "workflow.step.delete",
      resourceType: "workflow_step",
      resourceId: stepId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { workflowId, stepKey: step.step_key, name: step.name },
    });
    return { success: `节点“${step.name}”已删除` };
  }

  if (intent === "field_create") {
    const step = await ownedStep(workflowId, valueOf(form, "stepId"));
    if (!step) return { formError: "流程节点不存在" };
    const parsed = parseFieldForm(form);
    if ("formError" in parsed) return parsed;
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO workflow_step_fields(id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,sort_order,options_text,help_text,module_code,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id,
        workflowId,
        step.id,
        parsed.fieldKey,
        parsed.label,
        parsed.fieldType,
        parsed.required,
        parsed.active,
        parsed.sortOrder,
        parsed.optionsText,
        parsed.helpText,
        parsed.moduleCode,
        now,
        now,
      )
      .run();
    return { success: `字段“${parsed.label}”已新增` };
  }

  if (intent === "field_catalog_add") {
    const step = await ownedStep(workflowId, valueOf(form, "stepId"));
    const catalog = workflowFieldCatalogByKey.get(valueOf(form, "catalogFieldKey"));
    if (!step || !catalog || catalog.stepKey !== step.step_key)
      return { formError: "请选择属于当前节点的业务字段" };
    const exists = await env.DB.prepare(
      "SELECT id FROM workflow_step_fields WHERE workflow_id=? AND field_key=? AND COALESCE(module_code,?)=?",
    ).bind(workflowId, catalog.fieldKey, catalog.moduleCode, catalog.moduleCode).first<{ id: string }>();
    if (exists) return { formError: "该业务字段已经在当前工作流中" };
    const flags = workflowFieldModeFlags(catalog.defaultMode);
    await env.DB.prepare(
      `INSERT INTO workflow_step_fields(id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,sort_order,options_text,help_text,module_code,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(), workflowId, step.id, catalog.fieldKey, catalog.label,
      catalog.fieldType, flags.isRequired, flags.isActive,
      Number(valueOf(form, "fieldSortOrder")) || 10,
      catalog.optionsText ?? null, catalog.helpText, catalog.moduleCode, now, now,
    ).run();
    return { success: `业务字段“${catalog.label}”已加入` };
  }

  if (intent === "field_update") {
    const fieldId = valueOf(form, "fieldId");
    const field = await env.DB.prepare(
      "SELECT id FROM workflow_step_fields WHERE id=? AND workflow_id=?",
    )
      .bind(fieldId, workflowId)
      .first<{ id: string }>();
    if (!field) return { formError: "字段不存在" };
    const parsed = parseFieldForm(form);
    if ("formError" in parsed) return parsed;
    await env.DB.prepare(
      "UPDATE workflow_step_fields SET field_key=?,label=?,field_type=?,is_required=?,is_active=?,sort_order=?,options_text=?,help_text=?,module_code=?,updated_at=? WHERE id=? AND workflow_id=?",
    )
      .bind(
        parsed.fieldKey,
        parsed.label,
        parsed.fieldType,
        parsed.required,
        parsed.active,
        parsed.sortOrder,
        parsed.optionsText,
        parsed.helpText,
        parsed.moduleCode,
        now,
        fieldId,
        workflowId,
      )
      .run();
    return { success: `字段“${parsed.label}”已更新` };
  }

  if (intent === "field_delete") {
    const fieldId = valueOf(form, "fieldId");
    await env.DB.prepare("DELETE FROM workflow_step_fields WHERE id=? AND workflow_id=?")
      .bind(fieldId, workflowId)
      .run();
    return { success: "字段已删除" };
  }

  const stepId = valueOf(form, "stepId");
  const name = valueOf(form, "name").trim();
  const order = Number(valueOf(form, "sortOrder"));
  const entity = valueOf(form, "entityType");
  const scope = valueOf(form, "actorScope");
  if (
    !stepId ||
    name.length < 1 ||
    name.length > 30 ||
    !Number.isInteger(order) ||
    order < 1 ||
    order > 999 ||
    !Object.keys(entityLabels).includes(entity) ||
    !Object.keys(scopeLabels).includes(scope)
  )
    return { formError: "请填写有效的节点配置" };
  const owned = await ownedStep(workflowId, stepId);
  if (!owned) return { formError: "流程节点不存在" };
  const active = form.has("isActive") ? 1 : 0;
  await env.DB.prepare(
    "UPDATE workflow_steps SET name=?,entity_type=?,actor_scope=?,sort_order=?,is_active=?,updated_at=? WHERE id=? AND workflow_id=?",
  )
    .bind(name, entity, scope, order, active, now, stepId, workflowId)
    .run();
  await writeAudit({
    request,
    action: "workflow.step.update",
    resourceType: "workflow_step",
    resourceId: stepId,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata: { workflowId, stepKey: owned.step_key, name, order, active },
  });
  return { success: "流程节点已更新" };
}

async function copyWorkflowStepsAndFields(sourceWorkflowId: string, targetWorkflowId: string, now: string) {
  const sourceSteps = await env.DB.prepare(
    "SELECT id,step_key,name,entity_type,trigger_event,sort_order,is_active,actor_scope FROM workflow_steps WHERE workflow_id=? ORDER BY sort_order,step_key",
  )
    .bind(sourceWorkflowId)
    .all<Step>();
  const statements = [];
  const stepIdMap = new Map<string, string>();
  for (const step of sourceSteps.results) {
    const id = crypto.randomUUID();
    stepIdMap.set(step.id, id);
    statements.push(
      env.DB.prepare(
        `INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,is_required,is_active,actor_scope,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        targetWorkflowId,
        step.step_key,
        step.name,
        step.entity_type,
        step.trigger_event,
        step.sort_order,
        0,
        step.is_active,
        step.actor_scope,
        now,
        now,
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);

  const sourceFields = await env.DB.prepare(
    "SELECT step_id,field_key,label,field_type,is_required,is_active,sort_order,options_text,help_text,COALESCE(module_code,'consignment') module_code FROM workflow_step_fields WHERE workflow_id=? ORDER BY sort_order,field_key",
  )
    .bind(sourceWorkflowId)
    .all<Omit<StepField, "id">>();
  const fieldStatements = sourceFields.results
    .map((field) => {
      const targetStepId = stepIdMap.get(field.step_id);
      if (!targetStepId) return null;
      return env.DB.prepare(
        `INSERT INTO workflow_step_fields(id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,sort_order,options_text,help_text,module_code,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(),
        targetWorkflowId,
        targetStepId,
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
      );
    })
    .filter(Boolean) as D1PreparedStatement[];
  if (fieldStatements.length) await env.DB.batch(fieldStatements);
}

async function ownedStep(workflowId: string, stepId: string) {
  return env.DB.prepare("SELECT id,step_key FROM workflow_steps WHERE id=? AND workflow_id=?")
    .bind(stepId, workflowId)
    .first<{ id: string; step_key: string }>();
}

function parseFieldForm(form: FormData) {
  const label = valueOf(form, "label").trim();
  const rawKey = valueOf(form, "fieldKey").trim();
  const fieldKey = normalizeFieldKey(rawKey || label);
  const fieldType = valueOf(form, "fieldType");
  const moduleCode = valueOf(form, "moduleCode") as OrderModuleCode;
  const mode = valueOf(form, "fieldMode") || "optional";
  const flags = workflowFieldModeFlags(mode);
  const sortOrder = Number(valueOf(form, "fieldSortOrder"));
  if (
    label.length < 1 ||
    label.length > 40 ||
    fieldKey.length < 1 ||
    fieldKey.length > 60 ||
    !fieldTypeLabels[fieldType] ||
    !orderModuleDefinitions.some((module) => module.code === moduleCode) ||
    !Number.isInteger(sortOrder) ||
    sortOrder < 1 ||
    sortOrder > 999
  )
    return { formError: "请填写有效的字段名称、类型和排序" };
  return {
    label,
    fieldKey,
    fieldType,
    moduleCode,
    sortOrder,
    required: flags.isRequired,
    active: flags.isActive,
    optionsText: valueOf(form, "optionsText").trim() || null,
    helpText: valueOf(form, "helpText").trim() || null,
  };
}

function normalizeFieldKey(input: string) {
  const key = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || `field_${Date.now().toString(36)}`;
}

const entityLabels: Record<string, string> = {
  customer: "客户",
  quote: "报价",
  order: "订单",
  shipment: "运单",
  invoice: "账单",
};
const scopeLabels: Record<string, string> = {
  admin: "后台",
  portal: "客户门户",
  system: "系统",
};
function workflowTypeLabel(code: string) {
  if (code === "tms-default") return "拼车型标准流程";
  if (code === "tms-ftl-standard") return "整车型标准流程";
  return code;
}
const fieldTypeLabels: Record<string, string> = {
  text: "文本",
  textarea: "长文本",
  number: "数字",
  date: "日期",
  datetime: "日期时间",
  amount: "金额",
  select: "单选",
  multiselect: "多选",
  attachment: "附件",
  customer: "客户",
  supplier: "供应商",
  vehicle: "车辆",
  driver: "司机",
  warehouse: "仓库",
  border_port: "口岸",
};
const moduleLabels = Object.fromEntries(
  orderModuleDefinitions.map((module) => [module.code, module.name]),
) as Record<OrderModuleCode, string>;

export default function Workflow({ loaderData, actionData }: Route.ComponentProps) {
  const manage = loaderData.current.permissions.includes("workflow.manage") && loaderData.canEdit;
  const busy = useNavigation().state !== "idle";
  const activeSteps = loaderData.steps.filter((step) => step.is_active);
  const successMessage = actionData && "success" in actionData ? actionData.success : null;
  const formError = actionData && "formError" in actionData ? actionData.formError : null;
  const fieldsByStep = new Map<string, StepField[]>();
  for (const field of loaderData.fields) {
    const list = fieldsByStep.get(field.step_id) ?? [];
    list.push(field);
    fieldsByStep.set(field.step_id, list);
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">ROAD ORDER WORKFLOW</p>
          <h1>业务工作流</h1>
          <p>以运输订单主流程为准，管理可复制的工作流模板、节点和节点字段。</p>
        </div>
        <div className="page-actions">
          <span className="status-pill">{loaderData.definitions.length} 个模板</span>
          {manage && (
            <Modal title="新建工作流" triggerLabel="新建工作流" closeSignal={successMessage}>
              <Form method="post" className="stack">
                <input type="hidden" name="intent" value="workflow_create" />
                <label className="field">
                  <span>工作流名称</span>
                  <input name="name" placeholder="例如：霍尔果斯-阿拉木图流程" required />
                </label>
                <label className="field">
                  <span>从现有工作流复制</span>
                  <select name="sourceWorkflowId" defaultValue={loaderData.definition.id}>
                    <option value="">空白创建</option>
                    {loaderData.definitions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="field-hint">复制会带上节点和字段配置，不会带上订单实例。</p>
                <button className="primary" disabled={busy}>
                  创建工作流
                </button>
              </Form>
            </Modal>
          )}
        </div>
      </header>
      {(successMessage || formError) && (
        <div className={`alert ${formError ? "error" : "success"}`}>
          {formError ?? successMessage}
        </div>
      )}

      <section className="panel workflow-template-panel">
        <div className="panel-header">
          <div>
            <h2>工作流模板</h2>
            <p>选择一个模板后，在下方配置节点和字段。新订单后续可按模板生成订单流程。</p>
          </div>
        </div>
        <div className="workflow-template-list">
          {loaderData.definitions.map((item) => (
            <Link
              key={item.id}
              to={`/admin/workflow?workflowId=${encodeURIComponent(item.id)}`}
              className={item.id === loaderData.definition.id ? "active" : ""}
            >
              <strong>{item.name}</strong>
              <small>
                {workflowTypeLabel(item.code)} · {item.step_count} 个节点 · {item.instance_count} 个订单
              </small>
            </Link>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>{loaderData.definition.name}</h2>
            <p>{loaderData.definition.instance_count > 0 ? "已有订单使用该模板；已执行节点不能删除，只能停用。" : "该模板尚未被订单使用，可自由调整节点。"}</p>
          </div>
          <div className="page-actions">
            <span className={`status-pill ${loaderData.definition.status !== "active" ? "off" : ""}`}>
              {loaderData.definition.status === "active" ? "启用" : "停用"}
            </span>
            {manage && (
              <Modal title="新增流程节点" triggerLabel="新增节点" triggerClassName="secondary" closeSignal={successMessage}>
                <NodeCreateForm workflowId={loaderData.definition.id} activeSteps={activeSteps} busy={busy} />
              </Modal>
            )}
            {manage && (
              <Modal title={`节点配置 · ${loaderData.definition.name}`} triggerLabel="节点配置" triggerClassName="secondary" size="xwide">
                <NodeConfigDialog
                  workflowId={loaderData.definition.id}
                  steps={loaderData.steps}
                  fieldsByStep={fieldsByStep}
                  manage={manage}
                  busy={busy}
                  closeSignal={successMessage}
                />
              </Modal>
            )}
          </div>
        </div>
        {manage && <DefinitionForm definition={loaderData.definition} busy={busy} />}
        <div className="workflow-track">
          {activeSteps.map((step, index) => (
            <div className="workflow-node" key={step.id}>
              <span>{index + 1}</span>
              <strong>{step.name}</strong>
              <small>{scopeLabels[step.actor_scope]}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>订单流程实例</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>客户</th>
                <th>报价</th>
                <th>订单</th>
                <th>运单</th>
                <th>账单</th>
                <th>当前节点</th>
                <th>更新时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loaderData.instances.map((row) => {
                const current = activeSteps.find((step) => step.step_key === row.current_step_key);
                const next = activeSteps.find((step) => (current?.sort_order ?? -1) < step.sort_order);
                return (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.customer_name}</strong>
                    </td>
                    <td>{row.quote_number || "—"}</td>
                    <td>{row.order_number || "—"}</td>
                    <td>{row.shipment_number || "—"}</td>
                    <td>{row.invoice_number || "—"}</td>
                    <td>
                      <span className={`status-pill ${row.status === "cancelled" ? "off" : ""}`}>
                        {row.current_step_name}
                      </span>
                      {next && !next.is_required && <small>下一步：{next.name}（人工）</small>}
                    </td>
                    <td>{new Date(row.updated_at).toLocaleString("zh-CN")}</td>
                    <td>
                      {manage && row.status === "active" && next && !next.is_required && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="advance" />
                          <input type="hidden" name="workflowId" value={loaderData.definition.id} />
                          <input type="hidden" name="instanceId" value={row.id} />
                          <button className="text-button" disabled={busy}>
                            推进
                          </button>
                        </Form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loaderData.instances.length && <p className="empty-state">该模板还没有订单实例。</p>}
      </section>
    </>
  );
}

function DefinitionForm({ definition, busy }: { definition: Definition; busy: boolean }) {
  return (
    <Form method="post" className="workflow-definition-form">
      <input type="hidden" name="intent" value="definition" />
      <input type="hidden" name="workflowId" value={definition.id} />
      <label className="field grow">
        <span>流程名称</span>
        <input name="name" defaultValue={definition.name} required />
      </label>
      <label className="field compact">
        <span>状态</span>
        <select name="status" defaultValue={definition.status}>
          <option value="active">启用</option>
          <option value="disabled">停用</option>
        </select>
      </label>
      <button className="secondary" disabled={busy}>
        保存模板
      </button>
    </Form>
  );
}

function NodeConfigDialog({
  workflowId,
  steps,
  fieldsByStep,
  manage,
  busy,
  closeSignal,
}: {
  workflowId: string;
  steps: Step[];
  fieldsByStep: Map<string, StepField[]>;
  manage: boolean;
  busy: boolean;
  closeSignal?: unknown;
}) {
  return (
    <div className="workflow-config-dialog">
      <div className="workflow-config-dialog-header">
        <div>
          <strong>节点与字段</strong>
          <span>展开一个节点后，可以维护基础信息、必填字段、选填字段和字段表。</span>
        </div>
        <small>已有执行记录的节点不能物理删除，只能停用。</small>
      </div>
      <div className="workflow-node-config-list">
        {steps.map((step) => (
          <details className="workflow-node-config" key={step.id}>
            <summary>
              <span>{step.sort_order}</span>
              <strong>{step.name}</strong>
              <small>
                {step.is_active ? "启用" : "停用"} · {fieldsByStep.get(step.id)?.length ?? 0} 个字段
              </small>
            </summary>
            {manage ? (
              <NodeEditForm workflowId={workflowId} step={step} busy={busy} />
            ) : (
              <p className="empty-state">当前账号没有配置权限。</p>
            )}
            <FieldList
              workflowId={workflowId}
              step={step}
              fields={fieldsByStep.get(step.id) ?? []}
              manage={manage}
              busy={busy}
              closeSignal={closeSignal}
            />
          </details>
        ))}
      </div>
    </div>
  );
}

function NodeCreateForm({
  workflowId,
  activeSteps,
  busy,
}: {
  workflowId: string;
  activeSteps: Step[];
  busy: boolean;
}) {
  return (
    <Form method="post" className="stack">
      <input type="hidden" name="intent" value="create" />
      <input type="hidden" name="workflowId" value={workflowId} />
      <label className="field">
        <span>节点名称</span>
        <input name="name" placeholder="例如：过关、边检查验、客户确认" required />
      </label>
      <Select name="entityType" label="所属业务" items={Object.entries(entityLabels)} value="order" />
      <Select name="actorScope" label="执行角色" items={Object.entries(scopeLabels)} value="admin" />
      <label className="field">
        <span>流程顺序</span>
        <input name="sortOrder" type="number" min="1" max="999" defaultValue={(activeSteps.at(-1)?.sort_order ?? 0) + 10} required />
      </label>
      <p className="field-hint">新增节点会加入当前选中的工作流模板。</p>
      <button className="primary" disabled={busy}>
        新增节点
      </button>
    </Form>
  );
}

function NodeEditForm({ workflowId, step, busy }: { workflowId: string; step: Step; busy: boolean }) {
  return (
    <Form method="post" className="workflow-node-edit-form">
      <input type="hidden" name="workflowId" value={workflowId} />
      <input type="hidden" name="stepId" value={step.id} />
      <label className="field">
        <span>显示名称</span>
        <input name="name" defaultValue={step.name} required />
      </label>
      <Select name="entityType" label="所属业务" items={Object.entries(entityLabels)} value={step.entity_type} />
      <Select name="actorScope" label="执行角色" items={Object.entries(scopeLabels)} value={step.actor_scope} />
      <label className="field compact">
        <span>顺序</span>
        <input name="sortOrder" type="number" min="1" max="999" defaultValue={step.sort_order} required />
      </label>
      <label className="check-field">
        <input name="isActive" type="checkbox" defaultChecked={Boolean(step.is_active)} />
        启用
      </label>
      <div className="button-row">
        <button className="secondary" name="intent" value="step" disabled={busy}>
          保存节点
        </button>
        <button className="text-button danger" name="intent" value="delete" formNoValidate disabled={busy}>
          删除节点
        </button>
      </div>
    </Form>
  );
}

function FieldList({
  workflowId,
  step,
  fields,
  manage,
  busy,
  closeSignal,
}: {
  workflowId: string;
  step: Step;
  fields: StepField[];
  manage: boolean;
  busy: boolean;
  closeSignal?: unknown;
}) {
  const fieldGroupDescriptions = {
    required: "未填写时阻止当前节点提交。",
    optional: "业务需要时填写，不影响当前节点提交。",
    hidden: "保留字段配置，但业务页面不显示。",
  } as const;
  const fieldGroupMarks = {
    required: "必",
    optional: "选",
    hidden: "隐",
  } as const;
  const fieldGroups = workflowFieldModes.map((mode) => ({
    ...mode,
    fields: fields.filter((field) => workflowFieldMode(field) === mode.value),
  }));

  return (
    <div className="workflow-field-config">
      <div className="workflow-field-config-heading">
        <div>
          <h3>字段填写规则</h3>
          <p>字段按业务页面中的填写要求分类，点击“编辑”可调整所属分组。</p>
        </div>
        <strong>{fields.length} 个字段</strong>
      </div>
      <div className="workflow-field-groups">
        {fieldGroups.map((group) => (
          <section
            className={`workflow-field-group workflow-field-group-${group.value}`}
            key={group.value}
            aria-labelledby={`${step.id}-${group.value}-title`}
          >
            <header className="workflow-field-group-header">
              <span className="workflow-field-group-mark" aria-hidden="true">
                {fieldGroupMarks[group.value]}
              </span>
              <div>
                <h4 id={`${step.id}-${group.value}-title`}>{group.label}</h4>
                <p>{fieldGroupDescriptions[group.value]}</p>
              </div>
              <strong>{group.fields.length} 项</strong>
            </header>
            {group.fields.length ? (
              <div className="workflow-field-group-list">
                {group.fields.map((field) => {
                  const source = workflowFieldCatalogByKey.get(field.field_key)?.requirementSource;
                  return (
                    <div className="workflow-field-row" key={field.id}>
                      <span className="workflow-field-order">{field.sort_order}</span>
                      <div className="workflow-field-name">
                        <strong>{field.label}</strong>
                        <small>{field.field_key}</small>
                      </div>
                      <div className="workflow-field-meta">
                        <span>{fieldTypeLabels[field.field_type]}</span>
                        <span>{moduleLabels[field.module_code]}</span>
                        <span>
                          {source === "legacy_required"
                            ? "旧系统必填基线"
                            : workflowFieldCatalogByKey.has(field.field_key)
                              ? "新系统字段"
                              : "自定义字段"}
                        </span>
                      </div>
                      <p className="workflow-field-help">{field.help_text || "暂无说明"}</p>
                      {manage && (
                        <Modal
                          title={`编辑字段 · ${field.label}`}
                          triggerLabel="编辑"
                          triggerClassName="text-button"
                          size="wide"
                          closeSignal={closeSignal}
                        >
                          <FieldForm workflowId={workflowId} stepId={step.id} field={field} busy={busy} />
                        </Modal>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="workflow-field-group-empty">该分组暂无字段</p>
            )}
          </section>
        ))}
      </div>
      {!fields.length && <p className="empty-state">该节点暂未配置字段。</p>}
      {manage && (
        <div className="workflow-field-actions">
          <Modal title={`从字段库添加 · ${step.name}`} triggerLabel="从字段库添加" triggerClassName="secondary" size="wide" closeSignal={closeSignal}>
            <CatalogFieldForm workflowId={workflowId} step={step} fields={fields} busy={busy} nextSort={(fields.at(-1)?.sort_order ?? 0) + 10} />
          </Modal>
          <Modal title={`新增字段 · ${step.name}`} triggerLabel="新增自定义字段" triggerClassName="secondary" size="wide" closeSignal={closeSignal}>
            <FieldForm workflowId={workflowId} stepId={step.id} busy={busy} nextSort={(fields.at(-1)?.sort_order ?? 0) + 10} />
          </Modal>
        </div>
      )}
    </div>
  );
}

function FieldForm({
  workflowId,
  stepId,
  field,
  busy,
  nextSort = 10,
}: {
  workflowId: string;
  stepId: string;
  field?: StepField;
  busy: boolean;
  nextSort?: number;
}) {
  const editing = Boolean(field);
  return (
    <Form method="post" className="workflow-field-form workflow-field-modal-form">
      <input type="hidden" name="intent" value={editing ? "field_update" : "field_create"} />
      <input type="hidden" name="workflowId" value={workflowId} />
      <input type="hidden" name="stepId" value={stepId} />
      {field && <input type="hidden" name="fieldId" value={field.id} />}
      <label className="field">
        <span>字段名称</span>
        <input name="label" defaultValue={field?.label} placeholder="例如：过关文件" required />
      </label>
      <label className="field">
        <span>字段编码</span>
        <input name="fieldKey" defaultValue={field?.field_key} placeholder="例如：customs_clearance_file" />
      </label>
      <Select name="fieldType" label="字段类型" items={Object.entries(fieldTypeLabels)} value={field?.field_type ?? "text"} />
      <label className="field compact">
        <span>排序</span>
        <input name="fieldSortOrder" type="number" min="1" max="999" defaultValue={field?.sort_order ?? nextSort} required />
      </label>
      <Select name="moduleCode" label="所属业务模块" items={Object.entries(moduleLabels)} value={field?.module_code ?? "consignment"} />
      <Select
        name="fieldMode"
        label="填写规则"
        items={workflowFieldModes.map((item) => [item.value, item.label])}
        value={field ? workflowFieldMode(field) : "optional"}
      />
      <label className="check-field" style={{ display: "none" }}>
        <input name="fieldRequired" type="checkbox" defaultChecked={Boolean(field?.is_required)} />
        必填
      </label>
      {editing && (
        <label className="check-field" style={{ display: "none" }}>
          <input name="isActive" type="checkbox" defaultChecked={Boolean(field?.is_active)} />
          启用
        </label>
      )}
      <label className="field span-2">
        <span>选项</span>
        <input name="optionsText" defaultValue={field?.options_text ?? ""} placeholder="单选/多选可用，一行或逗号分隔一个选项" />
      </label>
      <label className="field span-2">
        <span>说明</span>
        <input name="helpText" defaultValue={field?.help_text ?? ""} placeholder="告诉使用者这个字段应该填什么" />
      </label>
      <div className="button-row span-2">
        <button className="secondary" disabled={busy}>
          {editing ? "保存字段" : "新增字段"}
        </button>
        {editing && (
          <button className="text-button danger" name="intent" value="field_delete" formNoValidate disabled={busy}>
            删除字段
          </button>
        )}
      </div>
    </Form>
  );
}

function CatalogFieldForm({
  workflowId,
  step,
  fields,
  busy,
  nextSort,
}: {
  workflowId: string;
  step: Step;
  fields: StepField[];
  busy: boolean;
  nextSort: number;
}) {
  const existing = new Set(fields.map((field) => field.field_key));
  const choices = workflowFieldCatalog.filter(
    (field) => field.stepKey === step.step_key && !existing.has(field.fieldKey),
  );
  if (!choices.length) return <p className="empty-state">当前节点的标准业务字段已经全部加入。</p>;
  return (
    <Form method="post" className="workflow-field-form workflow-field-modal-form">
      <input type="hidden" name="intent" value="field_catalog_add" />
      <input type="hidden" name="workflowId" value={workflowId} />
      <input type="hidden" name="stepId" value={step.id} />
      <label className="field span-2">
        <span>业务字段积木</span>
        <select name="catalogFieldKey" required defaultValue="">
          <option value="">请选择字段</option>
          {choices.map((field) => (
            <option key={`${field.moduleCode}:${field.fieldKey}`} value={field.fieldKey}>
              {moduleLabels[field.moduleCode]} · {field.label} · {workflowFieldModes.find((item) => item.value === field.defaultMode)?.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field compact">
        <span>排序</span>
        <input name="fieldSortOrder" type="number" min="1" max="999" defaultValue={nextSort} required />
      </label>
      <button className="secondary" disabled={busy}>加入当前节点</button>
    </Form>
  );
}

function Select({
  name,
  label,
  items,
  value,
}: {
  name: string;
  label: string;
  items: [string, string][];
  value?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={value} required>
        {items.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}

export function meta() {
  return [{ title: "业务工作流 | International TMS" }];
}
