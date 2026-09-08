PRAGMA foreign_keys = ON;

-- Domestic receiving must never silently turn an omitted measurement into a
-- real zero. Make both total weight and total volume visible and required in
-- the workflow definitions. Boss-authored changes made after this migration
-- remain editable through the normal workflow configuration page.
UPDATE workflow_step_fields
SET is_active=1,
    is_required=1,
    label=CASE field_key
      WHEN 'actual_weight_kg' THEN '实收重量KG'
      WHEN 'actual_volume_cbm' THEN '实收总体积CBM'
      ELSE label
    END,
    help_text=CASE field_key
      WHEN 'actual_weight_kg' THEN '仓库收货时登记整票入仓包装的实收重量。'
      WHEN 'actual_volume_cbm' THEN '仓库收货时登记整票入仓包装的实收总体积；最终出库包装尺寸在二次打包贴标阶段登记。'
      ELSE help_text
    END,
    updated_at=datetime('now')
WHERE COALESCE(module_code,'consignment')='warehouse'
  AND field_key IN ('actual_weight_kg','actual_volume_cbm');

-- Match the system's hot-update rule: the current and future node adopt the
-- new requirement, while a completed/not-applicable receiving node keeps its
-- frozen historical snapshot and is not sent backwards.
UPDATE workflow_instance_fields AS instance_field
SET is_active=1,
    is_required=1,
    label=CASE instance_field.field_key
      WHEN 'actual_weight_kg' THEN '实收重量KG'
      WHEN 'actual_volume_cbm' THEN '实收总体积CBM'
      ELSE instance_field.label
    END,
    help_text=CASE instance_field.field_key
      WHEN 'actual_weight_kg' THEN '仓库收货时登记整票入仓包装的实收重量。'
      WHEN 'actual_volume_cbm' THEN '仓库收货时登记整票入仓包装的实收总体积；最终出库包装尺寸在二次打包贴标阶段登记。'
      ELSE instance_field.help_text
    END
WHERE instance_field.module_code='warehouse'
  AND instance_field.field_key IN ('actual_weight_kg','actual_volume_cbm')
  AND EXISTS (
    SELECT 1
    FROM workflow_instance_step_states AS state
    WHERE state.instance_id=instance_field.instance_id
      AND state.step_key=instance_field.step_key
      AND state.status NOT IN ('completed','not_applicable')
  );
