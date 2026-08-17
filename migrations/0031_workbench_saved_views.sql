PRAGMA foreign_keys = ON;

CREATE TABLE workbench_saved_views (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL CHECK(workspace IN ('tasks','customs','documents','tracking','costs')),
  name TEXT NOT NULL,
  query_text TEXT,
  status_view TEXT NOT NULL DEFAULT 'all' CHECK(status_view IN ('all','pending','overdue')),
  ownership_scope TEXT NOT NULL DEFAULT 'team' CHECK(ownership_scope IN ('team','mine','unassigned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,user_id,workspace,name)
);

CREATE INDEX idx_workbench_saved_views_user
  ON workbench_saved_views(organization_id,user_id,workspace,updated_at DESC);
