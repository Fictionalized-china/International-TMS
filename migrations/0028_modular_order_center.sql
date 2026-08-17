PRAGMA foreign_keys = ON;

CREATE TABLE order_module_instances (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  module_name TEXT NOT NULL,
  workflow_version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  is_required INTEGER NOT NULL DEFAULT 1 CHECK(is_required IN (0,1)),
  status TEXT NOT NULL DEFAULT 'not_started',
  current_step_code TEXT,
  current_step_name TEXT,
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK(progress_percent BETWEEN 0 AND 100),
  assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  blocking_reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_id,module_code)
);

CREATE TABLE order_module_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL REFERENCES order_module_instances(id) ON DELETE CASCADE,
  action_code TEXT NOT NULL,
  action_name TEXT NOT NULL,
  from_step_code TEXT,
  to_step_code TEXT,
  to_step_name TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE order_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'module_owner',
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_order_modules_order ON order_module_instances(order_id,enabled,status);
CREATE INDEX idx_order_module_history_instance ON order_module_history(module_instance_id,occurred_at DESC);
CREATE INDEX idx_order_tasks_order ON order_tasks(order_id,module_code,status);
CREATE INDEX idx_order_tasks_assignee ON order_tasks(organization_id,assignee_user_id,status,due_at);
