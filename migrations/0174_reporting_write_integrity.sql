ALTER TABLE order_commission_records ADD COLUMN write_token TEXT;
CREATE UNIQUE INDEX commission_history_revision ON order_commission_history(organization_id,order_id,revision);
