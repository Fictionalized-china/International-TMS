ALTER TABLE reference_data ADD COLUMN parent_code TEXT;

CREATE INDEX IF NOT EXISTS idx_reference_data_geo_parent
  ON reference_data(organization_id, category, parent_code, status, sort_order);

ALTER TABLE transport_orders ADD COLUMN origin_state TEXT;
ALTER TABLE transport_orders ADD COLUMN destination_state TEXT;
