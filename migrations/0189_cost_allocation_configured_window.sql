-- Align SQLite with the configured approved-PZ cost window used by the service.
-- Only remove the obsolete physical-dispatch prerequisite. All organization,
-- frozen field, approval, terminal state, lock and actual-exit checks remain.
DROP TRIGGER cost_allocation_line_insert_frozen_gate;
CREATE TRIGGER IF NOT EXISTS cost_allocation_line_insert_frozen_gate
BEFORE INSERT ON transport_cost_allocation_lines
WHEN NOT EXISTS (
  SELECT 1
  FROM transport_cost_allocations allocation
  JOIN transport_batches batch
    ON batch.id=allocation.batch_id
   AND batch.organization_id=allocation.organization_id
  JOIN transport_batch_orders batch_order
    ON batch_order.batch_id=allocation.batch_id
   AND batch_order.organization_id=allocation.organization_id
   AND batch_order.order_id=NEW.order_id AND batch_order.status!='removed'
  JOIN transport_orders order_row
    ON order_row.id=batch_order.order_id
   AND order_row.organization_id=batch_order.organization_id
   AND order_row.business_type='ltl'
   AND order_row.status NOT IN ('completed','cancelled')
  JOIN workflow_instances instance
    ON instance.id=order_row.workflow_instance_id
   AND instance.organization_id=order_row.organization_id
   AND instance.order_id=order_row.id AND instance.status='active'
  JOIN workflow_instance_step_states current_step
    ON current_step.instance_id=instance.id
   AND current_step.step_key=instance.current_step_key
   AND current_step.status='active'
  JOIN workflow_instance_fields allocation_field
    ON allocation_field.instance_id=instance.id
   AND allocation_field.module_code='loading'
   AND allocation_field.field_key='cost_allocation'
   AND allocation_field.is_active=1
  JOIN workflow_instance_step_states allocation_step
    ON allocation_step.instance_id=instance.id
   AND allocation_step.step_key=allocation_field.step_key
  JOIN workflow_instance_module_states loading_module
    ON loading_module.instance_step_state_id=allocation_step.id
   AND loading_module.module_code='loading'
   AND loading_module.status!='blocked'
  JOIN order_module_instances costs
    ON costs.organization_id=order_row.organization_id
   AND costs.order_id=order_row.id AND costs.module_code='costs'
   AND costs.enabled=1 AND costs.status NOT IN ('completed','not_applicable','blocked')
  LEFT JOIN order_expense_direction_controls control
    ON control.organization_id=order_row.organization_id
   AND control.order_id=order_row.id AND control.direction='payable'
  WHERE allocation.id=NEW.allocation_id
    AND allocation.organization_id=NEW.organization_id
    AND allocation.status='draft'
    AND batch.approval_status='approved' AND batch.status!='cancelled'
    AND batch.actual_departure_at IS NULL
    AND NEW.organization_id=batch_order.organization_id
    AND current_step.sort_order>=allocation_step.sort_order
    AND current_step.sort_order<=(
      SELECT MAX(cost_step.sort_order)
      FROM workflow_instance_step_states cost_step
      JOIN workflow_instance_module_states cost_module
        ON cost_module.instance_step_state_id=cost_step.id
       AND cost_module.module_code='costs'
      WHERE cost_step.instance_id=instance.id
    )
    AND (SELECT COUNT(*) FROM workflow_instance_step_states current_candidate
         WHERE current_candidate.instance_id=instance.id
           AND current_candidate.step_key=instance.current_step_key)=1
    AND (SELECT COUNT(*) FROM workflow_instance_fields any_field
         WHERE any_field.instance_id=instance.id
           AND any_field.field_key='cost_allocation')=1
    AND (SELECT COUNT(*) FROM workflow_instance_module_states loading_candidate
         JOIN workflow_instance_step_states loading_step
           ON loading_step.id=loading_candidate.instance_step_state_id
         WHERE loading_step.instance_id=instance.id
           AND loading_candidate.module_code='loading')=1
    AND (SELECT COUNT(*) FROM order_module_instances costs_candidate
         WHERE costs_candidate.organization_id=order_row.organization_id
           AND costs_candidate.order_id=order_row.id
           AND costs_candidate.module_code='costs')=1
    AND COALESCE(control.confirmed,0)=0
    AND COALESCE(control.business_reviewed,0)=0
    AND COALESCE(control.finance_reviewed,0)=0
    AND COALESCE(control.business_locked,0)=0
    AND COALESCE(control.finance_locked,0)=0
    AND NOT EXISTS (
      SELECT 1 FROM order_tracking_milestones milestone
      WHERE milestone.organization_id=order_row.organization_id
        AND milestone.order_id=order_row.id
        AND milestone.milestone_code IN ('exported','actual_exit','exit')
    )
)
AND NOT EXISTS (SELECT 1 FROM eligible_planned_cost_orders WHERE allocation_id=NEW.allocation_id AND organization_id=NEW.organization_id AND order_id=NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, '挂载订单未通过冻结 cost_allocation 字段及费用窗口门禁');
END;

