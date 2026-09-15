PRAGMA foreign_keys = ON;

ALTER TABLE sessions ADD COLUMN site TEXT NOT NULL DEFAULT 'admin' CHECK (site IN ('admin', 'portal'));
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

CREATE TABLE reference_data (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('country', 'currency', 'unit', 'transport_mode', 'service_level', 'cargo_type', 'lead_source')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_en TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, category, code)
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT,
  type TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'agent', 'partner')),
  tax_id TEXT,
  website TEXT,
  industry TEXT,
  source_code TEXT,
  sales_owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  credit_limit REAL NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credit_currency TEXT NOT NULL DEFAULT 'USD',
  payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('prospect', 'active', 'suspended', 'archived')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, code)
);

CREATE TABLE customer_contacts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE customer_addresses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'shipping' CHECK (type IN ('registered', 'billing', 'shipping', 'warehouse')),
  label TEXT NOT NULL,
  country_code TEXT NOT NULL,
  state TEXT,
  city TEXT NOT NULL,
  postal_code TEXT,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE customer_portal_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id),
  UNIQUE (customer_id, user_id)
);

CREATE TABLE sales_leads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  source_code TEXT,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'lost')),
  estimated_monthly_shipments INTEGER NOT NULL DEFAULT 0 CHECK (estimated_monthly_shipments >= 0),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sales_opportunities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id TEXT REFERENCES sales_leads(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'discovery' CHECK (stage IN ('discovery', 'solution', 'quotation', 'negotiation', 'won', 'lost')),
  estimated_value REAL NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  probability INTEGER NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),
  expected_close_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sales_activities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES sales_leads(id) ON DELETE CASCADE,
  opportunity_id TEXT REFERENCES sales_opportunities(id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'task', 'note')),
  subject TEXT NOT NULL,
  due_at TEXT,
  completed_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_reference_org_category ON reference_data(organization_id, category, status);
CREATE INDEX idx_customers_org_status ON customers(organization_id, status);
CREATE INDEX idx_customer_contacts_customer ON customer_contacts(customer_id);
CREATE INDEX idx_customer_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX idx_portal_accounts_user ON customer_portal_accounts(user_id, status);
CREATE INDEX idx_sales_leads_org_status ON sales_leads(organization_id, status);
CREATE INDEX idx_opportunities_org_stage ON sales_opportunities(organization_id, stage);
CREATE INDEX idx_sales_activities_org_due ON sales_activities(organization_id, due_at);

INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'country', 'CN', '中国', 'China', 10, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'country', 'US', '美国', 'United States', 20, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'currency', 'CNY', '人民币', 'Chinese Yuan', 10, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'currency', 'USD', '美元', 'US Dollar', 20, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'unit', 'KG', '千克', 'Kilogram', 10, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'unit', 'CBM', '立方米', 'Cubic Meter', 20, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'transport_mode', 'ROAD', '公路零担', 'Road LTL', 10, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'transport_mode', 'AIR', '空运', 'Air Freight', 20, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'transport_mode', 'OCEAN', '海运', 'Ocean Freight', 30, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'service_level', 'STANDARD', '标准服务', 'Standard', 10, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'service_level', 'EXPRESS', '加急服务', 'Express', 20, 'active', datetime('now'), datetime('now') FROM organizations;
INSERT INTO reference_data SELECT lower(hex(randomblob(16))), id, 'lead_source', 'REFERRAL', '客户转介绍', 'Referral', 10, 'active', datetime('now'), datetime('now') FROM organizations;

INSERT INTO permissions (code, module, name, description) VALUES
  ('master.view', 'master', '查看基础数据', '查看运输基础数据和代码表'),
  ('master.manage', 'master', '管理基础数据', '创建和停用运输基础数据'),
  ('customer.view', 'crm', '查看客户', '查看客户、联系人和地址'),
  ('customer.manage', 'crm', '管理客户', '创建和维护客户、联系人、地址及门户账户'),
  ('sales.view', 'sales', '查看销售', '查看线索、商机和销售活动'),
  ('sales.manage', 'sales', '管理销售', '创建和推进线索、商机和销售活动'),
  ('security.manage', 'identity', '管理安全', '查看并撤销组织会话和处理安全状态');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM roles r
JOIN permissions p ON p.code IN ('master.view', 'master.manage', 'customer.view', 'customer.manage', 'sales.view', 'sales.manage', 'security.manage')
WHERE r.code = 'owner' AND r.is_system = 1;
