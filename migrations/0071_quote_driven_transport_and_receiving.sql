PRAGMA foreign_keys = ON;

-- The customer-facing quote decides whether the order is FTL or LTL.
ALTER TABLE quotations ADD COLUMN road_load_type TEXT NOT NULL DEFAULT 'ltl'
  CHECK(road_load_type IN ('ftl','ltl'));

UPDATE quotations
SET road_load_type=COALESCE(
  (
    SELECT CASE WHEN o.business_type='ftl' THEN 'ftl' ELSE 'ltl' END
    FROM transport_orders o
    WHERE o.quotation_id=quotations.id
    ORDER BY o.created_at DESC
    LIMIT 1
  ),
  'ltl'
);

-- Preserve the commercial facts used when an order was created. Later quote edits
-- must not silently rewrite an existing order.
CREATE TABLE transport_order_quote_snapshots (
  order_id TEXT PRIMARY KEY REFERENCES transport_orders(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE RESTRICT,
  quote_number TEXT NOT NULL,
  road_load_type TEXT NOT NULL CHECK(road_load_type IN ('ftl','ltl')),
  currency TEXT NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO transport_order_quote_snapshots(
  order_id,organization_id,quotation_id,quote_number,road_load_type,currency,
  subtotal,tax_amount,total_amount,snapshot_json,created_at
)
SELECT
  o.id,o.organization_id,q.id,q.quote_number,
  CASE WHEN o.business_type='ftl' THEN 'ftl' ELSE 'ltl' END,
  q.currency,q.subtotal,q.tax_amount,q.total_amount,
  json_object(
    'quoteNumber',q.quote_number,
    'roadLoadType',CASE WHEN o.business_type='ftl' THEN 'ftl' ELSE 'ltl' END,
    'currency',q.currency,
    'subtotal',q.subtotal,
    'taxAmount',q.tax_amount,
    'totalAmount',q.total_amount,
    'capturedFromLegacyOrder',1
  ),
  o.created_at
FROM transport_orders o
JOIN quotations q ON q.id=o.quotation_id
WHERE o.quotation_id IS NOT NULL;

ALTER TABLE warehouse_receipts ADD COLUMN cargo_complete INTEGER NOT NULL DEFAULT 0
  CHECK(cargo_complete IN (0,1));
ALTER TABLE warehouse_receipts ADD COLUMN has_exception INTEGER NOT NULL DEFAULT 0
  CHECK(has_exception IN (0,1));
ALTER TABLE warehouse_receipts ADD COLUMN exception_notes TEXT;

UPDATE warehouse_receipts
SET cargo_complete=CASE WHEN status='completed' THEN 1 ELSE 0 END;

ALTER TABLE warehouse_packages ADD COLUMN parent_package_id TEXT
  REFERENCES warehouse_packages(id) ON DELETE SET NULL;

ALTER TABLE order_transport_assignments ADD COLUMN destination_warehouse_id TEXT
  REFERENCES warehouses(id) ON DELETE SET NULL;

-- One domestic waybill/assignment may use several pickup vehicles.
CREATE TABLE domestic_waybill_vehicles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES order_transport_assignments(id) ON DELETE CASCADE,
  vehicle_sequence INTEGER NOT NULL DEFAULT 1 CHECK(vehicle_sequence > 0),
  vehicle_type TEXT,
  plate_number TEXT NOT NULL,
  driver_name TEXT,
  driver_phone TEXT,
  driver_id_number TEXT,
  planned_pickup_at TEXT,
  actual_pickup_at TEXT,
  actual_arrival_at TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned','picked_up','arrived','cancelled')),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(assignment_id,vehicle_sequence)
);

CREATE INDEX idx_order_quote_snapshots_org
  ON transport_order_quote_snapshots(organization_id,quotation_id);
CREATE INDEX idx_domestic_waybill_vehicles_assignment
  ON domestic_waybill_vehicles(assignment_id,status,vehicle_sequence);
