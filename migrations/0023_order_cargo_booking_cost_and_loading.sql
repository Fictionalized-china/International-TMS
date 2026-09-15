PRAGMA foreign_keys = ON;

ALTER TABLE transport_orders ADD COLUMN order_date TEXT;
ALTER TABLE transport_orders ADD COLUMN business_nature TEXT NOT NULL DEFAULT 'export' CHECK (business_nature IN ('export','import','transit','domestic'));
ALTER TABLE transport_orders ADD COLUMN business_type TEXT NOT NULL DEFAULT 'ltl';
ALTER TABLE transport_orders ADD COLUMN transport_terms TEXT;
ALTER TABLE transport_orders ADD COLUMN trade_terms TEXT;
ALTER TABLE transport_orders ADD COLUMN exit_port TEXT;
ALTER TABLE transport_orders ADD COLUMN transit_locations TEXT;
ALTER TABLE transport_orders ADD COLUMN customs_location TEXT;
ALTER TABLE transport_orders ADD COLUMN route_notes TEXT;

CREATE TABLE order_services (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  service_code TEXT NOT NULL,
  service_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','in_progress','completed','cancelled')),
  created_at TEXT NOT NULL,
  UNIQUE(order_id,service_code)
);

CREATE TABLE order_cargo_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  cargo_name_cn TEXT NOT NULL,
  cargo_name_en TEXT,
  hs_code TEXT,
  overseas_hs_code TEXT,
  package_type TEXT NOT NULL,
  package_count INTEGER NOT NULL CHECK(package_count > 0),
  pieces_per_package INTEGER NOT NULL DEFAULT 1 CHECK(pieces_per_package > 0),
  gross_weight_per_package_kg REAL NOT NULL DEFAULT 0 CHECK(gross_weight_per_package_kg >= 0),
  net_weight_per_package_kg REAL NOT NULL DEFAULT 0 CHECK(net_weight_per_package_kg >= 0),
  length_cm REAL NOT NULL DEFAULT 0 CHECK(length_cm >= 0),
  width_cm REAL NOT NULL DEFAULT 0 CHECK(width_cm >= 0),
  height_cm REAL NOT NULL DEFAULT 0 CHECK(height_cm >= 0),
  volume_per_package_cbm REAL NOT NULL DEFAULT 0 CHECK(volume_per_package_cbm >= 0),
  declared_value REAL NOT NULL DEFAULT 0 CHECK(declared_value >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  origin_country TEXT,
  brand_model TEXT,
  marks TEXT,
  special_attributes TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_id,line_no)
);

CREATE TABLE order_cargo_packages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  cargo_item_id TEXT NOT NULL REFERENCES order_cargo_items(id) ON DELETE CASCADE,
  package_code TEXT NOT NULL,
  package_sequence INTEGER NOT NULL CHECK(package_sequence > 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','received','loaded','in_transit','delivered','cancelled')),
  created_at TEXT NOT NULL,
  UNIQUE(order_id,package_code),
  UNIQUE(cargo_item_id,package_sequence)
);

CREATE TABLE transport_batches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  batch_number TEXT NOT NULL,
  batch_name TEXT NOT NULL,
  origin_location TEXT NOT NULL,
  destination_location TEXT NOT NULL,
  planned_departure_at TEXT,
  planned_arrival_at TEXT,
  status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','loading','departed','arrived','cancelled')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,batch_number)
);

CREATE TABLE transport_batch_vehicles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transport_batches(id) ON DELETE CASCADE,
  vehicle_no TEXT NOT NULL,
  plate_number TEXT,
  carrier_id TEXT REFERENCES carriers(id) ON DELETE SET NULL,
  driver_name TEXT,
  driver_phone TEXT,
  capacity_weight_kg REAL NOT NULL DEFAULT 0 CHECK(capacity_weight_kg >= 0),
  capacity_volume_cbm REAL NOT NULL DEFAULT 0 CHECK(capacity_volume_cbm >= 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','loading','departed','arrived','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id,vehicle_no)
);

CREATE TABLE transport_vehicle_loads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transport_batches(id) ON DELETE CASCADE,
  vehicle_id TEXT NOT NULL REFERENCES transport_batch_vehicles(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES order_cargo_packages(id) ON DELETE RESTRICT,
  loaded_at TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id,package_id)
);

CREATE TABLE booking_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  booking_number TEXT NOT NULL,
  booking_type TEXT NOT NULL DEFAULT 'road',
  carrier_id TEXT REFERENCES carriers(id) ON DELETE SET NULL,
  booking_agent TEXT,
  carrier_reference TEXT,
  equipment_type TEXT,
  equipment_quantity INTEGER NOT NULL DEFAULT 1 CHECK(equipment_quantity > 0),
  service_reference TEXT,
  planned_departure_at TEXT,
  planned_arrival_at TEXT,
  cutoff_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','confirmed','cancelled','completed')),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,booking_number)
);

CREATE TABLE business_expenses (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT REFERENCES transport_orders(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES booking_records(id) ON DELETE SET NULL,
  shipment_id TEXT REFERENCES shipments(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')),
  stage TEXT NOT NULL DEFAULT 'estimated' CHECK(stage IN ('estimated','confirmed','reconciled','invoiced','settled','cancelled')),
  charge_code TEXT NOT NULL,
  charge_name TEXT NOT NULL,
  counterparty_name TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  quantity REAL NOT NULL DEFAULT 1 CHECK(quantity > 0),
  unit_price REAL NOT NULL DEFAULT 0 CHECK(unit_price >= 0),
  amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
  exchange_rate REAL NOT NULL DEFAULT 1 CHECK(exchange_rate > 0),
  base_amount REAL NOT NULL DEFAULT 0 CHECK(base_amount >= 0),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_order_services_order ON order_services(order_id,status);
CREATE INDEX idx_cargo_items_order ON order_cargo_items(order_id,line_no);
CREATE INDEX idx_cargo_packages_order ON order_cargo_packages(order_id,status);
CREATE INDEX idx_batches_order ON transport_batches(order_id,status);
CREATE INDEX idx_batch_vehicles_batch ON transport_batch_vehicles(batch_id,status);
CREATE INDEX idx_vehicle_loads_vehicle ON transport_vehicle_loads(vehicle_id);
CREATE INDEX idx_bookings_order ON booking_records(order_id,status);
CREATE INDEX idx_expenses_order ON business_expenses(order_id,direction,stage);

UPDATE transport_orders SET order_date=substr(created_at,1,10) WHERE order_date IS NULL;

INSERT INTO order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,volume_per_package_cbm,created_at,updated_at)
SELECT 'cargo-'||id,organization_id,id,1,cargo_description,'other',pieces,1,CASE WHEN pieces>0 THEN gross_weight_kg/pieces ELSE 0 END,CASE WHEN pieces>0 THEN volume_cbm/pieces ELSE 0 END,created_at,updated_at
FROM transport_orders;

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<500)
INSERT INTO order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,created_at)
SELECT 'pkg-'||o.id||'-'||seq.n,o.organization_id,o.id,'cargo-'||o.id,o.order_number||'-P'||printf('%03d',seq.n),seq.n,o.created_at
FROM transport_orders o JOIN seq ON seq.n<=MIN(o.pieces,500);
