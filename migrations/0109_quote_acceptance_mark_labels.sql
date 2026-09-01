-- 入仓唛头是由订单号确定的虚拟业务单据，不复制订单资料，避免后续字段变更造成两套数据不一致。
-- 报价一经接受并生成订单，即记录标签生成事件；历史已接受报价在本迁移中补齐审计记录。
INSERT OR IGNORE INTO order_workflow_history(
  id,organization_id,order_id,action_code,action_name,from_status,to_status,
  to_step_code,actor_user_id,notes,occurred_at
)
SELECT
  o.id || ':mark-label-generated',
  o.organization_id,
  o.id,
  'order_mark_label_generated',
  '客户接受报价，系统自动生成入仓唛头标签',
  'draft',
  'draft',
  'order_creation',
  o.created_by_user_id,
  '唛头号 ' || o.order_number || '（与订单号一致）',
  COALESCE(q.accepted_at,o.created_at)
FROM transport_orders o
JOIN quotations q
  ON q.id=o.quotation_id
 AND q.organization_id=o.organization_id
WHERE q.accepted_at IS NOT NULL;
