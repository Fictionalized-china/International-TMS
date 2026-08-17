PRAGMA foreign_keys = ON;

-- 第一版以订单详情页的汽运八阶段为准，把后台“业务工作流”同步为订单流程。
UPDATE workflow_definitions
SET name = '汽运订单标准流程',
    updated_at = datetime('now')
WHERE code = 'tms-default';

DELETE FROM workflow_steps
WHERE workflow_id IN (
  SELECT id FROM workflow_definitions WHERE code = 'tms-default'
);

INSERT INTO workflow_steps(id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:order_creation', o.id || ':tms-default', 'order_creation', '订单创建', 'order', 'order.created', 10, 1, 1, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps(id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:review_assignment', o.id || ':tms-default', 'review_assignment', '审核分配', 'order', 'manual.review_assignment', 20, 1, 1, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps(id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:domestic_execution', o.id || ':tms-default', 'domestic_execution', '国内运输', 'order', 'manual.domestic_execution', 30, 1, 1, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps(id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:port_loading', o.id || ':tms-default', 'port_loading', '口岸配载', 'order', 'manual.port_loading', 40, 1, 1, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps(id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:outbound_transport', o.id || ':tms-default', 'outbound_transport', '出境运输', 'order', 'manual.outbound_transport', 50, 1, 1, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps(id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:overseas_pickup', o.id || ':tms-default', 'overseas_pickup', '境外仓自提', 'order', 'manual.overseas_pickup', 60, 1, 1, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps(id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:reconciliation', o.id || ':tms-default', 'reconciliation', '对账结算', 'order', 'manual.reconciliation', 70, 1, 1, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps(id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, is_required, is_active, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:completion_review', o.id || ':tms-default', 'completion_review', '完成复盘', 'order', 'manual.completion_review', 80, 1, 1, 'admin', datetime('now'), datetime('now') FROM organizations o;

INSERT OR IGNORE INTO workflow_instances(
  id, organization_id, workflow_id, customer_id, quotation_id, order_id, shipment_id, invoice_id,
  current_step_key, status, started_at, completed_at, updated_at
)
SELECT
  t.organization_id || ':order-wf:' || t.id,
  t.organization_id,
  t.organization_id || ':tms-default',
  t.customer_id,
  t.quotation_id,
  t.id,
  (SELECT s.id FROM shipments s WHERE s.order_id = t.id ORDER BY s.created_at DESC LIMIT 1),
  (SELECT i.id FROM invoices i JOIN shipments s ON s.id = i.shipment_id WHERE s.order_id = t.id ORDER BY i.created_at DESC LIMIT 1),
  CASE
    WHEN t.status = 'cancelled' THEN 'completion_review'
    WHEN t.status = 'completed' THEN 'completion_review'
    WHEN t.current_step_code = 'ready_to_complete' OR t.current_step_code = 'module:review' THEN 'completion_review'
    WHEN t.current_step_code = 'module:costs' THEN 'reconciliation'
    WHEN t.current_step_code = 'module:overseas_warehouse' THEN 'overseas_pickup'
    WHEN t.current_step_code = 'module:tracking' THEN 'outbound_transport'
    WHEN t.current_step_code = 'module:loading' THEN 'port_loading'
    WHEN t.current_step_code IN ('module:transport', 'module:warehouse', 'module:documents', 'module:customs', 'execution') THEN 'domestic_execution'
    WHEN t.current_step_code IN ('approval', 'dispatch') OR t.status IN ('submitted', 'confirmed') THEN 'review_assignment'
    ELSE 'order_creation'
  END,
  CASE
    WHEN t.status = 'cancelled' THEN 'cancelled'
    WHEN t.status = 'completed' THEN 'completed'
    ELSE 'active'
  END,
  COALESCE(t.created_at, datetime('now')),
  CASE WHEN t.status = 'completed' THEN COALESCE(t.workflow_updated_at, t.updated_at, datetime('now')) ELSE NULL END,
  COALESCE(t.workflow_updated_at, t.updated_at, datetime('now'))
FROM transport_orders t
WHERE EXISTS (
  SELECT 1 FROM workflow_definitions wd
  WHERE wd.id = t.organization_id || ':tms-default'
);

UPDATE workflow_instances
SET current_step_key = (
      SELECT CASE
        WHEN t.status = 'cancelled' THEN 'completion_review'
        WHEN t.status = 'completed' THEN 'completion_review'
        WHEN t.current_step_code = 'ready_to_complete' OR t.current_step_code = 'module:review' THEN 'completion_review'
        WHEN t.current_step_code = 'module:costs' THEN 'reconciliation'
        WHEN t.current_step_code = 'module:overseas_warehouse' THEN 'overseas_pickup'
        WHEN t.current_step_code = 'module:tracking' THEN 'outbound_transport'
        WHEN t.current_step_code = 'module:loading' THEN 'port_loading'
        WHEN t.current_step_code IN ('module:transport', 'module:warehouse', 'module:documents', 'module:customs', 'execution') THEN 'domestic_execution'
        WHEN t.current_step_code IN ('approval', 'dispatch') OR t.status IN ('submitted', 'confirmed') THEN 'review_assignment'
        ELSE 'order_creation'
      END
      FROM transport_orders t
      WHERE t.id = workflow_instances.order_id
    ),
    status = (
      SELECT CASE
        WHEN t.status = 'cancelled' THEN 'cancelled'
        WHEN t.status = 'completed' THEN 'completed'
        ELSE 'active'
      END
      FROM transport_orders t
      WHERE t.id = workflow_instances.order_id
    ),
    completed_at = (
      SELECT CASE
        WHEN t.status = 'completed' THEN COALESCE(t.workflow_updated_at, t.updated_at, datetime('now'))
        ELSE NULL
      END
      FROM transport_orders t
      WHERE t.id = workflow_instances.order_id
    ),
    updated_at = COALESCE((SELECT COALESCE(t.workflow_updated_at, t.updated_at) FROM transport_orders t WHERE t.id = workflow_instances.order_id), datetime('now'))
WHERE workflow_id IN (SELECT id FROM workflow_definitions WHERE code = 'tms-default')
  AND order_id IS NOT NULL;

UPDATE transport_orders
SET workflow_instance_id = (
  SELECT wi.id
  FROM workflow_instances wi
  WHERE wi.organization_id = transport_orders.organization_id
    AND wi.order_id = transport_orders.id
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM workflow_instances wi
  WHERE wi.organization_id = transport_orders.organization_id
    AND wi.order_id = transport_orders.id
);

INSERT INTO workflow_history(id, instance_id, step_key, step_name, actor_user_id, source, metadata, occurred_at)
SELECT
  'wf-sync-0043-' || wi.id,
  wi.id,
  wi.current_step_key,
  ws.name,
  t.created_by_user_id,
  'system',
  json_object('migration', '0043_sync_business_workflow_to_road_orders', 'order_status', t.status, 'order_step_code', t.current_step_code),
  COALESCE(t.workflow_updated_at, t.updated_at, datetime('now'))
FROM workflow_instances wi
JOIN transport_orders t ON t.id = wi.order_id
JOIN workflow_steps ws ON ws.workflow_id = wi.workflow_id AND ws.step_key = wi.current_step_key
WHERE wi.workflow_id IN (SELECT id FROM workflow_definitions WHERE code = 'tms-default')
  AND NOT EXISTS (
    SELECT 1 FROM workflow_history wh
    WHERE wh.instance_id = wi.id
      AND wh.step_key = wi.current_step_key
  );
