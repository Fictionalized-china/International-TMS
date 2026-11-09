-- Do not infer missing plans on historical orders.
ALTER TABLE quotations ADD COLUMN exit_port TEXT;
ALTER TABLE quotations ADD COLUMN transit_locations TEXT;
ALTER TABLE quotations ADD COLUMN customs_location TEXT;
ALTER TABLE quotations ADD COLUMN domestic_agent TEXT;
ALTER TABLE quotations ADD COLUMN intake_route_recorded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transport_orders ADD COLUMN domestic_agent TEXT;
