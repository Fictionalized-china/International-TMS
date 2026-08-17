PRAGMA foreign_keys = ON;

CREATE TABLE freight_inquiries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inquiry_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  logistics_product_id TEXT REFERENCES logistics_products(id) ON DELETE SET NULL,
  origin_country TEXT NOT NULL,
  origin_city TEXT,
  destination_country TEXT NOT NULL,
  destination_city TEXT,
  cargo_description TEXT NOT NULL,
  pieces INTEGER NOT NULL DEFAULT 1 CHECK (pieces > 0),
  gross_weight_kg REAL NOT NULL CHECK (gross_weight_kg > 0),
  volume_cbm REAL NOT NULL CHECK (volume_cbm > 0),
  estimated_currency TEXT NOT NULL,
  estimated_base_freight REAL NOT NULL DEFAULT 0,
  estimated_total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','quoting','quoted','cancelled')),
  customer_notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id,inquiry_number)
);

CREATE INDEX idx_freight_inquiries_org_status ON freight_inquiries(organization_id,status,created_at DESC);
CREATE INDEX idx_freight_inquiries_customer ON freight_inquiries(customer_id,created_at DESC);

ALTER TABLE quotations ADD COLUMN inquiry_id TEXT REFERENCES freight_inquiries(id) ON DELETE SET NULL;
ALTER TABLE quotations ADD COLUMN logistics_product_id TEXT REFERENCES logistics_products(id) ON DELETE SET NULL;
ALTER TABLE quotations ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_quotations_inquiry_version ON quotations(inquiry_id,version_number DESC);
CREATE UNIQUE INDEX idx_transport_orders_one_per_quote ON transport_orders(quotation_id) WHERE quotation_id IS NOT NULL;
