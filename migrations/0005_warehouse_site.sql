PRAGMA foreign_keys = OFF;

CREATE TABLE sessions_with_warehouse (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  site TEXT NOT NULL DEFAULT 'admin' CHECK (site IN ('admin', 'portal', 'warehouse'))
);

INSERT INTO sessions_with_warehouse (id,user_id,organization_id,token_hash,expires_at,last_seen_at,created_at,site)
SELECT id,user_id,organization_id,token_hash,expires_at,last_seen_at,created_at,site FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_with_warehouse RENAME TO sessions;
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

PRAGMA foreign_keys = ON;

INSERT INTO permissions (code,module,name,description) VALUES
  ('warehouse.view','warehouse','查看仓库工作台','登录仓库站点并查看仓库作业队列'),
  ('warehouse.operate','warehouse','执行仓库作业','执行收货、分拣、装卸、出库和异常登记'),
  ('warehouse.manage','warehouse','管理仓库配置','管理仓库、库区、月台、作业规则和人员');

INSERT OR IGNORE INTO role_permissions (role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.module='warehouse'
WHERE r.code='owner' AND r.is_system=1;
