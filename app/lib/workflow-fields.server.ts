import { env } from "cloudflare:workers";
import type { OrderModuleCode } from "./order-modules";
import { orderDocumentPlacements } from "./order-documents";
import {
  workflowFieldCatalog,
  workflowFieldCatalogByKey,
  workflowFieldMode,
  type WorkflowFieldMode,
} from "./workflow-field-catalog";

export type WorkflowFieldRule = {
  id: string;
  workflowId: string;
  stepKey: string;
  moduleCode: OrderModuleCode;
  fieldKey: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
  isActive: boolean;
  mode: WorkflowFieldMode;
  sortOrder: number;
  optionsText: string | null;
  helpText: string | null;
  isBuiltIn: boolean;
};

export type WorkflowFieldState = WorkflowFieldRule & {
  present: boolean;
  displayValue: string | null;
};

const standardWorkflowCodes = new Set([
  "tms-road-pending",
  "tms-default",
  "tms-ftl-standard",
]);

const loadingTypeLockedFields = new Set([
  "business_type",
  "loading_batch",
  "consolidation_warehouse",
  "cost_allocation",
  "vehicle_capacity_weight",
  "vehicle_capacity_volume",
]);
const loadingTypeFixedField = new Set(["business_type"]);
const retiredWorkflowFields = new Set(["loading_seal_number"]);

export async function ensureWorkflowCatalogFields(organizationId: string) {
  const workflows = await env.DB.prepare(
    "SELECT id,code FROM workflow_definitions WHERE organization_id=?",
  )
    .bind(organizationId)
    .all<{ id: string; code: string }>();
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const workflow of workflows.results) {
    if (!standardWorkflowCodes.has(workflow.code)) continue;
    for (const item of workflowFieldCatalog) {
      if (retiredWorkflowFields.has(item.fieldKey)) continue;
      const isFtlLoadingField =
        workflow.code === "tms-ftl-standard" && item.moduleCode === "loading";
      if (isFtlLoadingField && loadingTypeLockedFields.has(item.fieldKey)) continue;
      const targetStepKey = item.stepKey;
      const isActive = item.defaultMode === "hidden" ? 0 : 1;
      const isRequired = item.defaultMode === "required" ? 1 : 0;
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO workflow_step_fields(
           id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
             sort_order,options_text,help_text,module_code,created_at,updated_at
           )
           SELECT ?,?,s.id,?,?,?,?,?,?,?,?,?,?,?
           FROM workflow_steps s
           WHERE s.workflow_id=? AND s.step_key=?
             AND NOT EXISTS(
               SELECT 1 FROM workflow_step_fields existing
               WHERE existing.workflow_id=?
                 AND existing.field_key=?
                 AND COALESCE(existing.module_code,?)=?
             )`,
        ).bind(
          `${workflow.id}:catalog:${item.moduleCode}:${item.fieldKey}`,
          workflow.id,
          item.fieldKey,
          item.label,
          item.fieldType,
          isRequired,
          isActive,
          workflowFieldCatalog.indexOf(item) * 10 + 10,
          item.optionsText ?? null,
          item.helpText,
          item.moduleCode,
          now,
          now,
          workflow.id,
          targetStepKey,
          workflow.id,
          item.fieldKey,
          item.moduleCode,
          item.moduleCode,
        ),
      );
    }
  }
  for (let index = 0; index < statements.length; index += 80) {
    await env.DB.batch(statements.slice(index, index + 80));
  }
  await env.DB.prepare(
    `UPDATE workflow_step_fields
     SET module_code=COALESCE(module_code,(
       SELECT CASE ws.step_key
         WHEN 'order_creation' THEN 'consignment'
         WHEN 'consignment_approval' THEN 'consignment'
         WHEN 'task_assignment' THEN 'assignment'
         WHEN 'domestic_execution' THEN 'transport'
         WHEN 'warehouse_receiving' THEN 'warehouse'
         WHEN 'port_loading' THEN 'loading'
         WHEN 'outbound_transport' THEN 'tracking'
         WHEN 'overseas_pickup' THEN 'overseas_warehouse'
         WHEN 'reconciliation' THEN 'costs'
         WHEN 'completion_review' THEN 'review'
         ELSE 'consignment' END
       FROM workflow_steps ws WHERE ws.id=workflow_step_fields.step_id
     ))
     WHERE workflow_id IN (SELECT id FROM workflow_definitions WHERE organization_id=?)`,
  )
    .bind(organizationId)
    .run();
  await env.DB.prepare(
    `UPDATE workflow_step_fields
     SET is_active=0,is_required=0,updated_at=?
     WHERE workflow_id IN (SELECT id FROM workflow_definitions WHERE organization_id=?)
       AND field_key='loading_seal_number'`,
  )
    .bind(now, organizationId)
    .run();
  await env.DB.prepare(
    `UPDATE workflow_instance_fields
     SET is_active=0,is_required=0
     WHERE workflow_id IN (SELECT id FROM workflow_definitions WHERE organization_id=?)
       AND field_key='loading_seal_number'`,
  )
    .bind(organizationId)
    .run();
  const standardCodes = [...standardWorkflowCodes];
  const placeholders = standardCodes.map(() => "?").join(",");
  await env.DB.prepare(
    `UPDATE workflow_step_fields
     SET step_id=(
       SELECT target.id FROM workflow_steps target
       WHERE target.workflow_id=workflow_step_fields.workflow_id
         AND target.step_key='port_loading'
     ),updated_at=?
     WHERE module_code='loading'
       AND workflow_id IN (
         SELECT id FROM workflow_definitions
         WHERE organization_id=? AND code IN (${placeholders})
       )`,
  )
    .bind(now, organizationId, ...standardCodes)
    .run();
  await env.DB.prepare(
    `UPDATE workflow_instance_fields
     SET step_key='port_loading'
     WHERE module_code='loading'
       AND workflow_id IN (
         SELECT id FROM workflow_definitions
         WHERE organization_id=? AND code IN (${placeholders})
       )`,
  )
    .bind(organizationId, ...standardCodes)
    .run();
    const ftlWorkflow = workflows.results.find((item) => item.code === "tms-ftl-standard");
  if (ftlWorkflow) {
    const excludedFields = [...loadingTypeLockedFields];
    const excludedPlaceholders = excludedFields.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE workflow_step_fields
       SET is_active=0,is_required=0,updated_at=?
       WHERE workflow_id=? AND module_code='loading'
         AND field_key IN (${excludedPlaceholders})`,
    )
      .bind(now, ftlWorkflow.id, ...excludedFields)
      .run();
    await env.DB.prepare(
      `UPDATE workflow_instance_fields
       SET is_active=0,is_required=0
       WHERE workflow_id=? AND module_code='loading'
         AND field_key IN (${excludedPlaceholders})`,
    )
      .bind(ftlWorkflow.id, ...excludedFields)
      .run();
  }
}

