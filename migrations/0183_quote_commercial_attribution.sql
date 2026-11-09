-- Keep historical attribution unknown rather than guessing from creator/sales.
ALTER TABLE quotations ADD COLUMN quote_commercial_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quotations ADD COLUMN quote_commercial_name_snapshot TEXT;
ALTER TABLE transport_orders ADD COLUMN quote_commercial_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transport_orders ADD COLUMN quote_commercial_name_snapshot TEXT;

CREATE INDEX idx_orders_quote_commercial ON transport_orders(organization_id,quote_commercial_user_id);
