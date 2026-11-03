-- Commercial feedback is recorded before supervisor approval. Cost allocation
-- remains protected by the existing approved-batch and frozen-workflow guards.
CREATE TABLE batch_dispatch_quotes (
  organization_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  carrier_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  freight_amount REAL NOT NULL CHECK(freight_amount > 0),
  currency TEXT NOT NULL,
  exchange_rate REAL NOT NULL CHECK(exchange_rate > 0),
  allocation_method TEXT NOT NULL CHECK(allocation_method IN ('auto','weight','volume','equal')),
  notes TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id,batch_id)
);
