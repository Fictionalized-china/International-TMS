PRAGMA foreign_keys = ON;

CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, code)
);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('customer', 'quote', 'order', 'shipment', 'invoice')),
  trigger_event TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_required INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  actor_scope TEXT NOT NULL DEFAULT 'admin' CHECK (actor_scope IN ('admin', 'portal', 'system')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_id, step_key),
  UNIQUE (workflow_id, trigger_event)
);

CREATE TABLE workflow_instances (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  quotation_id TEXT REFERENCES quotations(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES transport_orders(id) ON DELETE SET NULL,
  shipment_id TEXT REFERENCES shipments(id) ON DELETE SET NULL,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  current_step_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_history (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  step_name TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('admin', 'portal', 'system')),
  metadata TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_workflow_definitions_org ON workflow_definitions(organization_id, status);
CREATE INDEX idx_workflow_steps_definition ON workflow_steps(workflow_id, sort_order);
CREATE INDEX idx_workflow_instances_org ON workflow_instances(organization_id, status, updated_at);
CREATE UNIQUE INDEX idx_workflow_instances_quote ON workflow_instances(quotation_id) WHERE quotation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_workflow_instances_order ON workflow_instances(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_workflow_instances_shipment ON workflow_instances(shipment_id) WHERE shipment_id IS NOT NULL;
CREATE UNIQUE INDEX idx_workflow_instances_invoice ON workflow_instances(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_workflow_history_instance ON workflow_history(instance_id, occurred_at);

INSERT INTO permissions (code, module, name, description) VALUES
  ('workflow.view', 'workflow', '查看工作流', '查看端到端业务流程和执行进度'),
  ('workflow.manage', 'workflow', '管理工作流', '配置业务流程节点、顺序和启停状态');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM roles r
JOIN permissions p ON p.module = 'workflow'
WHERE r.code = 'owner' AND r.is_system = 1;

INSERT INTO workflow_definitions (id, organization_id, code, name, created_at, updated_at)
SELECT o.id || ':tms-default', o.id, 'tms-default', '国际零担标准流程', datetime('now'), datetime('now')
FROM organizations o;

INSERT INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:customer', o.id || ':tms-default', 'customer', '客户', 'customer', 'customer.ready', 10, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:quotation', o.id || ':tms-default', 'quotation', '报价', 'quote', 'quote.created', 20, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:portal_accepted', o.id || ':tms-default', 'portal_accepted', '门户接受', 'quote', 'quote.accepted', 30, 'portal', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:order', o.id || ':tms-default', 'order', '订单', 'order', 'order.created', 40, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:shipment', o.id || ':tms-default', 'shipment', '运单', 'shipment', 'shipment.created', 50, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:picked_up', o.id || ':tms-default', 'picked_up', '提货', 'shipment', 'shipment.picked_up', 60, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:in_transit', o.id || ':tms-default', 'in_transit', '在途', 'shipment', 'shipment.in_transit', 70, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:delivered', o.id || ':tms-default', 'delivered', '签收', 'shipment', 'shipment.delivered', 80, 'admin', datetime('now'), datetime('now') FROM organizations o;
INSERT INTO workflow_steps (id, workflow_id, step_key, name, entity_type, trigger_event, sort_order, actor_scope, created_at, updated_at)
SELECT o.id || ':wf:invoice', o.id || ':tms-default', 'invoice', '账单', 'invoice', 'invoice.created', 90, 'admin', datetime('now'), datetime('now') FROM organizations o;
