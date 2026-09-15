PRAGMA foreign_keys = ON;

UPDATE workflow_step_fields
SET field_type='select',
    options_text='卡车' || char(10) || '尖程拼车' || char(10) ||
      '13米平板' || char(10) || '13.5米高栏' || char(10) ||
      '13.7米平板' || char(10) || '17.5米平板' || char(10) ||
      '17.5米厢式车' || char(10) || '13米高栏' || char(10) ||
      '16米厢式车' || char(10) || '13米厢式车' || char(10) || '冷藏车',
    updated_at=datetime('now')
WHERE field_key='domestic_vehicle_type'
  AND COALESCE(module_code,'transport')='transport';

UPDATE workflow_instance_fields
SET field_type='select',
    options_text='卡车' || char(10) || '尖程拼车' || char(10) ||
      '13米平板' || char(10) || '13.5米高栏' || char(10) ||
      '13.7米平板' || char(10) || '17.5米平板' || char(10) ||
      '17.5米厢式车' || char(10) || '13米高栏' || char(10) ||
      '16米厢式车' || char(10) || '13米厢式车' || char(10) || '冷藏车'
WHERE field_key='domestic_vehicle_type'
  AND module_code='transport';
