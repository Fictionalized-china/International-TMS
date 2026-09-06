import {
  resolveBatchCostAllocationActionPolicy,
  type BatchCostAllocationActionPolicy,
  type BatchCostAllocationGateRow,
} from "./batch-cost-allocation-action-policy";

const targetFieldStepSql = `(SELECT field.step_key
  FROM workflow_instance_fields field
  WHERE field.instance_id=wi.id
    AND field.module_code='loading'
    AND field.field_key='cost_allocation'
  ORDER BY field.sort_order,field.id LIMIT 1)`;

/** Read one authoritative, organization-scoped snapshot for every mounted order. */
export async function loadBatchCostAllocationActionPolicy(input: {
  db: D1Database;
  organizationId: string;
  batchId: string;
}): Promise<{ rows: BatchCostAllocationGateRow[]; policy: BatchCostAllocationActionPolicy }> {
  const result = await input.db.prepare(`SELECT
      bo.order_id,o.order_number,o.business_type,o.status order_status,
      b.status batch_status,b.approval_status batch_approval_status,
      b.actual_departure_at batch_actual_departure_at,
      o.workflow_instance_id,wi.id matched_instance_id,
      wi.status workflow_instance_status,wi.current_step_key,
      current_step.step_name current_step_name,
      current_step.status current_step_status,
      current_step.sort_order current_step_sort_order,
      (SELECT COUNT(*) FROM workflow_instance_step_states step
       WHERE step.instance_id=wi.id AND step.step_key=wi.current_step_key) current_step_count,
      (SELECT COUNT(*) FROM workflow_instance_fields field
       WHERE field.instance_id=wi.id AND field.field_key='cost_allocation') cost_allocation_field_count,
      (SELECT COUNT(*) FROM workflow_instance_fields field
       WHERE field.instance_id=wi.id AND field.module_code='loading'
         AND field.field_key='cost_allocation') loading_cost_allocation_field_count,
      (SELECT COUNT(*) FROM workflow_instance_fields field
       WHERE field.instance_id=wi.id AND field.module_code='loading'
         AND field.field_key='cost_allocation' AND field.is_active=1) active_cost_allocation_field_count,
      COALESCE((SELECT MAX(field.is_required) FROM workflow_instance_fields field
       WHERE field.instance_id=wi.id AND field.module_code='loading'
         AND field.field_key='cost_allocation' AND field.is_active=1),0) cost_allocation_required,
      ${targetFieldStepSql} cost_allocation_step_key,
      (SELECT MIN(step.step_name) FROM workflow_instance_step_states step
       WHERE step.instance_id=wi.id AND step.step_key=${targetFieldStepSql}) cost_allocation_step_name,
      (SELECT MIN(step.sort_order) FROM workflow_instance_step_states step
       WHERE step.instance_id=wi.id AND step.step_key=${targetFieldStepSql}) cost_allocation_step_sort_order,
      (SELECT COUNT(*) FROM workflow_instance_step_states step
       WHERE step.instance_id=wi.id AND step.step_key=${targetFieldStepSql}) cost_allocation_step_count,
      (SELECT COUNT(*) FROM workflow_instance_module_states module
       JOIN workflow_instance_step_states step ON step.id=module.instance_step_state_id
       WHERE step.instance_id=wi.id AND module.module_code='loading') loading_module_count,
      (SELECT COUNT(*) FROM workflow_instance_module_states module
       JOIN workflow_instance_step_states step ON step.id=module.instance_step_state_id
       WHERE step.instance_id=wi.id AND module.module_code='loading'
         AND step.step_key=${targetFieldStepSql}) target_loading_module_count,
      (SELECT MIN(module.status) FROM workflow_instance_module_states module
       JOIN workflow_instance_step_states step ON step.id=module.instance_step_state_id
       WHERE step.instance_id=wi.id AND module.module_code='loading'
         AND step.step_key=${targetFieldStepSql}) target_loading_module_status,
      (SELECT step.step_key FROM workflow_instance_step_states step
       JOIN workflow_instance_module_states module ON module.instance_step_state_id=step.id
       WHERE step.instance_id=wi.id AND module.module_code='costs'
       ORDER BY step.sort_order DESC,step.id DESC,module.id DESC LIMIT 1) final_cost_step_key,
      (SELECT step.step_name FROM workflow_instance_step_states step
       JOIN workflow_instance_module_states module ON module.instance_step_state_id=step.id
       WHERE step.instance_id=wi.id AND module.module_code='costs'
       ORDER BY step.sort_order DESC,step.id DESC,module.id DESC LIMIT 1) final_cost_step_name,
      (SELECT MAX(step.sort_order) FROM workflow_instance_step_states step
       JOIN workflow_instance_module_states module ON module.instance_step_state_id=step.id
       WHERE step.instance_id=wi.id AND module.module_code='costs') final_cost_step_sort_order,
      (SELECT COUNT(DISTINCT step.id) FROM workflow_instance_step_states step
       JOIN workflow_instance_module_states module ON module.instance_step_state_id=step.id
       WHERE step.instance_id=wi.id AND module.module_code='costs'
         AND step.sort_order=(SELECT MAX(cost_step.sort_order)
           FROM workflow_instance_step_states cost_step
           JOIN workflow_instance_module_states cost_module
             ON cost_module.instance_step_state_id=cost_step.id
           WHERE cost_step.instance_id=wi.id AND cost_module.module_code='costs')) final_cost_step_count,
      (SELECT COUNT(*) FROM order_module_instances costs
       WHERE costs.organization_id=o.organization_id AND costs.order_id=o.id
         AND costs.module_code='costs') costs_instance_count,
      COALESCE((SELECT MAX(costs.enabled) FROM order_module_instances costs
       WHERE costs.organization_id=o.organization_id AND costs.order_id=o.id
         AND costs.module_code='costs'),0) costs_enabled,
      (SELECT MIN(costs.status) FROM order_module_instances costs
       WHERE costs.organization_id=o.organization_id AND costs.order_id=o.id
         AND costs.module_code='costs') costs_status,
      COALESCE(control.confirmed,0) payable_confirmed,
      COALESCE(control.business_reviewed,0) payable_business_reviewed,
      COALESCE(control.finance_reviewed,0) payable_finance_reviewed,
      COALESCE(control.business_locked,0) payable_business_locked,
      COALESCE(control.finance_locked,0) payable_finance_locked,
      CASE WHEN EXISTS(
        SELECT 1 FROM warehouse_dispatches dispatch
        JOIN warehouse_dispatch_items item
          ON item.dispatch_id=dispatch.id AND item.organization_id=dispatch.organization_id
        JOIN warehouse_packages package
          ON package.id=item.package_id AND package.organization_id=item.organization_id
        JOIN shipments shipment
          ON shipment.id=package.shipment_id AND shipment.organization_id=package.organization_id
        WHERE dispatch.organization_id=bo.organization_id
          AND dispatch.transport_batch_id=bo.batch_id
          AND shipment.order_id=bo.order_id AND dispatch.status='dispatched'
      ) THEN 1 ELSE 0 END dispatched,
      CASE WHEN b.actual_departure_at IS NOT NULL OR EXISTS(
        SELECT 1 FROM order_tracking_milestones milestone
        WHERE milestone.organization_id=o.organization_id AND milestone.order_id=o.id
          AND milestone.milestone_code IN ('exported','actual_exit','exit')
      ) THEN 1 ELSE 0 END actual_exit_recorded
    FROM transport_batch_orders bo
    JOIN transport_batches b
      ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
    JOIN transport_orders o
      ON o.id=bo.order_id AND o.organization_id=bo.organization_id
    LEFT JOIN workflow_instances wi
      ON wi.id=o.workflow_instance_id
     AND wi.organization_id=o.organization_id AND wi.order_id=o.id
    LEFT JOIN workflow_instance_step_states current_step
      ON current_step.instance_id=wi.id AND current_step.step_key=wi.current_step_key
    LEFT JOIN order_expense_direction_controls control
      ON control.organization_id=o.organization_id AND control.order_id=o.id
     AND control.direction='payable'
    WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
    ORDER BY bo.sequence_no,bo.order_id`)
    .bind(input.organizationId, input.batchId)
    .all<BatchCostAllocationGateRow>();
  const policy = resolveBatchCostAllocationActionPolicy(result.results);
  return { rows: result.results, policy };
}

export async function assertBatchCostAllocationActionOpen(input: {
  db: D1Database;
  organizationId: string;
  batchId: string;
}) {
  const snapshot = await loadBatchCostAllocationActionPolicy(input);
  if (!snapshot.policy.editable) throw new Error(snapshot.policy.reason ?? "当前不能办理配载成本分摊");
  return snapshot.rows;
}

