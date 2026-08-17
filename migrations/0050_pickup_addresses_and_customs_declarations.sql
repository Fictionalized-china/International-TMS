ALTER TABLE transport_orders ADD COLUMN shipper_customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE transport_orders ADD COLUMN pickup_address_id TEXT REFERENCES customer_addresses(id) ON DELETE SET NULL;
ALTER TABLE transport_orders ADD COLUMN cargo_ready_at TEXT;
ALTER TABLE transport_orders ADD COLUMN ro_agent TEXT;

CREATE INDEX idx_transport_orders_shipper_customer
  ON transport_orders(organization_id,shipper_customer_id,created_at);
CREATE INDEX idx_transport_orders_pickup_address
  ON transport_orders(organization_id,pickup_address_id,created_at);

CREATE TABLE order_customs_declarations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  customs_record_id TEXT NOT NULL REFERENCES order_customs_records(id) ON DELETE CASCADE,
  declaration_number TEXT NOT NULL,
  declaration_type TEXT NOT NULL,
  declaration_title TEXT NOT NULL,
  declaring_company TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  declared_amount REAL NOT NULL DEFAULT 0 CHECK(declared_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  gross_weight_kg REAL NOT NULL DEFAULT 0 CHECK(gross_weight_kg >= 0),
  released_at TEXT,
  status TEXT NOT NULL DEFAULT 'declared' CHECK(status IN ('draft','declared','released','cancelled')),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0,1)),
  is_redeclared INTEGER NOT NULL DEFAULT 0 CHECK(is_redeclared IN (0,1)),
  is_amended INTEGER NOT NULL DEFAULT 0 CHECK(is_amended IN (0,1)),
  is_inspected INTEGER NOT NULL DEFAULT 0 CHECK(is_inspected IN (0,1)),
  change_reason TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,order_id,declaration_number)
);

CREATE INDEX idx_customs_declarations_order
  ON order_customs_declarations(organization_id,order_id,status,is_deleted);
CREATE INDEX idx_customs_declarations_record
  ON order_customs_declarations(customs_record_id,status,is_deleted,updated_at);

INSERT OR IGNORE INTO order_customs_declarations(
  id,organization_id,order_id,customs_record_id,declaration_number,declaration_type,
  declaration_title,declaring_company,declared_at,declared_amount,currency,gross_weight_kg,
  released_at,status,is_deleted,is_redeclared,is_amended,is_inspected,change_reason,
  created_by_user_id,created_at,updated_at
)
SELECT
  r.id || ':declaration',r.organization_id,r.order_id,r.id,r.declaration_number,
  COALESCE(NULLIF(r.declaration_type,''),'未分类'),
  COALESCE(NULLIF(r.document_provider,''),'待补充'),
  COALESCE(NULLIF(r.broker_name,''),'待补充'),
  COALESCE(r.declared_at,r.created_at),0,'USD',0,r.released_at,
  CASE
    WHEN r.status='released' THEN 'released'
    WHEN r.status='cancelled' THEN 'cancelled'
    WHEN r.status IN ('declared','inspecting') THEN 'declared'
    ELSE 'draft'
  END,
  CASE WHEN r.status='cancelled' THEN 1 ELSE 0 END,
  0,0,r.inspection_required,r.inspection_notes,
  r.created_by_user_id,r.created_at,r.updated_at
FROM order_customs_records r
WHERE NULLIF(TRIM(r.declaration_number),'') IS NOT NULL;
