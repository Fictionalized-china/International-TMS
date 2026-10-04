-- Planning costs are a separate, atomic path. Existing post-dispatch guards stay intact.
ALTER TABLE transport_cost_allocations ADD COLUMN creation_mode TEXT NOT NULL DEFAULT 'post_dispatch' CHECK(creation_mode IN ('post_dispatch','planning'));

CREATE VIEW eligible_planned_cost_orders AS
SELECT a.id allocation_id,a.organization_id,bo.order_id
FROM transport_cost_allocations a
JOIN transport_batches b ON b.id=a.batch_id AND b.organization_id=a.organization_id
JOIN loading_planning_submissions submission ON submission.batch_id=b.id AND submission.organization_id=b.organization_id
JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
JOIN order_module_instances costs ON costs.organization_id=o.organization_id AND costs.order_id=o.id AND costs.module_code='costs'
WHERE a.creation_mode='planning' AND a.status='draft'
  AND b.approval_status='draft' AND b.status='planning' AND b.actual_departure_at IS NULL
  AND submission.sync_status='pending' AND submission.actor_user_id=a.created_by_user_id
  AND b.approved_by_user_id=submission.actor_user_id
  AND o.status='in_execution' AND o.business_type='ltl'
  AND costs.enabled=1 AND costs.status NOT IN ('completed','not_applicable','blocked')
  AND (o.workflow_instance_id IS NULL OR EXISTS (
    SELECT 1 FROM workflow_instances wi
    JOIN workflow_instance_step_states step ON step.instance_id=wi.id AND step.step_key=wi.current_step_key AND step.status='active'
    JOIN workflow_instance_module_states module ON module.instance_step_state_id=step.id AND module.module_code='loading' AND module.status NOT IN ('completed','not_applicable','blocked')
    WHERE wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id AND wi.order_id=o.id AND wi.status='active'
  ))
  AND EXISTS (SELECT 1 FROM warehouse_packing_jobs job
    WHERE job.organization_id=o.organization_id AND job.order_id=o.id AND job.transport_batch_id=b.id AND job.status='allocated')
  AND NOT EXISTS (SELECT 1 FROM order_expense_direction_controls control
    WHERE control.organization_id=o.organization_id AND control.order_id=o.id AND control.direction='payable'
      AND (control.confirmed=1 OR control.business_reviewed=1 OR control.finance_reviewed=1 OR control.business_locked=1 OR control.finance_locked=1))
  AND NOT EXISTS (SELECT 1 FROM order_tracking_milestones milestone
    WHERE milestone.organization_id=o.organization_id AND milestone.order_id=o.id AND milestone.milestone_code IN ('exported','actual_exit','exit'));

DROP TRIGGER cost_allocation_header_insert_scope_guard;
CREATE TRIGGER IF NOT EXISTS cost_allocation_header_insert_scope_guard
BEFORE INSERT ON transport_cost_allocations
WHEN NOT EXISTS (
  SELECT 1 FROM transport_batches batch
  WHERE batch.id=NEW.batch_id AND batch.organization_id=NEW.organization_id
    AND batch.batch_number LIKE 'PZ-%' AND batch.status!='cancelled'
    AND (batch.approval_status='approved' OR (NEW.creation_mode='planning' AND batch.approval_status='draft' AND batch.status='planning' AND EXISTS (SELECT 1 FROM loading_planning_submissions submission WHERE submission.organization_id=NEW.organization_id AND submission.batch_id=NEW.batch_id AND submission.sync_status='pending' AND submission.actor_user_id=NEW.created_by_user_id AND submission.actor_user_id=batch.approved_by_user_id))) AND batch.actual_departure_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, '配载单未审核、已取消或已实际出境，不能创建费用分摊');
