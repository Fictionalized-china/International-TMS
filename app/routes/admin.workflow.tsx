import { env } from "cloudflare:workers";
import { Form, Link, redirect, useNavigation } from "react-router";
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
import {
  releaseHiddenWorkflowFieldData,
  synchronizeWorkflowFieldDefinitionForInstances,
} from "../lib/workflow-fields.server";
import { ensureWorkflowExecutionSnapshot } from "../lib/workflow-execution.server";
import {
  editableWorkflowFieldFlags,
  editableWorkflowFieldMode,
  normalizedWorkflowSortOrders,
  parseWorkflowSortOrder,
  workflowEditCapabilities,
  workflowInsertionSortOrder,
  workflowIntentAllowedForUsage,
} from "../lib/workflow-edit-policy";

type Definition = {
  id: string;
  code: string;
  name: string;
  status: string;
  step_count: number;
  instance_count: number;
  updated_at: string;
  template_family_id: string;
  version_number: number;
  lifecycle_status: "draft" | "published" | "retired";
  validation_status: "pending" | "valid" | "invalid";
  validation_message: string | null;
  published_at: string | null;
  road_load_type: "ltl" | "ftl";
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
type StepModule = {
  id: string;
  step_id: string;
  module_code: OrderModuleCode;
  display_name: string;
  sort_order: number;
  is_required: number;
  is_active: number;
  responsibility_position_code: string | null;
  activation_condition: string | null;
  completion_mode: "all_tasks" | "manual_confirm" | "automatic";
};
type ModuleTask = {
  id: string;
  step_module_id: string;
  task_key: string;
  name: string;
  task_type: "form" | "review" | "decision" | "system";
  sort_order: number;
  is_required: number;
  is_active: number;
  responsibility_position_code: string | null;
  instructions: string | null;
};
type PositionOption = { code: string; name: string; department_name: string | null };
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
      wd.template_family_id,wd.version_number,wd.lifecycle_status,wd.validation_status,
      wd.validation_message,wd.published_at,wd.road_load_type,
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

  const [steps, fields, stepModules, moduleTasks, positions, instances] = await Promise.all([
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
      `SELECT id,step_id,module_code,display_name,sort_order,is_required,is_active,
        responsibility_position_code,activation_condition,completion_mode
       FROM workflow_step_modules WHERE workflow_id=? ORDER BY step_id,sort_order,module_code`,
    ).bind(workflowId).all<StepModule>(),
    env.DB.prepare(
      `SELECT id,step_module_id,task_key,name,task_type,sort_order,is_required,is_active,
        responsibility_position_code,instructions
       FROM workflow_module_tasks WHERE workflow_id=? ORDER BY step_module_id,sort_order,task_key`,
    ).bind(workflowId).all<ModuleTask>(),
    env.DB.prepare(
      `SELECT p.code,p.name,d.name department_name
       FROM positions p LEFT JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code
       WHERE p.organization_id=? AND p.status='active' ORDER BY p.sort_order,p.name`,
    ).bind(current.organizationId).all<PositionOption>(),
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
    stepModules: stepModules.results,
    moduleTasks: moduleTasks.results,
    positions: positions.results,
    validationIssues: validateWorkflowConfiguration(
      steps.results,
      stepModules.results,
      moduleTasks.results,
    ),
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
    const roadLoadType = valueOf(form,"roadLoadType");
    if (name.length < 2 || name.length > 60) return { formError: "工作流名称需为 2–60 个字符" };
    if (!["ltl","ftl"].includes(roadLoadType)) return { formError: "请选择拼车型或整车型" };
    const source = sourceWorkflowId
      ? await env.DB.prepare(
          "SELECT id,road_load_type FROM workflow_definitions WHERE id=? AND organization_id=?",
        ).bind(sourceWorkflowId,current.organizationId).first<{id:string;road_load_type:string}>()
      : null;
    if (sourceWorkflowId && !source) return { formError: "复制来源不存在" };
    if (source && source.road_load_type !== roadLoadType)
      return { formError: "复制来源与新模板的整车/拼车类型必须一致" };
    const id = crypto.randomUUID();
    const code = `wf-${Date.now().toString(36)}-${id.slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO workflow_definitions(
        id,organization_id,code,name,status,template_family_id,version_number,lifecycle_status,
        based_on_workflow_id,validation_status,road_load_type,created_at,updated_at
       ) VALUES(?,?,?,?, 'active', ?,1,'draft',?,'pending',?,?,?)`,
    )
      .bind(id, current.organizationId, code, name, id, sourceWorkflowId || null, roadLoadType, now, now)
      .run();
    if (sourceWorkflowId) {
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
    throw redirect(`/admin/workflow?workflowId=${encodeURIComponent(id)}`);
  }

  const definition = await env.DB.prepare(
    `SELECT wd.id,wd.code,wd.name,wd.status,wd.template_family_id,wd.version_number,
       wd.lifecycle_status,wd.road_load_type,
       (SELECT COUNT(*) FROM workflow_instances wi WHERE wi.workflow_id=wd.id) instance_count
     FROM workflow_definitions wd WHERE wd.id=? AND wd.organization_id=?`,
  )
    .bind(workflowId, current.organizationId)
    .first<{
      id: string;
      code: string;
      name: string;
      status: string;
      template_family_id: string;
      version_number: number;
      lifecycle_status: string;
      road_load_type: string;
      instance_count: number;
    }>();
  if (!definition) return { formError: "工作流不存在" };

  if (intent === "version_create") {
    const nextVersion = await env.DB.prepare(
      "SELECT COALESCE(MAX(version_number),0)+1 next_version FROM workflow_definitions WHERE organization_id=? AND template_family_id=?",
    ).bind(current.organizationId, definition.template_family_id).first<{ next_version: number }>();
    const version = nextVersion?.next_version ?? definition.version_number + 1;
    const id = crypto.randomUUID();
    const code = `${definition.code.replace(/-v\d+$/, "")}-v${version}`;
    await env.DB.prepare(
      `INSERT INTO workflow_definitions(
        id,organization_id,code,name,status,template_family_id,version_number,lifecycle_status,
        based_on_workflow_id,validation_status,road_load_type,created_at,updated_at
       ) VALUES(?,?,?,?, 'active', ?,?,'draft',?,'pending',?,?,?)`,
    ).bind(
      id,current.organizationId,code,definition.name,definition.template_family_id,
      version,definition.id,definition.road_load_type,now,now,
    ).run();
    await copyWorkflowStepsAndFields(definition.id, id, now);
    throw redirect(`/admin/workflow?workflowId=${encodeURIComponent(id)}`);
  }

  if (intent === "validate" || intent === "publish") {
    if (definition.lifecycle_status !== "draft") return { formError: "只有草稿版本可以校验或发布" };
    const issues = await loadWorkflowValidationIssues(definition.id);
    const validationStatus = issues.length ? "invalid" : "valid";
    await env.DB.prepare(
      "UPDATE workflow_definitions SET validation_status=?,validation_message=?,updated_at=? WHERE id=? AND organization_id=?",
    ).bind(validationStatus, issues.join("\n") || null, now, definition.id, current.organizationId).run();
    if (issues.length) return { formError: `发布校验未通过：${issues.join("；")}` };
    if (intent === "validate") return { success: "校验通过，可以进入模拟预览或正式发布" };
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workflow_definitions SET lifecycle_status='retired',status='disabled',updated_at=?
         WHERE organization_id=? AND template_family_id=? AND lifecycle_status='published' AND id<>?`,
      ).bind(now,current.organizationId,definition.template_family_id,definition.id),
      env.DB.prepare(
        `UPDATE workflow_definitions SET lifecycle_status='published',status='active',validation_status='valid',
          published_at=?,published_by_user_id=?,updated_at=? WHERE id=? AND organization_id=?`,
      ).bind(now,current.userId,now,definition.id,current.organizationId),
    ]);
    return { success: `工作流 v${definition.version_number} 已发布；旧订单继续使用原版本` };
  }

  if (intent === "field_mode_update") {
    const fieldId = valueOf(form, "fieldId");
    const mode = editableWorkflowFieldMode(valueOf(form, "fieldMode"));
    if (!mode) return { formError: "字段规则只能设置为必填、选填或隐藏" };
    const field = await env.DB.prepare(
      `SELECT f.id,f.step_id,s.step_key,f.field_key,f.label,f.field_type,f.is_active,f.sort_order,
        f.options_text,f.help_text,COALESCE(f.module_code,'consignment') module_code
       FROM workflow_step_fields f JOIN workflow_steps s ON s.id=f.step_id
       WHERE f.id=? AND f.workflow_id=?`,
    )
      .bind(fieldId, workflowId)
      .first<{
        id: string;
        step_id: string;
        step_key: string;
        field_key: string;
        label: string;
        field_type: string;
        is_active: number;
        sort_order: number;
        options_text: string | null;
        help_text: string | null;
        module_code: OrderModuleCode;
    }>();
    if (!field) return { formError: "字段不存在" };
    const flags = editableWorkflowFieldFlags(mode);
    await env.DB.prepare(
      "UPDATE workflow_step_fields SET is_required=?,is_active=?,updated_at=? WHERE id=? AND workflow_id=?",
    )
      .bind(flags.isRequired, flags.isActive, now, field.id, workflowId)
      .run();
    await synchronizeWorkflowFieldDefinitionForInstances({
      workflowId,
      stepKey: field.step_key,
      fieldKey: field.field_key,
      moduleCode: field.module_code,
      label: field.label,
      fieldType: field.field_type,
      isRequired: flags.isRequired,
      isActive: flags.isActive,
      sortOrder: field.sort_order,
      optionsText: field.options_text,
      helpText: field.help_text,
    });
    if (flags.isActive) {
      await ensureFieldPolicyModule(workflowId, field.step_id, field.module_code, flags.isRequired, now);
    }
    await reconcileFieldPolicyModule(workflowId, field.step_id, field.module_code, now);
    const released = flags.releasesStoredValue
      ? await releaseHiddenWorkflowFieldData({
          organizationId: current.organizationId,
          workflowId,
          fieldKey: field.field_key,
          moduleCode: field.module_code,
        })
      : null;
    await writeAudit({
      request,
      action: "workflow.field.requirement.update",
      resourceType: "workflow_step_field",
      resourceId: field.id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: {
        workflowId,
        lifecycleStatus: definition.lifecycle_status,
        fieldKey: field.field_key,
        mode,
        released,
      },
    });
    const releasedText = released && (released.releasedFiles || released.releasedCustomValues)
      ? `；已释放 ${released.releasedFiles} 个文件、${released.releasedCustomValues} 条自定义值`
      : "";
    const modeLabel = mode === "required" ? "必填" : mode === "optional" ? "选填" : "隐藏";
    return { success: `字段“${field.label}”已设为${modeLabel}，现有订单后续门禁已同步${releasedText}` };
  }

  if (!workflowIntentAllowedForUsage(intent, definition.instance_count) && intent !== "advance") {
    return { formError: "该工作流已被订单使用，只能调整字段为必填、选填或隐藏；不能增删节点、模组和办理步骤" };
  }

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
    if (
      name.length < 1 ||
      name.length > 30 ||
      !Object.keys(entityLabels).includes(entity) ||
      !Object.keys(scopeLabels).includes(scope)
    )
      return { formError: "请填写有效的节点配置" };
    const orderedSteps = await env.DB.prepare(
      "SELECT id,sort_order FROM workflow_steps WHERE workflow_id=? AND is_active=1 ORDER BY sort_order,id",
    ).bind(workflowId).all<{ id: string; sort_order: number }>();
    const insertAfterStepId = valueOf(form, "insertAfterStepId");
    const afterIndex = insertAfterStepId
      ? orderedSteps.results.findIndex((item) => item.id === insertAfterStepId)
      : orderedSteps.results.length - 1;
    if (insertAfterStepId && afterIndex < 0) return { formError: "插入位置不属于当前工作流" };
    let previous = afterIndex >= 0 ? orderedSteps.results[afterIndex]?.sort_order ?? null : null;
    let next = orderedSteps.results[afterIndex + 1]?.sort_order ?? null;
    let order = workflowInsertionSortOrder(previous, next);
    if (order === null) {
      const normalized = normalizedWorkflowSortOrders(orderedSteps.results.length);
      await env.DB.batch(orderedSteps.results.map((item, index) =>
        env.DB.prepare("UPDATE workflow_steps SET sort_order=?,updated_at=? WHERE id=? AND workflow_id=?")
          .bind(normalized[index], now, item.id, workflowId),
      ));
      previous = afterIndex >= 0 ? normalized[afterIndex] ?? null : null;
      next = normalized[afterIndex + 1] ?? null;
      order = workflowInsertionSortOrder(previous, next);
    }
    if (order === null) return { formError: "节点顺序已达到上限，请先调整现有节点" };
    const id = crypto.randomUUID();
    const key = `custom_${id.replaceAll("-", "")}`;
    const activeCount = await env.DB.prepare(
      "SELECT COUNT(*) count FROM workflow_steps WHERE workflow_id=? AND is_active=1",
    ).bind(workflowId).first<{ count: number }>();
    const triggerEvent = activeCount?.count ? `manual.${key}` : "order.created";
    await env.DB.prepare(
      `INSERT INTO workflow_steps(id,workflow_id,step_key,name,entity_type,trigger_event,sort_order,is_required,is_active,actor_scope,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,0,1,?,?,?)`,
    )
      .bind(id, workflowId, key, name, entity, triggerEvent, order, scope, now, now)
      .run();
    await writeAudit({
      request,
      action: "workflow.step.create",
      resourceType: "workflow_step",
      resourceId: id,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { workflowId, key, name, entity, order, scope, insertAfterStepId: insertAfterStepId || null },
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
    if (parsed.active) {
      await ensureFieldPolicyModule(workflowId, step.id, parsed.moduleCode, parsed.required, now);
    }
    await reconcileFieldPolicyModule(workflowId, step.id, parsed.moduleCode, now);
    return { success: `字段“${parsed.label}”已新增` };
  }

  if (intent === "field_catalog_add" || intent === "field_catalog_assign") {
    const step = await ownedStep(workflowId, valueOf(form, "stepId"));
    const catalog = workflowFieldCatalogByKey.get(valueOf(form, "catalogFieldKey"));
    if (!step || !catalog) return { formError: "请选择有效的节点和业务字段" };
    const mode = editableWorkflowFieldMode(valueOf(form, "fieldMode") || catalog.defaultMode);
    if (!mode) return { formError: "请选择必填、选填或隐藏规则" };
    const flags = editableWorkflowFieldFlags(mode);
    const sortOrder = parseWorkflowSortOrder(valueOf(form, "fieldSortOrder"), 9999);
    if (sortOrder === null)
      return { formError: "字段顺序必须在 1–9999 之间" };
    const exists = await env.DB.prepare(
      `SELECT id,step_id,COALESCE(module_code,?) module_code
       FROM workflow_step_fields
       WHERE workflow_id=? AND field_key=? AND COALESCE(module_code,?)=?`,
    ).bind(catalog.moduleCode,workflowId,catalog.fieldKey,catalog.moduleCode,catalog.moduleCode)
      .first<{ id: string; step_id: string; module_code: OrderModuleCode }>();
    const fieldId = exists?.id || crypto.randomUUID();
    if (exists) {
      await env.DB.prepare(
        `UPDATE workflow_step_fields SET step_id=?,label=?,field_type=?,is_required=?,is_active=?,
          sort_order=?,options_text=?,help_text=?,module_code=?,updated_at=?
         WHERE id=? AND workflow_id=?`,
      ).bind(
        step.id,catalog.label,catalog.fieldType,flags.isRequired,flags.isActive,sortOrder,
        catalog.optionsText ?? null,catalog.helpText,catalog.moduleCode,now,fieldId,workflowId,
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO workflow_step_fields(id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,sort_order,options_text,help_text,module_code,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        fieldId,workflowId,step.id,catalog.fieldKey,catalog.label,catalog.fieldType,
        flags.isRequired,flags.isActive,sortOrder,catalog.optionsText ?? null,
        catalog.helpText,catalog.moduleCode,now,now,
      ).run();
    }
    if (flags.isActive) {
      await ensureFieldPolicyModule(workflowId, step.id, catalog.moduleCode, flags.isRequired, now);
    }
    await synchronizeWorkflowFieldDefinitionForInstances({
      workflowId,
      stepKey: step.step_key,
      fieldKey: catalog.fieldKey,
      moduleCode: catalog.moduleCode,
      label: catalog.label,
      fieldType: catalog.fieldType,
      isRequired: flags.isRequired,
      isActive: flags.isActive,
      sortOrder,
      optionsText: catalog.optionsText ?? null,
      helpText: catalog.helpText,
    });
    if (exists?.step_id && exists.step_id !== step.id) {
      await reconcileFieldPolicyModule(workflowId, exists.step_id, exists.module_code, now);
    }
    await reconcileFieldPolicyModule(workflowId, step.id, catalog.moduleCode, now);
    if (flags.releasesStoredValue) {
      await releaseHiddenWorkflowFieldData({
        organizationId: current.organizationId,
        workflowId,
        fieldKey: catalog.fieldKey,
        moduleCode: catalog.moduleCode,
      });
    }
    await writeAudit({
      request,
      action: "workflow.field.block.assign",
      resourceType: "workflow_step_field",
      resourceId: fieldId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { workflowId, stepKey: step.step_key, fieldKey: catalog.fieldKey, mode, moved: Boolean(exists) },
    });
    return { success: `业务字段“${catalog.label}”已${exists ? "移动并更新" : "加入"}到“${step.step_key}”，现有订单已同步` };
  }

  if (intent === "field_update") {
    const fieldId = valueOf(form, "fieldId");
    const field = await env.DB.prepare(
      `SELECT f.id,f.step_id,s.step_key,f.field_key,COALESCE(f.module_code,'consignment') module_code
       FROM workflow_step_fields f JOIN workflow_steps s ON s.id=f.step_id
       WHERE f.id=? AND f.workflow_id=?`,
    )
      .bind(fieldId, workflowId)
      .first<{ id: string; step_id: string; step_key: string; field_key: string; module_code: OrderModuleCode }>();
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
    if (parsed.active) {
      await ensureFieldPolicyModule(workflowId, field.step_id, parsed.moduleCode, parsed.required, now);
    }
    await synchronizeWorkflowFieldDefinitionForInstances({
      workflowId,
      stepKey: field.step_key,
      fieldKey: parsed.fieldKey,
      moduleCode: parsed.moduleCode,
      label: parsed.label,
      fieldType: parsed.fieldType,
      isRequired: parsed.required,
      isActive: parsed.active,
      sortOrder: parsed.sortOrder,
      optionsText: parsed.optionsText,
      helpText: parsed.helpText,
    });
    await reconcileFieldPolicyModule(workflowId, field.step_id, field.module_code, now);
    if (field.module_code !== parsed.moduleCode) {
      await reconcileFieldPolicyModule(workflowId, field.step_id, parsed.moduleCode, now);
    }
    if (!parsed.active) {
      await releaseHiddenWorkflowFieldData({
        organizationId: current.organizationId,
        workflowId,
        fieldKey: parsed.fieldKey,
        moduleCode: parsed.moduleCode,
      });
    }
    return { success: `字段“${parsed.label}”已更新，填写规则已同步到现有订单` };
  }

  if (intent === "field_delete") {
    const fieldId = valueOf(form, "fieldId");
    const field = await env.DB.prepare(
      `SELECT step_id,COALESCE(module_code,'consignment') module_code
       FROM workflow_step_fields WHERE id=? AND workflow_id=?`,
    ).bind(fieldId,workflowId).first<{step_id:string;module_code:OrderModuleCode}>();
    if (!field) return { formError: "字段不存在" };
    await env.DB.prepare("DELETE FROM workflow_step_fields WHERE id=? AND workflow_id=?")
      .bind(fieldId, workflowId)
      .run();
    await reconcileFieldPolicyModule(workflowId,field.step_id,field.module_code,now);
    return { success: "字段已删除" };
  }

  if (intent === "module_add") {
    const step = await ownedStep(workflowId, valueOf(form, "stepId"));
    const moduleCode = valueOf(form, "moduleCode") as OrderModuleCode;
    const definitionModule = orderModuleDefinitions.find((item) => item.code === moduleCode);
    if (!step || !definitionModule) return { formError: "请选择有效的节点和功能模组" };
    const sortOrder = parseWorkflowSortOrder(valueOf(form, "moduleSortOrder"));
    if (sortOrder === null)
      return { formError: "模组顺序必须在 1–999 之间" };
    const positionCode = valueOf(form, "positionCode") || null;
    if (positionCode && !(await validPosition(current.organizationId, positionCode)))
      return { formError: "负责岗位无效" };
    const moduleId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workflow_step_modules(
          id,workflow_id,step_id,module_code,display_name,sort_order,is_required,is_active,
          responsibility_position_code,completion_mode,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,1,1,?,'all_tasks',?,?)`,
      ).bind(moduleId,workflowId,step.id,moduleCode,definitionModule.name,sortOrder,positionCode,now,now),
      env.DB.prepare(
        `INSERT INTO workflow_module_tasks(
          id,workflow_id,step_module_id,task_key,name,task_type,sort_order,is_required,is_active,
          responsibility_position_code,created_at,updated_at
         ) VALUES(?,?,?,?,?,'form',10,1,1,?,?,?)`,
      ).bind(crypto.randomUUID(),workflowId,moduleId,`handle_${moduleCode}`,`办理${definitionModule.name}`,positionCode,now,now),
    ]);
    return { success: `模组“${definitionModule.name}”已加入节点` };
  }

  if (intent === "module_update") {
    const moduleId = valueOf(form, "stepModuleId");
    const row = await env.DB.prepare(
      "SELECT id FROM workflow_step_modules WHERE id=? AND workflow_id=?",
    ).bind(moduleId,workflowId).first<{ id: string }>();
    if (!row) return { formError: "功能模组不存在" };
    const displayName = valueOf(form, "displayName").trim();
    const sortOrder = parseWorkflowSortOrder(valueOf(form, "moduleSortOrder"));
    const completionMode = valueOf(form, "completionMode");
    const positionCode = valueOf(form, "positionCode") || null;
    if (!displayName || sortOrder === null ||
        !["all_tasks","manual_confirm","automatic"].includes(completionMode))
      return { formError: "请填写有效的模组配置" };
    if (positionCode && !(await validPosition(current.organizationId, positionCode)))
      return { formError: "负责岗位无效" };
    await env.DB.prepare(
      `UPDATE workflow_step_modules SET display_name=?,sort_order=?,is_required=?,is_active=?,
        responsibility_position_code=?,activation_condition=?,completion_mode=?,updated_at=?
       WHERE id=? AND workflow_id=?`,
    ).bind(
      displayName,sortOrder,form.has("isRequired")?1:0,form.has("isActive")?1:0,
      positionCode,valueOf(form,"activationCondition").trim()||null,completionMode,now,moduleId,workflowId,
    ).run();
    return { success: `模组“${displayName}”已更新` };
  }

  if (intent === "module_delete") {
    const moduleId = valueOf(form, "stepModuleId");
    const fieldCount = await env.DB.prepare(
      `SELECT COUNT(*) count FROM workflow_step_fields f JOIN workflow_step_modules m
       ON m.step_id=f.step_id AND m.module_code=COALESCE(f.module_code,'consignment')
       WHERE m.id=? AND m.workflow_id=?`,
    ).bind(moduleId,workflowId).first<{ count: number }>();
    if (fieldCount?.count) return { formError: "该模组仍有字段，请先移动或删除字段" };
    await env.DB.prepare("DELETE FROM workflow_step_modules WHERE id=? AND workflow_id=?")
      .bind(moduleId,workflowId).run();
    return { success: "功能模组已删除" };
  }

  if (intent === "task_create" || intent === "task_update") {
    const moduleId = valueOf(form, "stepModuleId");
    const module = await env.DB.prepare(
      "SELECT id FROM workflow_step_modules WHERE id=? AND workflow_id=?",
    ).bind(moduleId,workflowId).first<{ id: string }>();
    if (!module) return { formError: "功能模组不存在" };
    const name = valueOf(form,"taskName").trim();
    const taskType = valueOf(form,"taskType");
    const sortOrder = parseWorkflowSortOrder(valueOf(form,"taskSortOrder"));
    const positionCode = valueOf(form,"positionCode") || null;
    if (!name || !["form","review","decision","system"].includes(taskType) ||
        sortOrder === null)
      return { formError: "请填写有效的办理步骤" };
    if (positionCode && !(await validPosition(current.organizationId, positionCode)))
      return { formError: "负责岗位无效" };
    if (intent === "task_create") {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO workflow_module_tasks(
          id,workflow_id,step_module_id,task_key,name,task_type,sort_order,is_required,is_active,
          responsibility_position_code,instructions,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,workflowId,moduleId,`task_${id.replaceAll("-","")}`,name,taskType,sortOrder,
        form.has("isRequired")?1:0,1,positionCode,valueOf(form,"instructions").trim()||null,now,now,
      ).run();
    } else {
      const taskId = valueOf(form,"taskId");
      await env.DB.prepare(
        `UPDATE workflow_module_tasks SET name=?,task_type=?,sort_order=?,is_required=?,is_active=?,
          responsibility_position_code=?,instructions=?,updated_at=?
         WHERE id=? AND workflow_id=? AND step_module_id=?`,
      ).bind(
        name,taskType,sortOrder,form.has("isRequired")?1:0,form.has("isActive")?1:0,
        positionCode,valueOf(form,"instructions").trim()||null,now,taskId,workflowId,moduleId,
      ).run();
    }
    return { success: intent === "task_create" ? "办理步骤已新增" : "办理步骤已更新" };
  }

  if (intent === "task_delete") {
    await env.DB.prepare("DELETE FROM workflow_module_tasks WHERE id=? AND workflow_id=?")
      .bind(valueOf(form,"taskId"),workflowId).run();
    return { success: "办理步骤已删除" };
  }

  const stepId = valueOf(form, "stepId");
  const name = valueOf(form, "name").trim();
  const order = parseWorkflowSortOrder(valueOf(form, "sortOrder"));
  const entity = valueOf(form, "entityType");
  const scope = valueOf(form, "actorScope");
  if (
    !stepId ||
    name.length < 1 ||
    name.length > 30 ||
    order === null ||
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

  const sourceModules = await env.DB.prepare(
    `SELECT id,step_id,module_code,display_name,sort_order,is_required,is_active,
      responsibility_position_code,activation_condition,completion_mode
     FROM workflow_step_modules WHERE workflow_id=? ORDER BY sort_order,module_code`,
  ).bind(sourceWorkflowId).all<StepModule>();
  const moduleIdMap = new Map<string,string>();
  const moduleStatements = sourceModules.results.map((item) => {
    const targetStepId = stepIdMap.get(item.step_id);
    if (!targetStepId) return null;
    const id = crypto.randomUUID();
    moduleIdMap.set(item.id,id);
    return env.DB.prepare(
      `INSERT INTO workflow_step_modules(
        id,workflow_id,step_id,module_code,display_name,sort_order,is_required,is_active,
        responsibility_position_code,activation_condition,completion_mode,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id,targetWorkflowId,targetStepId,item.module_code,item.display_name,item.sort_order,
      item.is_required,item.is_active,item.responsibility_position_code,item.activation_condition,
      item.completion_mode,now,now,
    );
  }).filter(Boolean) as D1PreparedStatement[];
  if (moduleStatements.length) await env.DB.batch(moduleStatements);

  const sourceTasks = await env.DB.prepare(
    `SELECT id,step_module_id,task_key,name,task_type,sort_order,is_required,is_active,
      responsibility_position_code,instructions
     FROM workflow_module_tasks WHERE workflow_id=? ORDER BY sort_order,task_key`,
  ).bind(sourceWorkflowId).all<ModuleTask>();
  const taskStatements = sourceTasks.results.map((item) => {
    const targetModuleId = moduleIdMap.get(item.step_module_id);
    if (!targetModuleId) return null;
    return env.DB.prepare(
      `INSERT INTO workflow_module_tasks(
        id,workflow_id,step_module_id,task_key,name,task_type,sort_order,is_required,is_active,
        responsibility_position_code,instructions,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(),targetWorkflowId,targetModuleId,item.task_key,item.name,item.task_type,
      item.sort_order,item.is_required,item.is_active,item.responsibility_position_code,
      item.instructions,now,now,
    );
  }).filter(Boolean) as D1PreparedStatement[];
  if (taskStatements.length) await env.DB.batch(taskStatements);
}

async function synchronizeWorkflowExecutionSnapshots(workflowId: string) {
  const instances = await env.DB.prepare(
    "SELECT id FROM workflow_instances WHERE workflow_id=? ORDER BY id",
  ).bind(workflowId).all<{ id: string }>();
  const chunkSize = 20;
  for (let index = 0; index < instances.results.length; index += chunkSize) {
    await Promise.all(
      instances.results.slice(index, index + chunkSize).map((instance) =>
        ensureWorkflowExecutionSnapshot({ instanceId: instance.id, workflowId }),
      ),
    );
  }
}

async function ensureFieldPolicyModule(
  workflowId: string,
  stepId: string,
  moduleCode: OrderModuleCode,
  required: number,
  now: string,
) {
  const existing = await env.DB.prepare(
    `SELECT id,is_active,activation_condition FROM workflow_step_modules
     WHERE workflow_id=? AND step_id=? AND module_code=?`,
  ).bind(workflowId, stepId, moduleCode)
    .first<{ id: string; is_active: number; activation_condition: string | null }>();
  if (existing) {
    if (!existing.is_active || existing.activation_condition === "field_policy") {
      await env.DB.prepare(
        `UPDATE workflow_step_modules SET is_active=1,
          is_required=CASE WHEN activation_condition='field_policy' THEN ? ELSE MAX(is_required,?) END,
          updated_at=? WHERE id=?`,
      ).bind(required, required, now, existing.id).run();
    }
    await synchronizeWorkflowExecutionSnapshots(workflowId);
    return existing.id;
  }
  const definitionModule = orderModuleDefinitions.find((item) => item.code === moduleCode);
  const order = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order),0)+10 next_order FROM workflow_step_modules WHERE workflow_id=? AND step_id=?",
  ).bind(workflowId, stepId).first<{ next_order: number }>();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO workflow_step_modules(
      id,workflow_id,step_id,module_code,display_name,sort_order,is_required,is_active,
      activation_condition,completion_mode,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,1,'field_policy','automatic',?,?)`,
  ).bind(
    id, workflowId, stepId, moduleCode, definitionModule?.name ?? moduleCode,
    order?.next_order ?? 10, required, now, now,
  ).run();
  await synchronizeWorkflowExecutionSnapshots(workflowId);
  return id;
}

async function reconcileFieldPolicyModule(
  workflowId: string,
  stepId: string,
  moduleCode: OrderModuleCode,
  now: string,
) {
  const module = await env.DB.prepare(
    `SELECT id,activation_condition FROM workflow_step_modules
     WHERE workflow_id=? AND step_id=? AND module_code=?`,
  ).bind(workflowId, stepId, moduleCode)
    .first<{ id: string; activation_condition: string | null }>();
  if (!module) return;
  const fields = await env.DB.prepare(
    `SELECT COUNT(*) active_count,
      COALESCE(MAX(CASE WHEN is_active=1 THEN is_required ELSE 0 END),0) required_count
     FROM workflow_step_fields
     WHERE workflow_id=? AND step_id=? AND COALESCE(module_code,'consignment')=? AND is_active=1`,
  ).bind(workflowId, stepId, moduleCode)
    .first<{ active_count: number; required_count: number }>();
  const activeCount = Number(fields?.active_count ?? 0);
  const required = Number(fields?.required_count ?? 0) > 0 ? 1 : 0;
  if (module.activation_condition === "field_policy") {
    await env.DB.prepare(
      "UPDATE workflow_step_modules SET is_active=?,is_required=?,updated_at=? WHERE id=?",
    ).bind(activeCount ? 1 : 0, required, now, module.id).run();
    if (!activeCount) {
      await env.DB.prepare(
        "DELETE FROM workflow_instance_module_states WHERE step_module_id=?",
      ).bind(module.id).run();
      return;
    }
  }
  await env.DB.prepare(
    `UPDATE workflow_instance_module_states SET is_required=?,updated_at=?
     WHERE step_module_id=?`,
  ).bind(required, now, module.id).run();
  if (activeCount) await synchronizeWorkflowExecutionSnapshots(workflowId);
}

function validateWorkflowConfiguration(
  steps: Step[],
  modules: StepModule[],
  tasks: ModuleTask[],
) {
  const issues: string[] = [];
  const activeSteps = steps.filter((item) => item.is_active).sort((a,b) => a.sort_order-b.sort_order);
  if (!activeSteps.length) issues.push("至少需要一个启用节点");
  if (activeSteps.length && activeSteps[0].trigger_event !== "order.created")
    issues.push("第一个启用节点必须承接订单创建");
  const duplicateStepOrders = activeSteps.filter(
    (item,index) => activeSteps.findIndex((other) => other.sort_order === item.sort_order) !== index,
  );
  if (duplicateStepOrders.length) issues.push("启用节点的顺序不能重复");
  const requiredRuntimeSteps = [
    "order_creation","consignment_approval","task_assignment","domestic_execution",
    "warehouse_receiving","port_loading","outbound_transport","overseas_pickup",
    "reconciliation","completion_review",
  ];
  const missingRuntimeSteps = requiredRuntimeSteps.filter(
    (key)=>!activeSteps.some((step)=>step.step_key===key),
  );
  if (missingRuntimeSteps.length)
    issues.push(`第一版运行链缺少基础节点：${missingRuntimeSteps.join("、")}`);
  for (const step of activeSteps) {
    const stepModules = modules.filter((item) => item.step_id === step.id && item.is_active);
    if (!stepModules.length) issues.push(`节点“${step.name}”没有启用的功能模组`);
    for (const stepModule of stepModules) {
      const activeTasks = tasks.filter((item) => item.step_module_id === stepModule.id && item.is_active);
      if (stepModule.completion_mode !== "automatic" && !activeTasks.length)
        issues.push(`模组“${stepModule.display_name}”没有办理步骤`);
    }
  }
  return [...new Set(issues)];
}

async function loadWorkflowValidationIssues(workflowId: string) {
  const [steps,modules,tasks] = await Promise.all([
    env.DB.prepare(
      "SELECT id,step_key,name,entity_type,trigger_event,sort_order,is_required,is_active,actor_scope FROM workflow_steps WHERE workflow_id=? ORDER BY sort_order,step_key",
    ).bind(workflowId).all<Step>(),
    env.DB.prepare(
      `SELECT id,step_id,module_code,display_name,sort_order,is_required,is_active,
        responsibility_position_code,activation_condition,completion_mode
       FROM workflow_step_modules WHERE workflow_id=? ORDER BY sort_order,module_code`,
    ).bind(workflowId).all<StepModule>(),
    env.DB.prepare(
      `SELECT id,step_module_id,task_key,name,task_type,sort_order,is_required,is_active,
        responsibility_position_code,instructions
       FROM workflow_module_tasks WHERE workflow_id=? ORDER BY sort_order,task_key`,
    ).bind(workflowId).all<ModuleTask>(),
  ]);
  return validateWorkflowConfiguration(steps.results,modules.results,tasks.results);
}

async function validPosition(organizationId: string, code: string) {
  return Boolean(await env.DB.prepare(
    "SELECT 1 FROM positions WHERE organization_id=? AND code=? AND status='active'",
  ).bind(organizationId,code).first());
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
  const sortOrder = parseWorkflowSortOrder(valueOf(form, "fieldSortOrder"), 9999);
  if (
    label.length < 1 ||
    label.length > 40 ||
    fieldKey.length < 1 ||
    fieldKey.length > 60 ||
    !fieldTypeLabels[fieldType] ||
    !orderModuleDefinitions.some((module) => module.code === moduleCode) ||
    sortOrder === null
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
function lifecycleLabel(status: string) {
  if (status === "draft") return "草稿";
  if (status === "published") return "已发布";
  if (status === "retired") return "已归档";
  return status;
}
const completionModeLabels: Record<string,string> = {
  all_tasks:"全部步骤完成",
  manual_confirm:"人工确认无误",
  automatic:"系统自动完成",
};
const taskTypeLabels: Record<string,string> = {
  form:"填写表单",
  review:"审核确认",
  decision:"人工决策",
  system:"系统处理",
};
function positionLabel(positions:PositionOption[],code:string|null) {
  if (!code) return "待分配岗位";
  return positions.find((item)=>item.code===code)?.name || code;
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
  const capabilities = workflowEditCapabilities(loaderData.definition.instance_count);
  const structureEditable = manage && capabilities.structureEditable;
  const isDraft = loaderData.definition.lifecycle_status === "draft";
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
  const modulesByStep = new Map<string, StepModule[]>();
  for (const item of loaderData.stepModules) {
    const list = modulesByStep.get(item.step_id) ?? [];
    list.push(item);
    modulesByStep.set(item.step_id,list);
  }
  const tasksByModule = new Map<string, ModuleTask[]>();
  for (const item of loaderData.moduleTasks) {
    const list = tasksByModule.get(item.step_module_id) ?? [];
    list.push(item);
    tasksByModule.set(item.step_module_id,list);
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
                <label className="field">
                  <span>订单类型</span>
                  <select name="roadLoadType" defaultValue={loaderData.definition.road_load_type} required>
                    <option value="ltl">拼车型</option>
                    <option value="ftl">整车型</option>
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
        <div className="table-wrap workflow-template-list">
          <table>
            <thead>
              <tr>
                <th>工作流模板</th>
                <th>订单类型</th>
                <th>版本</th>
                <th>状态</th>
                <th>节点</th>
                <th>订单</th>
                <th>最后更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.definitions.map((item) => (
                <tr key={item.id} className={item.id === loaderData.definition.id ? "active" : ""}>
                  <td><strong>{item.name}</strong></td>
                  <td>{item.road_load_type === "ftl" ? "整车型" : "拼车型"}</td>
                  <td>v{item.version_number}</td>
                  <td><span className={`status-pill ${item.lifecycle_status === "retired" ? "off" : ""}`}>{lifecycleLabel(item.lifecycle_status)}</span></td>
                  <td>{item.step_count}</td>
                  <td>{item.instance_count}</td>
                  <td>{new Date(item.updated_at).toLocaleDateString("zh-CN")}</td>
                  <td>
                    <Link className="text-button" to={`/admin/workflow?workflowId=${encodeURIComponent(item.id)}`}>
                      {item.id === loaderData.definition.id ? "当前查看" : "查看配置"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>{loaderData.definition.name}</h2>
            <p>v{loaderData.definition.version_number} · {capabilities.usedByOrders ? "已有订单：节点结构锁定，字段可实时设为必填、选填或隐藏" : "尚无订单：可自由增删节点、模组、办理步骤和字段积木"}</p>
          </div>
          <div className="page-actions">
            <span className={`status-pill ${loaderData.definition.status !== "active" ? "off" : ""}`}>
              {lifecycleLabel(loaderData.definition.lifecycle_status)}
            </span>
            {manage && capabilities.usedByOrders && (
              <Form method="post">
                <input type="hidden" name="intent" value="version_create" />
                <input type="hidden" name="workflowId" value={loaderData.definition.id} />
                <button className="primary" disabled={busy}>创建新版本</button>
              </Form>
            )}
            {structureEditable && (
              <Modal title="新增流程节点" triggerLabel="新增节点" triggerClassName="secondary" closeSignal={successMessage}>
                <NodeCreateForm workflowId={loaderData.definition.id} activeSteps={activeSteps} busy={busy} />
              </Modal>
            )}
            {manage && (
              <Modal
                title={`节点配置 · ${loaderData.definition.name}`}
                triggerLabel="节点配置"
                triggerClassName="secondary"
                size="xwide"
                closeSignal={successMessage}
              >
                <NodeConfigDialog
                  workflowId={loaderData.definition.id}
                  steps={loaderData.steps}
                  fieldsByStep={fieldsByStep}
                  allFields={loaderData.fields}
                  structureEditable={structureEditable}
                  requirementEditable={manage}
                  busy={busy}
                  closeSignal={successMessage}
                  modulesByStep={modulesByStep}
                  tasksByModule={tasksByModule}
                  positions={loaderData.positions}
                />
              </Modal>
            )}
          </div>
        </div>
        {structureEditable && <DefinitionForm definition={loaderData.definition} busy={busy} />}
        {structureEditable && isDraft && (
          <div className="workflow-definition-form">
            <div className={`alert ${loaderData.validationIssues.length ? "warning" : "success"}`}>
              {loaderData.validationIssues.length
                ? `待处理：${loaderData.validationIssues.join("；")}`
                : "结构校验通过：节点、模组与办理步骤完整。"}
            </div>
            <Form method="post">
              <input type="hidden" name="workflowId" value={loaderData.definition.id} />
              <button className="secondary" name="intent" value="validate" disabled={busy}>校验并模拟</button>
              <button className="primary" name="intent" value="publish" disabled={busy || loaderData.validationIssues.length > 0}>发布版本</button>
            </Form>
          </div>
        )}
        <div className="table-wrap workflow-track">
          <table>
            <thead><tr><th>顺序</th><th>流程节点</th><th>执行角色</th><th>功能模组</th><th>字段规则</th><th>状态</th></tr></thead>
            <tbody>
              {activeSteps.map((step, index) => {
                const stepFields = fieldsByStep.get(step.id) ?? [];
                const requiredCount = stepFields.filter((field) => field.is_active && field.is_required).length;
                const optionalCount = stepFields.filter((field) => field.is_active && !field.is_required).length;
                return (
                  <tr key={step.id}>
                    <td>{String(index + 1).padStart(2, "0")}</td>
                    <td><strong>{step.name}</strong></td>
                    <td>{scopeLabels[step.actor_scope]}</td>
                    <td>{(modulesByStep.get(step.id) ?? []).filter((item) => item.is_active).map((item) => item.display_name).join(" / ") || "未配置"}</td>
                    <td>{requiredCount} 必填 · {optionalCount} 选填</td>
                    <td><span className="status-pill success">启用</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
  allFields,
  structureEditable,
  requirementEditable,
  busy,
  closeSignal,
  modulesByStep,
  tasksByModule,
  positions,
}: {
  workflowId: string;
  steps: Step[];
  fieldsByStep: Map<string, StepField[]>;
  allFields: StepField[];
  structureEditable: boolean;
  requirementEditable: boolean;
  busy: boolean;
  closeSignal?: unknown;
  modulesByStep: Map<string, StepModule[]>;
  tasksByModule: Map<string, ModuleTask[]>;
  positions: PositionOption[];
}) {
  return (
    <div className="workflow-config-dialog">
      <div className="workflow-config-dialog-header">
        <div>
          <strong>节点与字段</strong>
          <span>{structureEditable ? "该工作流尚无订单，可像积木一样插入、删除节点并配置字段。" : "该工作流已有订单：节点、模组和步骤锁定，字段仍可移动并设为必填、选填或隐藏。"}</span>
        </div>
        <small>{structureEditable ? "首个订单使用后自动锁定节点结构。" : "保存即同步到现有订单和后续门禁；隐藏附件会释放订单级文件。"}</small>
      </div>
      <div className="workflow-node-config-list">
        <div className="workflow-node-config-table-head" aria-hidden="true">
          <span>顺序</span><span>节点</span><span>执行角色</span><span>模组</span><span>字段</span><span>状态 / 操作</span>
        </div>
        {steps.map((step) => (
          <details className="workflow-node-config" key={step.id}>
            <summary>
              <span className="workflow-field-order">{step.sort_order}</span>
              <strong>{step.name}</strong>
              <span>{scopeLabels[step.actor_scope]}</span>
              <span>{(modulesByStep.get(step.id) ?? []).filter((item) => item.is_active).length}</span>
              <span>{fieldsByStep.get(step.id)?.length ?? 0}</span>
              <small>{step.is_active ? "启用" : "停用"} · 展开配置</small>
            </summary>
            {structureEditable ? (
              <NodeEditForm workflowId={workflowId} step={step} busy={busy} />
            ) : null}
            {structureEditable && (
              <ModuleList
                workflowId={workflowId}
                step={step}
                modules={modulesByStep.get(step.id) ?? []}
                tasksByModule={tasksByModule}
                positions={positions}
                busy={busy}
                closeSignal={closeSignal}
              />
            )}
            <FieldList
              workflowId={workflowId}
              step={step}
              steps={steps}
              fields={fieldsByStep.get(step.id) ?? []}
              allFields={allFields}
              structureEditable={structureEditable}
              requirementEditable={requirementEditable}
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
        <span>插入位置</span>
        <select name="insertAfterStepId" defaultValue={activeSteps[activeSteps.length - 1]?.id ?? ""}>
          {!activeSteps.length && <option value="">作为第一个节点</option>}
          {activeSteps.map((step,index) => (
            <option key={step.id} value={step.id}>
              {index === activeSteps.length - 1
                ? `在“${step.name}”之后`
                : `在“${step.name}”与“${activeSteps[index + 1].name}”之间`}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint">系统自动重排节点顺序；不需要手工输入数字，避免 0/O 等误录。</p>
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

function ModuleList({
  workflowId,step,modules,tasksByModule,positions,busy,closeSignal,
}: {
  workflowId:string;
  step:Step;
  modules:StepModule[];
  tasksByModule:Map<string,ModuleTask[]>;
  positions:PositionOption[];
  busy:boolean;
  closeSignal?:unknown;
}) {
  const used = new Set(modules.map((item) => item.module_code));
  const available = orderModuleDefinitions.filter((item) => !used.has(item.code));
  return (
    <section className="workflow-module-config">
      <div className="workflow-field-config-heading">
        <div><h3>功能模组与办理顺序</h3><p>一个节点可包含多个模组；模组内的办理步骤按顺序交给具体岗位。</p></div>
        <strong>{modules.filter((item) => item.is_active).length} 个模组</strong>
      </div>
      <div className="workflow-module-list">
        {modules.map((item) => {
          const tasks = tasksByModule.get(item.id) ?? [];
          return (
            <article className={`workflow-module-row${item.is_active ? "" : " off"}`} key={item.id}>
              <header>
                <span className="workflow-field-order">{item.sort_order}</span>
                <div><strong>{item.display_name}</strong><small>{moduleLabels[item.module_code]} · {completionModeLabels[item.completion_mode]}</small></div>
                <span>{positionLabel(positions,item.responsibility_position_code)}</span>
                <Modal title={`配置模组 · ${item.display_name}`} triggerLabel="配置" triggerClassName="text-button" size="wide" closeSignal={closeSignal}>
                  <Form method="post" className="workflow-field-form workflow-field-modal-form">
                    <input type="hidden" name="workflowId" value={workflowId}/>
                    <input type="hidden" name="stepModuleId" value={item.id}/>
                    <label className="field"><span>显示名称</span><input name="displayName" defaultValue={item.display_name} required/></label>
                    <label className="field compact"><span>顺序</span><input name="moduleSortOrder" type="number" min="1" max="999" defaultValue={item.sort_order} required/></label>
                    <Select name="completionMode" label="完成规则" items={Object.entries(completionModeLabels)} value={item.completion_mode}/>
                    <PositionSelect positions={positions} value={item.responsibility_position_code}/>
                    <label className="field span-2"><span>启用条件</span><input name="activationCondition" defaultValue={item.activation_condition || ""} placeholder="选填，例如：仅拼车订单"/></label>
                    <label className="check-field"><input name="isRequired" type="checkbox" defaultChecked={Boolean(item.is_required)}/>必须办理</label>
                    <label className="check-field"><input name="isActive" type="checkbox" defaultChecked={Boolean(item.is_active)}/>启用</label>
                    <div className="button-row span-2"><button className="secondary" name="intent" value="module_update" disabled={busy}>保存模组</button><button className="text-button danger" name="intent" value="module_delete" formNoValidate disabled={busy}>删除模组</button></div>
                  </Form>
                </Modal>
              </header>
              <div className="workflow-task-list">
                {tasks.map((task,index) => (
                  <div className={`workflow-task-row${task.is_active ? "" : " off"}`} key={task.id}>
                    <span>{index+1}</span><strong>{task.name}</strong><small>{taskTypeLabels[task.task_type]} · {positionLabel(positions,task.responsibility_position_code || item.responsibility_position_code)}</small>
                    <Modal title={`编辑办理步骤 · ${task.name}`} triggerLabel="编辑" triggerClassName="text-button" closeSignal={closeSignal}>
                      <TaskForm workflowId={workflowId} module={item} task={task} positions={positions} busy={busy}/>
                    </Modal>
                  </div>
                ))}
                {!tasks.length && <p className="workflow-field-group-empty">尚未配置办理步骤</p>}
                <Modal title={`新增办理步骤 · ${item.display_name}`} triggerLabel="新增办理步骤" triggerClassName="secondary" closeSignal={closeSignal}>
                  <TaskForm workflowId={workflowId} module={item} positions={positions} busy={busy} nextSort={(tasks[tasks.length - 1]?.sort_order ?? 0)+10}/>
                </Modal>
              </div>
            </article>
          );
        })}
      </div>
      {available.length > 0 && (
        <Modal title={`加入功能模组 · ${step.name}`} triggerLabel="加入功能模组" triggerClassName="secondary" closeSignal={closeSignal}>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="module_add"/><input type="hidden" name="workflowId" value={workflowId}/><input type="hidden" name="stepId" value={step.id}/>
            <label className="field"><span>功能模组</span><select name="moduleCode" required>{available.map((item)=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
            <PositionSelect positions={positions}/>
            <label className="field"><span>顺序</span><input name="moduleSortOrder" type="number" min="1" max="999" defaultValue={(modules[modules.length - 1]?.sort_order ?? 0)+10} required/></label>
            <button className="primary" disabled={busy}>加入节点</button>
          </Form>
        </Modal>
      )}
    </section>
  );
}

function TaskForm({workflowId,module,task,positions,busy,nextSort=10}:{workflowId:string;module:StepModule;task?:ModuleTask;positions:PositionOption[];busy:boolean;nextSort?:number}) {
  return (
    <Form method="post" className="workflow-field-form workflow-field-modal-form">
      <input type="hidden" name="intent" value={task?"task_update":"task_create"}/>
      <input type="hidden" name="workflowId" value={workflowId}/>
      <input type="hidden" name="stepModuleId" value={module.id}/>
      {task&&<input type="hidden" name="taskId" value={task.id}/>}
      <label className="field"><span>步骤名称</span><input name="taskName" defaultValue={task?.name || ""} placeholder="例如：业务填写、操作复核" required/></label>
      <Select name="taskType" label="步骤类型" items={Object.entries(taskTypeLabels)} value={task?.task_type || "form"}/>
      <label className="field compact"><span>顺序</span><input name="taskSortOrder" type="number" min="1" max="999" defaultValue={task?.sort_order ?? nextSort} required/></label>
      <PositionSelect positions={positions} value={task?.responsibility_position_code || module.responsibility_position_code}/>
      <label className="field span-2"><span>办理说明</span><textarea name="instructions" rows={3} defaultValue={task?.instructions || ""}/></label>
      <label className="check-field"><input name="isRequired" type="checkbox" defaultChecked={task ? Boolean(task.is_required) : true}/>必须完成</label>
      {task&&<label className="check-field"><input name="isActive" type="checkbox" defaultChecked={Boolean(task.is_active)}/>启用</label>}
      <div className="button-row span-2"><button className="secondary" disabled={busy}>{task?"保存步骤":"新增步骤"}</button>{task&&<button className="text-button danger" name="intent" value="task_delete" formNoValidate disabled={busy}>删除步骤</button>}</div>
    </Form>
  );
}

function PositionSelect({positions,value}:{positions:PositionOption[];value?:string|null}) {
  return <label className="field"><span>负责岗位</span><select name="positionCode" defaultValue={value || ""}><option value="">继承模组/待分配</option>{positions.map((item)=><option key={item.code} value={item.code}>{item.name}{item.department_name?` · ${item.department_name}`:""}</option>)}</select></label>;
}

function FieldList({
  workflowId,
  step,
  steps,
  fields,
  allFields,
  structureEditable,
  requirementEditable,
  busy,
  closeSignal,
}: {
  workflowId: string;
  step: Step;
  steps: Step[];
  fields: StepField[];
  allFields: StepField[];
  structureEditable: boolean;
  requirementEditable: boolean;
  busy: boolean;
  closeSignal?: unknown;
}) {
  return (
    <div className="workflow-field-config">
      <div className="workflow-field-config-heading">
        <div>
          <h3>字段填写规则</h3>
          <p>必填字段缺失会阻断后续流程；选填不阻断；隐藏不显示、不阻断，并释放订单级附件或自定义值。</p>
        </div>
        <strong>{fields.length} 个字段</strong>
      </div>
      <div className="table-wrap workflow-field-table">
        <table>
          <thead><tr><th>顺序</th><th>字段</th><th>业务模块</th><th>类型</th><th>当前规则</th><th>说明</th><th>操作</th></tr></thead>
          <tbody>
            {fields.map((field) => {
              const mode = workflowFieldMode(field);
              return (
                <tr key={field.id}>
                  <td>{field.sort_order}</td>
                  <td><strong>{field.label}</strong><small>{field.field_key}</small></td>
                  <td>{moduleLabels[field.module_code]}</td>
                  <td>{fieldTypeLabels[field.field_type]}</td>
                  <td><span className={`status-pill workflow-mode-${mode}`}>{workflowFieldModes.find((item) => item.value === mode)?.label}</span></td>
                  <td>{field.help_text || "—"}</td>
                  <td>
                    <div className="workflow-field-row-actions">
                      {requirementEditable && (
                        <RequirementModeForm workflowId={workflowId} field={field} busy={busy} />
                      )}
                      {structureEditable && (
                        <Modal title={`编辑字段 · ${field.label}`} triggerLabel="编辑结构" triggerClassName="text-button" size="wide" closeSignal={closeSignal}>
                          <FieldForm workflowId={workflowId} stepId={step.id} field={field} busy={busy} />
                        </Modal>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!fields.length && <tr><td colSpan={7} className="empty-state">该节点暂未配置字段。</td></tr>}
          </tbody>
        </table>
      </div>
      {(requirementEditable || structureEditable) && (
        <div className="workflow-field-actions">
          {requirementEditable && (
            <Modal title={`配置字段积木 · ${step.name}`} triggerLabel="配置字段积木" triggerClassName="secondary" size="wide" closeSignal={closeSignal}>
              <CatalogFieldForm workflowId={workflowId} step={step} steps={steps} allFields={allFields} busy={busy} nextSort={(fields[fields.length - 1]?.sort_order ?? 0) + 10} />
            </Modal>
          )}
          {structureEditable && (
            <Modal title={`新增字段 · ${step.name}`} triggerLabel="新增自定义字段" triggerClassName="secondary" size="wide" closeSignal={closeSignal}>
              <FieldForm workflowId={workflowId} stepId={step.id} busy={busy} nextSort={(fields[fields.length - 1]?.sort_order ?? 0) + 10} />
            </Modal>
          )}
        </div>
      )}
    </div>
  );
}

function RequirementModeForm({
  workflowId,
  field,
  busy,
}: {
  workflowId: string;
  field: StepField;
  busy: boolean;
}) {
  return (
    <Form method="post" className="workflow-requirement-form">
      <input type="hidden" name="intent" value="field_mode_update" />
      <input type="hidden" name="workflowId" value={workflowId} />
      <input type="hidden" name="fieldId" value={field.id} />
      <select name="fieldMode" defaultValue={workflowFieldMode(field)} aria-label={`${field.label}填写规则`}>
        <option value="required">必填</option>
        <option value="optional">选填</option>
        <option value="hidden">隐藏</option>
      </select>
      <button className="text-button" disabled={busy}>保存</button>
    </Form>
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
        <input name="fieldSortOrder" type="number" min="1" max="9999" defaultValue={field?.sort_order ?? nextSort} required />
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
  steps,
  allFields,
  busy,
  nextSort,
}: {
  workflowId: string;
  step: Step;
  steps: Step[];
  allFields: StepField[];
  busy: boolean;
  nextSort: number;
}) {
  const existingByKey = new Map(
    allFields.map((field) => [`${field.module_code}:${field.field_key}`,field]),
  );
  const stepNameById = new Map(steps.map((item)=>[item.id,item.name]));
  return (
    <div className="table-wrap workflow-catalog-table">
      <table>
        <thead><tr><th>字段积木</th><th>业务模块</th><th>当前节点</th><th>本节点规则</th><th>排序</th><th>操作</th></tr></thead>
        <tbody>
          {workflowFieldCatalog.map((catalog) => {
            const existing = existingByKey.get(`${catalog.moduleCode}:${catalog.fieldKey}`);
            const onCurrentStep = existing?.step_id === step.id;
            return (
              <tr key={`${catalog.moduleCode}:${catalog.fieldKey}`}>
                <td><strong>{catalog.label}</strong><small>{catalog.fieldKey}</small></td>
                <td>{moduleLabels[catalog.moduleCode]}</td>
                <td>{existing ? stepNameById.get(existing.step_id) ?? "其他节点" : "尚未加入"}</td>
                <td colSpan={3}>
                  <Form method="post" className="workflow-catalog-row-form">
                    <input type="hidden" name="intent" value="field_catalog_assign" />
                    <input type="hidden" name="workflowId" value={workflowId} />
                    <input type="hidden" name="stepId" value={step.id} />
                    <input type="hidden" name="catalogFieldKey" value={catalog.fieldKey} />
                    <select name="fieldMode" defaultValue={existing ? workflowFieldMode(existing) : catalog.defaultMode} aria-label={`${catalog.label}填写规则`}>
                      <option value="required">必填</option>
                      <option value="optional">选填</option>
                      <option value="hidden">隐藏</option>
                    </select>
                    <input name="fieldSortOrder" type="number" min="1" max="9999" defaultValue={existing?.sort_order ?? nextSort} aria-label={`${catalog.label}排序`} required />
                    <button className="text-button" disabled={busy}>
                      {onCurrentStep ? "更新规则" : existing ? "移动到本节点" : "加入本节点"}
                    </button>
                  </Form>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
