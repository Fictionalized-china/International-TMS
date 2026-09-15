PRAGMA foreign_keys = ON;

ALTER TABLE quotation_charges
  ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1 CHECK(exchange_rate > 0);

UPDATE workflow_step_fields
SET is_active=0,
    is_required=0,
    help_text='应付费用在国内运输安排确定承运商和运价时录入，不在订单创建阶段填写。',
    updated_at=datetime('now')
WHERE step_id IN (
    SELECT id FROM workflow_steps WHERE step_key='order_creation'
  )
  AND module_code='costs'
  AND field_key='pre_payable_expenses';

UPDATE workflow_instance_fields
SET is_active=0,
    is_required=0,
    help_text='应付费用在国内运输安排确定承运商和运价时录入，不在订单创建阶段填写。'
WHERE step_key='order_creation'
  AND module_code='costs'
  AND field_key='pre_payable_expenses';

UPDATE workflow_step_fields
SET label='已接受报价应收费用',
    help_text='选择已接受报价创建订单后，系统自动继承报价费用；没有应收明细时不能提交审批。',
    updated_at=datetime('now')
WHERE step_id IN (
    SELECT id FROM workflow_steps WHERE step_key='order_creation'
  )
  AND module_code='costs'
  AND field_key='pre_receivable_expenses';

UPDATE workflow_instance_fields
SET label='已接受报价应收费用',
    help_text='选择已接受报价创建订单后，系统自动继承报价费用；没有应收明细时不能提交审批。'
WHERE step_key='order_creation'
  AND module_code='costs'
  AND field_key='pre_receivable_expenses';
