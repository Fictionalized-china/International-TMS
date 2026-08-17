PRAGMA foreign_keys = ON;

CREATE TABLE order_customs_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  clearance_stage TEXT NOT NULL CHECK(clearance_stage IN ('origin','destination')),
  declaration_number TEXT,
  declaration_type TEXT,
  declaration_mode TEXT,
  document_provider TEXT,
  broker_name TEXT,
  broker_contact TEXT,
  cutoff_at TEXT,
  declared_at TEXT,
  released_at TEXT,
  transit_customs INTEGER NOT NULL DEFAULT 0 CHECK(transit_customs IN (0,1)),
  inspection_required INTEGER NOT NULL DEFAULT 0 CHECK(inspection_required IN (0,1)),
  inspection_notes TEXT,
  quarantine_required INTEGER NOT NULL DEFAULT 0 CHECK(quarantine_required IN (0,1)),
  quarantine_notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','documents_pending','declared','inspecting','released','cancelled')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE order_transport_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  leg_type TEXT NOT NULL CHECK(leg_type IN ('first_mile','main','last_mile')),
  carrier_id TEXT REFERENCES carriers(id) ON DELETE SET NULL,
  carrier_name TEXT,
  vehicle_type TEXT,
  plate_number TEXT,
  driver_name TEXT,
  driver_phone TEXT,
  driver_id_number TEXT,
  freight_amount REAL NOT NULL DEFAULT 0 CHECK(freight_amount >= 0),
  freight_currency TEXT NOT NULL DEFAULT 'CNY',
  origin_location TEXT,
  destination_location TEXT,
  border_port TEXT,
  transit_location TEXT,
  route_country TEXT,
  planned_departure_at TEXT,
  planned_arrival_at TEXT,
  actual_departure_at TEXT,
  actual_arrival_at TEXT,
  loading_requirements TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','dispatched','departed','arrived','cancelled')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE order_waybills (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  waybill_number TEXT NOT NULL,
  shipper_name TEXT,
  shipper_address TEXT,
  consignee_name TEXT,
  consignee_address TEXT,
  shipper_instructions TEXT,
  customs_notes TEXT,
  accompanying_documents TEXT,
  documents_verified INTEGER NOT NULL DEFAULT 0 CHECK(documents_verified IN (0,1)),
  accompanying_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','verified','cancelled')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,waybill_number)
);

CREATE TABLE order_tracking_milestones (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  milestone_code TEXT NOT NULL,
  milestone_name TEXT NOT NULL,
  event_at TEXT NOT NULL,
  location TEXT,
  vehicle_reference TEXT,
  notes TEXT,
  visible_to_customer INTEGER NOT NULL DEFAULT 1 CHECK(visible_to_customer IN (0,1)),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE order_document_metadata (
  attachment_id TEXT PRIMARY KEY REFERENCES order_attachments(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  document_category TEXT NOT NULL DEFAULT 'other',
  description TEXT,
  public_to_customer INTEGER NOT NULL DEFAULT 0 CHECK(public_to_customer IN (0,1)),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected','archived')),
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE order_expense_controls (
  order_id TEXT PRIMARY KEY REFERENCES transport_orders(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_locked INTEGER NOT NULL DEFAULT 0 CHECK(business_locked IN (0,1)),
  finance_locked INTEGER NOT NULL DEFAULT 0 CHECK(finance_locked IN (0,1)),
  business_locked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  finance_locked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  business_locked_at TEXT,
  finance_locked_at TEXT,
  receivable_recorded_at TEXT,
  payable_recorded_at TEXT,
  closed_at TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE business_expenses ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0;
ALTER TABLE business_expenses ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE business_expenses ADD COLUMN occurred_on TEXT;
ALTER TABLE business_expenses ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE business_expenses ADD COLUMN foreign_account_no TEXT;

CREATE INDEX idx_order_customs_records_order ON order_customs_records(order_id,clearance_stage,status);
CREATE INDEX idx_order_transport_assignments_order ON order_transport_assignments(order_id,leg_type,status);
CREATE INDEX idx_order_waybills_order ON order_waybills(order_id,status);
CREATE INDEX idx_order_tracking_milestones_order ON order_tracking_milestones(order_id,event_at DESC);
CREATE INDEX idx_order_document_metadata_order ON order_document_metadata(order_id,document_category,review_status);