END;

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
    AND EXISTS (
      SELECT 1 FROM warehouse_dispatches dispatch
      JOIN warehouse_dispatch_items item
        ON item.dispatch_id=dispatch.id AND item.organization_id=dispatch.organization_id
      JOIN warehouse_packages package_row
        ON package_row.id=item.package_id AND package_row.organization_id=item.organization_id
      JOIN shipments shipment
        ON shipment.id=package_row.shipment_id AND shipment.organization_id=package_row.organization_id
      WHERE dispatch.organization_id=batch_order.organization_id
        AND dispatch.transport_batch_id=batch_order.batch_id
        AND shipment.order_id=batch_order.order_id AND dispatch.status='dispatched'
    )
    AND NOT EXISTS (
      SELECT 1 FROM order_tracking_milestones milestone
      WHERE milestone.organization_id=order_row.organization_id
        AND milestone.order_id=order_row.id
        AND milestone.milestone_code IN ('exported','actual_exit','exit')
    )
)
AND NOT EXISTS (SELECT 1 FROM eligible_planned_cost_orders WHERE allocation_id=NEW.allocation_id AND organization_id=NEW.organization_id AND order_id=NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, '挂载订单未通过冻结 cost_allocation 字段、出库或费用窗口门禁');
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
    AND EXISTS (
      SELECT 1 FROM warehouse_dispatches dispatch
      JOIN warehouse_dispatch_items item
        ON item.dispatch_id=dispatch.id AND item.organization_id=dispatch.organization_id
      JOIN warehouse_packages package_row
        ON package_row.id=item.package_id AND package_row.organization_id=item.organization_id
      JOIN shipments shipment
        ON shipment.id=package_row.shipment_id AND shipment.organization_id=package_row.organization_id
      WHERE dispatch.organization_id=batch_order.organization_id
        AND dispatch.transport_batch_id=batch_order.batch_id
        AND shipment.order_id=batch_order.order_id AND dispatch.status='dispatched'
    )
    AND NOT EXISTS (
      SELECT 1 FROM order_tracking_milestones milestone
      WHERE milestone.organization_id=order_row.organization_id
        AND milestone.order_id=order_row.id
        AND milestone.milestone_code IN ('exported','actual_exit','exit')
    )
)
AND NOT EXISTS (SELECT 1 FROM eligible_planned_cost_orders WHERE organization_id=NEW.organization_id AND order_id=NEW.order_id AND allocation_id=(SELECT allocation_id FROM transport_cost_allocation_lines WHERE id=NEW.source_id AND organization_id=NEW.organization_id))
BEGIN
  SELECT RAISE(ABORT, '确认分摊前必须重新通过冻结字段、出库和费用窗口门禁');
END;

DROP TRIGGER cost_allocation_header_status_guard;
CREATE TRIGGER IF NOT EXISTS cost_allocation_header_status_guard
BEFORE UPDATE OF status ON transport_cost_allocations
WHEN OLD.status!='draft'
  OR NEW.status NOT IN ('confirmed','cancelled')
  OR (NEW.status='confirmed' AND (
    NEW.confirmed_by_user_id IS NULL OR NEW.confirmed_at IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM transport_batches batch
      WHERE batch.id=NEW.batch_id AND batch.organization_id=NEW.organization_id
        AND (batch.approval_status='approved' OR (NEW.creation_mode='planning' AND batch.approval_status='draft' AND batch.status='planning' AND EXISTS (SELECT 1 FROM loading_planning_submissions submission WHERE submission.organization_id=NEW.organization_id AND submission.batch_id=NEW.batch_id AND submission.sync_status='pending' AND submission.actor_user_id=NEW.created_by_user_id AND submission.actor_user_id=batch.approved_by_user_id))) AND batch.status!='cancelled'
        AND batch.actual_departure_at IS NULL
    )
    OR NOT EXISTS (
      SELECT 1 FROM transport_cost_allocation_lines line
      WHERE line.allocation_id=NEW.id AND line.organization_id=NEW.organization_id
    )
    OR EXISTS (
      SELECT 1 FROM transport_cost_allocation_lines line
      WHERE line.allocation_id=NEW.id AND line.organization_id=NEW.organization_id
        AND (line.expense_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM business_expenses expense
          WHERE expense.id=line.expense_id
            AND expense.organization_id=line.organization_id
            AND expense.order_id=line.order_id
            AND expense.source_type='loading_cost_allocation_line'
            AND expense.source_id=line.id AND expense.stage!='cancelled'
        ))
    )
    OR EXISTS (
      SELECT 1 FROM transport_cost_allocation_lines line
      WHERE line.allocation_id=NEW.id AND line.organization_id=NEW.organization_id
        AND NOT EXISTS (
          SELECT 1 FROM transport_batch_orders batch_order
          WHERE batch_order.batch_id=NEW.batch_id
            AND batch_order.organization_id=NEW.organization_id
            AND batch_order.order_id=line.order_id AND batch_order.status!='removed'
        )
    )
    OR EXISTS (
      SELECT 1 FROM transport_batch_orders batch_order
      WHERE batch_order.batch_id=NEW.batch_id
        AND batch_order.organization_id=NEW.organization_id
        AND batch_order.status!='removed'
        AND NOT EXISTS (
          SELECT 1 FROM transport_cost_allocation_lines line
          WHERE line.allocation_id=NEW.id
            AND line.organization_id=NEW.organization_id
            AND line.order_id=batch_order.order_id
        )
    )
    OR ABS((SELECT COALESCE(SUM(line.final_amount),0)
            FROM transport_cost_allocation_lines line
            WHERE line.allocation_id=NEW.id
              AND line.organization_id=NEW.organization_id)-NEW.total_amount)>0.009
  ))
