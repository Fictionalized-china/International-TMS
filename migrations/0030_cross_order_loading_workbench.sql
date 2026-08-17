PRAGMA foreign_keys = ON;

ALTER TABLE transport_batches ADD COLUMN route_key TEXT;
ALTER TABLE transport_batches ADD COLUMN warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE transport_batches ADD COLUMN carrier_id TEXT REFERENCES carriers(id) ON DELETE SET NULL;
ALTER TABLE transport_batches ADD COLUMN created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transport_batches ADD COLUMN actual_departure_at TEXT;
ALTER TABLE transport_batches ADD COLUMN actual_arrival_at TEXT;

CREATE TABLE transport_batch_orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transport_batches(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL DEFAULT 1 CHECK(sequence_no > 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','loaded','departed','arrived','removed')),
  added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id,order_id)
);

INSERT INTO transport_batch_orders(
  id,organization_id,batch_id,order_id,sequence_no,status,created_at,updated_at
)
SELECT
  lower(hex(randomblob(16))),organization_id,id,order_id,1,
  CASE status
    WHEN 'departed' THEN 'departed'
    WHEN 'arrived' THEN 'arrived'
    ELSE 'planned'
  END,
  created_at,updated_at
FROM transport_batches;

UPDATE transport_batches
SET route_key=(
  SELECT lower(trim(o.origin_country)||'|'||trim(COALESCE(o.origin_state,''))||'|'||trim(o.origin_city)||'>'||trim(o.destination_country)||'|'||trim(COALESCE(o.destination_state,''))||'|'||trim(o.destination_city))
  FROM transport_orders o
  WHERE o.id=transport_batches.order_id
)
WHERE route_key IS NULL;

CREATE INDEX idx_batch_orders_order ON transport_batch_orders(order_id,status,batch_id);
CREATE INDEX idx_batch_orders_batch ON transport_batch_orders(batch_id,status,sequence_no);
CREATE INDEX idx_transport_batches_route ON transport_batches(organization_id,route_key,status,planned_departure_at);

