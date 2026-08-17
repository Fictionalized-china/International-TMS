ALTER TABLE transport_orders ADD COLUMN requires_transloading INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transport_orders ADD COLUMN requires_transit_customs INTEGER NOT NULL DEFAULT 0;
