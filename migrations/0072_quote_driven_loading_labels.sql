PRAGMA foreign_keys = ON;

-- Transport type is fixed by the accepted quotation. Keep existing workflow
-- templates and active instances aligned with the user-facing module name.
UPDATE workflow_steps
SET name='装车与出库', updated_at=datetime('now')
WHERE name='配载选择与装车出库';

UPDATE order_module_instances
SET module_name='装车与出库', updated_at=datetime('now')
WHERE module_code='loading' AND module_name='配载选择与装车出库';

UPDATE workflow_step_fields
SET label='货齐状态', updated_at=datetime('now')
WHERE label='齐套复核';

UPDATE workflow_instance_fields
SET label='货齐状态'
WHERE label='齐套复核';
