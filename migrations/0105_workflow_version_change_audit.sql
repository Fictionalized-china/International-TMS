PRAGMA foreign_keys = ON;

CREATE TABLE workflow_instance_version_changes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  order_id TEXT,
  from_workflow_id TEXT NOT NULL,
  to_workflow_id TEXT NOT NULL,
  preserved_current_step_key TEXT NOT NULL,
  affected_order_count INTEGER NOT NULL DEFAULT 1,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT 'manual_switch',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_workflow_version_changes_instance
  ON workflow_instance_version_changes(instance_id,created_at DESC);

CREATE TABLE workflow_instance_version_step_archive (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES workflow_instance_version_changes(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  step_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE workflow_instance_version_task_archive (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES workflow_instance_version_changes(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  module_code TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_by_user_id TEXT,
  completed_at TEXT
);

CREATE TABLE workflow_field_value_audit_archive (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES workflow_instance_version_changes(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  source_workflow_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  module_code TEXT NOT NULL,
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  value_text TEXT,
  original_created_at TEXT NOT NULL,
  original_updated_at TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

CREATE INDEX idx_workflow_field_value_archive_order
  ON workflow_field_value_audit_archive(organization_id,order_id,archived_at DESC);
