PRAGMA foreign_keys = ON;

CREATE TABLE document_sequences (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('quote', 'order', 'shipment', 'invoice')),
  next_value INTEGER NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organization_id, document_type)
);

CREATE TABLE carriers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  scac TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, code)
);

CREATE TABLE quotations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quote_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  opportunity_id TEXT REFERENCES sales_opportunities(id) ON DELETE SET NULL,
  origin_country TEXT NOT NULL,
  origin_city TEXT NOT NULL,
  destination_country TEXT NOT NULL,
  destination_city TEXT NOT NULL,
  transport_mode TEXT NOT NULL,
  service_level TEXT,
  cargo_description TEXT NOT NULL,
  pieces INTEGER NOT NULL DEFAULT 1 CHECK (pieces > 0),
  gross_weight_kg REAL NOT NULL DEFAULT 0 CHECK (gross_weight_kg >= 0),
  volume_cbm REAL NOT NULL DEFAULT 0 CHECK (volume_cbm >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  subtotal REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_amount REAL NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount REAL NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled')),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, quote_number)
);

CREATE TABLE quotation_charges (
  id TEXT PRIMARY KEY,
  quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  charge_code TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE transport_orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  quotation_id TEXT REFERENCES quotations(id) ON DELETE SET NULL,
  customer_reference TEXT,
  shipper_name TEXT NOT NULL,
  shipper_contact TEXT,
  shipper_phone TEXT,
  origin_country TEXT NOT NULL,
  origin_city TEXT NOT NULL,
  origin_address TEXT NOT NULL,
  consignee_name TEXT NOT NULL,
  consignee_contact TEXT,
  consignee_phone TEXT,
  destination_country TEXT NOT NULL,
  destination_city TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  cargo_description TEXT NOT NULL,
  pieces INTEGER NOT NULL DEFAULT 1 CHECK (pieces > 0),
  gross_weight_kg REAL NOT NULL DEFAULT 0 CHECK (gross_weight_kg >= 0),
  volume_cbm REAL NOT NULL DEFAULT 0 CHECK (volume_cbm >= 0),
  transport_mode TEXT NOT NULL,
  service_level TEXT,
  requested_pickup_date TEXT,
  requested_delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'confirmed', 'in_execution', 'completed', 'cancelled')),
  source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'portal')),
  special_instructions TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, order_number)
);

CREATE TABLE shipments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shipment_number TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  master_tracking_number TEXT,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'picked_up', 'in_transit', 'customs', 'out_for_delivery', 'delivered', 'exception', 'cancelled')),
  current_location TEXT,
  estimated_delivery_at TEXT,
  actual_pickup_at TEXT,
  actual_delivery_at TEXT,
  signed_by TEXT,
  exception_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, shipment_number),
  UNIQUE (order_id)
);

CREATE TABLE shipment_legs (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  carrier_id TEXT REFERENCES carriers(id) ON DELETE SET NULL,
  carrier_reference TEXT,
  origin_location TEXT NOT NULL,
  destination_location TEXT NOT NULL,
  planned_departure_at TEXT,
  planned_arrival_at TEXT,
  actual_departure_at TEXT,
  actual_arrival_at TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'dispatched', 'departed', 'arrived', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shipment_id, sequence_no)
);

CREATE TABLE shipment_events (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  location TEXT,
  description TEXT NOT NULL,
  event_at TEXT NOT NULL,
  visible_to_customer INTEGER NOT NULL DEFAULT 1 CHECK (visible_to_customer IN (0, 1)),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  shipment_id TEXT REFERENCES shipments(id) ON DELETE SET NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  subtotal REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_amount REAL NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount REAL NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  paid_amount REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  issue_date TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void')),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, invoice_number)
);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_carriers_org_status ON carriers(organization_id, status);
CREATE INDEX idx_quotations_org_status ON quotations(organization_id, status, created_at);
CREATE INDEX idx_quotation_charges_quote ON quotation_charges(quotation_id, sort_order);
CREATE INDEX idx_orders_org_status ON transport_orders(organization_id, status, created_at);
CREATE INDEX idx_orders_customer ON transport_orders(customer_id, created_at);
CREATE INDEX idx_shipments_org_status ON shipments(organization_id, status, updated_at);
CREATE INDEX idx_shipments_customer ON shipments(customer_id, updated_at);
CREATE INDEX idx_shipment_events_shipment ON shipment_events(shipment_id, event_at DESC);
CREATE INDEX idx_invoices_org_status ON invoices(organization_id, status, due_date);
CREATE INDEX idx_invoices_customer ON invoices(customer_id, created_at);

INSERT INTO permissions (code, module, name, description) VALUES
  ('quote.view', 'quote', '查看报价', '查看客户询价和运输报价'),
  ('quote.manage', 'quote', '管理报价', '创建报价、费用明细并推进报价状态'),
  ('order.view', 'order', '查看订单', '查看客户运输订单'),
  ('order.manage', 'order', '管理订单', '创建、确认和取消运输订单'),
  ('shipment.view', 'shipment', '查看运单', '查看运单、运输分段和轨迹'),
  ('shipment.manage', 'shipment', '管理运单', '创建运单、分配承运商并更新运输轨迹'),
  ('billing.view', 'billing', '查看账单', '查看客户应收账单'),
  ('billing.manage', 'billing', '管理账单', '创建、开具和核销客户账单');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM roles r
JOIN permissions p ON p.module IN ('quote', 'order', 'shipment', 'billing')
WHERE r.code = 'owner' AND r.is_system = 1;

