PRAGMA foreign_keys = ON;

CREATE TABLE transport_batch_exceptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transport_batches(id) ON DELETE CASCADE,
  exception_number TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('batch','order','package')),
  order_id TEXT REFERENCES transport_orders(id) ON DELETE CASCADE,
  package_id TEXT REFERENCES warehouse_packages(id) ON DELETE SET NULL,
  exception_type TEXT NOT NULL CHECK(exception_type IN (
    'cargo_damage','cargo_shortage','document','customs','vehicle','delay','route','warehouse','other'
  )),
  severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
  blocks_progress INTEGER NOT NULL DEFAULT 1 CHECK(blocks_progress IN (0,1)),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','processing','resolved','cancelled')),
  description TEXT NOT NULL,
  resolution TEXT,
  reported_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reported_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,exception_number),
  CHECK(
    (scope='batch' AND order_id IS NULL AND package_id IS NULL)
    OR (scope='order' AND order_id IS NOT NULL AND package_id IS NULL)
    OR (scope='package' AND order_id IS NOT NULL AND package_id IS NOT NULL)
  )
);

CREATE INDEX idx_transport_batch_exceptions_batch
  ON transport_batch_exceptions(organization_id,batch_id,status,updated_at DESC);

CREATE INDEX idx_transport_batch_exceptions_order
  ON transport_batch_exceptions(organization_id,order_id,status,updated_at DESC);

CREATE UNIQUE INDEX uq_transport_batch_exceptions_active_target
  ON transport_batch_exceptions(
    organization_id,batch_id,scope,COALESCE(order_id,''),COALESCE(package_id,''),exception_type
  )
  WHERE status IN ('open','processing');

CREATE TABLE transport_batch_exception_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  exception_id TEXT NOT NULL REFERENCES transport_batch_exceptions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('created','processing','resolved','cancelled')),
  notes TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_transport_batch_exception_events
  ON transport_batch_exception_events(exception_id,created_at);

-- Establish a truthful baseline for legacy warehouse exceptions. Subsequent
-- warehouse and PZ exception mutations keep this denormalized status in sync.
UPDATE transport_orders
SET exception_status = CASE
  WHEN EXISTS(
    SELECT 1 FROM warehouse_exceptions e
    JOIN shipments s ON s.id=e.shipment_id
    WHERE e.organization_id=transport_orders.organization_id
      AND s.order_id=transport_orders.id
      AND e.status IN ('open','processing')
      AND e.severity IN ('high','critical')
  ) THEN 'exception'
  WHEN EXISTS(
    SELECT 1 FROM warehouse_exceptions e
    JOIN shipments s ON s.id=e.shipment_id
    WHERE e.organization_id=transport_orders.organization_id
      AND s.order_id=transport_orders.id
      AND e.status IN ('open','processing')
  ) THEN 'warning'
  ELSE 'normal'
END;
