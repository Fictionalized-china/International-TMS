CREATE TABLE customer_business_role_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role_code TEXT NOT NULL CHECK (role_code IN (
    'overseas_agent',
    'fee_party',
    'principal',
    'shipper',
    'consignee',
    'notify_party',
    'trucking',
    'shipping_agent',
    'factory',
    'booking_party',
    'warehouse',
    'customs_broker',
    'ro_agent',
    'intermediary',
    'container_owner',
    'freight_station',
    'yard'
  )),
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, customer_id, role_code)
);

CREATE INDEX idx_customer_business_roles_customer
  ON customer_business_role_assignments(organization_id, customer_id, role_code);

INSERT INTO customer_business_role_assignments(
  id,
  organization_id,
  customer_id,
  role_code,
  created_at
)
SELECT
  lower(hex(randomblob(16))),
  organization_id,
  id,
  CASE type
    WHEN 'agent' THEN 'overseas_agent'
    WHEN 'partner' THEN 'fee_party'
    ELSE 'principal'
  END,
  created_at
FROM customers;
