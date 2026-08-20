PRAGMA foreign_keys = ON;

CREATE TABLE position_portal_settings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  order_scope TEXT NOT NULL DEFAULT 'current_position'
    CHECK(order_scope IN ('current_position','all_orders')),
  default_filter TEXT NOT NULL DEFAULT 'open'
    CHECK(default_filter IN ('open','all','blocked','overdue')),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,position_id)
);

CREATE INDEX idx_position_portal_settings_org
  ON position_portal_settings(organization_id,position_id);

INSERT INTO position_portal_settings(
  id,organization_id,position_id,order_scope,default_filter,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),p.organization_id,p.id,
       CASE WHEN p.code IN ('BOSS','DEVELOPER') THEN 'all_orders' ELSE 'current_position' END,
       'open',datetime('now'),datetime('now')
FROM positions p;
