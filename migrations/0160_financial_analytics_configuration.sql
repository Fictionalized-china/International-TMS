PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
  ('analytics.config.manage','analytics','配置财务分析口径','配置指标自动计算、指定填报岗位、起算日期来源、目标值和预警阈值'),
  ('analytics.manual.fill','analytics','填写财务分析指标','按获授权岗位填写或导入人工统计值');

CREATE TABLE analytics_metric_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric_code TEXT NOT NULL,
  calculation_mode TEXT NOT NULL DEFAULT 'automatic'
    CHECK(calculation_mode IN ('automatic','manual')),
  assigned_position_id TEXT REFERENCES positions(id) ON DELETE SET NULL,
  start_date_source TEXT NOT NULL DEFAULT 'settlement_confirmed'
    CHECK(start_date_source IN (
      'order_created','actual_departure','actual_arrival','customer_signed',
      'settlement_confirmed','bill_created','agreed_due','cash_occurred','manual'
    )),
  target_value REAL,
  warning_value REAL,
  danger_value REAL,
  config_json TEXT,
  effective_from TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,metric_code)
);

CREATE TABLE analytics_manual_metric_values (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric_code TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  dimension_key TEXT NOT NULL DEFAULT '',
  dimension_label TEXT,
  numeric_value REAL,
  text_value TEXT,
  source_note TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('draft','confirmed','void')),
  entered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,metric_code,period_start,period_end,dimension_key)
);

CREATE TABLE analytics_report_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  generation_mode TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(generation_mode IN ('scheduled','manual')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,period_start,period_end,generated_at)
);

CREATE TABLE analytics_port_settings (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  port_name TEXT NOT NULL,
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK(is_visible IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 100,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,port_name)
);

CREATE INDEX idx_analytics_metric_configs_org
  ON analytics_metric_configs(organization_id,metric_code);
CREATE INDEX idx_analytics_manual_values_period
  ON analytics_manual_metric_values(organization_id,period_start,period_end,metric_code,status);
CREATE INDEX idx_analytics_snapshots_period
  ON analytics_report_snapshots(organization_id,period_start,period_end,generated_at DESC);

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'analytics.config.manage' FROM roles
WHERE status='active' AND code IN ('owner','boss','pos_finance');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'analytics.manual.fill' FROM roles
WHERE status='active' AND code IN ('owner','boss','pos_finance');
