PRAGMA foreign_keys = ON;

CREATE TABLE order_expense_direction_controls (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)),
  business_reviewed INTEGER NOT NULL DEFAULT 0 CHECK(business_reviewed IN (0,1)),
  finance_reviewed INTEGER NOT NULL DEFAULT 0 CHECK(finance_reviewed IN (0,1)),
  business_locked INTEGER NOT NULL DEFAULT 0 CHECK(business_locked IN (0,1)),
  finance_locked INTEGER NOT NULL DEFAULT 0 CHECK(finance_locked IN (0,1)),
  confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  business_reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  finance_reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  business_locked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  finance_locked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  business_reviewed_at TEXT,
  finance_reviewed_at TEXT,
  business_locked_at TEXT,
  finance_locked_at TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(order_id,direction)
);

CREATE INDEX idx_expense_direction_controls ON order_expense_direction_controls(organization_id,direction,confirmed,finance_locked);

INSERT INTO order_expense_direction_controls(organization_id,order_id,direction,confirmed,business_reviewed,finance_reviewed,business_locked,finance_locked,business_locked_at,finance_locked_at,updated_at)
SELECT c.organization_id,c.order_id,d.direction,
       CASE WHEN EXISTS(SELECT 1 FROM business_expenses e WHERE e.order_id=c.order_id AND e.direction=d.direction AND e.stage!='estimated') THEN 1 ELSE 0 END,
       c.business_locked,c.finance_locked,c.business_locked,c.finance_locked,c.business_locked_at,c.finance_locked_at,c.updated_at
FROM order_expense_controls c
CROSS JOIN (SELECT 'receivable' direction UNION ALL SELECT 'payable') d;
