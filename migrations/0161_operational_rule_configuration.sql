PRAGMA foreign_keys = ON;

CREATE TABLE operational_rule_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_code TEXT NOT NULL,
  numeric_value REAL NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,rule_code)
);

CREATE INDEX idx_operational_rule_configs_org
  ON operational_rule_configs(organization_id,rule_code);
