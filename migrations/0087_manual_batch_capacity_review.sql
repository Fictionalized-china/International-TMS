PRAGMA foreign_keys = ON;

-- Vehicle capacity is reference data for manual dispatch decisions. It must
-- never block loading or reject a batch automatically.
UPDATE workflow_step_fields
SET is_required = 0,
    label = CASE field_key
      WHEN 'vehicle_capacity_weight' THEN '车辆载重参考KG'
      ELSE '车辆容积参考CBM'
    END,
    help_text = '仅供人工判断装载方案，系统不校验是否超载。',
    updated_at = datetime('now')
WHERE module_code = 'loading'
  AND field_key IN ('vehicle_capacity_weight', 'vehicle_capacity_volume');

UPDATE workflow_instance_fields
SET is_required = 0,
    label = CASE field_key
      WHEN 'vehicle_capacity_weight' THEN '车辆载重参考KG'
      ELSE '车辆容积参考CBM'
    END,
    help_text = '仅供人工判断装载方案，系统不校验是否超载。'
WHERE module_code = 'loading'
  AND field_key IN ('vehicle_capacity_weight', 'vehicle_capacity_volume');