BEGIN
  SELECT RAISE(ABORT, '费用分摊确认条件已变化或记录不完整');
END;

CREATE TRIGGER cost_allocation_creation_mode_immutable BEFORE UPDATE OF creation_mode ON transport_cost_allocations
WHEN NEW.creation_mode!=OLD.creation_mode BEGIN SELECT RAISE(ABORT,'费用分摊来源不可变更'); END;

DROP TRIGGER loading_cost_allocation_expense_gate;
CREATE TRIGGER IF NOT EXISTS loading_cost_allocation_expense_gate
BEFORE INSERT ON business_expenses
WHEN NEW.source_type='loading_cost_allocation_line' AND NOT EXISTS (
  SELECT 1
  FROM transport_cost_allocation_lines line
  JOIN transport_cost_allocations allocation
    ON allocation.id=line.allocation_id
   AND allocation.organization_id=line.organization_id
   AND allocation.status='draft'
  JOIN transport_batch_orders batch_order
    ON batch_order.batch_id=allocation.batch_id
   AND batch_order.order_id=line.order_id
   AND batch_order.organization_id=line.organization_id
   AND batch_order.status!='removed'
  JOIN transport_orders o
    ON o.id=line.order_id AND o.organization_id=line.organization_id
   AND o.status NOT IN ('completed','cancelled')
  JOIN workflow_instances wi
    ON wi.id=o.workflow_instance_id
   AND wi.organization_id=o.organization_id
   AND wi.order_id=o.id
   AND wi.status='active'
  JOIN workflow_instance_step_states current_step
    ON current_step.instance_id=wi.id AND current_step.step_key=wi.current_step_key
  JOIN order_module_instances costs
    ON costs.organization_id=o.organization_id AND costs.order_id=o.id
   AND costs.module_code='costs' AND costs.enabled=1
   AND costs.status NOT IN ('completed','not_applicable')
  LEFT JOIN order_expense_direction_controls control
    ON control.organization_id=o.organization_id AND control.order_id=o.id
   AND control.direction='payable'
  WHERE line.id=NEW.source_id
    AND line.organization_id=NEW.organization_id
    AND line.order_id=NEW.order_id
    AND line.expense_id IS NULL
    AND NEW.direction='payable'
    AND current_step.sort_order<=(
      SELECT MAX(cost_step.sort_order)
      FROM workflow_instance_step_states cost_step
      JOIN workflow_instance_module_states cost_module
        ON cost_module.instance_step_state_id=cost_step.id
       AND cost_module.module_code='costs'
      WHERE cost_step.instance_id=wi.id
    )
    AND COALESCE(control.confirmed,0)=0
    AND COALESCE(control.business_reviewed,0)=0
    AND COALESCE(control.finance_reviewed,0)=0
    AND COALESCE(control.business_locked,0)=0
    AND COALESCE(control.finance_locked,0)=0
)
AND NOT EXISTS (SELECT 1 FROM eligible_planned_cost_orders WHERE organization_id=NEW.organization_id AND order_id=NEW.order_id AND allocation_id=(SELECT allocation_id FROM transport_cost_allocation_lines WHERE id=NEW.source_id AND organization_id=NEW.organization_id))
BEGIN
  SELECT RAISE(ABORT, '配载费用已越过冻结费用节点或已有签核，不能确认分摊');
END;