export async function snapshotWorkflowFieldsForInstance(input: {
  organizationId: string;
  instanceId: string;
  workflowId: string;
}) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_instance_fields(
       id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
       is_required,is_active,sort_order,options_text,help_text,created_at
     )
     SELECT lower(hex(randomblob(16))),?,f.workflow_id,s.step_key,
            COALESCE(f.module_code,'consignment'),f.field_key,f.label,f.field_type,
            f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,?
     FROM workflow_step_fields f
     JOIN workflow_steps s ON s.id=f.step_id AND s.workflow_id=f.workflow_id
     WHERE f.workflow_id=?`,
  )
    .bind(input.instanceId, now, input.workflowId)
    .run();
}

export async function synchronizeWorkflowFieldPolicyForInstances(input: {
  workflowId: string;
  fieldKey: string;
  moduleCode: OrderModuleCode;
  isRequired: number;
  isActive: number;
}) {
  await env.DB.prepare(
    `UPDATE workflow_instance_fields
     SET is_required=?,is_active=?
     WHERE workflow_id=? AND field_key=? AND module_code=?`,
  )
    .bind(
      input.isRequired,
      input.isActive,
      input.workflowId,
      input.fieldKey,
      input.moduleCode,
    )
    .run();
}

export async function synchronizeWorkflowFieldDefinitionForInstances(input: {
  workflowId: string;
  stepKey: string;
  fieldKey: string;
  moduleCode: OrderModuleCode;
  label: string;
  fieldType: string;
  isRequired: number;
  isActive: number;
  sortOrder: number;
  optionsText: string | null;
  helpText: string | null;
}) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workflow_instance_fields
       SET step_key=?,label=?,field_type=?,is_required=?,is_active=?,sort_order=?,
           options_text=?,help_text=?
       WHERE workflow_id=? AND field_key=? AND module_code=?`,
    ).bind(
      input.stepKey,
      input.label,
      input.fieldType,
      input.isRequired,
      input.isActive,
      input.sortOrder,
      input.optionsText,
      input.helpText,
      input.workflowId,
      input.fieldKey,
      input.moduleCode,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO workflow_instance_fields(
         id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
         is_required,is_active,sort_order,options_text,help_text,created_at
       )
       SELECT lower(hex(randomblob(16))),wi.id,wi.workflow_id,?,?,?,?,?,?,?,?,?,?,?
       FROM workflow_instances wi WHERE wi.workflow_id=?`,
    ).bind(
      input.stepKey,
      input.moduleCode,
      input.fieldKey,
      input.label,
      input.fieldType,
      input.isRequired,
      input.isActive,
      input.sortOrder,
      input.optionsText,
      input.helpText,
      now,
      input.workflowId,
    ),
  ]);
}

export async function inspectHiddenWorkflowFieldData(input: {
  organizationId: string;
  workflowId: string;
  fieldKey: string;
  moduleCode: OrderModuleCode;
}) {
  const placement = orderDocumentPlacements.find(
    (item) => item.fieldKey === input.fieldKey,
  );
  let preservedFiles = 0;
  let preservedBytes = 0;
  if (placement) {
    const stored = await env.DB.prepare(
      `SELECT COUNT(*) file_count,COALESCE(SUM(a.size_bytes),0) total_bytes
       FROM order_attachments a
       JOIN order_document_metadata m ON m.attachment_id=a.id
       WHERE a.organization_id=? AND m.document_category=?
         AND EXISTS(
           SELECT 1 FROM workflow_instances wi
           WHERE wi.workflow_id=? AND wi.order_id=a.order_id
         )`,
    ).bind(
      input.organizationId,
      placement.documentCode,
      input.workflowId,
    ).first<{ file_count: number; total_bytes: number }>();
    preservedFiles = Number(stored?.file_count || 0);
    preservedBytes = Number(stored?.total_bytes || 0);
  }
  const customValues = await env.DB.prepare(
    `SELECT COUNT(*) value_count
     FROM order_custom_workflow_field_values
     WHERE organization_id=? AND field_instance_id IN (
       SELECT id FROM workflow_instance_fields
       WHERE workflow_id=? AND field_key=? AND module_code=?
     )`,
  ).bind(
    input.organizationId,
    input.workflowId,
    input.fieldKey,
    input.moduleCode,
  ).first<{ value_count: number }>();
  return {
    preservedFiles,
    preservedBytes,
    preservedCustomValues: Number(customValues?.value_count || 0),
  };
}

export async function listTemplateWorkflowFields(workflowIds: string[]) {
  if (!workflowIds.length) return [] as (WorkflowFieldRule & { workflowId: string })[];
  const placeholders = workflowIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT f.id,f.workflow_id,s.step_key,COALESCE(f.module_code,'consignment') module_code,
            f.field_key,f.label,f.field_type,f.is_required,f.is_active,f.sort_order,
            f.options_text,f.help_text
     FROM workflow_step_fields f
     JOIN workflow_steps s ON s.id=f.step_id
     WHERE f.workflow_id IN (${placeholders})
     ORDER BY f.workflow_id,s.sort_order,f.sort_order,f.field_key`,
  )
    .bind(...workflowIds)
    .all<RawField>();
  return rows.results.map(toRule);
}

