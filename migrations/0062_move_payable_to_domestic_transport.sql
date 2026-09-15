PRAGMA foreign_keys = ON;

-- Payables are decided together with the domestic carrier, not during approval.
UPDATE workflow_step_fields
SET is_active=0,
    is_required=0,
    help_text='应付费用改由业务员在国内运输开始时随承运商安排一并登记。',
    updated_at=datetime('now')
WHERE field_key='pre_payable_expenses';

UPDATE workflow_instance_fields
SET is_active=0,
    is_required=0,
    help_text='应付费用改由业务员在国内运输开始时随承运商安排一并登记。'
WHERE field_key='pre_payable_expenses';

WITH transport_fields(field_key,label,field_type,sort_order,options_text,help_text) AS (
  VALUES
    ('domestic_payable_charge_name','应付费用名称','text',145,NULL,'随国内承运商安排登记的应付费用名称。'),
    ('domestic_freight_currency','国内运费币种','select',146,'CNY\nUSD\nKZT\nUZS\nRUB','业务员安排国内承运商时确认应付币种。'),
    ('domestic_payable_exchange_rate','应付费用汇率','number',147,NULL,'国内运输应付费用折算汇率。'),
    ('domestic_payable_quantity','应付计价数量','number',148,NULL,'国内运输应付费用的计价数量。'),
    ('domestic_freight_amount','国内运费单价','amount',149,NULL,'业务员安排国内承运商时登记预计应付单价。')
)
INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
  sort_order,options_text,help_text,module_code,created_at,updated_at
)
SELECT
  s.id||':'||f.field_key,s.workflow_id,s.id,f.field_key,f.label,f.field_type,
  1,1,f.sort_order,f.options_text,f.help_text,'transport',datetime('now'),datetime('now')
FROM workflow_steps s
CROSS JOIN transport_fields f
WHERE s.step_key='domestic_execution';

UPDATE workflow_step_fields
SET module_code='transport',
    is_active=1,
    is_required=1,
    sort_order=CASE field_key
      WHEN 'domestic_payable_charge_name' THEN 145
      WHEN 'domestic_freight_currency' THEN 146
      WHEN 'domestic_payable_exchange_rate' THEN 147
      WHEN 'domestic_payable_quantity' THEN 148
      WHEN 'domestic_freight_amount' THEN 149
    END,
    help_text=CASE field_key
      WHEN 'domestic_payable_charge_name' THEN '随国内承运商安排登记的应付费用名称。'
      WHEN 'domestic_freight_currency' THEN '业务员安排国内承运商时确认应付币种。'
      WHEN 'domestic_payable_exchange_rate' THEN '国内运输应付费用折算汇率。'
      WHEN 'domestic_payable_quantity' THEN '国内运输应付费用的计价数量。'
      WHEN 'domestic_freight_amount' THEN '业务员安排国内承运商时登记预计应付单价。'
    END,
    updated_at=datetime('now')
WHERE field_key IN (
  'domestic_payable_charge_name','domestic_freight_currency',
  'domestic_payable_exchange_rate','domestic_payable_quantity','domestic_freight_amount'
);

WITH transport_fields(field_key,label,field_type,sort_order,options_text,help_text) AS (
  VALUES
    ('domestic_payable_charge_name','应付费用名称','text',145,NULL,'随国内承运商安排登记的应付费用名称。'),
    ('domestic_freight_currency','国内运费币种','select',146,'CNY\nUSD\nKZT\nUZS\nRUB','业务员安排国内承运商时确认应付币种。'),
    ('domestic_payable_exchange_rate','应付费用汇率','number',147,NULL,'国内运输应付费用折算汇率。'),
    ('domestic_payable_quantity','应付计价数量','number',148,NULL,'国内运输应付费用的计价数量。'),
    ('domestic_freight_amount','国内运费单价','amount',149,NULL,'业务员安排国内承运商时登记预计应付单价。')
)
INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT
  i.id||':wif:domestic_execution:transport:'||f.field_key,
  i.id,i.workflow_id,'domestic_execution','transport',f.field_key,f.label,
  f.field_type,1,1,f.sort_order,f.options_text,f.help_text,datetime('now')
FROM workflow_instances i
CROSS JOIN transport_fields f;

UPDATE workflow_instance_fields
SET step_key='domestic_execution',
    module_code='transport',
    is_active=1,
    is_required=1,
    sort_order=CASE field_key
      WHEN 'domestic_payable_charge_name' THEN 145
      WHEN 'domestic_freight_currency' THEN 146
      WHEN 'domestic_payable_exchange_rate' THEN 147
      WHEN 'domestic_payable_quantity' THEN 148
      WHEN 'domestic_freight_amount' THEN 149
    END
WHERE field_key IN (
  'domestic_payable_charge_name','domestic_freight_currency',
  'domestic_payable_exchange_rate','domestic_payable_quantity','domestic_freight_amount'
);
