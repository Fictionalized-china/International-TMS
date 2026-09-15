-- Financial facts may only change while the corresponding direction remains
-- unsigned. Application checks provide friendly messages; these triggers are
-- the final guard against concurrent browser submissions and forged forms.

CREATE TRIGGER IF NOT EXISTS business_expense_insert_open_direction_guard
BEFORE INSERT ON business_expenses
WHEN NEW.stage!='cancelled' AND (
  EXISTS (
    SELECT 1 FROM transport_orders o
    WHERE o.id=NEW.order_id AND o.organization_id=NEW.organization_id
      AND o.status IN ('completed','cancelled')
  ) OR EXISTS (
    SELECT 1 FROM order_expense_direction_controls c
    WHERE c.organization_id=NEW.organization_id
      AND c.order_id=NEW.order_id AND c.direction=NEW.direction
      AND (c.confirmed=1 OR c.business_reviewed=1 OR c.finance_reviewed=1
        OR c.business_locked=1 OR c.finance_locked=1)
  )
)
BEGIN
  SELECT RAISE(ABORT, '费用方向已签核、锁定或订单已终态，不能新增费用');
END;

CREATE TRIGGER IF NOT EXISTS business_expense_material_update_open_direction_guard
BEFORE UPDATE OF order_id,direction,charge_code,charge_name,counterparty_name,
  currency,quantity,unit_price,amount,exchange_rate,base_amount,notes,tax_rate,
  tax_amount,occurred_on,is_internal,foreign_account_no ON business_expenses
WHEN NEW.stage!='cancelled' AND (
  EXISTS (
    SELECT 1 FROM transport_orders o
    WHERE ((o.id=OLD.order_id AND o.organization_id=OLD.organization_id)
        OR (o.id=NEW.order_id AND o.organization_id=NEW.organization_id))
      AND o.status IN ('completed','cancelled')
  ) OR EXISTS (
    SELECT 1 FROM order_expense_direction_controls c
    WHERE ((c.organization_id=OLD.organization_id
          AND c.order_id=OLD.order_id AND c.direction=OLD.direction)
        OR (c.organization_id=NEW.organization_id
          AND c.order_id=NEW.order_id AND c.direction=NEW.direction))
      AND (c.confirmed=1 OR c.business_reviewed=1 OR c.finance_reviewed=1
        OR c.business_locked=1 OR c.finance_locked=1)
  )
)
BEGIN
  SELECT RAISE(ABORT, '费用方向已签核、锁定或订单已终态，不能修改费用');
END;

CREATE TRIGGER IF NOT EXISTS business_expense_delete_open_direction_guard
BEFORE DELETE ON business_expenses
WHEN EXISTS (
    SELECT 1 FROM transport_orders o
    WHERE o.id=OLD.order_id AND o.organization_id=OLD.organization_id
      AND o.status IN ('completed','cancelled')
  ) OR EXISTS (
    SELECT 1 FROM order_expense_direction_controls c
    WHERE c.organization_id=OLD.organization_id
      AND c.order_id=OLD.order_id AND c.direction=OLD.direction
      AND (c.confirmed=1 OR c.business_reviewed=1 OR c.finance_reviewed=1
        OR c.business_locked=1 OR c.finance_locked=1)
  )
BEGIN
  SELECT RAISE(ABORT, '费用方向已签核、锁定或订单已终态，不能删除费用');
END;

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
BEGIN
  SELECT RAISE(ABORT, '配载费用已越过冻结费用节点或已有签核，不能确认分摊');
END;
