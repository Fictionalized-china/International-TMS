PRAGMA foreign_keys = ON;

CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES departments(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, code),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX idx_departments_org_parent ON departments(organization_id,parent_id,sort_order,name);

ALTER TABLE memberships ADD COLUMN department_id TEXT REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX idx_memberships_department ON memberships(organization_id,department_id);

INSERT INTO permissions(code,module,name,description) VALUES
  ('department.view','identity','查看部门','查看组织的多级部门结构'),
  ('department.manage','identity','管理部门','创建部门并维护部门层级和状态');

INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r JOIN permissions p ON p.code IN ('department.view','department.manage')
WHERE r.code='owner' AND r.is_system=1;

INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at)
SELECT lower(hex(randomblob(16))),id,NULL,'HQ','总部','active',10,datetime('now'),datetime('now')
FROM organizations;

UPDATE memberships
SET department_id=(SELECT d.id FROM departments d WHERE d.organization_id=memberships.organization_id AND d.code='HQ' LIMIT 1)
WHERE department_id IS NULL;
