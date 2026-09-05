PRAGMA foreign_keys = ON;

-- Customer-service confirmation used to be a hard-coded third sign-off with
-- no workflow field. Give it a real configurable rule so the editor, UI and
-- runtime gate can share one source of truth.
INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
  sort_order,options_text,help_text,module_code,created_at,updated_at
)
SELECT definition.id || ':catalog:costs:customer_service_confirmation',
       definition.id,step.id,'customer_service_confirmation','客服费用确认','select',
       1,1,1215,'approved|通过
rejected|退回','本单客服负责人确认应收、应付费用明细完整。','costs',
       CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM workflow_definitions AS definition
JOIN workflow_steps AS step
  ON step.workflow_id=definition.id AND step.step_key='reconciliation'
WHERE definition.road_load_type IN ('ftl','ltl')
  AND NOT EXISTS(
    SELECT 1 FROM workflow_step_fields AS existing
    WHERE existing.workflow_id=definition.id
      AND existing.field_key='customer_service_confirmation'
      AND COALESCE(existing.module_code,'consignment')='costs'
  );

-- Only current/future reconciliation stages receive the new gate. Orders that
-- already passed reconciliation retain their historical snapshot.
INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT lower(hex(randomblob(16))),instance.id,instance.workflow_id,
       'reconciliation','costs','customer_service_confirmation','客服费用确认','select',
       1,1,1215,'approved|通过
rejected|退回','本单客服负责人确认应收、应付费用明细完整。',CURRENT_TIMESTAMP
FROM workflow_instances AS instance
JOIN workflow_definitions AS definition
  ON definition.id=instance.workflow_id
JOIN workflow_steps AS current_step
  ON current_step.workflow_id=instance.workflow_id
 AND current_step.step_key=instance.current_step_key
JOIN workflow_steps AS target_step
  ON target_step.workflow_id=instance.workflow_id
 AND target_step.step_key='reconciliation'
WHERE definition.road_load_type IN ('ftl','ltl')
  AND current_step.sort_order<=target_step.sort_order;
