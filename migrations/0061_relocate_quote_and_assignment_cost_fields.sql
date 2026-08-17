PRAGMA foreign_keys = ON;

-- Receivable amounts are confirmed on the accepted quotation and inherited by
-- the order. They are not an order-creation form field or submission gate.
UPDATE workflow_step_fields
SET is_active=0,
    is_required=0,
    help_text='应收费用在询价报价中确认，创建订单时仅继承。',
    updated_at=datetime('now')
WHERE field_key='pre_receivable_expenses';

UPDATE workflow_instance_fields
SET is_active=0,
    is_required=0,
    help_text='应收费用在询价报价中确认，创建订单时仅继承。'
WHERE field_key='pre_receivable_expenses';

-- Keep one payable requirement per workflow/template before relocating it.
DELETE FROM workflow_step_fields
WHERE field_key='pre_payable_expenses'
  AND id NOT IN (
    SELECT MIN(id)
    FROM workflow_step_fields
    WHERE field_key='pre_payable_expenses'
    GROUP BY workflow_id
  );

UPDATE workflow_step_fields
SET step_id=(
      SELECT s.id FROM workflow_steps s
      WHERE s.workflow_id=workflow_step_fields.workflow_id
        AND s.step_key='review_assignment'
      LIMIT 1
    ),
    module_code='assignment',
    label='应付费用确认',
    field_type='text',
    is_active=1,
    is_required=1,
    sort_order=170,
    help_text='审核分配时确认预计应付费用；派单前至少录入一条应付明细。',
    updated_at=datetime('now')
WHERE field_key='pre_payable_expenses'
  AND EXISTS (
    SELECT 1 FROM workflow_steps s
    WHERE s.workflow_id=workflow_step_fields.workflow_id
      AND s.step_key='review_assignment'
  );

INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
  sort_order,options_text,help_text,module_code,created_at,updated_at
)
SELECT
  s.id||':pre_payable_expenses',s.workflow_id,s.id,'pre_payable_expenses',
  '应付费用确认','text',1,1,170,NULL,
  '审核分配时确认预计应付费用；派单前至少录入一条应付明细。',
  'assignment',datetime('now'),datetime('now')
FROM workflow_steps s
WHERE s.step_key='review_assignment';

DELETE FROM workflow_instance_fields
WHERE field_key='pre_payable_expenses'
  AND id NOT IN (
    SELECT MIN(id)
    FROM workflow_instance_fields
    WHERE field_key='pre_payable_expenses'
    GROUP BY instance_id
  );

UPDATE workflow_instance_fields
SET step_key='review_assignment',
    module_code='assignment',
    label='应付费用确认',
    field_type='text',
    is_active=1,
    is_required=1,
    sort_order=170,
    help_text='审核分配时确认预计应付费用；派单前至少录入一条应付明细。'
WHERE field_key='pre_payable_expenses';

INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT
  i.id||':wif:review_assignment:assignment:pre_payable_expenses',
  i.id,i.workflow_id,'review_assignment','assignment','pre_payable_expenses',
  '应付费用确认','text',1,1,170,NULL,
  '审核分配时确认预计应付费用；派单前至少录入一条应付明细。',
  datetime('now')
FROM workflow_instances i;

-- The domestic transport screen now consumes the payable decision instead of
-- asking users to enter the same values again.
UPDATE workflow_step_fields
SET is_active=0,is_required=0,updated_at=datetime('now')
WHERE field_key IN (
  'domestic_freight_amount','domestic_freight_currency',
  'domestic_payable_charge_name','domestic_payable_quantity',
  'domestic_payable_exchange_rate'
);

UPDATE workflow_instance_fields
SET is_active=0,is_required=0
WHERE field_key IN (
  'domestic_freight_amount','domestic_freight_currency',
  'domestic_payable_charge_name','domestic_payable_quantity',
  'domestic_payable_exchange_rate'
);