export async function loadOrderModuleWorkflowFields(
  organizationId: string,
  orderId: string,
  moduleCode: OrderModuleCode,
): Promise<WorkflowFieldState[]> {
  const binding = await env.DB.prepare(
    `SELECT o.workflow_instance_id,wi.workflow_id
     FROM transport_orders o
     LEFT JOIN workflow_instances wi ON wi.id=o.workflow_instance_id
     WHERE o.id=? AND o.organization_id=?`,
  )
    .bind(orderId, organizationId)
    .first<{ workflow_instance_id: string | null; workflow_id: string | null }>();
  if (!binding?.workflow_id) return [];
  let raw: RawField[] = [];
  if (binding.workflow_instance_id) {
    const snapshot = await env.DB.prepare(
      `SELECT id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,
              is_active,sort_order,options_text,help_text
       FROM workflow_instance_fields
       WHERE instance_id=? AND module_code=?
       ORDER BY sort_order,field_key`,
    )
      .bind(binding.workflow_instance_id, moduleCode)
      .all<RawField>();
    raw = snapshot.results;
  }
  if (!raw.length) {
    const live = await env.DB.prepare(
      `SELECT f.id,f.workflow_id,s.step_key,COALESCE(f.module_code,'consignment') module_code,
              f.field_key,f.label,f.field_type,f.is_required,f.is_active,f.sort_order,
              f.options_text,f.help_text
       FROM workflow_step_fields f
       JOIN workflow_steps s ON s.id=f.step_id
       WHERE f.workflow_id=? AND COALESCE(f.module_code,'consignment')=?
       ORDER BY f.sort_order,f.field_key`,
    )
      .bind(binding.workflow_id, moduleCode)
      .all<RawField>();
    raw = live.results;
  }
  if (moduleCode === "loading") {
    const order = await env.DB.prepare(
      "SELECT business_type FROM transport_orders WHERE organization_id=? AND id=?",
    )
      .bind(organizationId, orderId)
      .first<{ business_type: string | null }>();
    raw = raw.filter((item) => !loadingTypeFixedField.has(item.field_key) && !retiredWorkflowFields.has(item.field_key));
    if (order?.business_type === "ftl") {
      raw = raw.filter((item) => !loadingTypeLockedFields.has(item.field_key));
    }
  }
  const rules = raw.map(toRule);
  const presence = await resolveFieldPresence(organizationId, orderId, moduleCode, rules);
  return rules.map((rule) => ({
    ...rule,
    present: presence.get(rule.fieldKey)?.present ?? false,
    displayValue: presence.get(rule.fieldKey)?.displayValue ?? null,
  }));
}

export async function missingRequiredModuleFields(
  organizationId: string,
  orderId: string,
  moduleCode: OrderModuleCode,
) {
  const fields = await loadOrderModuleWorkflowFields(organizationId, orderId, moduleCode);
  return fields.filter((item) => item.isActive && item.isRequired && !item.present);
}

export async function missingRequiredWorkflowModuleStepFields(
  organizationId: string,
  orderId: string,
  stepKey: string,
  moduleCode: OrderModuleCode,
) {
  const fields = await loadOrderModuleWorkflowFields(organizationId, orderId, moduleCode);
  return fields.filter(
    (item) =>
      item.stepKey === stepKey &&
      item.isActive &&
      item.isRequired &&
      !item.present,
  );
}

export async function missingRequiredWorkflowStepFields(
  organizationId: string,
  orderId: string,
  stepKey: string,
) {
  const moduleCodes: OrderModuleCode[] = [
    "consignment",
    "cargo",
    "assignment",
    "transport",
    "warehouse",
    "loading",
    "documents",
    "customs",
    "tracking",
    "overseas_warehouse",
    "costs",
    "exceptions",
    "review",
  ];
  const groups = await Promise.all(
    moduleCodes.map((moduleCode) =>
      loadOrderModuleWorkflowFields(organizationId, orderId, moduleCode),
    ),
  );
  return groups
    .flat()
    .filter(
      (field) =>
        field.stepKey === stepKey &&
        field.isActive &&
        field.isRequired &&
        !field.present,
    );
}

