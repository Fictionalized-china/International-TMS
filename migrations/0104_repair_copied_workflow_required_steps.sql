-- 修复旧版复制逻辑把工作流节点 is_required 全部写成 0 的数据。
-- 只处理“当前没有任何必经节点”的派生版本；以模板族根版本同 step_key 的规则为准。
UPDATE workflow_steps
SET is_required = COALESCE(
  (
    SELECT source_step.is_required
    FROM workflow_definitions target_definition
    JOIN workflow_steps source_step
      ON source_step.workflow_id = target_definition.template_family_id
     AND source_step.step_key = workflow_steps.step_key
    WHERE target_definition.id = workflow_steps.workflow_id
      AND target_definition.id <> target_definition.template_family_id
  ),
  workflow_steps.is_required
)
WHERE workflow_id IN (
  SELECT derived.id
  FROM workflow_definitions derived
  WHERE derived.template_family_id IS NOT NULL
    AND derived.id <> derived.template_family_id
    AND NOT EXISTS (
      SELECT 1
      FROM workflow_steps required_step
      WHERE required_step.workflow_id = derived.id
        AND required_step.is_active = 1
        AND required_step.is_required = 1
    )
);
