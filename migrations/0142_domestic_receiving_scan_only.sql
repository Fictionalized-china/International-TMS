-- 国内仓收货改为统一唛头扫描：包装数由扫码累计，商品件数和最终包装体积不在收货环节采集。
UPDATE workflow_step_fields
SET is_required=0,
    is_active=0,
    label='收货实测体积（旧）',
    help_text='国内仓收货不再测量最终包装体积；二次打包后的尺寸与体积在装车准备阶段登记。',
    updated_at=datetime('now')
WHERE field_key='actual_volume_cbm'
  AND step_id IN (SELECT id FROM workflow_steps WHERE step_key='warehouse_receiving');

UPDATE workflow_instance_fields
SET is_required=0,
    is_active=0,
    label='收货实测体积（旧）',
    help_text='国内仓收货不再测量最终包装体积；二次打包后的尺寸与体积在装车准备阶段登记。'
WHERE step_key='warehouse_receiving'
  AND field_key='actual_volume_cbm';