DROP TRIGGER cost_allocation_expense_frozen_gate;
CREATE TRIGGER IF NOT EXISTS cost_allocation_expense_frozen_gate
BEFORE INSERT ON business_expenses
WHEN NEW.source_type='loading_cost_allocation_line' AND NOT EXISTS (
  SELECT 1
  FROM transport_cost_allocation_lines line
  JOIN transport_cost_allocations allocation
    ON allocation.id=line.allocation_id
   AND allocation.organization_id=line.organization_id
   AND allocation.status='draft'
  JOIN transport_batches batch
    ON batch.id=allocation.batch_id
   AND batch.organization_id=allocation.organization_id
   AND batch.approval_status='approved' AND batch.status!='cancelled'
   AND batch.actual_departure_at IS NULL
  JOIN transport_batch_orders batch_order
    ON batch_order.batch_id=allocation.batch_id
   AND batch_order.organization_id=allocation.organization_id
   AND batch_order.order_id=line.order_id AND batch_order.status!='removed'
  JOIN transport_orders order_row
    ON order_row.id=line.order_id AND order_row.organization_id=line.organization_id
   AND order_row.business_type='ltl'
   AND order_row.status NOT IN ('completed','cancelled')
  JOIN workflow_instances instance
    ON instance.id=order_row.workflow_instance_id
   AND instance.organization_id=order_row.organization_id
   AND instance.order_id=order_row.id AND instance.status='active'
  JOIN workflow_instance_step_states current_step
    ON current_step.instance_id=instance.id
   AND current_step.step_key=instance.current_step_key
   AND current_step.status='active'
  JOIN workflow_instance_fields allocation_field
    ON allocation_field.instance_id=instance.id
   AND allocation_field.module_code='loading'
   AND allocation_field.field_key='cost_allocation'
   AND allocation_field.is_active=1
  JOIN workflow_instance_step_states allocation_step
    ON allocation_step.instance_id=instance.id
   AND allocation_step.step_key=allocation_field.step_key
  JOIN workflow_instance_module_states loading_module
    ON loading_module.instance_step_state_id=allocation_step.id
   AND loading_module.module_code='loading' AND loading_module.status!='blocked'
  JOIN order_module_instances costs
    ON costs.organization_id=order_row.organization_id
   AND costs.order_id=order_row.id AND costs.module_code='costs'
   AND costs.enabled=1 AND costs.status NOT IN ('completed','not_applicable','blocked')
  LEFT JOIN order_expense_direction_controls control
    ON control.organization_id=order_row.organization_id
   AND control.order_id=order_row.id AND control.direction='payable'
  WHERE line.id=NEW.source_id AND line.organization_id=NEW.organization_id
    AND line.order_id=NEW.order_id AND line.expense_id IS NULL
    AND NEW.direction='payable'
    AND current_step.sort_order>=allocation_step.sort_order
    AND current_step.sort_order<=(
      SELECT MAX(cost_step.sort_order)
      FROM workflow_instance_step_states cost_step
      JOIN workflow_instance_module_states cost_module
        ON cost_module.instance_step_state_id=cost_step.id
       AND cost_module.module_code='costs'
      WHERE cost_step.instance_id=instance.id
    )
    AND (SELECT COUNT(*) FROM workflow_instance_fields any_field
         WHERE any_field.instance_id=instance.id
           AND any_field.field_key='cost_allocation')=1
    AND (SELECT COUNT(*) FROM workflow_instance_module_states loading_candidate
         JOIN workflow_instance_step_states loading_step
           ON loading_step.id=loading_candidate.instance_step_state_id
         WHERE loading_step.instance_id=instance.id
           AND loading_candidate.module_code='loading')=1
    AND (SELECT COUNT(*) FROM order_module_instances costs_candidate
         WHERE costs_candidate.organization_id=order_row.organization_id
           AND costs_candidate.order_id=order_row.id
           AND costs_candidate.module_code='costs')=1
    AND COALESCE(control.confirmed,0)=0
    AND COALESCE(control.business_reviewed,0)=0
    AND COALESCE(control.finance_reviewed,0)=0
    AND COALESCE(control.business_locked,0)=0
    AND COALESCE(control.finance_locked,0)=0
    AND NOT EXISTS (
      SELECT 1 FROM order_tracking_milestones milestone
      WHERE milestone.organization_id=order_row.organization_id
        AND milestone.order_id=order_row.id
        AND milestone.milestone_code IN ('exported','actual_exit','exit')
    )
)
AND NOT EXISTS (SELECT 1 FROM eligible_planned_cost_orders WHERE organization_id=NEW.organization_id AND order_id=NEW.order_id AND allocation_id=(SELECT allocation_id FROM transport_cost_allocation_lines WHERE id=NEW.source_id AND organization_id=NEW.organization_id))
BEGIN
  SELECT RAISE(ABORT, '确认分摊前必须重新通过冻结字段和费用窗口门禁');
END;
