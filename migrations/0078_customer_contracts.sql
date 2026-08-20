PRAGMA foreign_keys = ON;

-- 合同归档到客户资料页：合同不再挂订单工作流，而是在客户维度长期归档。
-- 订单创建时可引用客户名下合同；历史订单合同附件保留在 order_attachments 中不迁移。

CREATE TABLE IF NOT EXISTS customer_contracts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  data_url TEXT NOT NULL,
  effective_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  notes TEXT,
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_contracts_customer
  ON customer_contracts(organization_id,customer_id,status,created_at DESC);
