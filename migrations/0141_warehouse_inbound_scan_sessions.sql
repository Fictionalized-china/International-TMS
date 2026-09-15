PRAGMA foreign_keys = ON;

-- The scanner belongs to the warehouse, never to the order page.  A scan
-- resolves an IN mark to its order and opens/continues that order's receiving
-- session under the single active warehouse scanner session.
CREATE TABLE warehouse_inbound_scan_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed','cancelled')),
  opened_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  closed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE warehouse_inbound_order_receiving_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  scan_session_id TEXT NOT NULL REFERENCES warehouse_inbound_scan_sessions(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  shipment_id TEXT REFERENCES shipments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'scanning' CHECK(status IN ('scanning','confirmed','cancelled')),
  confirmed_receipt_id TEXT REFERENCES warehouse_receipts(id) ON DELETE RESTRICT,
  opened_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  opened_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((status='confirmed') = (confirmed_receipt_id IS NOT NULL))
);

CREATE TABLE warehouse_inbound_scan_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  scan_session_id TEXT NOT NULL REFERENCES warehouse_inbound_scan_sessions(id) ON DELETE RESTRICT,
  normalized_code TEXT NOT NULL,
  request_key TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','duplicate','not_found','wrong_warehouse','unavailable','cancelled')),
  inbound_mark_id TEXT REFERENCES order_cargo_packages(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES transport_orders(id) ON DELETE SET NULL,
  order_receiving_session_id TEXT REFERENCES warehouse_inbound_order_receiving_sessions(id) ON DELETE SET NULL,
  duplicate_of_event_id TEXT REFERENCES warehouse_inbound_scan_events(id) ON DELETE SET NULL,
  scanned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  scanned_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE warehouse_inbound_mark_receipts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  inbound_mark_id TEXT NOT NULL REFERENCES order_cargo_packages(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  order_receiving_session_id TEXT NOT NULL REFERENCES warehouse_inbound_order_receiving_sessions(id) ON DELETE RESTRICT,
  first_scan_event_id TEXT NOT NULL REFERENCES warehouse_inbound_scan_events(id) ON DELETE RESTRICT,
  receipt_id TEXT REFERENCES warehouse_receipts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'scanned' CHECK(status IN ('scanned','confirmed','cancelled')),
  scanned_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((status='confirmed') = (receipt_id IS NOT NULL))
);

CREATE TABLE warehouse_inbound_order_receiving_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_receiving_session_id TEXT NOT NULL REFERENCES warehouse_inbound_order_receiving_sessions(id) ON DELETE CASCADE,
  inbound_mark_id TEXT NOT NULL REFERENCES order_cargo_packages(id) ON DELETE RESTRICT,
  mark_receipt_id TEXT NOT NULL REFERENCES warehouse_inbound_mark_receipts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(order_receiving_session_id,inbound_mark_id),
  UNIQUE(mark_receipt_id)
);

CREATE UNIQUE INDEX idx_warehouse_inbound_scan_one_active
  ON warehouse_inbound_scan_sessions(organization_id,warehouse_id)
  WHERE status='active';
CREATE UNIQUE INDEX idx_warehouse_inbound_order_receiving_one_active
  ON warehouse_inbound_order_receiving_sessions(organization_id,warehouse_id,order_id)
  WHERE status='scanning';
CREATE UNIQUE INDEX idx_warehouse_inbound_order_receiving_one_active_scan
  ON warehouse_inbound_order_receiving_sessions(scan_session_id,order_id)
  WHERE status='scanning';
CREATE UNIQUE INDEX idx_warehouse_inbound_scan_request_idempotency
  ON warehouse_inbound_scan_events(scan_session_id,request_key)
  WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX idx_warehouse_inbound_mark_one_live_receipt
  ON warehouse_inbound_mark_receipts(organization_id,warehouse_id,inbound_mark_id)
  WHERE status IN ('scanned','confirmed');
CREATE INDEX idx_warehouse_inbound_scan_events_session
  ON warehouse_inbound_scan_events(organization_id,warehouse_id,scan_session_id,scanned_at DESC);
CREATE INDEX idx_warehouse_inbound_order_receiving_order
  ON warehouse_inbound_order_receiving_sessions(organization_id,warehouse_id,order_id,status);
CREATE INDEX idx_warehouse_inbound_mark_receipts_session
  ON warehouse_inbound_mark_receipts(order_receiving_session_id,status,inbound_mark_id);

CREATE TRIGGER warehouse_inbound_order_receiving_scope_guard
BEFORE INSERT ON warehouse_inbound_order_receiving_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM warehouse_inbound_scan_sessions scan
  WHERE scan.id=NEW.scan_session_id AND scan.organization_id=NEW.organization_id
    AND scan.warehouse_id=NEW.warehouse_id
)
BEGIN SELECT RAISE(ABORT,'inbound_order_receiving_session_scope_invalid'); END;

CREATE TRIGGER warehouse_inbound_mark_receipt_scope_guard
BEFORE INSERT ON warehouse_inbound_mark_receipts
WHEN NOT EXISTS (
  SELECT 1
    FROM warehouse_inbound_order_receiving_sessions receiving
    JOIN order_cargo_packages mark
      ON mark.id=NEW.inbound_mark_id AND mark.organization_id=NEW.organization_id
   WHERE receiving.id=NEW.order_receiving_session_id
     AND receiving.organization_id=NEW.organization_id
     AND receiving.warehouse_id=NEW.warehouse_id
     AND receiving.order_id=NEW.order_id
     AND mark.order_id=NEW.order_id
     AND mark.is_active=1 AND mark.status!='cancelled'
) OR NOT EXISTS (
  SELECT 1 FROM warehouse_inbound_scan_events event
  WHERE event.id=NEW.first_scan_event_id
    AND event.organization_id=NEW.organization_id
    AND event.warehouse_id=NEW.warehouse_id
    AND event.inbound_mark_id=NEW.inbound_mark_id
    AND event.order_id=NEW.order_id
    AND event.order_receiving_session_id=NEW.order_receiving_session_id
    AND event.outcome='accepted'
)
BEGIN SELECT RAISE(ABORT,'inbound_mark_receipt_scope_invalid'); END;

CREATE TRIGGER warehouse_inbound_order_receiving_item_scope_guard
BEFORE INSERT ON warehouse_inbound_order_receiving_items
WHEN NOT EXISTS (
  SELECT 1 FROM warehouse_inbound_mark_receipts receipt
  WHERE receipt.id=NEW.mark_receipt_id
    AND receipt.organization_id=NEW.organization_id
    AND receipt.order_receiving_session_id=NEW.order_receiving_session_id
    AND receipt.inbound_mark_id=NEW.inbound_mark_id
)
BEGIN SELECT RAISE(ABORT,'inbound_order_receiving_item_scope_invalid'); END;

CREATE TRIGGER warehouse_inbound_mark_receipt_confirm_guard
BEFORE UPDATE OF status,receipt_id ON warehouse_inbound_mark_receipts
WHEN NEW.status='confirmed' AND NOT EXISTS (
  SELECT 1 FROM warehouse_receipts receipt
  WHERE receipt.id=NEW.receipt_id AND receipt.organization_id=NEW.organization_id
    AND receipt.warehouse_id=NEW.warehouse_id AND receipt.status='completed'
)
BEGIN SELECT RAISE(ABORT,'inbound_mark_receipt_confirmation_invalid'); END;
