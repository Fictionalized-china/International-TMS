-- Preserve absent historical plans; JSON stores the canonical planned facts, not actual resources.
ALTER TABLE quotations ADD COLUMN intake_operations_json TEXT;
ALTER TABLE transport_orders ADD COLUMN intake_operations_json TEXT;