export async function saveOrderCustomWorkflowFieldValue(input: {
  organizationId: string;
  orderId: string;
  fieldId: string;
  value: string | null;
  actorUserId: string;
}) {
  const field = await env.DB.prepare(
    `SELECT f.id,f.field_key,f.is_active
     FROM workflow_instance_fields f
     JOIN workflow_instances wi ON wi.id=f.instance_id
     WHERE f.id=? AND wi.organization_id=? AND wi.order_id=?`,
  ).bind(input.fieldId, input.organizationId, input.orderId).first<{
    id: string;
    field_key: string;
    is_active: number;
  }>();
  if (!field?.is_active || workflowFieldCatalogByKey.has(field.field_key))
    throw new Error("该字段不是可编辑的自定义字段");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO order_custom_workflow_field_values(
       id,organization_id,order_id,field_instance_id,value_text,created_by_user_id,updated_by_user_id,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(order_id,field_instance_id) DO UPDATE SET
       value_text=excluded.value_text,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
  ).bind(
    crypto.randomUUID(), input.organizationId, input.orderId, input.fieldId,
    input.value?.trim() || null, input.actorUserId, input.actorUserId, now, now,
  ).run();
}

type RawField = {
  id: string;
  workflow_id: string;
  step_key: string;
  module_code: OrderModuleCode;
  field_key: string;
  label: string;
  field_type: string;
  is_required: number;
  is_active: number;
  sort_order: number;
  options_text: string | null;
  help_text: string | null;
};

function toRule(row: RawField): WorkflowFieldRule {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    stepKey: row.step_key,
    moduleCode: row.module_code,
    fieldKey: row.field_key,
    label: row.label,
    fieldType: row.field_type,
    isRequired: Boolean(row.is_required),
    isActive: Boolean(row.is_active),
    mode: workflowFieldMode(row),
    sortOrder: row.sort_order,
    optionsText: row.options_text,
    helpText: row.help_text,
    isBuiltIn: workflowFieldCatalogByKey.has(row.field_key),
  };
}

type Presence = { present: boolean; displayValue: string | null };

