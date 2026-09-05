import type { LockedWorkflowStageContext } from "./workflow-instance-stage-gate";

type WorkflowBindingRow = {
  workflow_instance_id: string | null;
  current_step_key: string | null;
};

type StepRow = {
  step_key: string;
  step_name: string;
  sort_order: number;
};

type ModuleRow = {
  module_code: string;
  step_key: string;
};

type FieldRow = {
  module_code: string;
  field_key: string;
  step_key: string;
  is_active: number;
  is_required: number;
};

export async function loadLockedWorkflowStageContext(
  db: D1Database,
  organizationId: string,
  orderId: string,
  moduleCode: string,
): Promise<LockedWorkflowStageContext> {
  const binding = await db.prepare(
    `SELECT o.workflow_instance_id,wi.current_step_key
     FROM transport_orders o
     LEFT JOIN workflow_instances wi
       ON wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id
     WHERE o.organization_id=? AND o.id=?`,
  ).bind(organizationId, orderId).first<WorkflowBindingRow>();

  if (!binding?.workflow_instance_id) {
    return {
      locked: false,
      currentStepKey: binding?.current_step_key ?? null,
      steps: [],
      modulePlacements: [],
      fields: [],
    };
  }

  const instanceId = binding.workflow_instance_id;
  const [steps, modules, fields] = await Promise.all([
    db.prepare(
      `SELECT step_key,step_name,sort_order
       FROM workflow_instance_step_states
       WHERE instance_id=?
       ORDER BY sort_order,id`,
    ).bind(instanceId).all<StepRow>(),
    db.prepare(
      `SELECT ms.module_code,ss.step_key
       FROM workflow_instance_module_states ms
       JOIN workflow_instance_step_states ss
         ON ss.id=ms.instance_step_state_id
       WHERE ss.instance_id=? AND ms.module_code=?
       ORDER BY ss.sort_order,ms.sort_order,ms.id`,
    ).bind(instanceId, moduleCode).all<ModuleRow>(),
    db.prepare(
      `SELECT module_code,field_key,step_key,is_active,is_required
       FROM workflow_instance_fields
       WHERE instance_id=? AND module_code=?
       ORDER BY sort_order,id`,
    ).bind(instanceId, moduleCode).all<FieldRow>(),
  ]);

  return {
    locked: true,
    currentStepKey: binding.current_step_key,
    steps: steps.results.map((step) => ({
      stepKey: step.step_key,
      stepName: step.step_name,
      sortOrder: step.sort_order,
    })),
    modulePlacements: modules.results.map((module) => ({
      moduleCode: module.module_code,
      stepKey: module.step_key,
    })),
    fields: fields.results.map((field) => ({
      moduleCode: field.module_code,
      fieldKey: field.field_key,
      stepKey: field.step_key,
      isActive: field.is_active === 1,
      isRequired: field.is_required === 1,
    })),
  };
}

