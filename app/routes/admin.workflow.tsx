import { env } from "cloudflare:workers";
import { useDeferredValue, useEffect, useState } from "react";
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
import { ConfirmAction } from "../components/ConfirmAction";
import { orderModuleDefinitions, type OrderModuleCode } from "../lib/order-modules";
import { chunkD1Rows, chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import {
  workflowFieldCatalog,
  workflowFieldCatalogByKey,
  workflowFieldModes,
  workflowFieldMode,
  workflowFieldModeFlags,
} from "../lib/workflow-field-catalog";
import { quotationNativeFieldCatalog } from "../lib/quotation-native-field-catalog";
import {
  ensureWorkflowCatalogFields,
  inspectHiddenWorkflowFieldData,
  synchronizeWorkflowFieldDefinitionForInstances,
} from "../lib/workflow-fields.server";
import {
  syncCostsModuleStatus,
  syncOrderWorkflowSnapshot,
} from "../lib/order-modules.server";
import { refreshOrdersForWorkflowFieldChanges } from "../lib/workflow-field-order-refresh";
import { ensureWorkflowExecutionSnapshot } from "../lib/workflow-execution.server";
import { broadcastInternalNotification } from "../lib/internal-notifications.server";
import {
  inspectWorkflowFieldPolicyImpact,
  synchronizeWorkflowSupplementTasks,
  type WorkflowFieldPolicyImpact,
} from "../lib/workflow-supplement.server";
import { reconcileWorkflowFieldRuntimeStatus } from "../lib/workflow-field-runtime-status.server";
import {
  editableWorkflowFieldFlags,
  editableWorkflowFieldMode,
  parseWorkflowFieldModeChanges,
  normalizedWorkflowSortOrders,
  parseWorkflowSortOrder,
  normalizeWorkflowStepRequiredFlag,
  partitionWorkflowDefinitionsByRoadType,
  workflowEditCapabilities,
  workflowEditorEntryMode,
  workflowInsertionSortOrder,
  workflowIntentAllowedForUsage,
  workflowFieldPlacementLock,
  type EditableWorkflowFieldMode,
} from "../lib/workflow-edit-policy";
import {
  filterWorkflowFieldLocatorItems,
  workflowFieldIdentityMatches,
  type WorkflowFieldLocatorItem,
} from "../lib/workflow-field-locator";
import {
  validateWorkflowResponsibilityReadiness,
  type PublicationPositionReadiness,
} from "../lib/workflow-publication-validation";

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
type DefinitionStepSummary = {
  workflow_id: string;
  id: string;
  name: string;
  sort_order: number;
  actor_scope: string;
  is_active: number;
  module_names: string;
  module_count: number;
  field_count: number;
  required_field_count: number;
  optional_field_count: number;
  hidden_field_count: number;
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
  updated_at: string;
};
type BatchEditableStepField = StepField & {
  step_key: string;
  step_name: string;
};
type StagedWorkflowFieldModeChange = {
  field: StepField;
  currentMode: EditableWorkflowFieldMode;
  mode: EditableWorkflowFieldMode;
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
export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "workflow.view");
  await ensureWorkflowCatalogFields(current.organizationId);
  const defaultWorkflowId = await ensureDefaultWorkflow(current.organizationId);
  const url = new URL(request.url);
  const requestedWorkflowId = url.searchParams.get("workflowId");
  const requestedFieldId = url.searchParams.get("fieldId");
  const requestedStepKey = url.searchParams.get("stepKey");
  const requestedModuleCode = url.searchParams.get("moduleCode");
  const requestedFieldKey = url.searchParams.get("fieldKey");
  const fieldDeepLinkRequested = Boolean(requestedFieldId || requestedFieldKey);
  const openEditor = url.searchParams.get("edit") === "1" || fieldDeepLinkRequested;

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

  const [steps, fields, stepModules, moduleTasks] = await Promise.all([
    env.DB.prepare(
      "SELECT id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope FROM workflow_steps WHERE workflow_id = ? ORDER BY sort_order, step_key",
    )
      .bind(workflowId)
      .all<Step>(),
    env.DB.prepare(
      "SELECT id, step_id, field_key, label, field_type, is_required, is_active, sort_order, options_text, help_text, COALESCE(module_code,'consignment') module_code, updated_at FROM workflow_step_fields WHERE workflow_id=? ORDER BY sort_order, field_key",
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
  ]);
  const [positions, positionReadiness, definitionSteps] = await Promise.all([
    env.DB.prepare(
      `SELECT p.code,p.name,d.name department_name
       FROM positions p LEFT JOIN departments d ON d.organization_id=p.organization_id AND d.code=p.department_code
       WHERE p.organization_id=? AND p.status='active' ORDER BY p.sort_order,p.name`,
    ).bind(current.organizationId).all<PositionOption>(),
    loadPublicationPositionReadiness(current.organizationId),
    env.DB.prepare(
      `SELECT ws.workflow_id,ws.id,ws.name,ws.sort_order,ws.actor_scope,ws.is_active,
        COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN wsm.is_active=1 THEN wsm.display_name END),'') module_names,
        COUNT(DISTINCT CASE WHEN wsm.is_active=1 THEN wsm.id END) module_count,
        COUNT(DISTINCT wsf.id) field_count,
        COUNT(DISTINCT CASE WHEN wsf.is_active=1 AND wsf.is_required=1 THEN wsf.id END) required_field_count,
        COUNT(DISTINCT CASE WHEN wsf.is_active=1 AND wsf.is_required=0 THEN wsf.id END) optional_field_count,
        COUNT(DISTINCT CASE WHEN wsf.is_active=0 THEN wsf.id END) hidden_field_count
       FROM workflow_steps ws
       JOIN workflow_definitions wd ON wd.id=ws.workflow_id
       LEFT JOIN workflow_step_modules wsm ON wsm.workflow_id=ws.workflow_id AND wsm.step_id=ws.id
       LEFT JOIN workflow_step_fields wsf ON wsf.workflow_id=ws.workflow_id AND wsf.step_id=ws.id
       WHERE wd.organization_id=?
       GROUP BY ws.id
       ORDER BY ws.workflow_id,ws.sort_order,ws.id`,
    ).bind(current.organizationId).all<DefinitionStepSummary>(),
  ]);
  const impactRows: Array<
    readonly [
      string,
      Awaited<ReturnType<typeof inspectWorkflowFieldPolicyImpact>>,
    ]
  > = [];
  for (const step of steps.results) {
    impactRows.push([
      step.step_key,
      await inspectWorkflowFieldPolicyImpact(workflowId,step.step_key),
    ] as const);
  }
  const focusedField = fields.results.find((field) => field.id === requestedFieldId) ??
    fields.results.find((field) => workflowFieldIdentityMatches({
      fieldKey:field.field_key,
      moduleCode:field.module_code,
      stepKey:steps.results.find((step) => step.id === field.step_id)?.step_key || "",
    },{
      fieldKey:requestedFieldKey || undefined,
      moduleCode:requestedModuleCode || undefined,
      stepKey:requestedStepKey || undefined,
    }));
  return {
    current,
    openEditor,
    focusedFieldId: focusedField?.id ?? null,
    definitions: definitions.results,
    definitionSteps: definitionSteps.results,
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
      fields.results,
      positionReadiness.results,
    ),
    fieldPolicyImpacts:Object.fromEntries(impactRows) as Record<string,WorkflowFieldPolicyImpact>,
    canEdit: canEditWorkflowDefinition(current),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "workflow.manage");
  await ensureWorkflowCatalogFields(current.organizationId);
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
    throw redirect(`/admin/workflow?workflowId=${encodeURIComponent(id)}&edit=1#workflow-editor`);
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
    throw redirect(`/admin/workflow?workflowId=${encodeURIComponent(id)}&edit=1#workflow-editor`);
  }

  if (intent === "validate" || intent === "publish") {
    if (definition.lifecycle_status !== "draft") return { formError: "只有草稿版本可以校验或发布" };
    const issues = await loadWorkflowValidationIssues(definition.id, current.organizationId);
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

  if (intent === "field_modes_batch_update") {
    const requestedChanges = parseWorkflowFieldModeChanges(
      valueOf(form,"fieldChanges"),
      500,
    );
    if (!requestedChanges)
      return { formError:"字段规则变更清单无效或超过 500 项，请刷新页面后核对" };
    const requestedById = new Map(requestedChanges.map((item)=>[item.fieldId,item]));
    const fields: BatchEditableStepField[] = [];
    for (const idChunk of chunkD1Values(requestedChanges.map((item)=>item.fieldId),1)) {
      const rows = await env.DB.prepare(
        `SELECT f.id,f.step_id,s.step_key,s.name step_name,f.field_key,f.label,f.field_type,
          f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,
          COALESCE(f.module_code,'consignment') module_code,f.updated_at
         FROM workflow_step_fields f JOIN workflow_steps s ON s.id=f.step_id
         WHERE f.workflow_id=? AND f.id IN (${d1Placeholders(idChunk.length)})`,
      ).bind(workflowId,...idChunk).all<BatchEditableStepField>();
      fields.push(...rows.results);
    }
    if (fields.length !== requestedChanges.length)
      return { formError:"部分字段不存在或已不属于当前工作流，请刷新后重新配置" };
    const staleFields = fields.filter((field)=>
      requestedById.get(field.id)?.updatedAt !== field.updated_at,
    );
    if (staleFields.length)
      return { formError:`${staleFields.map((field)=>`“${field.label}”`).join("、")} 已被其他窗口修改，本次没有应用任何变更，请刷新后重试` };
    const changes = fields.map((field)=>({
      field,
      previousMode:workflowFieldMode(field),
      mode:requestedById.get(field.id)!.mode,
      updatedAt:requestedById.get(field.id)!.updatedAt,
    })).filter((item)=>item.previousMode!==item.mode);
    if (!changes.length) return { success:"字段规则没有变化，无需应用" };
    const impacts = new Map<string,WorkflowFieldPolicyImpact>();
    for (const stepKey of [...new Set(changes.map((item)=>item.field.step_key))]) {
      impacts.set(stepKey,await inspectWorkflowFieldPolicyImpact(workflowId,stepKey));
    }
    if ([...impacts.values()].some((impact)=>impact.total>0)&&valueOf(form,"impactConfirmed")!=="1")
      return { formError:"本次变更会影响现有订单，请先预览影响并在弹窗中二次确认" };

    const updateStatements: D1PreparedStatement[] = [];
    for (const mode of ["required","optional","hidden"] as const) {
      const modeChanges = changes.filter((item)=>item.mode===mode);
      const flags = editableWorkflowFieldFlags(mode);
      for (const changeChunk of chunkD1Rows(modeChanges,2,4)) {
        updateStatements.push(env.DB.prepare(
          `UPDATE workflow_step_fields SET is_required=?,is_active=?,updated_at=?
           WHERE workflow_id=? AND (${changeChunk.map(()=>"(id=? AND updated_at=?)").join(" OR ")})`,
        ).bind(
          flags.isRequired,flags.isActive,now,workflowId,
          ...changeChunk.flatMap((item)=>[item.field.id,item.updatedAt]),
        ));
      }
    }
    const updateResults = await env.DB.batch(updateStatements);
    const appliedCount = updateResults.reduce((sum,result)=>sum+Number(result.meta.changes||0),0);
    if (appliedCount !== changes.length)
      return { formError:"应用过程中检测到字段版本冲突，请刷新工作流核对最新规则" };

    let supplementCreated=0,supplementCancelled=0,preservedFiles=0,preservedValues=0;
    const auditChanges: Record<string,unknown>[] = [];
    for (const change of changes) {
      const {field,mode,previousMode}=change;
      const flags=editableWorkflowFieldFlags(mode);
      await synchronizeWorkflowFieldDefinitionForInstances({
        workflowId,
        stepKey:field.step_key,
        fieldKey:field.field_key,
        moduleCode:field.module_code,
        label:field.label,
        fieldType:field.field_type,
        isRequired:flags.isRequired,
        isActive:flags.isActive,
        sortOrder:field.sort_order,
        optionsText:field.options_text,
        helpText:field.help_text,
      });
      if (flags.isActive)
        await ensureFieldPolicyModule(workflowId,field.step_id,field.module_code,flags.isRequired,now);
      await reconcileFieldPolicyModule(workflowId,field.step_id,field.module_code,now);
      const supplementTasks=await synchronizeWorkflowSupplementTasks({
        organizationId:current.organizationId,
        workflowId,
        targetStepKey:field.step_key,
        moduleCode:field.module_code,
        fieldKey:field.field_key,
        fieldLabel:field.label,
        mode,
        actorUserId:current.userId,
      });
      supplementCreated+=supplementTasks.created;
      supplementCancelled+=supplementTasks.cancelled;
      const runtimeStatus=await reconcileWorkflowFieldRuntimeStatus({
        organizationId:current.organizationId,
        workflowId,
        targetStepKey:field.step_key,
        moduleCode:field.module_code,
        fieldKey:field.field_key,
        actorUserId:current.userId,
        now,
      });
      const preserved=flags.preservesStoredValue
        ?await inspectHiddenWorkflowFieldData({
          organizationId:current.organizationId,
          workflowId,
          fieldKey:field.field_key,
          moduleCode:field.module_code,
        })
        :null;
      preservedFiles+=preserved?.preservedFiles??0;
      preservedValues+=preserved?.preservedCustomValues??0;
      auditChanges.push({
        fieldId:field.id,
        fieldKey:field.field_key,
        fieldLabel:field.label,
        stepKey:field.step_key,
        previousMode,
        mode,
        impact:impacts.get(field.step_key),
        supplementTasks,
        runtimeStatus,
        preserved,
      });
    }
    const orderRefresh = await refreshOrdersAffectedByWorkflowFields({
      organizationId: current.organizationId,
      workflowId,
      changes: changes.map(({ field }) => ({
        moduleCode: field.module_code,
        stepKey: field.step_key,
      })),
      now,
    });
    await writeAudit({
      request,
      action:"workflow.field.requirement.batch_update",
      resourceType:"workflow_definition",
      resourceId:workflowId,
      organizationId:current.organizationId,
      actorUserId:current.userId,
      metadata:{workflowId,lifecycleStatus:definition.lifecycle_status,changes:auditChanges,orderRefresh},
    });
    const summary=changes.slice(0,8).map((item)=>
      `${item.field.label}：${workflowModeLabel(item.previousMode)}→${workflowModeLabel(item.mode)}`,
    ).join("；");
    await broadcastInternalNotification({
      organizationId:current.organizationId,
      actorUserId:current.userId,
      category:"workflow_field_policy_changed",
      severity:changes.some((item)=>item.mode==="required")?"critical":"warning",
      title:`工作流字段规则已批量变更：${changes.length} 项`,
      message:`${summary}${changes.length>8?`；另有 ${changes.length-8} 项` : ""}。历史节点不会回退，后续门禁已同步。`,
      link:`/admin/workflow?workflowId=${encodeURIComponent(workflowId)}`,
      requiresLeadershipAck:true,
    });
    const taskText=[
      supplementCreated?`新增 ${supplementCreated} 项补录任务`:"",
      supplementCancelled?`关闭 ${supplementCancelled} 项旧补录任务`:"",
    ].filter(Boolean).join("，");
    const preservedText=preservedFiles||preservedValues
      ?`；保留 ${preservedFiles} 个历史文件和 ${preservedValues} 条历史值`
      :"";
    return { success:`已一次应用 ${changes.length} 项字段规则，现有订单后续门禁已同步${taskText?`；${taskText}`:""}${preservedText}` };
  }

  if (intent === "field_mode_update") {
    const fieldId = valueOf(form, "fieldId");
    const mode = editableWorkflowFieldMode(valueOf(form, "fieldMode"));
    if (!mode) return { formError: "字段规则只能设置为必填、选填或隐藏" };
    const field = await env.DB.prepare(
      `SELECT f.id,f.step_id,s.step_key,f.field_key,f.label,f.field_type,f.is_required,f.is_active,f.sort_order,
        f.options_text,f.help_text,COALESCE(f.module_code,'consignment') module_code,f.updated_at
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
        is_required:number;
        is_active: number;
        sort_order: number;
        options_text: string | null;
        help_text: string | null;
        module_code: OrderModuleCode;
        updated_at: string;
    }>();
    if (!field) return { formError: "字段不存在" };
    const previousMode=workflowFieldMode(field);
    if(previousMode===mode)return{success:`字段“${field.label}”当前已经是${mode==="required"?"必填":mode==="optional"?"选填":"隐藏"}`};
    const impact=await inspectWorkflowFieldPolicyImpact(workflowId,field.step_key);
    if(impact.total>0&&valueOf(form,"impactConfirmed")!=="1"){
      return{formError:"该规则会影响现有订单，请先查看分层影响并在弹窗中二次确认"};
    }
    const flags = editableWorkflowFieldFlags(mode);
    const expectedUpdatedAt=valueOf(form,"fieldUpdatedAt");
    if(!expectedUpdatedAt)return{formError:"字段版本信息缺失，请刷新工作流后重试"};
    const updateResult=await env.DB.prepare(
      "UPDATE workflow_step_fields SET is_required=?,is_active=?,updated_at=? WHERE id=? AND workflow_id=? AND updated_at=?",
    )
      .bind(flags.isRequired, flags.isActive, now, field.id, workflowId, expectedUpdatedAt)
      .run();
    if(!updateResult.meta.changes){
      return{formError:"该字段已被其他窗口修改，请刷新后查看最新规则再操作"};
    }
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
    const supplementTasks=await synchronizeWorkflowSupplementTasks({
      organizationId:current.organizationId,
      workflowId,
      targetStepKey:field.step_key,
      moduleCode:field.module_code,
      fieldKey:field.field_key,
      fieldLabel:field.label,
      mode,
      actorUserId:current.userId,
    });
    const runtimeStatus=await reconcileWorkflowFieldRuntimeStatus({
      organizationId:current.organizationId,
      workflowId,
      targetStepKey:field.step_key,
      moduleCode:field.module_code,
      fieldKey:field.field_key,
      actorUserId:current.userId,
      now,
    });
    const preserved = flags.preservesStoredValue
      ? await inspectHiddenWorkflowFieldData({
          organizationId: current.organizationId,
          workflowId,
          fieldKey: field.field_key,
          moduleCode: field.module_code,
        })
      : null;
    const orderRefresh = await refreshOrdersAffectedByWorkflowFields({
      organizationId: current.organizationId,
      workflowId,
      changes: [{ moduleCode: field.module_code, stepKey: field.step_key }],
      now,
    });
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
        previousMode,
        mode,
        preserved,
        impact,
        supplementTasks,
        runtimeStatus,
        orderRefresh,
      },
    });
    await broadcastInternalNotification({
      organizationId:current.organizationId,
      actorUserId:current.userId,
      category:"workflow_field_policy_changed",
      severity:mode==="required"?"critical":"warning",
      title:`工作流字段规则已变更：${field.label}`,
      message:`${field.label} 已由${previousMode==="required"?"必填":previousMode==="optional"?"选填":"隐藏"}改为${mode==="required"?"必填":mode==="optional"?"选填":"隐藏"}。影响 ${impact.total} 张订单：当前 ${impact.current}、未来 ${impact.future}、历史补录 ${impact.historical}、审计补录 ${impact.auditOnly}；历史节点不会回退。`,
      link:`/admin/workflow?workflowId=${encodeURIComponent(workflowId)}`,
      requiresLeadershipAck:true,
    });
    const preservedText = preserved && (preserved.preservedFiles || preserved.preservedCustomValues)
      ? `；历史数据已保留（${preserved.preservedFiles} 个文件、${preserved.preservedCustomValues} 条自定义值）`
      : "";
    const modeLabel = mode === "required" ? "必填" : mode === "optional" ? "选填" : "隐藏";
    const taskText=supplementTasks.created?`；已创建 ${supplementTasks.created} 项资料补录任务`:supplementTasks.cancelled?`；已关闭 ${supplementTasks.cancelled} 项旧补录任务`:"";
    return { success: `字段“${field.label}”已设为${modeLabel}，现有订单后续门禁已同步${taskText}${preservedText}` };
  }

  if (!workflowIntentAllowedForUsage(intent, definition.instance_count) && intent !== "advance") {
    return { formError: "该工作流已被订单使用：可新增字段并调整必填、选填或隐藏；不能增删节点、模组和办理步骤，也不能改写既有字段结构" };
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
    const duplicate = await env.DB.prepare(
      "SELECT 1 FROM workflow_step_fields WHERE workflow_id=? AND step_id=? AND field_key=?",
    ).bind(workflowId,step.id,parsed.fieldKey).first();
    if (duplicate) return { formError: `当前节点已存在编码为“${parsed.fieldKey}”的字段` };
    const impact=await inspectWorkflowFieldPolicyImpact(workflowId,step.step_key);
    if(impact.total>0&&valueOf(form,"impactConfirmed")!=="1"){
      return{formError:"新增字段会同步到现有订单，请先查看分层影响并在弹窗中二次确认"};
    }
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
    await synchronizeWorkflowFieldDefinitionForInstances({
      workflowId,
      stepKey:step.step_key,
      fieldKey:parsed.fieldKey,
      moduleCode:parsed.moduleCode,
      label:parsed.label,
      fieldType:parsed.fieldType,
      isRequired:parsed.required,
      isActive:parsed.active,
      sortOrder:parsed.sortOrder,
      optionsText:parsed.optionsText,
      helpText:parsed.helpText,
    });
    if (parsed.active) {
      await ensureFieldPolicyModule(workflowId, step.id, parsed.moduleCode, parsed.required, now);
    }
    await reconcileFieldPolicyModule(workflowId, step.id, parsed.moduleCode, now);
    const supplementTasks=await synchronizeWorkflowSupplementTasks({
      organizationId:current.organizationId,
      workflowId,
      targetStepKey:step.step_key,
      moduleCode:parsed.moduleCode,
      fieldKey:parsed.fieldKey,
      fieldLabel:parsed.label,
      mode:parsed.mode,
      actorUserId:current.userId,
    });
    const runtimeStatus=await reconcileWorkflowFieldRuntimeStatus({
      organizationId:current.organizationId,
      workflowId,
      targetStepKey:step.step_key,
      moduleCode:parsed.moduleCode,
      fieldKey:parsed.fieldKey,
      actorUserId:current.userId,
      now,
    });
    const orderRefresh = await refreshOrdersAffectedByWorkflowFields({
      organizationId: current.organizationId,
      workflowId,
      changes: [{ moduleCode: parsed.moduleCode, stepKey: step.step_key }],
      now,
    });
    await writeAudit({
      request,
      action:"workflow.field.create",
      resourceType:"workflow_step_field",
      resourceId:id,
      organizationId:current.organizationId,
      actorUserId:current.userId,
      metadata:{workflowId,stepKey:step.step_key,fieldKey:parsed.fieldKey,mode:parsed.mode,impact,supplementTasks,runtimeStatus,orderRefresh},
    });
    await broadcastInternalNotification({
      organizationId:current.organizationId,
      actorUserId:current.userId,
      category:"workflow_field_added",
      severity:parsed.mode==="required"?"critical":"warning",
      title:`工作流新增字段：${parsed.label}`,
      message:`“${parsed.label}”已加入“${step.step_key}”节点并设为${workflowModeLabel(parsed.mode)}。影响 ${impact.total} 张订单；历史节点不回退${supplementTasks.created?`，已生成 ${supplementTasks.created} 项补录任务`:""}。`,
      link:`/admin/workflow?workflowId=${encodeURIComponent(workflowId)}`,
      requiresLeadershipAck:true,
    });
    return { success: `字段“${parsed.label}”已新增并同步到 ${impact.total} 张现有订单${supplementTasks.created?`；已创建 ${supplementTasks.created} 项资料补录任务`:""}` };
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
      `SELECT id,step_id,COALESCE(module_code,?) module_code,is_required,is_active,sort_order
       FROM workflow_step_fields
       WHERE workflow_id=? AND field_key=? AND COALESCE(module_code,?)=?`,
    ).bind(catalog.moduleCode,workflowId,catalog.fieldKey,catalog.moduleCode,catalog.moduleCode)
      .first<{ id: string; step_id: string; module_code: OrderModuleCode;is_required:number;is_active:number;sort_order:number }>();
    const placementLock=workflowFieldPlacementLock({
      instanceCount:definition.instance_count,
      currentStepId:exists?.step_id??null,
      targetStepId:step.id,
      currentSortOrder:exists?.sort_order??null,
      targetSortOrder:sortOrder,
    });
    if(placementLock==="position"){
      return{formError:"工作流已有订单，不能移动已有字段；可以在目标节点新增另一个字段"};
    }
    const previousMode=exists?workflowFieldMode(exists):null;
    if(exists?.step_id===step.id&&previousMode===mode&&exists.sort_order===sortOrder){
      return{success:`业务字段“${catalog.label}”当前规则未变化`};
    }
    if(placementLock==="sort"){
      return{formError:"工作流已有订单，既有字段顺序已锁定，只能修改可填、必填或隐藏状态"};
    }
    const impact=await inspectWorkflowFieldPolicyImpact(workflowId,step.step_key);
    if(impact.total>0&&valueOf(form,"impactConfirmed")!=="1"){
      return{formError:"字段积木变更会影响现有订单，请先查看分层影响并在弹窗中二次确认"};
    }
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
    if (flags.preservesStoredValue) {
      await inspectHiddenWorkflowFieldData({
        organizationId: current.organizationId,
        workflowId,
        fieldKey: catalog.fieldKey,
        moduleCode: catalog.moduleCode,
      });
    }
    const supplementTasks=await synchronizeWorkflowSupplementTasks({
      organizationId:current.organizationId,
      workflowId,
      targetStepKey:step.step_key,
      moduleCode:catalog.moduleCode,
      fieldKey:catalog.fieldKey,
      fieldLabel:catalog.label,
      mode,
      actorUserId:current.userId,
    });
    const runtimeStatus=await reconcileWorkflowFieldRuntimeStatus({
      organizationId:current.organizationId,
      workflowId,
      targetStepKey:step.step_key,
      moduleCode:catalog.moduleCode,
      fieldKey:catalog.fieldKey,
      actorUserId:current.userId,
      now,
    });
    const orderRefresh = await refreshOrdersAffectedByWorkflowFields({
      organizationId: current.organizationId,
      workflowId,
      changes: [{ moduleCode: catalog.moduleCode, stepKey: step.step_key }],
      now,
    });
    await writeAudit({
      request,
      action: "workflow.field.block.assign",
      resourceType: "workflow_step_field",
      resourceId: fieldId,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      metadata: { workflowId, stepKey: step.step_key, fieldKey: catalog.fieldKey, mode, moved: Boolean(exists&&exists.step_id!==step.id), impact, supplementTasks, runtimeStatus, orderRefresh },
    });
    await broadcastInternalNotification({
      organizationId:current.organizationId,
      actorUserId:current.userId,
      category:"workflow_field_catalog_changed",
      severity:mode==="required"?"critical":"warning",
      title:`工作流字段积木已变更：${catalog.label}`,
      message:`“${catalog.label}”已${exists?"更新":"加入"}到“${step.step_key}”并设为${workflowModeLabel(mode)}。影响 ${impact.total} 张订单；历史节点不回退${supplementTasks.created?`，已生成 ${supplementTasks.created} 项补录任务`:""}。`,
      link:`/admin/workflow?workflowId=${encodeURIComponent(workflowId)}`,
      requiresLeadershipAck:true,
    });
    return { success: `业务字段“${catalog.label}”已${exists ? "更新" : "加入"}到“${step.step_key}”，${impact.total} 张现有订单已同步${supplementTasks.created?`；已创建 ${supplementTasks.created} 项补录任务`:""}` };
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
      sourceStepKey: field.step_key,
      sourceFieldKey: field.field_key,
      sourceModuleCode: field.module_code,
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
      await inspectHiddenWorkflowFieldData({
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
    "SELECT id,step_key,name,entity_type,trigger_event,sort_order,is_required,is_active,actor_scope FROM workflow_steps WHERE workflow_id=? ORDER BY sort_order,step_key",
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
        normalizeWorkflowStepRequiredFlag(step.is_required),
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

async function synchronizeWorkflowExecutionSnapshots(
  workflowId: string,
  targetStepId: string,
) {
  const instances = await env.DB.prepare(
    `SELECT wi.id
     FROM workflow_instances wi
     JOIN workflow_steps current_step
       ON current_step.workflow_id=wi.workflow_id
      AND current_step.step_key=wi.current_step_key
     JOIN workflow_steps target_step
       ON target_step.workflow_id=wi.workflow_id
      AND target_step.id=?
     WHERE wi.workflow_id=?
       AND current_step.sort_order<=target_step.sort_order
     ORDER BY wi.id`,
  ).bind(targetStepId,workflowId).all<{ id: string }>();
  const chunkSize = 4;
  for (let index = 0; index < instances.results.length; index += chunkSize) {
    await Promise.all(
      instances.results.slice(index, index + chunkSize).map((instance) =>
        ensureWorkflowExecutionSnapshot({ instanceId: instance.id, workflowId }),
      ),
    );
  }
}

async function refreshOrdersAffectedByWorkflowFields(input: {
  organizationId: string;
  workflowId: string;
  changes: readonly { moduleCode: OrderModuleCode; stepKey: string }[];
  now: string;
}) {
  return refreshOrdersForWorkflowFieldChanges({
    changes: input.changes,
    listAffectedOrderIds: async (targetStepKeys) => {
      if (!targetStepKeys.length) return [];
      const affected = await env.DB.prepare(
        `SELECT DISTINCT wi.order_id
         FROM workflow_instances wi
         JOIN workflow_steps current_step
           ON current_step.workflow_id=wi.workflow_id
          AND current_step.step_key=wi.current_step_key
         JOIN workflow_steps target_step
           ON target_step.workflow_id=wi.workflow_id
         JOIN transport_orders o
           ON o.id=wi.order_id
          AND o.organization_id=wi.organization_id
         WHERE wi.organization_id=?
           AND wi.workflow_id=?
           AND wi.status='active'
           AND wi.order_id IS NOT NULL
           AND target_step.step_key IN (${d1Placeholders(targetStepKeys.length)})
           AND current_step.sort_order<=target_step.sort_order
           AND o.status NOT IN ('completed','cancelled')
         ORDER BY wi.order_id`,
      ).bind(
        input.organizationId,
        input.workflowId,
        ...targetStepKeys,
      ).all<{ order_id: string }>();
      return affected.results.map((item) => item.order_id);
    },
    syncCostsModuleStatus: (orderId) =>
      syncCostsModuleStatus(input.organizationId, orderId, input.now),
    syncOrderWorkflowSnapshot: (orderId) =>
      syncOrderWorkflowSnapshot(input.organizationId, orderId),
  });
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
    await synchronizeWorkflowExecutionSnapshots(workflowId,stepId);
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
  await synchronizeWorkflowExecutionSnapshots(workflowId,stepId);
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
  }
  await env.DB.prepare(
    `UPDATE workflow_instance_module_states
     SET is_required=?,updated_at=?
     WHERE step_module_id=?
       AND EXISTS(
         SELECT 1
         FROM workflow_instance_step_states target_state
         JOIN workflow_instances wi ON wi.id=target_state.instance_id
         JOIN workflow_steps current_step
           ON current_step.workflow_id=wi.workflow_id
          AND current_step.step_key=wi.current_step_key
         JOIN workflow_steps target_step
           ON target_step.workflow_id=wi.workflow_id
          AND target_step.id=?
         WHERE target_state.id=workflow_instance_module_states.instance_step_state_id
           AND current_step.sort_order<=target_step.sort_order
       )`,
  ).bind(activeCount ? required : 0, now, module.id, stepId).run();
  if (activeCount) await synchronizeWorkflowExecutionSnapshots(workflowId,stepId);
}

function validateWorkflowConfiguration(
  steps: Step[],
  modules: StepModule[],
  tasks: ModuleTask[],
  fields: StepField[] = [],
  positions: PublicationPositionReadiness[] = [],
) {
  const issues: string[] = [];
  const activeSteps = steps.filter((item) => item.is_active).sort((a,b) => a.sort_order-b.sort_order);
  if (!activeSteps.length) issues.push("至少需要一个启用节点");
  if (activeSteps.length && activeSteps[0].trigger_event !== "quote.created")
    issues.push("第一个启用节点必须是询价报价，并承接报价首次保存");
  const duplicateStepOrders = activeSteps.filter(
    (item,index) => activeSteps.findIndex((other) => other.sort_order === item.sort_order) !== index,
  );
  if (duplicateStepOrders.length) issues.push("启用节点的顺序不能重复");
  const requiredRuntimeSteps = [
    "quotation","order_creation","consignment_approval","task_assignment","domestic_execution",
    "warehouse_receiving","port_loading","outbound_transport","overseas_pickup",
    "reconciliation","completion_review",
  ];
  const missingRuntimeSteps = requiredRuntimeSteps.filter(
    (key)=>!activeSteps.some((step)=>step.step_key===key),
  );
  if (missingRuntimeSteps.length)
    issues.push(`第一版运行链缺少基础节点：${missingRuntimeSteps.join("、")}`);
  const quotationStep = activeSteps.find((step) => step.step_key === "quotation");
  if (quotationStep) {
    const quotationKeys = new Set(
      fields.filter((field) => field.step_id === quotationStep.id).map((field) => field.field_key),
    );
    const missingQuotationFields = quotationNativeFieldCatalog.filter(
      (field) => !quotationKeys.has(field.fieldKey),
    );
    if (missingQuotationFields.length)
      issues.push(`询价报价节点缺少标准字段：${missingQuotationFields.map((field) => field.label).join("、")}`);
  }
  const duplicateFieldKeys = fields.filter(
    (field,index) => fields.findIndex((other) => other.field_key === field.field_key) !== index,
  );
  if (duplicateFieldKeys.length)
    issues.push(`同一工作流内字段键不能跨节点重复：${[...new Set(duplicateFieldKeys.map((field) => field.field_key))].join("、")}`);
  for (const step of activeSteps) {
    const stepModules = modules.filter((item) => item.step_id === step.id && item.is_active);
    if (!stepModules.length) issues.push(`节点“${step.name}”没有启用的功能模组`);
    for (const stepModule of stepModules) {
      const activeTasks = tasks.filter((item) => item.step_module_id === stepModule.id && item.is_active);
      if (stepModule.completion_mode !== "automatic" && !activeTasks.length)
        issues.push(`模组“${stepModule.display_name}”没有办理步骤`);
    }
  }
  issues.push(...validateWorkflowResponsibilityReadiness({ steps, modules, tasks, positions }));
  return [...new Set(issues)];
}

async function loadWorkflowValidationIssues(workflowId: string, organizationId: string) {
  const [steps,modules,tasks,fields,positions] = await Promise.all([
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
    env.DB.prepare(
      `SELECT id,step_id,field_key,label,field_type,is_required,is_active,sort_order,
        options_text,help_text,COALESCE(module_code,'consignment') module_code
       FROM workflow_step_fields WHERE workflow_id=? ORDER BY sort_order,field_key`,
    ).bind(workflowId).all<StepField>(),
    loadPublicationPositionReadiness(organizationId),
  ]);
  return validateWorkflowConfiguration(
    steps.results,
    modules.results,
    tasks.results,
    fields.results,
    positions.results,
  );
}

function loadPublicationPositionReadiness(organizationId: string) {
  return env.DB.prepare(
    `SELECT p.code,p.name,p.status,
       COUNT(DISTINCT CASE WHEN m.status='active' AND u.status='active' THEN m.user_id END) active_member_count,
       GROUP_CONCAT(DISTINCT CASE
         WHEN m.status='active' AND u.status='active'
         THEN effective_permission.permission_code END) permission_codes
     FROM positions p
     LEFT JOIN memberships m
       ON m.organization_id=p.organization_id AND m.position_id=p.id
     LEFT JOIN users u ON u.id=m.user_id
     LEFT JOIN (
       SELECT effective_membership.position_id,role_permission.permission_code
       FROM memberships effective_membership
       JOIN users effective_user
         ON effective_user.id=effective_membership.user_id
        AND effective_user.status='active'
       JOIN membership_roles effective_membership_role
         ON effective_membership_role.membership_id=effective_membership.id
       JOIN roles effective_role
         ON effective_role.id=effective_membership_role.role_id
        AND effective_role.organization_id=effective_membership.organization_id
        AND effective_role.status='active'
       JOIN role_permissions role_permission ON role_permission.role_id=effective_role.id
       WHERE effective_membership.status='active'
         AND NOT EXISTS (
           SELECT 1 FROM membership_permission_overrides denied
           WHERE denied.membership_id=effective_membership.id
             AND denied.permission_code=role_permission.permission_code
             AND denied.effect='deny'
         )
       UNION
       SELECT effective_membership.position_id,allowed.permission_code
       FROM memberships effective_membership
       JOIN users effective_user
         ON effective_user.id=effective_membership.user_id
        AND effective_user.status='active'
       JOIN membership_permission_overrides allowed
         ON allowed.membership_id=effective_membership.id AND allowed.effect='allow'
       WHERE effective_membership.status='active'
     ) effective_permission ON effective_permission.position_id=p.id
     WHERE p.organization_id=?
     GROUP BY p.id,p.code,p.name,p.status
     ORDER BY p.sort_order,p.name`,
  ).bind(organizationId).all<PublicationPositionReadiness>();
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
  const mode = editableWorkflowFieldMode(valueOf(form, "fieldMode") || "optional");
  if (!mode) return { formError: "填写规则只能设置为必填、选填或隐藏" };
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
    mode,
    sortOrder,
    required: flags.isRequired,
    active: flags.isActive,
    optionsText: valueOf(form, "optionsText").trim() || null,
    helpText: valueOf(form, "helpText").trim() || null,
  };
}

function workflowModeLabel(mode:"required"|"optional"|"hidden"){
  return mode==="required"?"必填":mode==="optional"?"选填":"隐藏";
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
  if (code === "ltl") return "拼车型";
  if (code === "ftl") return "整车型";
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
  const [editorOpen, setEditorOpen] = useState(loaderData.openEditor);
  const successMessage = actionData && "success" in actionData ? actionData.success : null;
  const formError = actionData && "formError" in actionData ? actionData.formError : null;
  useEffect(() => {
    if (successMessage) {
      setEditorOpen(false);
      return;
    }
    if (loaderData.openEditor) setEditorOpen(true);
  }, [loaderData.definition.id, loaderData.openEditor, successMessage]);
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
  const definitionStepsByWorkflow = new Map<string, DefinitionStepSummary[]>();
  for (const step of loaderData.definitionSteps) {
    const list = definitionStepsByWorkflow.get(step.workflow_id) ?? [];
    list.push(step);
    definitionStepsByWorkflow.set(step.workflow_id, list);
  }
  const workflowGroups = partitionWorkflowDefinitionsByRoadType(loaderData.definitions);

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

      <section className="workflow-type-groups" aria-label="按订单类型分类的工作流">
        <WorkflowTypeGroup
          type="ftl"
          definitions={workflowGroups.ftl}
          definitionStepsByWorkflow={definitionStepsByWorkflow}
          selectedId={loaderData.definition.id}
          manage={manage}
          busy={busy}
          onEditSelected={() => setEditorOpen(true)}
        />
        <WorkflowTypeGroup
          type="ltl"
          definitions={workflowGroups.ltl}
          definitionStepsByWorkflow={definitionStepsByWorkflow}
          selectedId={loaderData.definition.id}
          manage={manage}
          busy={busy}
          onEditSelected={() => setEditorOpen(true)}
        />
      </section>
      {workflowGroups.unclassified.length > 0 && (
        <div className="alert error">发现 {workflowGroups.unclassified.length} 个未标记整车/拼车类型的历史工作流，已从候选列表隔离，请先修复类型后再使用。</div>
      )}

      {manage && (
        <Modal
          title={`节点配置 · ${loaderData.definition.name}`}
          size="xwide"
          isOpen={editorOpen}
          onOpenChange={setEditorOpen}
        >
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
            fieldPolicyImpacts={loaderData.fieldPolicyImpacts}
            focusedFieldId={loaderData.focusedFieldId}
          />
        </Modal>
      )}
    </>
  );
}

function WorkflowTypeGroup({
  type,
  definitions,
  definitionStepsByWorkflow,
  selectedId,
  manage,
  busy,
  onEditSelected,
}: {
  type: "ftl" | "ltl";
  definitions: Definition[];
  definitionStepsByWorkflow: Map<string, DefinitionStepSummary[]>;
  selectedId: string;
  manage: boolean;
  busy: boolean;
  onEditSelected: () => void;
}) {
  const label = type === "ftl" ? "整车工作流" : "拼车工作流";
  return (
    <section className={`panel workflow-type-group workflow-type-${type}`}>
      <div className="panel-header workflow-type-group-header">
        <div>
          <div className="workflow-type-title"><span className="workflow-type-code">{type.toUpperCase()}</span><h2>{label}</h2></div>
          <p>{type === "ftl" ? "仅用于整车报价与订单，不会出现在拼车工作流候选项中。" : "仅用于拼车报价与订单，不会与整车工作流混用。"}</p>
        </div>
        <span className="status-pill">{definitions.length} 个版本</span>
      </div>
      <div className="workflow-definition-cards">
        {definitions.map((definition) => (
          <WorkflowDefinitionCard
            key={definition.id}
            definition={definition}
            steps={definitionStepsByWorkflow.get(definition.id) ?? []}
            selected={definition.id === selectedId}
            manage={manage}
            busy={busy}
            onEditSelected={onEditSelected}
          />
        ))}
        {!definitions.length && <div className="empty-state">尚未创建{label}。</div>}
      </div>
    </section>
  );
}

function WorkflowDefinitionCard({
  definition,
  steps,
  selected,
  manage,
  busy,
  onEditSelected,
}: {
  definition: Definition;
  steps: DefinitionStepSummary[];
  selected: boolean;
  manage: boolean;
  busy: boolean;
  onEditSelected: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const capabilities = workflowEditCapabilities(definition.instance_count);
  const activeSteps = steps.filter((step) => step.is_active);
  const hiddenFieldCount = steps.reduce((total, step) => total + step.hidden_field_count, 0);
  const cloneName = `${definition.name.slice(0, 52)}（副本）`;
  const editorEntryMode = workflowEditorEntryMode(selected);
  return (
    <>
      <button
        type="button"
        className={`workflow-definition-card ${selected ? "active" : ""}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span className="workflow-definition-card-main">
          <span className="workflow-definition-card-title"><strong>{definition.name}</strong><span className={`status-pill ${definition.lifecycle_status === "retired" ? "off" : ""}`}>{lifecycleLabel(definition.lifecycle_status)}</span></span>
          <small>{activeSteps.slice(0, 4).map((step) => step.name).join(" → ")}{activeSteps.length > 4 ? ` → 等 ${activeSteps.length} 个节点` : ""}</small>
        </span>
        <span className="workflow-definition-card-metrics">
          <span><b>v{definition.version_number}</b><small>版本</small></span>
          <span><b>{definition.step_count}</b><small>节点</small></span>
          <span><b>{definition.instance_count}</b><small>订单</small></span>
        </span>
        <span className="workflow-definition-card-open">查看配置 →</span>
      </button>
      <Modal
        title={`工作流配置 · ${definition.name}`}
        isOpen={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setShowClone(false);
        }}
        size="wide"
        dialogClassName="workflow-inspect-modal"
        initialFocusSelector=".workflow-inspect-primary"
      >
        {({ close }) => (
          <div className="workflow-inspect-content">
            <div className="workflow-inspect-summary">
              <div><span>订单类型</span><strong>{workflowTypeLabel(definition.road_load_type)}</strong></div>
              <div><span>版本状态</span><strong>v{definition.version_number} · {lifecycleLabel(definition.lifecycle_status)}</strong></div>
              <div><span>流程节点</span><strong>{activeSteps.length} 个</strong></div>
              <div><span>使用订单</span><strong>{definition.instance_count} 张</strong></div>
              <div><span>隐藏字段</span><strong>{hiddenFieldCount} 个</strong></div>
              <div><span>最后更新</span><strong>{new Date(definition.updated_at).toLocaleString("zh-CN", { hour12: false })}</strong></div>
            </div>
            <div className={`alert ${capabilities.usedByOrders ? "warning" : "success"}`}>
              {capabilities.usedByOrders
                ? "该版本已被订单使用：可以新增字段并调整必填、选填或隐藏；历史节点不回退。若需增删节点，请基于此版本创建新的工作流。"
                : "该版本尚未被订单使用：点击编辑后可新增、删除节点，配置功能模组，并调整字段必填、选填或隐藏。"}
            </div>
            <div className="table-wrap workflow-inspect-node-table">
              <table>
                <thead><tr><th>顺序</th><th>节点</th><th>执行角色</th><th>功能模组</th><th>字段规则</th><th>状态</th></tr></thead>
                <tbody>
                  {steps.map((step, index) => (
                    <tr key={step.id}>
                      <td>{String(index + 1).padStart(2, "0")}</td>
                      <td><strong>{step.name}</strong></td>
                      <td>{scopeLabels[step.actor_scope] ?? step.actor_scope}</td>
                      <td>{step.module_names || "未配置"}</td>
                      <td>{step.required_field_count} 必填 · {step.optional_field_count} 选填{step.hidden_field_count ? ` · ${step.hidden_field_count} 隐藏` : ""}</td>
                      <td><span className={`status-pill ${step.is_active ? "success" : "off"}`}>{step.is_active ? "启用" : "停用"}</span></td>
                    </tr>
                  ))}
                  {!steps.length && <tr><td colSpan={6} className="empty-state">该工作流尚未配置节点。</td></tr>}
                </tbody>
              </table>
            </div>
            {showClone && manage && (
              <Form method="post" className="workflow-clone-form" onSubmit={() => close()}>
                <input type="hidden" name="intent" value="workflow_create" />
                <input type="hidden" name="sourceWorkflowId" value={definition.id} />
                <input type="hidden" name="roadLoadType" value={definition.road_load_type} />
                <div><strong>基于当前配置创建独立工作流</strong><small>复制节点、模组、办理步骤与字段，但不复制历史订单；订单类型固定为{workflowTypeLabel(definition.road_load_type)}。</small></div>
                <label className="field"><span>新工作流名称</span><input name="name" defaultValue={cloneName} minLength={2} maxLength={60} required data-autofocus /></label>
                <button className="primary" disabled={busy}>创建并进入编辑</button>
              </Form>
            )}
            <div className="workflow-inspect-actions">
              {manage && editorEntryMode === "open_current" && (
                <button
                  type="button"
                  className="primary workflow-inspect-primary"
                  onClick={() => {
                    close();
                    onEditSelected();
                  }}
                >
                  编辑
                </button>
              )}
              {manage && editorEntryMode === "navigate_and_open" && (
                <Link className="primary workflow-inspect-primary" to={`/admin/workflow?workflowId=${encodeURIComponent(definition.id)}&edit=1`} onClick={() => close()}>编辑</Link>
              )}
              {manage && <button type="button" className="secondary" onClick={() => setShowClone((current) => !current)}>{showClone ? "收起新建表单" : "以此工作流为基础创建新工作流"}</button>}
              <button type="button" className="secondary" onClick={close}>取消</button>
            </div>
          </div>
        )}
      </Modal>
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
  fieldPolicyImpacts,
  focusedFieldId,
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
  fieldPolicyImpacts:Record<string,WorkflowFieldPolicyImpact>;
  focusedFieldId:string|null;
}) {
  const stepNames = new Map(steps.map((step) => [step.id, step.name]));
  const [draftModes,setDraftModes] = useState<Record<string,EditableWorkflowFieldMode>>(()=>
    Object.fromEntries(allFields.map((field)=>[field.id,workflowFieldMode(field)])),
  );
  const stagedChanges = allFields.map((field)=>({
    field,
    currentMode:workflowFieldMode(field),
    mode:draftModes[field.id]??workflowFieldMode(field),
  })).filter((item)=>item.currentMode!==item.mode);
  const stageFieldMode = (fieldId:string,mode:EditableWorkflowFieldMode) => {
    setDraftModes((current)=>({...current,[fieldId]:mode}));
  };
  const locatorItems: WorkflowFieldLocatorItem[] = allFields.map((field) => ({
    id: field.id,
    label: field.label,
    fieldKey: field.field_key,
    moduleLabel: moduleLabels[field.module_code],
    stepId: field.step_id,
    stepName: stepNames.get(field.step_id) || "未知节点",
    modeLabel: workflowFieldModes.find((item) => item.value === workflowFieldMode(field))?.label || "未知规则",
  }));
  const focusedField = locatorItems.find((field) => field.id === focusedFieldId);
  const [fieldQuery,setFieldQuery] = useState(focusedField?.label || "");
  const [highlightedFieldId,setHighlightedFieldId] = useState(focusedFieldId);
  const deferredQuery = useDeferredValue(fieldQuery);
  const matches = filterWorkflowFieldLocatorItems(locatorItems,deferredQuery);
  const revealField = (field:WorkflowFieldLocatorItem) => {
    setHighlightedFieldId(field.id);
    const node=document.getElementById(`workflow-node-${field.stepId}`) as HTMLDetailsElement|null;
    if(node)node.open=true;
    window.requestAnimationFrame(()=>{
      const row=document.getElementById(`workflow-field-${field.id}`);
      row?.scrollIntoView({behavior:"smooth",block:"center"});
      row?.focus({preventScroll:true});
    });
  };
  useEffect(()=>{
    if(!focusedField)return;
    setFieldQuery(focusedField.label);
    const frame=window.requestAnimationFrame(()=>revealField(focusedField));
    return()=>window.cancelAnimationFrame(frame);
  // The deep link should reveal the field once when the dialog is mounted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[focusedFieldId]);
  return (
    <div className="workflow-config-dialog">
      <div className="workflow-config-dialog-header">
        <div>
          <strong>节点与字段</strong>
          <span>{structureEditable ? "该工作流尚无订单，可像积木一样插入、删除节点并配置字段。" : "该工作流已有订单：节点、模组和步骤锁定，仍可在既有节点新增字段并设置为必填、选填或隐藏。"}</span>
        </div>
        <div className="workflow-config-dialog-tools">
          <small>{structureEditable ? "首份报价保存后自动锁定节点结构。" : "字段修改先暂存，点击确认应用后一次性同步到既有业务实例和后续门禁；隐藏只影响显示，历史值和附件永久保留审计。"}</small>
          {structureEditable && (
            <Modal title="新增流程节点" triggerLabel="新增节点" triggerClassName="secondary" closeSignal={closeSignal}>
              <NodeCreateForm workflowId={workflowId} activeSteps={steps.filter((step) => step.is_active)} busy={busy} />
            </Modal>
          )}
        </div>
      </div>
      <section className="workflow-field-locator" aria-label="查找工作流字段">
        <label>
          <span>查找字段</span>
          <input type="search" value={fieldQuery} onChange={(event)=>setFieldQuery(event.target.value)} placeholder="输入名称或编码，例如：逐件扫码装车 / loading_scan_confirmation" autoComplete="off"/>
        </label>
        {fieldQuery.trim() ? <div className="workflow-field-locator-results" aria-live="polite">
          {matches.map((field)=><button type="button" key={field.id} onClick={()=>revealField(field)}><strong>{field.label}</strong><span>{field.stepName} · {field.moduleLabel} · {field.modeLabel}</span><em>定位并展开</em></button>)}
          {!matches.length&&<p>没有匹配字段，请尝试字段名称、字段编码或节点名称。</p>}
        </div>:<p>可从整个工作流直接定位字段，不必逐个展开节点查找。</p>}
      </section>
      <div className="workflow-node-config-list">
        <div className="workflow-node-config-table-head" aria-hidden="true">
          <span>顺序</span><span>节点</span><span>执行角色</span><span>模组</span><span>字段</span><span>状态 / 操作</span>
        </div>
        {steps.map((step) => (
          <details className="workflow-node-config" id={`workflow-node-${step.id}`} key={step.id}>
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
              used={!structureEditable}
              busy={busy}
              closeSignal={closeSignal}
              impact={fieldPolicyImpacts[step.step_key]??{total:0,future:0,current:0,historical:0,auditOnly:0}}
              highlightedFieldId={highlightedFieldId}
              draftModes={draftModes}
              onModeChange={stageFieldMode}
            />
          </details>
        ))}
      </div>
      {requirementEditable&&<WorkflowFieldBatchActions
        workflowId={workflowId}
        changes={stagedChanges}
        steps={steps}
        fieldPolicyImpacts={fieldPolicyImpacts}
        busy={busy}
      />}
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
        <ConfirmAction
          title="删除工作流节点"
          description={`将删除节点“${step.name}”。如果节点已经产生执行记录，服务端会拒绝删除并要求改为停用。`}
          triggerLabel="删除节点"
          confirmLabel="确认删除"
          name="intent"
          value="delete"
          pending={busy}
        />
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
                    <div className="button-row span-2"><button className="secondary" name="intent" value="module_update" disabled={busy}>保存模组</button><ConfirmAction title="删除工作流模组" description={`将删除模组“${item.display_name}”。模组仍有关联字段时服务端会拒绝该操作。`} triggerLabel="删除模组" confirmLabel="确认删除" name="intent" value="module_delete" pending={busy}/></div>
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
      <div className="button-row span-2"><button className="secondary" disabled={busy}>{task?"保存步骤":"新增步骤"}</button>{task&&<ConfirmAction title="删除办理步骤" description={`将从当前模组删除“${task.name}”，历史执行记录不会因此回退。`} triggerLabel="删除步骤" confirmLabel="确认删除" name="intent" value="task_delete" pending={busy}/>}</div>
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
  used,
  busy,
  closeSignal,
  impact,
  highlightedFieldId,
  draftModes,
  onModeChange,
}: {
  workflowId: string;
  step: Step;
  steps: Step[];
  fields: StepField[];
  allFields: StepField[];
  structureEditable: boolean;
  requirementEditable: boolean;
  used:boolean;
  busy: boolean;
  closeSignal?: unknown;
  impact:WorkflowFieldPolicyImpact;
  highlightedFieldId:string|null;
  draftModes:Record<string,EditableWorkflowFieldMode>;
  onModeChange:(fieldId:string,mode:EditableWorkflowFieldMode)=>void;
}) {
  return (
    <div className="workflow-field-config">
      <div className="workflow-field-config-heading">
        <div>
          <h3>字段填写规则</h3>
          <p>必填字段缺失会阻断当前和未来流程；历史节点不回退而生成补录任务；隐藏不显示、不阻断，历史值与附件永久保留。</p>
        </div>
        <strong>{fields.length} 个字段</strong>
      </div>
      <div className="table-wrap workflow-field-table">
        <table>
          <thead><tr><th>顺序</th><th>字段</th><th>业务模块</th><th>类型</th><th>当前规则</th><th>说明</th><th>操作</th></tr></thead>
          <tbody>
            {fields.map((field) => {
              const mode = workflowFieldMode(field);
              const draftMode=draftModes[field.id]??mode;
              const modeChanged=draftMode!==mode;
              const rowClassName=[
                highlightedFieldId===field.id?"workflow-field-locator-target":"",
                modeChanged?"workflow-field-mode-pending":"",
              ].filter(Boolean).join(" ")||undefined;
              return (
                <tr key={field.id} id={`workflow-field-${field.id}`} tabIndex={-1} className={rowClassName}>
                  <td>{field.sort_order}</td>
                  <td><strong>{field.label}</strong><small>{field.field_key}</small></td>
                  <td>{moduleLabels[field.module_code]}</td>
                  <td>{fieldTypeLabels[field.field_type]}</td>
                  <td><span className={`status-pill workflow-mode-${mode}`}>{workflowFieldModes.find((item) => item.value === mode)?.label}</span></td>
                  <td>{field.help_text || "—"}</td>
                  <td>
                    <div className="workflow-field-row-actions">
                      {requirementEditable && (
                        <RequirementModeSelect field={field} mode={draftMode} changed={modeChanged} busy={busy} onModeChange={onModeChange}/>
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
              <CatalogFieldForm workflowId={workflowId} step={step} steps={steps} allFields={allFields} busy={busy} nextSort={(fields[fields.length - 1]?.sort_order ?? 0) + 10} impact={impact} used={used} />
            </Modal>
          )}
          {(structureEditable || requirementEditable) && (
            <Modal title={`新增字段 · ${step.name}`} triggerLabel="新增自定义字段" triggerClassName="secondary" size="wide" closeSignal={closeSignal}>
              <FieldForm workflowId={workflowId} stepId={step.id} busy={busy} nextSort={(fields[fields.length - 1]?.sort_order ?? 0) + 10} impact={impact} />
            </Modal>
          )}
        </div>
      )}
    </div>
  );
}

function RequirementModeSelect({
  field,
  mode,
  changed,
  busy,
  onModeChange,
}: {
  field: StepField;
  mode:EditableWorkflowFieldMode;
  changed:boolean;
  busy: boolean;
  onModeChange:(fieldId:string,mode:EditableWorkflowFieldMode)=>void;
}) {
  return (
    <div className="workflow-requirement-form">
      <select value={mode} disabled={busy} onChange={(event)=>onModeChange(field.id,editableWorkflowFieldMode(event.target.value)??"optional")} aria-label={`${field.label}填写规则`}>
        <option value="required">必填</option>
        <option value="optional">选填</option>
        <option value="hidden">隐藏</option>
      </select>
      {changed&&<span className="workflow-field-pending-label">待应用</span>}
    </div>
  );
}

function WorkflowFieldBatchActions({
  workflowId,
  changes,
  steps,
  fieldPolicyImpacts,
  busy,
}: {
  workflowId:string;
  changes:StagedWorkflowFieldModeChange[];
  steps:Step[];
  fieldPolicyImpacts:Record<string,WorkflowFieldPolicyImpact>;
  busy:boolean;
}) {
  const formId=`workflow-field-mode-batch-${workflowId}`;
  const stepById=new Map(steps.map((step)=>[step.id,step]));
  const payload=JSON.stringify(changes.map(({field,mode})=>({
    fieldId:field.id,
    mode,
    updatedAt:field.updated_at,
  })));
  const affectedStepCount=new Set(changes.map((item)=>item.field.step_id)).size;
  return <div className="workflow-field-batch-bar" role="region" aria-label="字段规则批量操作">
    <Form id={formId} method="post" hidden>
      <input type="hidden" name="intent" value="field_modes_batch_update"/>
      <input type="hidden" name="workflowId" value={workflowId}/>
      <input type="hidden" name="fieldChanges" value={payload}/>
    </Form>
    <div className="workflow-field-batch-status" aria-live="polite">
      <strong>{changes.length?`${changes.length} 项待应用变更`:"尚未修改字段规则"}</strong>
      <span>{changes.length?`涉及 ${affectedStepCount} 个节点；确认前不会改变实际工作流。`:"在任意字段下拉框选择新规则后，可统一预览和应用。"}</span>
    </div>
    <div className="workflow-field-batch-buttons">
      {changes.length?<Modal title={`预览字段规则变更 · ${changes.length} 项`} triggerLabel="预览" triggerClassName="secondary" size="wide">
        <div className="workflow-field-batch-preview">
          <div className="alert warning" role="status">这里只预览，不会保存。确认应用后，全部变更作为一次提交同步到实际工作流、现有订单门禁和补录任务。</div>
          <div className="table-wrap"><table><thead><tr><th>节点 / 字段</th><th>规则变化</th><th>现有订单影响</th></tr></thead><tbody>{changes.map(({field,currentMode,mode})=>{
            const step=stepById.get(field.step_id);
            const impact=fieldPolicyImpacts[step?.step_key??""]??{total:0,future:0,current:0,historical:0,auditOnly:0};
            return <tr key={field.id}><td><strong>{field.label}</strong><small>{step?.name??"未知节点"} · 顺序 {step?.sort_order??"—"}</small></td><td><span className={`status-pill workflow-mode-${currentMode}`}>{workflowModeLabel(currentMode)}</span><b className="workflow-field-change-arrow">→</b><span className={`status-pill workflow-mode-${mode}`}>{workflowModeLabel(mode)}</span></td><td>{impact.total?`${impact.total} 张：当前 ${impact.current}、未来 ${impact.future}、历史补录 ${impact.historical}、仅审计 ${impact.auditOnly}`:"当前没有既有订单受影响"}</td></tr>;
          })}</tbody></table></div>
        </div>
      </Modal>:<button type="button" className="secondary" disabled>预览</button>}
      <ConfirmAction
        title={`确认一次应用 ${changes.length} 项字段规则`}
        description={`系统会把当前页面暂存的 ${changes.length} 项变化一次提交，并按订单阶段同步门禁与补录任务；历史节点不会回退，隐藏字段的历史数据永久保留。`}
        triggerLabel="确认应用"
        confirmLabel="确认应用全部变更"
        className="primary"
        confirmClassName="primary"
        formId={formId}
        name="impactConfirmed"
        value="1"
        formNoValidate={false}
        disabled={!changes.length}
        pending={busy}
        pendingLabel="正在应用…"
      />
    </div>
  </div>;
}

function FieldForm({
  workflowId,
  stepId,
  field,
  busy,
  nextSort = 10,
  impact,
}: {
  workflowId: string;
  stepId: string;
  field?: StepField;
  busy: boolean;
  nextSort?: number;
  impact?:WorkflowFieldPolicyImpact;
}) {
  const editing = Boolean(field);
  const [mode,setMode]=useState(field?workflowFieldMode(field):"optional");
  const formId=`workflow-field-${field?.id??`new-${stepId}`}`;
  const impactDescription=mode==="required"
    ? `新增后，${impact?.current??0} 张当前节点订单与 ${impact?.future??0} 张未到达订单启用门禁；${impact?.historical??0} 张已通过节点订单生成资料补录；${impact?.auditOnly??0} 张已出境或完成订单只生成审计补录。历史节点不会回退。`
    : `新增后同步到 ${impact?.total??0} 张现有订单，设为${workflowModeLabel(mode)}，不会阻断已通过节点；历史数据保持不变。`;
  return (
    <Form id={formId} method="post" className="workflow-field-form workflow-field-modal-form">
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
      <label className="field"><span>填写规则</span><select name="fieldMode" value={mode} onChange={(event)=>setMode(editableWorkflowFieldMode(event.target.value)??"optional")} required>{workflowFieldModes.map((item)=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
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
        {editing||!impact?.total?(
          <button className="secondary" disabled={busy}>{editing ? "保存字段" : "新增字段"}</button>
        ):(
          <ConfirmAction
            title={`确认新增${workflowModeLabel(mode)}字段`}
            description={impactDescription}
            triggerLabel="预览影响并新增"
            confirmLabel="确认新增并同步"
            className="secondary"
            confirmClassName="primary"
            formId={formId}
            name="impactConfirmed"
            value="1"
            formNoValidate={false}
            pending={busy}
          />
        )}
        {editing && (
          <ConfirmAction
            title="删除工作流字段"
            description={`将删除字段“${field?.label ?? "未命名字段"}”。已有业务数据不会物理删除，但此字段不再出现在后续填写界面。`}
            triggerLabel="删除字段"
            confirmLabel="确认删除"
            name="intent"
            value="field_delete"
            pending={busy}
          />
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
  impact,
  used,
}: {
  workflowId: string;
  step: Step;
  steps: Step[];
  allFields: StepField[];
  busy: boolean;
  nextSort: number;
  impact:WorkflowFieldPolicyImpact;
  used:boolean;
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
                  {used&&existing&&!onCurrentStep
                    ? <span className="muted">已有订单，字段位置已锁定</span>
                    : <CatalogFieldAction workflowId={workflowId} step={step} catalog={catalog} existing={existing} onCurrentStep={onCurrentStep} busy={busy} nextSort={nextSort} impact={impact} used={used} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CatalogFieldAction({workflowId,step,catalog,existing,onCurrentStep,busy,nextSort,impact,used}:{
  workflowId:string;
  step:Step;
  catalog:(typeof workflowFieldCatalog)[number];
  existing?:StepField;
  onCurrentStep:boolean;
  busy:boolean;
  nextSort:number;
  impact:WorkflowFieldPolicyImpact;
  used:boolean;
}){
  const [mode,setMode]=useState(existing?workflowFieldMode(existing):catalog.defaultMode);
  const formId=`workflow-catalog-${step.id}-${catalog.fieldKey}`;
  const actionLabel=onCurrentStep?"更新规则":existing?"移动到本节点":"加入本节点";
  const description=mode==="required"
    ? `${actionLabel}后，${impact.current} 张当前节点订单与 ${impact.future} 张未到达订单启用门禁；${impact.historical} 张历史订单生成资料补录；${impact.auditOnly} 张已出境或完成订单只生成审计补录。历史节点不会回退。`
    : `${actionLabel}后同步到 ${impact.total} 张现有订单，设为${workflowModeLabel(mode)}；已有值与附件保持不变。`;
  return <Form id={formId} method="post" className="workflow-catalog-row-form">
    <input type="hidden" name="intent" value="field_catalog_assign" />
    <input type="hidden" name="workflowId" value={workflowId} />
    <input type="hidden" name="stepId" value={step.id} />
    <input type="hidden" name="catalogFieldKey" value={catalog.fieldKey} />
    <select name="fieldMode" value={mode} onChange={(event)=>setMode(editableWorkflowFieldMode(event.target.value)??"optional")} aria-label={`${catalog.label}填写规则`}>
      <option value="required">必填</option>
      <option value="optional">选填</option>
      <option value="hidden">隐藏</option>
    </select>
    {used&&existing?<><input type="hidden" name="fieldSortOrder" value={existing.sort_order}/><input type="number" value={existing.sort_order} aria-label={`${catalog.label}排序（已锁定）`} disabled /></>:<input name="fieldSortOrder" type="number" min="1" max="9999" defaultValue={existing?.sort_order ?? nextSort} aria-label={`${catalog.label}排序`} required />}
    {impact.total?<ConfirmAction
      title={`确认${actionLabel}“${catalog.label}”`}
      description={description}
      triggerLabel="预览影响"
      confirmLabel={`确认${actionLabel}`}
      className="text-button"
      confirmClassName="primary"
      formId={formId}
      name="impactConfirmed"
      value="1"
      formNoValidate={false}
      pending={busy}
    />:<button className="text-button" disabled={busy}>{actionLabel}</button>}
  </Form>;
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