async function resolveFieldPresence(
  organizationId: string,
  orderId: string,
  moduleCode: OrderModuleCode,
  rules: WorkflowFieldRule[],
) {
  const result = new Map<string, Presence>();
  const order = await env.DB.prepare(
    `SELECT o.*,wi.id bound_instance_id
     FROM transport_orders o
     LEFT JOIN workflow_instances wi ON wi.id=o.workflow_instance_id
     WHERE o.id=? AND o.organization_id=?`,
  )
    .bind(orderId, organizationId)
    .first<Record<string, unknown>>();
  if (!order) return result;
  for (const rule of rules) {
    if (rule.fieldKey in order) setPresence(result, rule.fieldKey, order[rule.fieldKey]);
  }

  const documentRules = rules.filter((rule) =>
    orderDocumentPlacements.some(
      (placement) => placement.fieldKey === rule.fieldKey,
    ),
  );
  if (documentRules.length) {
    const attachments = await env.DB.prepare(
      `SELECT m.document_category,m.review_status,COUNT(*) total
       FROM order_attachments a
       JOIN order_document_metadata m ON m.attachment_id=a.id
       WHERE a.organization_id=? AND a.order_id=?
       GROUP BY m.document_category,m.review_status`,
    )
      .bind(organizationId, orderId)
      .all<{
        document_category: string;
        review_status: string | null;
        total: number;
      }>();
    for (const rule of documentRules) {
      const placement = orderDocumentPlacements.find(
        (item) => item.fieldKey === rule.fieldKey,
      );
      const rows = attachments.results.filter(
        (item) => item.document_category === placement?.documentCode,
      );
      const total = rows.reduce((sum, item) => sum + Number(item.total || 0), 0);
      const reviewed = rows.reduce(
        (sum, item) =>
          sum +
          (["approved", "archived"].includes(item.review_status || "")
            ? Number(item.total || 0)
            : 0),
        0,
      );
      result.set(rule.fieldKey, {
        present: total > 0,
        displayValue:
          total > 0 ? `${total} 份，${reviewed} 份已审核` : null,
      });
    }
  }

  if (moduleCode === "cargo") {
    const rows = await env.DB.prepare(
      "SELECT * FROM order_cargo_items WHERE organization_id=? AND order_id=? ORDER BY line_no",
    ).bind(organizationId, orderId).all<Record<string, unknown>>();
    const cargoKeyMap: Record<string, string> = {
      origin_country_cargo: "origin_country",
      cargo_images: "image_count",
      cargo_notes: "notes",
    };
    for (const rule of rules) {
      const column = cargoKeyMap[rule.fieldKey] ?? rule.fieldKey;
      if (rule.fieldKey === "cargo_images") {
        const image = await env.DB.prepare(
          "SELECT COUNT(*) total FROM order_cargo_images WHERE organization_id=? AND order_id=?",
        ).bind(organizationId, orderId).first<{ total: number }>();
        setPresence(result, rule.fieldKey, image?.total ?? 0, true);
      } else if (rows.results.length) {
        const present = rows.results.every((row) => meaningful(row[column], rule.fieldType));
        result.set(rule.fieldKey, { present, displayValue: present ? `${rows.results.length} 条明细` : null });
      }
    }
  }

  if (moduleCode === "assignment") {
    const assignment = await env.DB.prepare(
      `SELECT o.status,o.current_assignee_user_id,
              COUNT(CASE WHEN m.enabled=1 AND m.is_required=1 AND m.assignee_user_id IS NOT NULL THEN 1 END) assigned,
              COUNT(CASE WHEN m.enabled=1 AND m.is_required=1 THEN 1 END) required_total
       FROM transport_orders o
       LEFT JOIN order_module_instances m ON m.order_id=o.id AND m.organization_id=o.organization_id
       WHERE o.id=? AND o.organization_id=? GROUP BY o.id`,
    ).bind(orderId, organizationId).first<{ status: string; current_assignee_user_id: string | null; assigned: number; required_total: number }>();
    setPresence(result, "approval_result", assignment && !["draft", "submitted"].includes(assignment.status) ? "approved" : null);
    setPresence(result, "primary_operator", assignment?.current_assignee_user_id);
    setPresence(result, "module_assignees", assignment && assignment.required_total > 0 && assignment.assigned >= assignment.required_total ? assignment.assigned : null);
    setPresence(result, "assignment_scope", assignment && assignment.required_total > 0 && assignment.assigned >= assignment.required_total ? assignment.assigned : null);
    const assignmentTask = await env.DB.prepare(
      `SELECT due_at,
              (SELECT notes FROM order_module_history h
               WHERE h.organization_id=? AND h.order_id=? AND h.action_code IN ('assign','module_assigned')
               ORDER BY h.occurred_at DESC LIMIT 1) notes
       FROM order_tasks
       WHERE organization_id=? AND order_id=? AND task_type='module_owner'
       ORDER BY updated_at DESC LIMIT 1`,
    ).bind(organizationId, orderId, organizationId, orderId).first<{ due_at: string | null; notes: string | null }>();
    setPresence(result, "assignment_due_at", assignmentTask?.due_at);
    setPresence(result, "assignment_notes", assignmentTask?.notes);
    const payable = await env.DB.prepare(
      "SELECT COUNT(*) total FROM business_expenses WHERE organization_id=? AND order_id=? AND direction='payable' AND stage!='cancelled'",
    ).bind(organizationId, orderId).first<{ total: number }>();
    setPresence(result, "pre_payable_expenses", payable?.total ?? 0, true);
  }

  if (moduleCode === "transport") {
    const transport = await env.DB.prepare(
      `SELECT a.*,COALESCE(a.carrier_id,a.carrier_name) domestic_carrier_id,
              a.vehicle_type domestic_vehicle_type,a.vehicle_count domestic_vehicle_count,a.loading_mode domestic_loading_mode,a.plate_number domestic_plate_number,
              a.driver_name domestic_driver_name,a.driver_phone domestic_driver_phone,
              a.driver_id_number domestic_driver_id_number,
              a.planned_departure_at domestic_planned_departure_at,a.planned_arrival_at domestic_planned_arrival_at,
              a.freight_amount domestic_freight_amount,a.freight_currency domestic_freight_currency,
              a.loading_requirements domestic_loading_requirements,a.notes domestic_transport_notes
       FROM order_transport_assignments a
       WHERE a.organization_id=? AND a.order_id=? AND a.leg_type='first_mile' AND a.status!='cancelled'
       ORDER BY a.created_at DESC LIMIT 1`,
    ).bind(organizationId, orderId).first<Record<string, unknown>>();
    for (const rule of rules) {
      if (transport && rule.fieldKey in transport) setPresence(result, rule.fieldKey, transport[rule.fieldKey]);
    }
    const shipment = await env.DB.prepare(
      "SELECT actual_pickup_at,actual_delivery_at FROM shipments WHERE organization_id=? AND order_id=? ORDER BY created_at DESC LIMIT 1",
    ).bind(organizationId, orderId).first<{ actual_pickup_at: string | null; actual_delivery_at: string | null }>();
    setPresence(result, "domestic_actual_pickup_at", shipment?.actual_pickup_at);
    setPresence(result, "domestic_actual_arrival_at", shipment?.actual_delivery_at);
    const waybill = await env.DB.prepare(
      `SELECT waybill_number,accompanying_at waybill_accompanying_at,
              shipper_instructions waybill_shipper_instructions,
              customs_notes waybill_customs_notes,
              accompanying_documents waybill_accompanying_documents,
              documents_verified waybill_documents_verified
       FROM order_waybills
       WHERE organization_id=? AND order_id=? AND status!='cancelled'
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(organizationId, orderId).first<Record<string, unknown>>();
    for (const rule of rules) {
      if (waybill && rule.fieldKey in waybill)
        setPresence(result, rule.fieldKey, waybill[rule.fieldKey]);
    }
  }

  if (moduleCode === "warehouse") {
    const warehouse = await env.DB.prepare(
      `SELECT COUNT(DISTINCT r.id) receipt_count,
              COUNT(DISTINCT CASE WHEN p.barcode IS NOT NULL AND p.barcode!='' THEN p.id END) warehouse_barcode,
              MAX(r.package_type) actual_package_type,
              COALESCE(SUM(r.total_packages),0) actual_package_count,
              COALESCE(SUM(r.total_pieces),0) actual_pieces,
              COALESCE(SUM(r.total_weight_kg),0) actual_weight_kg,
              COALESCE(SUM(r.total_volume_cbm),0) actual_volume_cbm,
              MAX(r.location_id) warehouse_location,
              MAX(r.evidence_note) receipt_evidence,
              MAX(r.notes) warehouse_receipt_notes,
              EXISTS(SELECT 1 FROM warehouse_receipt_differences d WHERE d.order_id=? AND d.organization_id=?) receipt_difference,
              EXISTS(SELECT 1 FROM warehouse_sorting_batches b JOIN shipments sx ON sx.id=b.shipment_id WHERE sx.order_id=? AND b.organization_id=? AND b.status='verified') cargo_complete_set
       FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id
       LEFT JOIN warehouse_packages p ON p.receipt_id=r.id
       WHERE r.organization_id=? AND s.order_id=? AND r.status='completed'`,
    ).bind(orderId, organizationId, orderId, organizationId, organizationId, orderId).first<Record<string, unknown>>();
    if (warehouse) {
      setPresence(result, "warehouse_receipt", warehouse.receipt_count, true);
      for (const key of ["warehouse_barcode", "actual_package_type", "actual_package_count", "actual_pieces", "actual_weight_kg", "actual_volume_cbm", "warehouse_location", "receipt_evidence", "receipt_difference", "warehouse_receipt_notes", "cargo_complete_set"])
        setPresence(
          result,
          key,
          warehouse[key],
          ["warehouse_barcode", "actual_package_count", "actual_pieces", "actual_weight_kg", "actual_volume_cbm", "receipt_difference", "cargo_complete_set"].includes(key),
        );
    }
  }

  if (moduleCode === "loading") {
    const routeSelection = await env.DB.prepare(
      `SELECT business_type,exit_port,customs_location,transit_locations,route_notes route_code
       FROM transport_orders WHERE organization_id=? AND id=?`,
    ).bind(organizationId, orderId).first<Record<string, unknown>>();
    if (routeSelection) {
      for (const key of ["business_type", "exit_port", "customs_location", "transit_locations", "route_code"])
        setPresence(result, key, routeSelection[key]);
    }
    const batch = await env.DB.prepare(
      `SELECT b.*,b.id loading_batch,b.warehouse_id consolidation_warehouse,b.carrier_id main_carrier_id,
              v.vehicle_type main_vehicle_type,v.plate_number main_plate_number,
              v.driver_name main_driver_name,v.driver_phone main_driver_phone,
              v.capacity_weight_kg vehicle_capacity_weight,v.capacity_volume_cbm vehicle_capacity_volume,
              b.planned_departure_at planned_exit_at,b.route_notes loading_instruction,b.notes loading_notes,
              (SELECT COUNT(*) FROM transport_cost_allocations ca WHERE ca.batch_id=b.id AND ca.status='confirmed') cost_allocation
       FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id
       LEFT JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.status!='cancelled'
       WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND b.status!='cancelled'
       ORDER BY b.created_at DESC,v.created_at LIMIT 1`,
    ).bind(organizationId, orderId).first<Record<string, unknown>>();
    for (const rule of rules) if (batch && rule.fieldKey in batch) setPresence(result, rule.fieldKey, batch[rule.fieldKey], rule.fieldKey === "cost_allocation");
    if (!batch && routeSelection?.business_type === "ftl") {
      const assignment = await env.DB.prepare(
        `SELECT COALESCE(carrier_id,carrier_name) main_carrier_id,
                vehicle_type main_vehicle_type,plate_number main_plate_number,
                driver_name main_driver_name,driver_phone main_driver_phone,
                planned_departure_at planned_exit_at,planned_arrival_at planned_arrival_at,
                loading_requirements loading_instruction,notes loading_notes
         FROM order_transport_assignments
         WHERE organization_id=? AND order_id=? AND status!='cancelled'
         ORDER BY CASE leg_type WHEN 'main' THEN 0 WHEN 'first_mile' THEN 1 ELSE 2 END,created_at DESC LIMIT 1`,
      ).bind(organizationId, orderId).first<Record<string, unknown>>();
      for (const rule of rules)
        if (assignment && rule.fieldKey in assignment)
          setPresence(result, rule.fieldKey, assignment[rule.fieldKey]);
    }
    const dispatch = await env.DB.prepare(
      `SELECT d.notes loading_handover_notes,
              COUNT(CASE WHEN di.status='loaded' THEN 1 END) loaded,
              COUNT(di.id) total
       FROM warehouse_dispatches d
       JOIN warehouse_sorting_batches sb ON sb.id=d.sorting_batch_id
       JOIN shipments s ON s.id=sb.shipment_id
       LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
       WHERE d.organization_id=? AND s.order_id=? AND d.status!='cancelled'
       GROUP BY d.id ORDER BY d.created_at DESC LIMIT 1`,
    ).bind(organizationId, orderId).first<Record<string, unknown>>();
    if (dispatch) {
      setPresence(result, "loading_handover_notes", dispatch.loading_handover_notes);
      setPresence(
        result,
        "loading_scan_confirmation",
        Number(dispatch.total ?? 0) > 0 && Number(dispatch.loaded ?? 0) >= Number(dispatch.total ?? 0) ? 1 : null,
      );
    }
  }

  if (moduleCode === "documents") {
    const documents = await env.DB.prepare(
      `SELECT COUNT(*) total,
              COUNT(CASE WHEN COALESCE(m.review_status,'pending') IN ('approved','archived') THEN 1 END) reviewed,
              COUNT(CASE WHEN COALESCE(m.document_category,'')!='' THEN 1 END) categorized,
              COUNT(CASE WHEN COALESCE(m.description,'')!='' THEN 1 END) described,
              COUNT(CASE WHEN m.public_to_customer IS NOT NULL THEN 1 END) visibility_set
       FROM order_attachments a LEFT JOIN order_document_metadata m ON m.attachment_id=a.id
       WHERE a.organization_id=? AND a.order_id=?`,
    ).bind(organizationId, orderId).first<{ total: number; reviewed: number; categorized: number; described: number; visibility_set: number }>();
    setPresence(result, "predeparture_documents", documents?.total ?? 0, true);
    setPresence(result, "document_review", documents && documents.total > 0 && documents.reviewed >= documents.total ? documents.reviewed : null);
    setPresence(result, "document_attachment", documents?.total ?? 0, true);
    setPresence(result, "document_category", documents && documents.total > 0 && documents.categorized >= documents.total ? documents.categorized : null);
    setPresence(result, "document_description", documents && documents.total > 0 && documents.described >= documents.total ? documents.described : null);
    setPresence(result, "document_public_to_customer", documents && documents.total > 0 && documents.visibility_set >= documents.total ? documents.visibility_set : null);
  }

  if (moduleCode === "customs") {
    const declarations = await env.DB.prepare(
      `SELECT d.*,r.clearance_stage FROM order_customs_declarations d
       JOIN order_customs_records r ON r.id=d.customs_record_id
       WHERE d.organization_id=? AND d.order_id=? AND d.is_deleted=0`,
    ).bind(organizationId, orderId).all<Record<string, unknown>>();
    setPresence(result, "customs_declarations", declarations.results.length, true);
    const customsMap: Record<string, string> = {
      declaration_stage: "clearance_stage",
      declaration_status: "status",
      declaration_currency: "currency",
      declaration_gross_weight: "gross_weight_kg",
      declaration_change_reason: "change_reason",
      customs_release: "released_at",
    };
    for (const rule of rules) {
      const column = customsMap[rule.fieldKey] ?? rule.fieldKey;
      if (rule.fieldKey === "declaration_change_flags") {
        const hasFlags = declarations.results.some((row) => row.is_redeclared || row.is_amended || row.is_inspected);
        result.set(rule.fieldKey, { present: hasFlags, displayValue: hasFlags ? "已记录" : null });
      } else if (declarations.results.length && column in declarations.results[0]) {
        const origin = declarations.results.filter((row) => row.clearance_stage === "origin");
        const rows = rule.fieldKey === "customs_release" ? origin : declarations.results;
        const present = rows.length > 0 && rows.every((row) => meaningful(row[column], rule.fieldType));
        result.set(rule.fieldKey, { present, displayValue: present ? `${rows.length} 张申报单` : null });
      }
    }
  }

  if (moduleCode === "tracking") {
    const milestones = await env.DB.prepare(
      "SELECT milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer FROM order_tracking_milestones WHERE organization_id=? AND order_id=? ORDER BY event_at",
    ).bind(organizationId, orderId).all<Record<string, unknown>>();
    const first = milestones.results[0];
    const latest = milestones.results[milestones.results.length - 1];
    const exit = milestones.results.find((row) => ["exit", "departed", "actual_departure"].includes(String(row.milestone_code)));
    setPresence(result, "actual_departure_at", first?.event_at);
    setPresence(result, "actual_exit_at", exit?.event_at);
    setPresence(result, "tracking_milestone", latest?.milestone_code);
    setPresence(result, "tracking_milestone_name", latest?.milestone_name);
    setPresence(result, "tracking_event_at", latest?.event_at);
    setPresence(result, "tracking_location", latest?.location);
    setPresence(result, "tracking_vehicle", latest?.vehicle_reference);
    setPresence(result, "tracking_notes", latest?.notes);
    setPresence(result, "visible_to_customer", latest ? String(latest.visible_to_customer ?? "") : null);
  }

  if (moduleCode === "overseas_warehouse") {
    const operation = await env.DB.prepare(
      `SELECT actual_arrival_at overseas_arrival_at,notes overseas_arrival_notes,
              notified_at customer_notified_at,appointment_at pickup_appointment_at,
              pickup_contact overseas_pickup_contact,pickup_proof_reference pickup_proof,pickup_at pickup_completed_at,
              notes customer_notification_notes,notes pickup_appointment_notes,notes pickup_completion_notes
       FROM overseas_warehouse_operations
       WHERE organization_id=? AND order_id=? ORDER BY created_at DESC LIMIT 1`,
    ).bind(organizationId, orderId).first<Record<string, unknown>>();
    for (const rule of rules) if (operation && rule.fieldKey in operation) setPresence(result, rule.fieldKey, operation[rule.fieldKey]);
  }

  if (moduleCode === "costs") {
    const costs = await env.DB.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM business_expenses WHERE organization_id=? AND order_id=? AND direction='receivable' AND stage!='cancelled') pre_receivable_expenses,
         EXISTS(SELECT 1 FROM business_expenses WHERE organization_id=? AND order_id=? AND direction='payable' AND stage!='cancelled') pre_payable_expenses,
         EXISTS(SELECT 1 FROM business_expenses WHERE organization_id=? AND order_id=? AND direction='receivable' AND stage!='cancelled') receivable_expenses,
         EXISTS(SELECT 1 FROM business_expenses WHERE organization_id=? AND order_id=? AND direction='payable' AND stage!='cancelled') payable_expenses,
         EXISTS(SELECT 1 FROM business_expenses WHERE organization_id=? AND order_id=? AND currency!='') expense_currency,
         EXISTS(SELECT 1 FROM business_expenses WHERE organization_id=? AND order_id=? AND exchange_rate>0) expense_exchange_rate,
         EXISTS(SELECT 1 FROM order_expense_direction_controls WHERE organization_id=? AND order_id=? AND business_reviewed=1) business_review,
         EXISTS(SELECT 1 FROM order_expense_direction_controls WHERE organization_id=? AND order_id=? AND finance_reviewed=1) finance_review,
         EXISTS(SELECT 1 FROM settlement_reconciliation_lines l JOIN settlement_reconciliations r ON r.id=l.reconciliation_id JOIN business_expenses e ON e.id=l.expense_id WHERE r.organization_id=? AND e.order_id=?) reconciliation_statement,
         EXISTS(SELECT 1 FROM settlement_invoice_allocations a JOIN business_expenses e ON e.id=a.expense_id WHERE e.order_id=?) invoice_records,
         EXISTS(SELECT 1 FROM settlement_cash_allocations a JOIN business_expenses e ON e.id=a.expense_id WHERE e.order_id=?) cash_records,
         EXISTS(SELECT 1 FROM settlement_cash_allocations a JOIN business_expenses e ON e.id=a.expense_id WHERE e.order_id=?) writeoff_records`,
    ).bind(
      organizationId,orderId,organizationId,orderId,
      organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,
      organizationId,orderId,organizationId,orderId,organizationId,orderId,orderId,orderId,orderId,
    ).first<Record<string, unknown>>();
    for (const rule of rules) if (costs && rule.fieldKey in costs) setPresence(result, rule.fieldKey, costs[rule.fieldKey], true);
    const expenseRows = await env.DB.prepare(
      `SELECT direction,charge_code,charge_name,counterparty_name,currency,quantity,
              unit_price,exchange_rate,tax_rate,occurred_on,foreign_account_no,
              is_internal,notes
       FROM business_expenses
       WHERE organization_id=? AND order_id=? AND stage!='cancelled'`,
    ).bind(organizationId, orderId).all<Record<string, unknown>>();
    const expenseFieldMap: Record<string, string> = {
      expense_direction: "direction",
      expense_charge_code: "charge_code",
      expense_charge_name: "charge_name",
      expense_counterparty: "counterparty_name",
      expense_currency: "currency",
      expense_quantity: "quantity",
      expense_unit_price: "unit_price",
      expense_exchange_rate: "exchange_rate",
      expense_tax_rate: "tax_rate",
      expense_occurred_on: "occurred_on",
      expense_foreign_account_no: "foreign_account_no",
      expense_is_internal: "is_internal",
      expense_notes: "notes",
    };
    for (const rule of rules) {
      const column = expenseFieldMap[rule.fieldKey];
      if (!column) continue;
      const present = expenseRows.results.length > 0 && expenseRows.results.every((row) => meaningful(row[column], rule.fieldType));
      result.set(rule.fieldKey, {
        present,
        displayValue: present ? `${expenseRows.results.length} 条费用` : null,
      });
    }
  }

  if (moduleCode === "review") {
    const review = await env.DB.prepare(
      `SELECT customer_dispute_summary,review_conclusion review_result,
              improvement_notes review_improvements
       FROM order_review_snapshots
       WHERE organization_id=? AND order_id=?
       ORDER BY updated_at DESC LIMIT 1`,
    ).bind(organizationId, orderId).first<Record<string, unknown>>();
    for (const rule of rules)
      if (review && rule.fieldKey in review)
        setPresence(result, rule.fieldKey, review[rule.fieldKey]);
  }

  if (moduleCode === "exceptions") {
    const exceptions = await env.DB.prepare(
      `SELECT COUNT(*) total
       FROM warehouse_exceptions e JOIN shipments s ON s.id=e.shipment_id
       WHERE e.organization_id=? AND s.order_id=?`,
    ).bind(organizationId, orderId).first<{ total: number }>();
    setPresence(result, "exception_records", exceptions?.total ?? 0, true);
  }

  const customFields = rules.filter((rule) => !rule.isBuiltIn);
  if (customFields.length) {
    const ids = customFields.map((item) => item.id);
    const placeholders = ids.map(() => "?").join(",");
    const values = await env.DB.prepare(
      `SELECT field_instance_id,value_text FROM order_custom_workflow_field_values
       WHERE organization_id=? AND order_id=? AND field_instance_id IN (${placeholders})`,
    ).bind(organizationId, orderId, ...ids).all<{ field_instance_id: string; value_text: string | null }>();
    for (const item of values.results)
      setPresence(
        result,
        customFields.find((field) => field.id === item.field_instance_id)?.fieldKey ?? "",
        item.value_text,
      );
  }
  return result;
}

function setPresence(
  target: Map<string, Presence>,
  key: string,
  value: unknown,
  positiveNumber = false,
) {
  if (!key) return;
  const present = positiveNumber
    ? Number(value ?? 0) > 0
    : meaningful(value, "text");
  target.set(key, {
    present,
    displayValue: present ? display(value) : null,
  });
}

function meaningful(value: unknown, fieldType: string) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") {
    if (["number", "amount"].includes(fieldType)) return value > 0;
    return Number.isFinite(value);
  }
  if (typeof value === "boolean") return value;
  return true;
}

function display(value: unknown) {
  if (typeof value === "number") return value > 1 ? String(value) : "已填写";
  if (typeof value === "string" && value.length <= 40) return value;
  return "已填写";
}
