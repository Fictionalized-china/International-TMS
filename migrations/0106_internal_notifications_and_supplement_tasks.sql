PRAGMA foreign_keys = ON;

CREATE TABLE internal_notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  requires_ack INTEGER NOT NULL DEFAULT 0 CHECK(requires_ack IN (0,1)),
  is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
  read_at TEXT,
  acknowledged_at TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_internal_notifications_user
  ON internal_notifications(organization_id,user_id,is_read,created_at DESC);

CREATE TABLE workflow_supplement_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  target_step_key TEXT NOT NULL,
  module_code TEXT NOT NULL,
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  task_kind TEXT NOT NULL CHECK(task_kind IN ('supplement','audit_only')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')),
  reason TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_workflow_supplement_task_open
  ON workflow_supplement_tasks(instance_id,module_code,field_key)
  WHERE status='open';

CREATE INDEX idx_workflow_supplement_task_order
  ON workflow_supplement_tasks(organization_id,order_id,status,created_at DESC);
